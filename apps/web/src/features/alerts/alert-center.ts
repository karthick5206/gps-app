import { ALERT_TYPE_MAP, type AlertDto, type Paginated } from '@veetracer/shared';
import { realtime } from '@/features/live/realtime';
import { api } from '@/lib/api';
import { storage } from '@/lib/storage';
import { bindAudioUnlock, playAlertSound } from './sound';

const LATEST = 20;
const MUTE_KEY = 'vt.alerts.muted';
const POPUP_KEY = 'vt.alerts.criticalPopup';
/** Only emergencies block the screen; other CRITICAL alerts still get a toast and sound. */
const POPUP_TYPES: ReadonlySet<string> = new Set(['SOS', 'POWER_CUT']);

export interface AlertCenterState {
  latest: AlertDto[];
  unread: number;
  /** CRITICAL alerts received live in this session and not yet acknowledged/dismissed (oldest first). */
  critical: AlertDto[];
  muted: boolean;
  /** Show the blocking modal for emergency alerts (SOS, power cut) — per-user preference, default on. */
  criticalPopup: boolean;
  loaded: boolean;
}

type Listener = () => void;
type AlertListener = (a: AlertDto) => void;

export function alertTitle(a: Pick<AlertDto, 'type'>): string {
  return ALERT_TYPE_MAP[a.type]?.label ?? a.type;
}

/**
 * Realtime alert state outside React: unread count, latest 20, the critical queue and the mute preference.
 * Fed by `/api/alerts` on start and by the socket `alert` event; React reads it via useSyncExternalStore.
 */
class AlertCenter {
  private state: AlertCenterState = { latest: [], unread: 0, critical: [], muted: storage.get(MUTE_KEY) === '1', criticalPopup: storage.get(POPUP_KEY) !== '0', loaded: false };
  private listeners = new Set<Listener>();
  private alertListeners = new Set<AlertListener>();
  private changeListeners = new Set<AlertListener>();
  private seen = new Set<string>();
  private offSocket: (() => void) | null = null;
  private offStatus: (() => void) | null = null;
  private poll: ReturnType<typeof setInterval> | undefined;
  private refCount = 0;
  private wasDisconnected = false;

  getState = () => this.state;

  subscribe = (l: Listener) => {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  };

  /** New alerts as they arrive (after dedupe). */
  onAlert(l: AlertListener) {
    this.alertListeners.add(l);
    return () => {
      this.alertListeners.delete(l);
    };
  }

  /** Alerts whose status changed locally (acknowledged). */
  onChange(l: AlertListener) {
    this.changeListeners.add(l);
    return () => {
      this.changeListeners.delete(l);
    };
  }

  private set(patch: Partial<AlertCenterState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l());
  }

  start() {
    if (this.refCount++ > 0) return;
    bindAudioUnlock();
    this.offSocket = realtime.on<[AlertDto]>('alert', (a) => this.receive(a));
    this.offStatus = realtime.subscribe(() => {
      const s = realtime.getStatus();
      if (s === 'disconnected') this.wasDisconnected = true;
      if (s === 'connected' && this.wasDisconnected) {
        this.wasDisconnected = false;
        this.refresh().catch(() => undefined);
      }
    });
    this.refresh().catch(() => undefined);
    this.poll = setInterval(() => this.refreshCount().catch(() => undefined), 60_000);
  }

  stop() {
    if (--this.refCount > 0) return;
    this.refCount = 0;
    this.offSocket?.();
    this.offStatus?.();
    clearInterval(this.poll);
    this.offSocket = this.offStatus = null;
    this.seen.clear();
    this.set({ latest: [], unread: 0, critical: [], loaded: false });
  }

  async refresh() {
    const [count, list] = await Promise.all([
      api.get<{ count: number }>('/alerts/unread-count'),
      api.get<Paginated<AlertDto>>('/alerts', { page: 1, pageSize: LATEST, sort: 'occurredAt', order: 'desc' }),
    ]);
    for (const a of list.items) this.seen.add(a.id);
    this.set({ unread: count.count, latest: list.items, loaded: true });
  }

  async refreshCount() {
    const count = await api.get<{ count: number }>('/alerts/unread-count');
    this.set({ unread: count.count });
  }

  receive(a: AlertDto) {
    if (this.seen.has(a.id)) return;
    this.seen.add(a.id);
    const latest = [a, ...this.state.latest].slice(0, LATEST);
    const critical = this.state.criticalPopup && a.severity === 'CRITICAL' && POPUP_TYPES.has(a.type) && a.status === 'NEW' ? [...this.state.critical, a] : this.state.critical;
    this.set({ latest, critical, unread: this.state.unread + (a.status === 'NEW' ? 1 : 0) });
    if (!this.state.muted) playAlertSound(a.severity);
    this.alertListeners.forEach((l) => l(a));
  }

  private markAcked(ids: Set<string> | null, patch: Partial<AlertDto>) {
    let acked = 0;
    const update = (x: AlertDto) => {
      if (x.status !== 'NEW' || (ids && !ids.has(x.id))) return x;
      acked++;
      const next = { ...x, status: 'ACKNOWLEDGED' as const, ...patch };
      this.changeListeners.forEach((l) => l(next));
      return next;
    };
    const latest = this.state.latest.map(update);
    const critical = this.state.critical.filter((x) => ids && !ids.has(x.id));
    this.set({ latest, critical });
    return acked;
  }

  async ack(id: string, note?: string) {
    const res = await api.post<AlertDto | undefined>(`/alerts/${id}/ack`, note ? { note } : {});
    this.markAcked(new Set([id]), res ? { ackAt: res.ackAt, ackByName: res.ackByName, ackNote: res.ackNote } : { ackAt: new Date().toISOString(), ackNote: note ?? null });
    await this.refreshCount().catch(() => this.set({ unread: Math.max(0, this.state.unread - 1) }));
  }

  /** Acknowledge the given alerts, or every NEW alert in scope when `ids` is omitted. */
  async ackAll(ids?: string[], note?: string) {
    await api.post<unknown>('/alerts/ack-all', { ...(ids ? { ids } : {}), ...(note ? { note } : {}) });
    this.markAcked(ids ? new Set(ids) : null, { ackAt: new Date().toISOString(), ackNote: note ?? null });
    await this.refreshCount().catch(() => undefined);
  }

  /** Removes an alert from the critical queue without acknowledging (users without `alerts:edit`). */
  dismissCritical(id: string) {
    this.set({ critical: this.state.critical.filter((x) => x.id !== id) });
  }

  setMuted(muted: boolean) {
    storage.set(MUTE_KEY, muted ? '1' : '0');
    this.set({ muted });
    if (!muted) bindAudioUnlock();
  }

  setCriticalPopup(on: boolean) {
    storage.set(POPUP_KEY, on ? '1' : '0');
    this.set({ criticalPopup: on, ...(on ? {} : { critical: [] }) });
  }

  /** Alerts acknowledged elsewhere (Alerts page) — keep the bell in sync. */
  notifyAcked(ids: string[] | null) {
    this.markAcked(ids ? new Set(ids) : null, { ackAt: new Date().toISOString() });
    this.refreshCount().catch(() => undefined);
  }
}

export const alertCenter = new AlertCenter();

import { ALERT_TYPE_MAP, EMERGENCY_ALERT_TYPES, isParkingAlarm, type AlertDto, type AlertsAckedEvent, type AlertsReadEvent, type AlertUnreadCount, type Paginated } from '@veetracer/shared';
import { realtime } from '@/features/live/realtime';
import { api } from '@/lib/api';
import { i18n } from '@/lib/i18n';
import { storage } from '@/lib/storage';
import { isUnread, withRead } from './read-state';
import { bindAudioUnlock, playAlertSound, playSiren } from './sound';

const LATEST = 20;
const MUTE_KEY = 'vt.alerts.muted';
const POPUP_KEY = 'vt.alerts.criticalPopup';
/** Only emergencies block the screen (and repeat a siren until acknowledged); other CRITICAL alerts get a toast and beeps. */
const POPUP_TYPES: ReadonlySet<string> = new Set(EMERGENCY_ALERT_TYPES);
const SIREN_REPEAT_MS = 3000;

export interface AlertCenterState {
  latest: AlertDto[];
  unread: number;
  /** NEW alerts in scope that need acknowledgement (shared). */
  pendingAck: number;
  /** CRITICAL alerts received live in this session and not yet acknowledged/dismissed (oldest first). */
  critical: AlertDto[];
  muted: boolean;
  /** Show the blocking modal for emergency alerts (SOS, power cut) — per-user preference, default on. */
  criticalPopup: boolean;
  loaded: boolean;
}

type Listener = () => void;
type AlertListener = (a: AlertDto) => void;
/** Read / acknowledged here or in another session: `ids` null = all (or unknown which), refetch lists. */
export interface AlertSync {
  kind: 'read' | 'acked';
  ids: string[] | null;
}
type SyncListener = (e: AlertSync) => void;

export function alertTitle(a: Pick<AlertDto, 'type'>): string {
  const label = ALERT_TYPE_MAP[a.type]?.label;
  return label ? i18n.t(label) : a.type;
}

/**
 * Realtime alert state outside React: unread count, latest 20, the critical queue and the mute preference.
 * Fed by `/api/alerts` on start and by the socket `alert` event; React reads it via useSyncExternalStore.
 */
class AlertCenter {
  private state: AlertCenterState = { latest: [], unread: 0, pendingAck: 0, critical: [], muted: storage.get(MUTE_KEY) === '1', criticalPopup: storage.get(POPUP_KEY) !== '0', loaded: false };
  private listeners = new Set<Listener>();
  private alertListeners = new Set<AlertListener>();
  private changeListeners = new Set<AlertListener>();
  private syncListeners = new Set<SyncListener>();
  private offSync: (() => void)[] = [];
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

  /** Alerts read or acknowledged (this tab, another tab, the phone or another user) — lists update their rows. */
  onSync(l: SyncListener) {
    this.syncListeners.add(l);
    return () => {
      this.syncListeners.delete(l);
    };
  }

  private siren: ReturnType<typeof setInterval> | null = null;

  private set(patch: Partial<AlertCenterState>) {
    this.state = { ...this.state, ...patch };
    this.syncSiren();
    this.listeners.forEach((l) => l());
  }

  /** Siren every few seconds while an emergency popup is open (until acknowledged or dismissed), unless muted. */
  private syncSiren() {
    // A parking mode alarm rings even when alert sounds are muted: it is there to wake someone.
    const parking = this.state.critical.some((a) => isParkingAlarm(a.data));
    const on = this.state.critical.length > 0 && (!this.state.muted || parking);
    if (on && !this.siren) {
      playSiren(parking);
      this.siren = setInterval(() => playSiren(this.state.critical.some((a) => isParkingAlarm(a.data))), SIREN_REPEAT_MS);
    } else if (!on && this.siren) {
      clearInterval(this.siren);
      this.siren = null;
    }
  }

  start() {
    if (this.refCount++ > 0) return;
    bindAudioUnlock();
    this.offSocket = realtime.on<[AlertDto]>('alert', (a) => this.receive(a));
    this.offSync = [
      realtime.on<[AlertsReadEvent]>('alerts:read', (e) => this.onReadElsewhere(e)),
      realtime.on<[AlertsAckedEvent]>('alerts:acked', (e) => this.onAckedElsewhere(e)),
    ];
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
    this.offSync.forEach((off) => off());
    this.offSync = [];
    clearInterval(this.poll);
    this.offSocket = this.offStatus = null;
    this.seen.clear();
    this.set({ latest: [], unread: 0, pendingAck: 0, critical: [], loaded: false });
  }

  async refresh() {
    const [count, list] = await Promise.all([
      api.get<AlertUnreadCount>('/alerts/unread-count'),
      api.get<Paginated<AlertDto>>('/alerts', { page: 1, pageSize: LATEST, sort: 'occurredAt', order: 'desc' }),
    ]);
    for (const a of list.items) this.seen.add(a.id);
    this.set({ unread: count.count, pendingAck: count.pendingAck, latest: list.items, loaded: true });
  }

  async refreshCount() {
    const count = await api.get<AlertUnreadCount>('/alerts/unread-count');
    this.set({ unread: count.count, pendingAck: count.pendingAck });
  }

  receive(a: AlertDto) {
    if (this.seen.has(a.id)) return;
    this.seen.add(a.id);
    const latest = [a, ...this.state.latest].slice(0, LATEST);
    // Parking mode alarms always block the screen with the siren (whatever their severity or the popup preference).
    const alarm = isParkingAlarm(a.data) || (this.state.criticalPopup && a.severity === 'CRITICAL' && POPUP_TYPES.has(a.type));
    const critical = alarm && a.status === 'NEW' ? [...this.state.critical, a] : this.state.critical;
    this.set({ latest, critical, unread: this.state.unread + (isUnread(a) ? 1 : 0), pendingAck: this.state.pendingAck + (a.ackRequired && a.status === 'NEW' ? 1 : 0) });
    if (!this.state.muted && !POPUP_TYPES.has(a.type) && !isParkingAlarm(a.data)) playAlertSound(a.severity);
    this.alertListeners.forEach((l) => l(a));
  }

  private markAcked(ids: Set<string> | null, patch: Partial<AlertDto>) {
    let acked = 0;
    const update = (x: AlertDto) => {
      if (x.status !== 'NEW' || !x.ackRequired || (ids && !ids.has(x.id))) return x;
      acked++;
      const next = { ...x, status: 'ACKNOWLEDGED' as const, read: true, ...patch };
      this.changeListeners.forEach((l) => l(next));
      return next;
    };
    const latest = this.state.latest.map(update);
    const critical = this.state.critical.filter((x) => ids && !ids.has(x.id));
    this.set({ latest, critical });
    this.emitSync({ kind: 'acked', ids: ids ? [...ids] : null });
    return acked;
  }

  private emitSync(e: AlertSync) {
    this.syncListeners.forEach((l) => l(e));
  }

  private applyRead(ids: string[] | null) {
    this.set({ latest: withRead(this.state.latest, ids ? new Set(ids) : null), ...(ids ? {} : { unread: 0 }) });
    this.emitSync({ kind: 'read', ids });
  }

  /**
   * Opening an alert marks it read for this user only (idempotent). Skips the call when the alert is already known
   * to be read; the count is refetched because the alert may be older than the bell's latest 20.
   */
  async markRead(a: Pick<AlertDto, 'id' | 'read'>) {
    const known = this.state.latest.find((x) => x.id === a.id);
    if (a.read || known?.read) return;
    this.applyRead([a.id]);
    if (known && isUnread(known)) this.set({ unread: Math.max(0, this.state.unread - 1) });
    await api.post<unknown>(`/alerts/${a.id}/read`, {});
    await this.refreshCount().catch(() => undefined);
  }

  /** "Mark all as read" for this user (any role); acknowledging stays separate. */
  async markAllRead() {
    await api.post<unknown>('/alerts/read-all', {});
    this.applyRead(null);
    await this.refreshCount().catch(() => undefined);
  }

  /** The same user read alerts in another tab or on the phone. */
  private onReadElsewhere(e: AlertsReadEvent) {
    if (e.ids || e.all) this.applyRead(e.ids ?? null);
    else this.emitSync({ kind: 'read', ids: null });
    this.refreshCount().catch(() => undefined);
  }

  /** Someone (maybe another user) acknowledged alerts: they are handled, so read for everyone. */
  private onAckedElsewhere(e: AlertsAckedEvent) {
    if (e.ids) {
      this.markAcked(new Set(e.ids), { ackAt: e.ackAt, ackByName: e.ackByName });
      this.refreshCount().catch(() => undefined);
    } else {
      this.emitSync({ kind: 'acked', ids: null });
      this.refresh().catch(() => undefined);
    }
  }

  async ack(id: string, note?: string) {
    const res = await api.post<AlertDto | undefined>(`/alerts/${id}/ack`, note ? { note } : {});
    this.markAcked(new Set([id]), res ? { ackAt: res.ackAt, ackByName: res.ackByName, ackNote: res.ackNote } : { ackAt: new Date().toISOString(), ackNote: note ?? null });
    await this.refreshCount().catch(() => this.set({ unread: Math.max(0, this.state.unread - 1) }));
  }

  /** Acknowledge the given alerts, or every NEW alert in scope that needs it when `ids` is omitted. */
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

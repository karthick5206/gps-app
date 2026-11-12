/**
 * Passenger SOS offline queue (E5 WP 5.3 client of the WP 5.4 durable SOS; doc 08 §6.1, doc 10 §6, contract
 * `packages/shared/src/transport-sos.ts`). Pure TypeScript: storage, network and clock are injected, so the behaviour
 * is tested with `node --test` (sos-queue.test.ts). The app wires it to SecureStore and `POST /api/me/transport/sos`
 * in sos-store.ts. Same pattern as the driver event queue (event-queue.ts).
 *
 * Rules (contract file comment):
 * - The clientIncidentId (UUIDv7, also the `Idempotency-Key`) is made at tap time and the SOS is written to the store
 *   BEFORE the first network call. SOS is never part of a trip-event batch: one request per SOS.
 * - Retry with back-off SOS_LIMITS.retryBackoffMs (1 s, 2 s, 5 s, 10 s, then every 15 s) on network errors, timeouts,
 *   401 (after the session refresh), 408, 429 and 5xx, until a 2xx. 422 IDEMPOTENCY_KEY_REUSED counts as delivered.
 * - Any other answer (404: this server has no passenger SOS yet, 403, 400) marks it UNDELIVERED: kept and shown with
 *   the call buttons, retried only when the person taps "Try again". Nothing is ever dropped silently; a row is
 *   deleted only when the person dismisses a settled one.
 * - Honest wording: until the server answers, the app says "Not sent yet"; RECEIVED means "VeeTrax received your SOS",
 *   never "help is on the way"; only an acknowledgement is shown as acknowledged.
 * - Queues are per user (keys carry the user id) and per audience (`namespace`): passenger `sos`, driver `dsos`
 *   (r114: driver SOS button, doc 09 §7.3), so a person who is both keeps two queues sent to their own routes.
 */
import type { SosReceipt } from '@veetracer/shared';
import { uuidv7, type KeyValueStore } from './event-queue.ts';

/** SOS_LIMITS.retryBackoffMs of the shared contract (kept here so this file runs under plain `node --test`). */
export const SOS_RETRY_BACKOFF_MS: readonly number[] = [1_000, 2_000, 5_000, 10_000, 15_000];
/** SOS_LIMITS.noteMax. */
export const SOS_NOTE_MAX = 500;
/** SOS_LIMITS.promptCallAfterMs: no acknowledgement after this → prompt to call the desk / emergency number. */
export const SOS_PROMPT_CALL_AFTER_MS = 60_000;
/** Settled rows (received / undelivered) are display records; pruned at load after this. */
export const SOS_SETTLED_KEEP_MS = 24 * 3600_000;

export type SosItemState = 'PENDING' | 'RECEIVED' | 'UNDELIVERED';

export interface SosItem {
  clientIncidentId: string;
  raisedAt: string;
  tripId: string | null;
  note: string | null;
  state: SosItemState;
  attempts: number;
  /** Earliest next automatic attempt (ms), null = now. */
  nextAttemptAt: number | null;
  /** HTTP status / code of the last failure (shown for UNDELIVERED). */
  lastError: string | null;
  receipt: SosReceipt | null;
  settledAt: string | null;
}

/** Thrown by a transport: `status` undefined = no answer (network / timeout). */
export class SosSendError extends Error {
  readonly status: number | undefined;
  readonly code: string | null;
  // No parameter properties: `node --test` runs this file with type stripping only.
  constructor(status: number | undefined, code: string | null = null, message?: string) {
    super(message ?? `SOS send failed (${status ?? 'network'})`);
    this.status = status;
    this.code = code;
  }
}

export interface SosTransport {
  send(item: SosItem): Promise<SosReceipt>;
}

/** Same rule as `sosShouldRetry` of the shared contract. */
export function sosRetryable(status: number | undefined): boolean {
  if (status === undefined || status === 0) return true;
  if (status >= 200 && status < 300) return false;
  if (status === 422) return false;
  if (status === 401) return true;
  return status === 408 || status === 429 || status >= 500;
}

export function sosBackoffMs(attempts: number): number {
  if (attempts <= 0) return 0;
  return SOS_RETRY_BACKOFF_MS[Math.min(attempts - 1, SOS_RETRY_BACKOFF_MS.length - 1)];
}

/** What the app may say about one SOS (honest wording, doc 10 §6.3). */
export type SosStage = 'QUEUED_ON_DEVICE' | 'UNDELIVERED' | 'RECEIVED' | 'ACKNOWLEDGED' | 'RESOLVED';

export function sosStage(item: Pick<SosItem, 'state' | 'receipt'>): SosStage {
  if (item.state === 'PENDING') return 'QUEUED_ON_DEVICE';
  if (item.state === 'UNDELIVERED') return 'UNDELIVERED';
  const r = item.receipt;
  if (r && (r.incidentStatus === 'RESOLVED' || r.resolvedAt)) return 'RESOLVED';
  if (r?.acknowledgement) return 'ACKNOWLEDGED';
  return 'RECEIVED';
}

/** Whether to show "call the desk / emergency number" prominently: always unless acknowledged / resolved in time. */
export function shouldPromptCall(item: Pick<SosItem, 'state' | 'receipt' | 'raisedAt'>, nowMs: number): boolean {
  const stage = sosStage(item);
  if (stage === 'ACKNOWLEDGED' || stage === 'RESOLVED') return false;
  if (stage !== 'RECEIVED') return true;
  return nowMs - Date.parse(item.raisedAt) >= SOS_PROMPT_CALL_AFTER_MS;
}

export interface SosSnapshot {
  userId: string | null;
  items: readonly SosItem[];
  pending: number;
  /** The newest SOS (the one the screen shows). */
  latest: SosItem | null;
  sending: boolean;
}

interface Meta {
  v: 1;
  ids: string[];
}

export interface SosQueueOptions {
  store: KeyValueStore;
  /** Key namespace (lower-case letters): `sos` = passenger (default, keys unchanged since WP 5.3), `dsos` = driver. */
  namespace?: string;
  now?: () => number;
  random?: (n: number) => Uint8Array;
}

export class SosQueue {
  private readonly store: KeyValueStore;
  private readonly namespace: string;
  private readonly now: () => number;
  private readonly random: ((n: number) => Uint8Array) | undefined;
  private userId: string | null = null;
  private items = new Map<string, SosItem>();
  private order: string[] = [];
  private sending = false;
  private listeners = new Set<() => void>();
  private snap: SosSnapshot;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(opts: SosQueueOptions) {
    this.store = opts.store;
    this.namespace = opts.namespace ?? 'sos';
    if (!/^[a-z]+$/.test(this.namespace)) throw new Error('Invalid SOS queue namespace');
    this.now = opts.now ?? Date.now;
    this.random = opts.random;
    this.snap = this.build();
  }

  private prefix(): string {
    if (!this.userId) throw new Error('SOS queue not loaded');
    return `vt.${this.namespace}.${this.userId}`;
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  async load(userId: string): Promise<void> {
    if (!/^[A-Za-z0-9_-]+$/.test(userId)) throw new Error('Invalid user id for the SOS queue');
    await this.serial(async () => {
      this.userId = userId;
      this.items.clear();
      const raw = await this.store.get(`${this.prefix()}.meta`);
      const meta: Meta = raw ? (JSON.parse(raw) as Meta) : { v: 1, ids: [] };
      const kept: string[] = [];
      for (const id of meta.ids) {
        const row = await this.store.get(`${this.prefix()}.i.${id}`);
        if (!row) continue;
        const item = JSON.parse(row) as SosItem;
        // A pending SOS is retried at once after a restart (never waits for an old back-off).
        if (item.state === 'PENDING') item.nextAttemptAt = null;
        if (item.state !== 'PENDING' && item.settledAt && this.now() - Date.parse(item.settledAt) > SOS_SETTLED_KEEP_MS) {
          await this.store.delete(`${this.prefix()}.i.${id}`).catch(() => undefined);
          continue;
        }
        this.items.set(id, item);
        kept.push(id);
      }
      this.order = kept;
      if (kept.length !== meta.ids.length) await this.store.set(`${this.prefix()}.meta`, JSON.stringify({ v: 1, ids: kept } satisfies Meta));
    });
    this.emit();
  }

  unload(): void {
    this.userId = null;
    this.items.clear();
    this.order = [];
    this.emit();
  }

  /** Stores a new SOS (durably, before any network call) and returns it PENDING. Throws when it cannot be stored. */
  async raise(input: { tripId?: string | null; note?: string | null }): Promise<SosItem> {
    const item = await this.serial(async () => {
      const now = this.now();
      const it: SosItem = {
        clientIncidentId: uuidv7(now, this.random),
        raisedAt: new Date(now).toISOString(),
        tripId: input.tripId ?? null,
        note: input.note?.trim() ? input.note.trim().slice(0, SOS_NOTE_MAX) : null,
        state: 'PENDING',
        attempts: 0,
        nextAttemptAt: null,
        lastError: null,
        receipt: null,
        settledAt: null,
      };
      // Row first, then the index (a crash in between leaves an unindexed row, never an index without a row).
      await this.store.set(`${this.prefix()}.i.${it.clientIncidentId}`, JSON.stringify(it));
      const ids = [...this.order, it.clientIncidentId];
      await this.store.set(`${this.prefix()}.meta`, JSON.stringify({ v: 1, ids } satisfies Meta));
      this.order = ids;
      this.items.set(it.clientIncidentId, it);
      return it;
    });
    this.emit();
    return item;
  }

  /** Whether an automatic attempt is due now. */
  due(): boolean {
    if (!this.userId || this.sending) return false;
    const now = this.now();
    return this.pendingItems().some((i) => i.nextAttemptAt === null || now >= i.nextAttemptAt);
  }

  /** Earliest next attempt of a pending SOS (ms), or null. */
  nextDueAt(): number | null {
    const times = this.pendingItems().map((i) => i.nextAttemptAt ?? this.now());
    return times.length ? Math.min(...times) : null;
  }

  private pendingItems(): SosItem[] {
    return this.order.map((id) => this.items.get(id)!).filter((i) => i && i.state === 'PENDING');
  }

  /** Sends every due pending SOS, oldest first, one request each. `force` ignores the back-off. */
  async drain(transport: SosTransport, force = false): Promise<void> {
    if (!this.userId || this.sending) return;
    this.sending = true;
    this.emit();
    try {
      for (const item of this.pendingItems()) {
        if (!force && item.nextAttemptAt !== null && this.now() < item.nextAttemptAt) continue;
        let next: SosItem;
        try {
          const receipt = await transport.send(item);
          next = { ...item, state: 'RECEIVED', attempts: item.attempts + 1, receipt, lastError: null, nextAttemptAt: null, settledAt: new Date(this.now()).toISOString() };
        } catch (err) {
          const e = err instanceof SosSendError ? err : new SosSendError(undefined);
          const attempts = item.attempts + 1;
          if (e.status === 422) {
            // IDEMPOTENCY_KEY_REUSED: the first request with this key is stored on the server.
            next = { ...item, state: 'RECEIVED', attempts, lastError: e.code ?? '422', nextAttemptAt: null, settledAt: new Date(this.now()).toISOString() };
          } else if (sosRetryable(e.status)) {
            next = { ...item, attempts, lastError: e.code ?? String(e.status ?? 'network'), nextAttemptAt: this.now() + sosBackoffMs(attempts) };
          } else {
            next = { ...item, state: 'UNDELIVERED', attempts, lastError: e.code ?? String(e.status), nextAttemptAt: null, settledAt: new Date(this.now()).toISOString() };
          }
        }
        await this.serial(() => this.put(next));
        this.emit();
      }
    } finally {
      this.sending = false;
      this.emit();
    }
  }

  /** "Try again" on an UNDELIVERED SOS: back to PENDING (same clientIncidentId, so the server deduplicates). */
  async retry(clientIncidentId: string): Promise<boolean> {
    const item = this.items.get(clientIncidentId);
    if (!item || item.state !== 'UNDELIVERED') return false;
    await this.serial(() => this.put({ ...item, state: 'PENDING', nextAttemptAt: null, settledAt: null }));
    this.emit();
    return true;
  }

  /** A fresher receipt from GET /me/transport/sos/:id (acknowledgement / resolution). */
  async updateReceipt(clientIncidentId: string, receipt: SosReceipt): Promise<void> {
    const item = this.items.get(clientIncidentId);
    if (!item || item.state !== 'RECEIVED') return;
    await this.serial(() => this.put({ ...item, receipt }));
    this.emit();
  }

  /** Removes a settled SOS after the person has seen it. A pending SOS cannot be removed. */
  async dismiss(clientIncidentId: string): Promise<boolean> {
    const item = this.items.get(clientIncidentId);
    if (!item || item.state === 'PENDING') return false;
    await this.serial(async () => {
      const ids = this.order.filter((id) => id !== clientIncidentId);
      await this.store.set(`${this.prefix()}.meta`, JSON.stringify({ v: 1, ids } satisfies Meta));
      this.order = ids;
      this.items.delete(clientIncidentId);
      await this.store.delete(`${this.prefix()}.i.${clientIncidentId}`).catch(() => undefined);
    });
    this.emit();
    return true;
  }

  private async put(item: SosItem): Promise<void> {
    if (!this.userId || !this.items.has(item.clientIncidentId)) return;
    await this.store.set(`${this.prefix()}.i.${item.clientIncidentId}`, JSON.stringify(item));
    this.items.set(item.clientIncidentId, item);
  }

  subscribe(l: () => void): () => void {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  }

  snapshot(): SosSnapshot {
    return this.snap;
  }

  private build(): SosSnapshot {
    const items = this.order.map((id) => this.items.get(id)!).filter(Boolean);
    return { userId: this.userId, items, pending: items.filter((i) => i.state === 'PENDING').length, latest: items[items.length - 1] ?? null, sending: this.sending };
  }

  private emit() {
    this.snap = this.build();
    this.listeners.forEach((l) => l());
  }
}

/**
 * Driver offline event queue (doc 09 §6, doc 05 §3.8). Pure TypeScript: storage and network are injected, so the
 * whole behaviour is tested with `node --test` (event-queue.test.ts). The app wires it to SecureStore and
 * `POST /api/driver/v1/trips/:id/events` in queue-store.ts.
 *
 * Rules (doc 09 §6.2–6.5):
 * - The `clientEventId` (UUIDv7) is made when the driver taps, before any network call; `seq` is monotonic per trip.
 * - The event is written to the store BEFORE anything is sent. Upload is FIFO per trip, oldest first, ≤ 50 per batch.
 * - An event is deleted only after the server's per-event answer ACCEPTED / DUPLICATE (confirm-before-delete).
 * - REJECTED is terminal: kept and shown with its code until the driver dismisses it, never retried. LATE (the
 *   server stored it for the audit trail but it changed nothing, e.g. the trip had closed) is confirmed as received,
 *   never resent, and kept as an information row "recorded late, no effect" until dismissed, so it is not mistaken
 *   for an applied action. RETRY (e.g. OUT_OF_ORDER) and network / 5xx / 429 keep it PENDING with
 *   backoff 5 s → 5 min. 401 pauses until the same user signs in again; 403 DRIVER_INACTIVE pauses for an hour.
 * - Nothing is ever dropped silently. Above SOFT_LIMIT pending events the UI shows "Sync required".
 * - Queues are per user (keys carry the user id): another login on the same phone neither sends nor sees them.
 * - START_TRIP, duty start and SOS are never queued (online only); `assertQueueable` refuses them.
 */

export type QueueableEventType =
  | 'ACKNOWLEDGE'
  | 'ARRIVED'
  | 'BOARDED'
  | 'NO_SHOW'
  | 'DEPARTED'
  | 'DROPPED'
  | 'REPORT_DELAY'
  | 'REPORT_OBSTRUCTION'
  | 'REPORT_BREAKDOWN'
  | 'REPORT_INCIDENT'
  | 'REQUEST_ASSISTANCE'
  | 'COMPLETE_TRIP'
  | (string & {});

/** Online-only commands (doc 09 §4.4, doc 05 §3.8): never in an offline batch. */
export const ONLINE_ONLY: readonly string[] = ['START_TRIP', 'DUTY_START', 'SOS'];

export interface QueuedEventInput {
  tripId: string;
  type: QueueableEventType;
  stopSeq?: number;
  passengerTripId?: string;
  reasonCode?: string;
  etaMin?: number;
  note?: string;
  pin?: string;
}

export type QueuedEventState = 'PENDING' | 'REJECTED' | 'LATE';

export interface QueuedEvent extends QueuedEventInput {
  clientEventId: string;
  /** Monotonic per (install, user, trip). */
  seq: number;
  /** Local FIFO order across trips. */
  localId: number;
  occurredAt: string;
  state: QueuedEventState;
  attempts: number;
  /** Server code of a rejection (NOT_AT_STOP, TRIP_CLOSED, NOT_ASSIGNED, LATE…), or of the last retryable answer. */
  code: string | null;
  /** When the server rejected it. */
  rejectedAt: string | null;
}

export type ServerOutcome = 'ACCEPTED' | 'DUPLICATE' | 'REJECTED' | 'LATE' | 'RETRY';

export interface EventOutcome {
  clientEventId: string;
  outcome: ServerOutcome;
  code?: string | null;
  serverTime?: string | null;
}

/**
 * Thrown by a transport for a failure of the whole request. `network` (no answer, 408, 429, 5xx) and `retry` keep the
 * events pending with backoff; `auth` = the session cannot be refreshed; `inactive` = 403 DRIVER_INACTIVE;
 * `rejected` = a terminal answer for the whole batch (404 trip not assigned / revoked, 409 / 422 with a code).
 */
export type QueueSendErrorKind = 'network' | 'retry' | 'auth' | 'inactive' | 'rejected';

export class QueueSendError extends Error {
  readonly kind: QueueSendErrorKind;
  readonly code: string | null;
  // No parameter properties: `node --test` runs this file with type stripping only.
  constructor(kind: QueueSendErrorKind, code: string | null = null, message?: string) {
    super(message ?? kind);
    this.kind = kind;
    this.code = code;
  }
}

export interface QueueTransport {
  send(tripId: string, events: readonly QueuedEvent[], clockOffsetMs: number): Promise<EventOutcome[]>;
}

/** SecureStore-like async key/value store (keys: [A-Za-z0-9._-]). */
export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export const BATCH_MAX = 50;
export const SOFT_LIMIT = 100;
export const BACKOFF_MIN_MS = 5_000;
export const BACKOFF_MAX_MS = 5 * 60_000;
export const INACTIVE_PAUSE_MS = 60 * 60_000;
const TRIP_SEQ_KEEP = 50;
/** Keep stored events small (SecureStore values should stay well under 2 KB). */
export const NOTE_MAX = 280;

export type PauseReason = 'AUTH' | 'INACTIVE' | null;

export interface QueueSnapshot {
  userId: string | null;
  events: readonly QueuedEvent[];
  pending: number;
  rejected: number;
  /** Received by the server after the trip closed: stored, no effect. */
  late: number;
  syncing: boolean;
  paused: PauseReason;
  /** Earliest time of the next automatic attempt (backoff / pause), or null = now. */
  nextAttemptAt: number | null;
  /** Last time the server confirmed an event. */
  lastConfirmedAt: number | null;
  syncRequired: boolean;
}

interface Meta {
  v: 1;
  nextLocalId: number;
  ids: number[];
  tripSeq: Record<string, { n: number; at: number }>;
}

/** UUIDv7: 48-bit Unix ms + version + random (RFC 9562). Uniqueness is what matters, not secrecy. */
export function uuidv7(nowMs: number, random: (n: number) => Uint8Array = defaultRandom): string {
  const b = random(16);
  let ts = Math.max(0, Math.floor(nowMs));
  for (let i = 5; i >= 0; i--) {
    b[i] = ts % 256;
    ts = Math.floor(ts / 256);
  }
  b[6] = 0x70 | (b[6] & 0x0f);
  b[8] = 0x80 | (b[8] & 0x3f);
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function defaultRandom(n: number): Uint8Array {
  const out = new Uint8Array(n);
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (c?.getRandomValues) return c.getRandomValues(out);
  for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256);
  return out;
}

export function assertQueueable(type: string): void {
  if (ONLINE_ONLY.includes(type)) throw new Error(`${type} is online only and is never queued`);
}

export function backoffMs(failures: number): number {
  if (failures <= 0) return 0;
  return Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** (failures - 1));
}

export interface EventQueueOptions {
  store: KeyValueStore;
  now?: () => number;
  random?: (n: number) => Uint8Array;
}

export class EventQueue {
  private readonly store: KeyValueStore;
  private readonly now: () => number;
  private readonly random: (n: number) => Uint8Array;
  private userId: string | null = null;
  private meta: Meta = { v: 1, nextLocalId: 1, ids: [], tripSeq: {} };
  private events = new Map<number, QueuedEvent>();
  private listeners = new Set<() => void>();
  private syncing = false;
  private failures = 0;
  private paused: PauseReason = null;
  private nextAttemptAt: number | null = null;
  private lastConfirmedAt: number | null = null;
  private clockOffsetMs = 0;
  private snap: QueueSnapshot;
  /** Serialises store writes so meta and event rows never interleave. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(opts: EventQueueOptions) {
    this.store = opts.store;
    this.now = opts.now ?? Date.now;
    this.random = opts.random ?? defaultRandom;
    this.snap = this.buildSnapshot();
  }

  private prefix(): string {
    if (!this.userId) throw new Error('Event queue not loaded');
    return `vt.dq.${this.userId}`;
  }
  private metaKey() {
    return `${this.prefix()}.meta`;
  }
  private eventKey(localId: number) {
    return `${this.prefix()}.e.${localId}`;
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** Loads the queue of `userId` (call after sign-in; again after a user switch). */
  async load(userId: string): Promise<void> {
    if (!/^[A-Za-z0-9_-]+$/.test(userId)) throw new Error('Invalid user id for the event queue');
    await this.serial(async () => {
      this.userId = userId;
      this.events.clear();
      this.failures = 0;
      this.paused = null;
      this.nextAttemptAt = null;
      const raw = await this.store.get(this.metaKey());
      this.meta = raw ? (JSON.parse(raw) as Meta) : { v: 1, nextLocalId: 1, ids: [], tripSeq: {} };
      const kept: number[] = [];
      for (const id of this.meta.ids) {
        const row = await this.store.get(this.eventKey(id));
        if (!row) continue; // index pointing at a row that was never written: nothing to send
        this.events.set(id, JSON.parse(row) as QueuedEvent);
        kept.push(id);
      }
      this.meta.ids = kept;
    });
    this.emit();
  }

  /** Forget the in-memory state (sign-out). Stored events stay on the phone for the same user's next sign-in. */
  unload(): void {
    this.userId = null;
    this.events.clear();
    this.meta = { v: 1, nextLocalId: 1, ids: [], tripSeq: {} };
    this.paused = null;
    this.failures = 0;
    this.nextAttemptAt = null;
    this.emit();
  }

  get loadedUser(): string | null {
    return this.userId;
  }

  /** Stores the event (durably) and returns it as PENDING. Throws when it cannot be stored. */
  async enqueue(input: QueuedEventInput): Promise<QueuedEvent> {
    assertQueueable(input.type);
    const ev = await this.serial(async () => {
      const now = this.now();
      const localId = this.meta.nextLocalId;
      const prev = this.meta.tripSeq[input.tripId]?.n ?? 0;
      const event: QueuedEvent = {
        ...input,
        note: input.note ? input.note.slice(0, NOTE_MAX) : undefined,
        clientEventId: uuidv7(now, this.random),
        seq: prev + 1,
        localId,
        occurredAt: new Date(now).toISOString(),
        state: 'PENDING',
        attempts: 0,
        code: null,
        rejectedAt: null,
      };
      // Row first, then the index: a crash in between leaves an unindexed row, never an index entry without a row.
      await this.store.set(this.eventKey(localId), JSON.stringify(event));
      const tripSeq = { ...this.meta.tripSeq, [input.tripId]: { n: prev + 1, at: now } };
      const keep = Object.entries(tripSeq)
        .sort((a, b) => b[1].at - a[1].at)
        .slice(0, TRIP_SEQ_KEEP);
      const meta: Meta = { v: 1, nextLocalId: localId + 1, ids: [...this.meta.ids, localId], tripSeq: Object.fromEntries(keep) };
      await this.store.set(this.metaKey(), JSON.stringify(meta));
      this.meta = meta;
      this.events.set(localId, event);
      return event;
    });
    this.emit();
    return ev;
  }

  /**
   * Raises the trip's seq counter to at least `n` (the server's `lastSeq` for this trip, e.g. after a reinstall or a
   * second phone), so new events never reuse a lower seq than the server has stored.
   */
  async ensureSeqAtLeast(tripId: string, n: number | null | undefined): Promise<void> {
    if (!this.userId || !n || (this.meta.tripSeq[tripId]?.n ?? 0) >= n) return;
    await this.serial(async () => {
      const meta: Meta = { ...this.meta, tripSeq: { ...this.meta.tripSeq, [tripId]: { n, at: this.now() } } };
      await this.store.set(this.metaKey(), JSON.stringify(meta));
      this.meta = meta;
    });
  }

  /** Removes a REJECTED event after the driver has seen it. Pending events cannot be removed. */
  async dismiss(clientEventId: string): Promise<boolean> {
    const ev = [...this.events.values()].find((e) => e.clientEventId === clientEventId);
    if (!ev || ev.state === 'PENDING') return false;
    await this.serial(() => this.remove([ev.localId]));
    this.emit();
    return true;
  }

  private async remove(localIds: number[]): Promise<void> {
    if (!localIds.length) return;
    const drop = new Set(localIds);
    const meta: Meta = { ...this.meta, ids: this.meta.ids.filter((id) => !drop.has(id)) };
    // Index first: a crash leaves an orphan row (ignored at load), never an indexed event that was already confirmed
    // missing its row.
    await this.store.set(this.metaKey(), JSON.stringify(meta));
    this.meta = meta;
    for (const id of localIds) {
      this.events.delete(id);
      await this.store.delete(this.eventKey(id)).catch(() => undefined);
    }
  }

  private async update(ev: QueuedEvent): Promise<void> {
    await this.store.set(this.eventKey(ev.localId), JSON.stringify(ev));
    this.events.set(ev.localId, ev);
  }

  /** Clears the auth pause (after the same user signed in again) and allows an immediate attempt. */
  resume(): void {
    this.paused = null;
    this.nextAttemptAt = null;
    this.emit();
  }

  /** Whether an automatic attempt is due now. */
  due(): boolean {
    if (!this.userId || this.syncing || this.paused === 'AUTH') return false;
    if (!this.pendingEvents().length) return false;
    return this.nextAttemptAt === null || this.now() >= this.nextAttemptAt;
  }

  private pendingEvents(): QueuedEvent[] {
    return [...this.events.values()].filter((e) => e.state === 'PENDING').sort((a, b) => a.localId - b.localId);
  }

  /**
   * Sends pending events, trip by trip in order of each trip's oldest event, oldest first, ≤ 50 per request. Stops at
   * the first retryable failure so later events never overtake earlier ones. `force` ignores backoff (Sync now).
   */
  async drain(transport: QueueTransport, force = false): Promise<void> {
    if (!this.userId || this.syncing) return;
    if (this.paused === 'AUTH') return;
    if (!force && this.nextAttemptAt !== null && this.now() < this.nextAttemptAt) return;
    this.syncing = true;
    this.emit();
    try {
      for (;;) {
        const pending = this.pendingEvents();
        if (!pending.length) break;
        const tripId = pending[0].tripId;
        const batch = pending.filter((e) => e.tripId === tripId).slice(0, BATCH_MAX);
        const stop = await this.sendBatch(transport, tripId, batch);
        if (stop) break;
      }
    } finally {
      this.syncing = false;
      this.emit();
    }
  }

  /** Returns true when draining must stop (retryable failure or pause). */
  private async sendBatch(transport: QueueTransport, tripId: string, batch: QueuedEvent[]): Promise<boolean> {
    let outcomes: EventOutcome[];
    try {
      outcomes = await transport.send(tripId, batch, this.clockOffsetMs);
    } catch (err) {
      const e = err instanceof QueueSendError ? err : new QueueSendError('network');
      await this.serial(async () => {
        for (const ev of batch) await this.update({ ...ev, attempts: ev.attempts + 1, ...(e.kind === 'rejected' ? { state: 'REJECTED' as const, code: e.code ?? 'REJECTED', rejectedAt: new Date(this.now()).toISOString() } : {}) });
      });
      if (e.kind === 'rejected') return false; // terminal for this trip's batch; carry on with other trips
      if (e.kind === 'auth') {
        this.paused = 'AUTH';
        this.nextAttemptAt = null;
      } else if (e.kind === 'inactive') {
        this.paused = 'INACTIVE';
        this.nextAttemptAt = this.now() + INACTIVE_PAUSE_MS;
      } else {
        this.failures += 1;
        this.nextAttemptAt = this.now() + backoffMs(this.failures);
      }
      return true;
    }

    const byId = new Map(outcomes.map((o) => [o.clientEventId, o]));
    const confirmed: number[] = [];
    let retry = false;
    await this.serial(async () => {
      for (const ev of batch) {
        const o = byId.get(ev.clientEventId);
        if (o?.serverTime) {
          const t = Date.parse(o.serverTime);
          if (Number.isFinite(t)) this.clockOffsetMs = t - this.now();
        }
        if (!o || o.outcome === 'RETRY' || retry) {
          // No answer for it, a retryable answer, or behind one: stays pending, in order.
          retry = true;
          await this.update({ ...ev, attempts: ev.attempts + 1, code: o?.code ?? ev.code });
        } else if (o.outcome === 'ACCEPTED' || o.outcome === 'DUPLICATE') {
          confirmed.push(ev.localId);
        } else if (o.outcome === 'LATE') {
          await this.update({ ...ev, attempts: ev.attempts + 1, state: 'LATE', code: o.code ?? 'LATE', rejectedAt: null });
        } else {
          await this.update({ ...ev, attempts: ev.attempts + 1, state: 'REJECTED', code: o.code ?? o.outcome, rejectedAt: new Date(this.now()).toISOString() });
        }
      }
      await this.remove(confirmed);
    });
    if (confirmed.length) this.lastConfirmedAt = this.now();
    this.paused = null;
    if (retry) {
      this.failures += 1;
      this.nextAttemptAt = this.now() + backoffMs(this.failures);
      return true;
    }
    this.failures = 0;
    this.nextAttemptAt = null;
    return false;
  }

  /** Events of one trip (local projection for the trip screen), oldest first. */
  forTrip(tripId: string): QueuedEvent[] {
    return [...this.events.values()].filter((e) => e.tripId === tripId).sort((a, b) => a.localId - b.localId);
  }

  subscribe(l: () => void): () => void {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  }

  /** Stable snapshot for useSyncExternalStore. */
  snapshot(): QueueSnapshot {
    return this.snap;
  }

  private buildSnapshot(): QueueSnapshot {
    const events = [...this.events.values()].sort((a, b) => a.localId - b.localId);
    const pending = events.filter((e) => e.state === 'PENDING').length;
    return {
      userId: this.userId,
      events,
      pending,
      rejected: events.filter((e) => e.state === 'REJECTED').length,
      late: events.filter((e) => e.state === 'LATE').length,
      syncing: this.syncing,
      paused: this.paused,
      nextAttemptAt: this.nextAttemptAt,
      lastConfirmedAt: this.lastConfirmedAt,
      syncRequired: pending >= SOFT_LIMIT,
    };
  }

  private emit() {
    this.snap = this.buildSnapshot();
    this.listeners.forEach((l) => l());
  }
}

/**
 * Display state of an action in the trip screen (doc 09 §6.5): a local event is never shown as confirmed. The server's
 * trip state is the only source of "Confirmed".
 */
export type ActionDisplay = 'CONFIRMED' | 'PENDING' | 'REJECTED' | 'LATE' | 'NONE';

export function actionDisplay(serverConfirmed: boolean, local: readonly Pick<QueuedEvent, 'state'>[]): ActionDisplay {
  if (serverConfirmed) return 'CONFIRMED';
  const last = local[local.length - 1];
  if (!last) return 'NONE';
  return last.state;
}

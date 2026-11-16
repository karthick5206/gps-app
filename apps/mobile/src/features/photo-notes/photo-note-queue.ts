/**
 * Offline queue of location photo notes ("Add photo here", contract packages/shared/src/photo-notes.ts). Pure
 * TypeScript: storage, network and clock are injected, so the retry / back-off rules are tested with `node --test`
 * (photo-note-queue.test.ts). The app wires it to expo-file-system and POST /photo-notes in photo-note-store.ts.
 * The Tracker app keeps a copy of this file (apps/tracker/src/lib/photo-note-queue.ts); keep the two in step.
 *
 * Rules:
 * - A note is written to the store (its photos already copied into the app's own folder) BEFORE the first send, so it
 *   survives a restart. Its clientId (UUID) is the server's idempotency key: a resend after a lost answer returns the
 *   note already saved, so retries are safe.
 * - Retry with back-off (PHOTO_NOTE_RETRY_BACKOFF_MS) on no answer (network / timeout), 401 (after the session
 *   refresh), 408, 429 and 5xx. Any other 4xx marks the note FAILED: kept and shown with its error until the person
 *   taps "Try again" or deletes it. Nothing is dropped silently.
 * - A delivered note leaves the queue and its photo files are deleted.
 * - Never logs coordinates or file paths.
 */

/** Back-off between automatic attempts: 5 s, 15 s, 30 s, 1 min, 2 min, 5 min, then every 10 min. */
export const PHOTO_NOTE_RETRY_BACKOFF_MS: readonly number[] = [5_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000];

export type QueuedNoteState = 'PENDING' | 'FAILED';

export interface QueuedPhoto {
  /** File name inside the note's folder (relative: the app's folder path can change between installs on iOS). */
  file: string;
  mimeType: string;
}

export interface QueuedNote {
  clientId: string;
  /** When it was queued (ms). */
  queuedAt: number;
  takenAt: string;
  lat: number;
  lng: number;
  accuracyM: number | null;
  category: string;
  note: string | null;
  amountMinor: number | null;
  currency: string | null;
  photos: QueuedPhoto[];
  state: QueuedNoteState;
  attempts: number;
  /** Earliest next automatic attempt (ms); null = now. */
  nextAttemptAt: number | null;
  /** Message of the last failure (shown for FAILED, and as a hint while retrying). */
  lastError: string | null;
}

export type NewQueuedNote = Omit<QueuedNote, 'queuedAt' | 'state' | 'attempts' | 'nextAttemptAt' | 'lastError'>;

/** Thrown by a transport: `status` undefined (or 0) = no answer (network / timeout). */
export class PhotoNoteSendError extends Error {
  readonly status: number | undefined;
  // No parameter properties: `node --test` runs this file with type stripping only.
  constructor(status: number | undefined, message?: string) {
    super(message ?? `Photo note send failed (${status ?? 'network'})`);
    this.status = status;
  }
}

export interface PhotoNoteTransport {
  send(item: QueuedNote): Promise<void>;
}

export interface PhotoNoteQueueStorage {
  /** The queue JSON written last (null = none). */
  read(): Promise<string | null>;
  write(json: string): Promise<void>;
  /** Deletes the photo files of one note. */
  removeFiles(clientId: string): Promise<void>;
  /** Deletes every queued file and the queue itself. */
  removeAll(): Promise<void>;
}

export function photoNoteRetryable(status: number | undefined): boolean {
  if (status === undefined || status === 0) return true;
  if (status === 401 || status === 408 || status === 429) return true;
  return status >= 500;
}

export function photoNoteBackoffMs(attempts: number): number {
  if (attempts <= 0) return 0;
  return PHOTO_NOTE_RETRY_BACKOFF_MS[Math.min(attempts - 1, PHOTO_NOTE_RETRY_BACKOFF_MS.length - 1)];
}

export interface PhotoNoteQueueSnapshot {
  /** Owner of the loaded queue (null = not loaded). */
  owner: string | null;
  items: readonly QueuedNote[];
  pending: number;
  failed: number;
  sending: boolean;
  /** The note being sent right now. */
  sendingId: string | null;
}

interface Stored {
  v: 1;
  owner: string;
  items: QueuedNote[];
}

export interface PhotoNoteQueueOptions {
  storage: PhotoNoteQueueStorage;
  now?: () => number;
  /** Called after a note was delivered (e.g. refresh the list). */
  onDelivered?: (clientId: string) => void;
}

const EMPTY: PhotoNoteQueueSnapshot = { owner: null, items: [], pending: 0, failed: 0, sending: false, sendingId: null };

export class PhotoNoteQueue {
  private readonly storage: PhotoNoteQueueStorage;
  private readonly now: () => number;
  private readonly onDelivered: ((clientId: string) => void) | undefined;
  private owner: string | null = null;
  private items: QueuedNote[] = [];
  private sending = false;
  private sendingId: string | null = null;
  private draining: Promise<void> | null = null;
  private snap: PhotoNoteQueueSnapshot = EMPTY;
  private listeners = new Set<() => void>();
  /** Serialises writes so an older queue never overwrites a newer one. */
  private writing: Promise<void> = Promise.resolve();

  constructor(opts: PhotoNoteQueueOptions) {
    this.storage = opts.storage;
    this.now = opts.now ?? Date.now;
    this.onDelivered = opts.onDelivered;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): PhotoNoteQueueSnapshot {
    return this.snap;
  }

  private emit() {
    this.snap = {
      owner: this.owner,
      items: [...this.items].sort((a, b) => b.queuedAt - a.queuedAt),
      pending: this.items.filter((i) => i.state === 'PENDING').length,
      failed: this.items.filter((i) => i.state === 'FAILED').length,
      sending: this.sending,
      sendingId: this.sendingId,
    };
    for (const l of this.listeners) l();
  }

  private persist(): Promise<void> {
    const owner = this.owner;
    if (!owner) return Promise.resolve();
    const json = JSON.stringify({ v: 1, owner, items: this.items } satisfies Stored);
    this.writing = this.writing.catch(() => undefined).then(() => this.storage.write(json));
    return this.writing;
  }

  /**
   * Loads the queue of `owner` (user id / tracker session). A queue left by someone else is deleted with its photos
   * (it must never be sent with another person's credentials).
   */
  async load(owner: string): Promise<void> {
    if (this.owner === owner) return;
    let stored: Stored | null = null;
    try {
      const raw = await this.storage.read();
      const parsed = raw ? (JSON.parse(raw) as Stored) : null;
      if (parsed && parsed.v === 1 && Array.isArray(parsed.items)) stored = parsed;
    } catch {
      stored = null;
    }
    if (stored && stored.owner !== owner) {
      await this.storage.removeAll().catch(() => undefined);
      stored = null;
    }
    this.owner = owner;
    this.items = stored ? stored.items.filter((i) => i && typeof i.clientId === 'string' && Array.isArray(i.photos)) : [];
    this.emit();
  }

  /** Forgets the loaded queue in memory (the rows stay on the device). */
  unload(): void {
    this.owner = null;
    this.items = [];
    this.emit();
  }

  /** Deletes every queued note and its photos (sign-out / deactivation). */
  async clear(): Promise<void> {
    this.owner = null;
    this.items = [];
    this.emit();
    await this.writing.catch(() => undefined);
    await this.storage.removeAll();
  }

  /** Stores a new note (durably) as PENDING. Throws when it could not be stored. */
  async add(input: NewQueuedNote): Promise<QueuedNote> {
    if (!this.owner) throw new Error('Photo note queue is not loaded');
    if (this.items.some((i) => i.clientId === input.clientId)) throw new Error('Duplicate clientId');
    const item: QueuedNote = { ...input, queuedAt: this.now(), state: 'PENDING', attempts: 0, nextAttemptAt: null, lastError: null };
    const before = this.items;
    this.items = [...this.items, item];
    try {
      await this.persist();
    } catch (e) {
      this.items = before;
      throw e;
    }
    this.emit();
    return item;
  }

  /** "Try again": a FAILED (or waiting) note goes back to PENDING and is due now. */
  async retry(clientId: string): Promise<void> {
    this.items = this.items.map((i) => (i.clientId === clientId ? { ...i, state: 'PENDING', nextAttemptAt: null } : i));
    this.emit();
    await this.persist().catch(() => undefined);
  }

  /** Deletes one queued note and its photos. */
  async remove(clientId: string): Promise<void> {
    if (!this.items.some((i) => i.clientId === clientId)) return;
    this.items = this.items.filter((i) => i.clientId !== clientId);
    this.emit();
    await this.persist().catch(() => undefined);
    await this.storage.removeFiles(clientId).catch(() => undefined);
  }

  private dueItems(force: boolean): QueuedNote[] {
    const now = this.now();
    return this.items.filter((i) => i.state === 'PENDING' && (force || i.nextAttemptAt === null || i.nextAttemptAt <= now));
  }

  /** A PENDING note may be sent now. */
  due(): boolean {
    return this.dueItems(false).length > 0;
  }

  /** Milliseconds until the next automatic attempt (null = nothing waiting). */
  nextDueIn(): number | null {
    const now = this.now();
    let best: number | null = null;
    for (const i of this.items) {
      if (i.state !== 'PENDING') continue;
      const wait = Math.max(0, (i.nextAttemptAt ?? now) - now);
      best = best === null ? wait : Math.min(best, wait);
    }
    return best;
  }

  /** Sends the due notes one at a time (single flight). `force` ignores the back-off. */
  drain(transport: PhotoNoteTransport, force = false): Promise<void> {
    if (this.draining) return this.draining;
    this.draining = this.run(transport, force).finally(() => {
      this.draining = null;
      this.sending = false;
      this.sendingId = null;
      this.emit();
    });
    return this.draining;
  }

  private async run(transport: PhotoNoteTransport, force: boolean): Promise<void> {
    const owner = this.owner;
    if (!owner) return;
    const queue = this.dueItems(force);
    if (!queue.length) return;
    this.sending = true;
    this.emit();
    for (const item of queue) {
      // Signed out / switched user, or the note was deleted meanwhile.
      if (this.owner !== owner) return;
      const current = this.items.find((i) => i.clientId === item.clientId);
      if (!current || current.state !== 'PENDING') continue;
      this.sendingId = current.clientId;
      this.emit();
      try {
        await transport.send(current);
        if (this.owner !== owner) return;
        this.items = this.items.filter((i) => i.clientId !== item.clientId);
        this.emit();
        await this.persist().catch(() => undefined);
        await this.storage.removeFiles(item.clientId).catch(() => undefined);
        this.onDelivered?.(item.clientId);
      } catch (e) {
        if (this.owner !== owner) return;
        const status = e instanceof PhotoNoteSendError ? e.status : undefined;
        const message = e instanceof Error ? e.message : String(e);
        const retry = photoNoteRetryable(status);
        const attempts = current.attempts + 1;
        this.items = this.items.map((i) =>
          i.clientId === item.clientId
            ? { ...i, attempts, lastError: message, state: retry ? 'PENDING' : 'FAILED', nextAttemptAt: retry ? this.now() + photoNoteBackoffMs(attempts) : null }
            : i,
        );
        this.emit();
        await this.persist().catch(() => undefined);
        // No connection: the next notes would fail the same way; they wait for the next trigger.
        if (status === undefined || status === 0) return;
      }
    }
  }
}

/** Random UUID v4 (the note's clientId). */
export function randomUuid(random: (n: number) => Uint8Array = defaultRandom): string {
  const b = random(16);
  b[6] = 0x40 | (b[6] & 0x0f);
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

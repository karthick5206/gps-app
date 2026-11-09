import { closeSync, fdatasyncSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync, ftruncateSync } from 'node:fs';
import { join } from 'node:path';

/** One spooled position: the exact stream fields the gateway would have XADDed. */
export interface SpoolRecord {
  /** Message id (dedupe key carried into the stream as field `mid`). */
  m: string;
  /** NormalizedPosition JSON (stream field `data`). */
  d: string;
  /** Device remote address (stream field `remote`). */
  r: string;
  /** Epoch ms when it was spooled. */
  t: number;
}

/** Read position inside the spool. */
export interface SpoolCursor {
  segment: number;
  offset: number;
}

export interface SpoolOptions {
  dir: string;
  /** Hard cap on unreplayed bytes on disk; appends beyond it are refused (the caller then withholds the device ACK). */
  maxBytes: number;
  /** A new segment file is started once the current one reaches this size. */
  segmentBytes?: number;
  /** fdatasync after every append batch (default true). Only tests turn it off. */
  fsync?: boolean;
}

export interface SpoolStats {
  pendingEntries: number;
  pendingBytes: number;
  segments: number;
  oldestSpooledAt: number | null;
  appended: number;
  replayed: number;
  rejected: number;
  lastError: string | null;
}

const SEGMENT_RE = /^seg-(\d{9})\.jsonl$/;
const CHECKPOINT = 'checkpoint.json';
/** Bytes read per replay step (a 500-record batch of GT06 positions is about 170 KB). */
const READ_CHUNK = 256 * 1024;
const segName = (n: number) => `seg-${String(n).padStart(9, '0')}.jsonl`;

/** Opens (creating if needed) a segment for positional reads and writes. */
function openSegment(path: string): number {
  closeSync(openSync(path, 'a'));
  return openSync(path, 'r+');
}

/**
 * Durable, bounded, append-only on-disk FIFO for positions the gateway could not hand to the cache.
 *
 * - Records are JSON lines in numbered segment files; every append batch is written with one write + fdatasync
 *   before the promise resolves (group commit), so a resolved append survives a process crash or power loss.
 * - A checkpoint file (atomic write + rename) records how far replay has got; fully replayed segments are deleted.
 * - A torn last line (crash in the middle of a write) is cut off on open; that record was never acknowledged.
 * - Synchronous fs calls are deliberate: they keep the file state trivially consistent, and appends only happen while
 *   the cache is unavailable (an fdatasync on an SSD costs well under a few ms, batched over every pending append).
 */
export class PositionSpool {
  private readonly segmentBytes: number;
  private readonly fsync: boolean;
  /** Segment numbers present on disk, ascending. The last one is the one being appended to. */
  private segments: number[] = [];
  /** Durable size of each segment (bytes fully written and synced). */
  private readonly sizes = new Map<number, number>();
  private cursor: SpoolCursor = { segment: 1, offset: 0 };
  private fd: number | null = null;
  private queue: { lines: string; count: number; bytes: number; oldest: number; resolve: (ok: boolean) => void }[] = [];
  private flushScheduled = false;
  private stats: SpoolStats = { pendingEntries: 0, pendingBytes: 0, segments: 0, oldestSpooledAt: null, appended: 0, replayed: 0, rejected: 0, lastError: null };

  constructor(private readonly options: SpoolOptions) {
    this.segmentBytes = options.segmentBytes ?? 16 * 1024 * 1024;
    this.fsync = options.fsync ?? true;
    this.open();
  }

  /** Entries written to disk and not yet replayed (plus those waiting for the current group commit). */
  get pending(): number {
    return this.stats.pendingEntries + this.queue.reduce((s, q) => s + q.count, 0);
  }

  snapshot(): SpoolStats {
    return { ...this.stats, segments: this.segments.length };
  }

  /**
   * Appends records durably. Resolves true once they are on disk (fdatasync), false when the spool is full or the
   * disk write failed — never rejects.
   */
  append(records: SpoolRecord[]): Promise<boolean> {
    if (!records.length) return Promise.resolve(true);
    const lines = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
    const bytes = Buffer.byteLength(lines);
    const queuedBytes = this.queue.reduce((s, q) => s + q.bytes, 0);
    if (this.stats.pendingBytes + queuedBytes + bytes > this.options.maxBytes) {
      this.stats.rejected += records.length;
      this.stats.lastError = `spool full (${this.options.maxBytes} bytes)`;
      return Promise.resolve(false);
    }
    return new Promise((resolve) => {
      this.queue.push({ lines, count: records.length, bytes, oldest: records[0].t, resolve });
      if (!this.flushScheduled) {
        this.flushScheduled = true;
        // Group commit: everything appended in this tick shares one write + fdatasync.
        setImmediate(() => this.flush());
      }
    });
  }

  /** Up to `max` records from the replay cursor, with the cursor to commit once they are safely in the stream. */
  read(max: number): { records: SpoolRecord[]; next: SpoolCursor; lines: number } {
    const records: SpoolRecord[] = [];
    let lines = 0;
    let { segment, offset } = this.cursor;
    let chunk = READ_CHUNK;
    while (lines < max) {
      const size = this.sizes.get(segment) ?? 0;
      if (offset >= size) {
        const i = this.segments.indexOf(segment);
        if (i < 0 || i === this.segments.length - 1) break; // caught up with the segment being written
        segment = this.segments[i + 1];
        offset = 0;
        continue;
      }
      const length = Math.min(chunk, size - offset);
      const buf = Buffer.alloc(length);
      const fd = openSync(join(this.options.dir, segName(segment)), 'r');
      try {
        readSync(fd, buf, 0, length, offset);
      } finally {
        closeSync(fd);
      }
      let start = 0;
      for (let nl = buf.indexOf(0x0a, start); nl >= 0 && lines < max; nl = buf.indexOf(0x0a, start)) {
        const line = buf.subarray(start, nl).toString('utf8');
        start = nl + 1;
        lines++;
        try {
          const r = JSON.parse(line) as SpoolRecord;
          if (typeof r.d === 'string' && typeof r.m === 'string') records.push(r);
          else throw new Error('not a spool record');
        } catch {
          // A corrupt line (disk error) is skipped rather than blocking replay forever; it is counted as rejected.
          this.stats.rejected++;
          this.stats.lastError = 'corrupt spool line skipped';
        }
      }
      if (start === 0) {
        // No complete line in the chunk: a record larger than the chunk. Read a bigger piece (durable data always
        // ends with a newline, so this terminates).
        chunk *= 4;
        continue;
      }
      chunk = READ_CHUNK;
      offset += start;
    }
    return { records, next: { segment, offset }, lines };
  }

  /** Marks everything before `next` as replayed (`count` records) and deletes fully consumed segments. */
  commit(next: SpoolCursor, count: number): void {
    const before = this.cursor;
    this.cursor = next;
    this.writeCheckpoint();
    let freed = 0;
    for (const seg of [...this.segments]) {
      if (seg >= next.segment) break;
      freed += (this.sizes.get(seg) ?? 0) - (seg === before.segment ? before.offset : 0);
      this.removeSegment(seg);
    }
    freed += next.offset - (next.segment === before.segment ? before.offset : 0);
    this.stats.pendingBytes = Math.max(0, this.stats.pendingBytes - freed);
    this.stats.pendingEntries = Math.max(0, this.stats.pendingEntries - count);
    this.stats.replayed += count;
    if (this.stats.pendingEntries === 0) {
      this.stats.oldestSpooledAt = null;
      this.stats.pendingBytes = 0;
    } else {
      const peek = this.read(1).records[0];
      this.stats.oldestSpooledAt = peek?.t ?? null;
    }
  }

  close(): void {
    this.flushSync();
    if (this.fd !== null) closeSync(this.fd);
    this.fd = null;
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private open(): void {
    mkdirSync(this.options.dir, { recursive: true });
    this.segments = readdirSync(this.options.dir)
      .map((f) => SEGMENT_RE.exec(f))
      .filter((m): m is RegExpExecArray => !!m)
      .map((m) => Number(m[1]))
      .sort((a, b) => a - b);
    for (const seg of this.segments) this.sizes.set(seg, statSync(join(this.options.dir, segName(seg))).size);
    try {
      const cp = JSON.parse(readFileSync(join(this.options.dir, CHECKPOINT), 'utf8')) as SpoolCursor;
      if (Number.isInteger(cp.segment) && Number.isInteger(cp.offset)) this.cursor = cp;
    } catch {
      this.cursor = { segment: this.segments[0] ?? 1, offset: 0 };
    }
    // Segments older than the checkpoint were replayed but not deleted (crash between commit and unlink).
    for (const seg of [...this.segments]) if (seg < this.cursor.segment) this.removeSegment(seg);
    if (!this.segments.length) this.segments = [this.cursor.segment];
    if (!this.segments.includes(this.cursor.segment)) this.cursor = { segment: this.segments[0], offset: 0 };
    const last = this.segments[this.segments.length - 1];
    this.fd = openSegment(join(this.options.dir, segName(last)));
    this.truncateTornTail(last);
    // Count what is still to be replayed.
    let entries = 0;
    let bytes = 0;
    let oldest: number | null = null;
    let { segment, offset } = this.cursor;
    for (;;) {
      const batch = this.readRange(segment, offset);
      entries += batch.lines;
      bytes += batch.bytes;
      oldest ??= batch.oldest;
      const i = this.segments.indexOf(segment);
      if (i < 0 || i === this.segments.length - 1) break;
      segment = this.segments[i + 1];
      offset = 0;
    }
    this.stats.pendingEntries = entries;
    this.stats.pendingBytes = bytes;
    this.stats.oldestSpooledAt = oldest;
  }

  /** Counts complete lines of one segment from `offset` (used once on open). */
  private readRange(segment: number, offset: number): { lines: number; bytes: number; oldest: number | null } {
    const size = this.sizes.get(segment) ?? 0;
    if (offset >= size) return { lines: 0, bytes: 0, oldest: null };
    const buf = readFileSync(join(this.options.dir, segName(segment))).subarray(offset, size);
    let lines = 0;
    for (let i = buf.indexOf(0x0a); i >= 0; i = buf.indexOf(0x0a, i + 1)) lines++;
    let oldest: number | null = null;
    const nl = buf.indexOf(0x0a);
    if (nl > 0) {
      try {
        oldest = (JSON.parse(buf.subarray(0, nl).toString('utf8')) as SpoolRecord).t ?? null;
      } catch {
        oldest = null;
      }
    }
    return { lines, bytes: buf.length, oldest };
  }

  private truncateTornTail(segment: number): void {
    const size = this.sizes.get(segment) ?? 0;
    if (!size) return;
    const tailLen = Math.min(size, 64 * 1024);
    const buf = Buffer.alloc(tailLen);
    readSync(this.fd!, buf, 0, tailLen, size - tailLen);
    if (buf[tailLen - 1] === 0x0a) return;
    const nl = buf.lastIndexOf(0x0a);
    const keep = nl >= 0 ? size - tailLen + nl + 1 : tailLen === size ? 0 : size - tailLen;
    ftruncateSync(this.fd!, keep);
    this.sizes.set(segment, keep);
    this.stats.lastError = `torn spool tail truncated (${size - keep} bytes)`;
  }

  private flush(): void {
    this.flushScheduled = false;
    this.flushSync();
  }

  private flushSync(): void {
    const batch = this.queue;
    if (!batch.length) return;
    this.queue = [];
    const data = Buffer.from(batch.map((q) => q.lines).join(''));
    const count = batch.reduce((s, q) => s + q.count, 0);
    try {
      let seg = this.segments[this.segments.length - 1];
      if ((this.sizes.get(seg) ?? 0) >= this.segmentBytes) seg = this.rotate();
      // Positional writes at the durable end (not O_APPEND): Windows refuses ftruncate on append-only handles, and the
      // torn-tail / failed-write clean-up needs it.
      const base = this.sizes.get(seg) ?? 0;
      let written = 0;
      while (written < data.length) written += writeSync(this.fd!, data, written, data.length - written, base + written);
      if (this.fsync) fdatasyncSync(this.fd!);
      this.sizes.set(seg, (this.sizes.get(seg) ?? 0) + data.length);
      this.stats.pendingEntries += count;
      this.stats.pendingBytes += data.length;
      this.stats.appended += count;
      this.stats.oldestSpooledAt ??= batch[0].oldest;
      for (const q of batch) q.resolve(true);
    } catch (error) {
      this.stats.rejected += count;
      this.stats.lastError = `spool write failed: ${(error as Error).message}`;
      // Whatever part of the write landed is cut off so the file never holds records nobody was told about.
      try {
        const seg = this.segments[this.segments.length - 1];
        ftruncateSync(this.fd!, this.sizes.get(seg) ?? 0);
      } catch {
        // nothing more we can do; the torn-tail check on the next open handles a partial line
      }
      for (const q of batch) q.resolve(false);
    }
  }

  private rotate(): number {
    const next = this.segments[this.segments.length - 1] + 1;
    if (this.fd !== null) {
      if (this.fsync) fsyncSync(this.fd);
      closeSync(this.fd);
    }
    this.fd = openSegment(join(this.options.dir, segName(next)));
    this.segments.push(next);
    this.sizes.set(next, 0);
    return next;
  }

  private removeSegment(seg: number): void {
    const isCurrent = seg === this.segments[this.segments.length - 1];
    if (isCurrent) return; // never delete the file being appended to
    try {
      unlinkSync(join(this.options.dir, segName(seg)));
    } catch (error) {
      this.stats.lastError = `could not delete ${segName(seg)}: ${(error as Error).message}`;
    }
    this.segments = this.segments.filter((s) => s !== seg);
    this.sizes.delete(seg);
  }

  private writeCheckpoint(): void {
    const path = join(this.options.dir, CHECKPOINT);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.cursor));
    if (this.fsync) {
      const fd = openSync(tmp, 'r+');
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
    renameSync(tmp, path);
  }
}

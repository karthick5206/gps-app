import { Logger } from '@nestjs/common';
import { NormalizedPosition, SpoolMetrics } from '@veetracer/shared';
import type Redis from 'ioredis';
import { randomBytes } from 'node:crypto';
import { positionsStreamMaxLen, RedisKeys } from '../../redis/keys';
import { PositionSpool, SpoolRecord } from './position-spool';

/** An XADD that hasn't completed after this long counts as failed. */
export const ENQUEUE_TIMEOUT_MS = 10_000;
const REPLAY_BATCH = 500;
const BACKOFF_MIN_MS = 500;
const BACKOFF_MAX_MS = 30_000;
const BACKLOG_CHECK_MS = 5000;

export interface PublisherOptions {
  /** Replay rate cap (entries/s), so a long outage doesn't flood the processor in one burst. */
  replayPerSec?: number;
  /** Spool new positions instead of XADDing while the processor backlog exceeds this fraction of the stream cap. */
  backpressureHigh?: number;
  /** ...and resume direct XADDs once it is back below this fraction. */
  backpressureLow?: number;
  /** XADD timeout. */
  timeoutMs?: number;
  /** Tests: no timers. */
  autoReplay?: boolean;
}

export const backoffMs = (failures: number): number => (failures <= 0 ? 0 : Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** (failures - 1)));

/**
 * Hands decoded positions to the `vt:positions` stream, with a durable local spool behind it.
 *
 *  direct:   spool empty and cache ready → XADD (as before). If the XADD fails or times out the same positions are
 *            appended to the spool instead, and the publisher switches to spooling.
 *  spooling: every new position goes to the spool (so per-device order is kept: nothing overtakes spooled data).
 *  draining: the cache is back; the spool is replayed oldest-first at a capped rate. When it is empty the publisher
 *            goes back to direct.
 *
 * `publish` resolves true when the positions are either in the stream or fsynced in the spool — that is when the
 * device may be acknowledged. It resolves false only when both failed (spool full / disk error and cache down); the
 * gateway then withholds the ACK exactly as it did before the spool existed.
 *
 * Every entry carries a `mid` (message id) so the processor can drop an entry that reached the stream twice (an XADD
 * that timed out but was applied, then replayed from the spool).
 *
 * Without a spool (tests, GATEWAY_SPOOL=off) it behaves exactly like the previous gateway: XADD or withhold the ACK.
 */
export class PositionPublisher {
  private readonly logger = new Logger('Gateway:spool');
  private readonly bootId = randomBytes(4).toString('hex');
  private seq = 0;
  /** Set after a failed XADD: new positions go to the spool until it has been drained. */
  private spooling = false;
  private backpressure = false;
  private inflightAppends = 0;
  private replayTimer: NodeJS.Timeout | null = null;
  private backlogTimer: NodeJS.Timeout | null = null;
  private replaying = false;
  private failures = 0;
  private stopped = false;
  private readonly opts: Required<PublisherOptions>;
  readonly counters = { directOk: 0, directFailed: 0, spooled: 0, replayed: 0, notAcked: 0 };
  private lastError: string | null = null;
  private lastErrorAt: number | null = null;

  constructor(
    private readonly redis: Redis,
    private readonly spool: PositionSpool | null,
    options: PublisherOptions = {},
  ) {
    this.opts = {
      replayPerSec: options.replayPerSec ?? 2000,
      backpressureHigh: options.backpressureHigh ?? 0.8,
      backpressureLow: options.backpressureLow ?? 0.6,
      timeoutMs: options.timeoutMs ?? ENQUEUE_TIMEOUT_MS,
      autoReplay: options.autoReplay ?? true,
    };
    if (spool && this.opts.autoReplay) {
      this.scheduleReplay(0);
      this.backlogTimer = setInterval(() => void this.checkBacklog(), BACKLOG_CHECK_MS);
      this.backlogTimer.unref();
    }
    if (spool && spool.pending > 0) {
      this.spooling = true;
      this.logger.warn(`${spool.pending} spooled position(s) from before the restart will be replayed`);
    }
  }

  get mode(): SpoolMetrics['mode'] {
    if (!this.spool) return 'disabled';
    if (!this.spooling && !this.backpressure && this.spool.pending === 0) return 'direct';
    return this.cacheReady && !this.backpressure ? 'draining' : 'spooling';
  }

  private get cacheReady(): boolean {
    return this.redis.status === 'ready';
  }

  metrics(): SpoolMetrics {
    const s = this.spool?.snapshot();
    return {
      enabled: !!this.spool,
      mode: this.mode,
      cacheReady: this.cacheReady,
      backpressure: this.backpressure,
      pendingEntries: this.spool?.pending ?? 0,
      pendingBytes: s?.pendingBytes ?? 0,
      oldestSpooledAt: s?.oldestSpooledAt ? new Date(s.oldestSpooledAt).toISOString() : null,
      spooled: this.counters.spooled,
      replayed: this.counters.replayed,
      rejected: s?.rejected ?? 0,
      directFailed: this.counters.directFailed,
      notAcked: this.counters.notAcked,
      lastError: this.lastError ?? s?.lastError ?? null,
      lastErrorAt: this.lastErrorAt ? new Date(this.lastErrorAt).toISOString() : null,
    };
  }

  /** Resolves true when the positions are durable (stream or spool); never rejects. */
  async publish(positions: NormalizedPosition[], remote: string): Promise<boolean> {
    const records: SpoolRecord[] = positions.map((p) => ({ m: this.nextMid(), d: JSON.stringify(p), r: remote, t: Date.now() }));
    if (!this.spool) return this.xadd(records).then((n) => n === records.length).catch((e: Error) => this.fail(e, records.length, true));

    const direct = !this.spooling && !this.backpressure && this.spool.pending === 0 && this.inflightAppends === 0 && this.cacheReady;
    if (direct) {
      try {
        const added = await this.xadd(records);
        if (added === records.length) {
          this.counters.directOk += records.length;
          return true;
        }
        // Partial pipeline failure: spool only the entries that did not make it (order inside the frame is kept).
        records.splice(0, added);
        throw new Error('XADD failed for part of the batch');
      } catch (error) {
        this.counters.directFailed += records.length;
        this.noteError(`XADD failed, spooling ${records.length} position(s): ${(error as Error).message}`);
        this.spooling = true;
      }
    }
    return this.toSpool(records);
  }

  private async toSpool(records: SpoolRecord[]): Promise<boolean> {
    this.inflightAppends++;
    try {
      if (await this.spool!.append(records)) {
        if (!this.spooling && !this.backpressure) this.spooling = true;
        this.counters.spooled += records.length;
        this.scheduleReplay(0);
        return true;
      }
    } finally {
      this.inflightAppends--;
    }
    // Spool full or disk error: a direct XADD is still better than nothing when the cache is up.
    if (this.cacheReady) {
      try {
        if ((await this.xadd(records)) === records.length) {
          this.counters.directOk += records.length;
          return true;
        }
      } catch {
        // fall through
      }
    }
    return this.fail(new Error(this.spool!.snapshot().lastError ?? 'spool append failed'), records.length, false);
  }

  private fail(error: Error, count: number, legacy: boolean): false {
    this.counters.notAcked += count;
    this.noteError(
      legacy
        ? `XADD failed (${count} position(s) not acknowledged to the device): ${error.message}`
        : `Spool and cache both unavailable: ${count} position(s) not acknowledged to the device (${error.message})`,
    );
    return false;
  }

  private noteError(message: string): void {
    const now = Date.now();
    // Rate-limited: one line per 10 s is enough during an outage.
    if (!this.lastErrorAt || now - this.lastErrorAt > 10_000) this.logger.warn(message);
    this.lastError = message;
    this.lastErrorAt = now;
  }

  private nextMid(): string {
    this.seq = (this.seq + 1) % Number.MAX_SAFE_INTEGER;
    return `${this.bootId}-${this.seq.toString(36)}`;
  }

  /** XADDs in order; resolves with how many leading entries were added (rejects on timeout / connection error). */
  private async xadd(records: SpoolRecord[]): Promise<number> {
    const pipeline = this.redis.pipeline();
    const maxLen = positionsStreamMaxLen();
    for (const r of records) pipeline.xadd(RedisKeys.positionsStream, 'MAXLEN', '~', maxLen, '*', 'data', r.d, 'remote', r.r, 'mid', r.m);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${this.opts.timeoutMs} ms`)), this.opts.timeoutMs);
      timer.unref();
    });
    const exec = pipeline.exec();
    exec.catch(() => undefined);
    try {
      const results = (await Promise.race([exec, timeout])) ?? [];
      const firstFailed = results.findIndex(([error]) => error);
      if (firstFailed === 0) throw results[0][0] as Error;
      return firstFailed < 0 ? records.length : firstFailed;
    } finally {
      clearTimeout(timer);
    }
  }

  // ── replay ─────────────────────────────────────────────────────────────────

  private scheduleReplay(delayMs: number): void {
    if (!this.spool || !this.opts.autoReplay || this.stopped || this.replayTimer || this.replaying) return;
    this.replayTimer = setTimeout(() => {
      this.replayTimer = null;
      void this.replayOnce().then((next) => {
        if (next !== null) this.scheduleReplay(next);
      });
    }, delayMs);
    this.replayTimer.unref();
  }

  /**
   * Replays one batch. Returns the delay before the next attempt, or null when there is nothing to do (an append
   * schedules the next run). Public for tests.
   */
  async replayOnce(): Promise<number | null> {
    if (!this.spool || this.replaying) return null;
    this.replaying = true;
    try {
      if (this.spool.pending === 0) {
        if (this.inflightAppends === 0 && this.spooling) {
          this.spooling = false;
          this.logger.log('Spool drained; positions go straight to the stream again');
        }
        return this.spooling ? 200 : null;
      }
      if (!this.cacheReady || this.backpressure) return 1000;
      const { records, next, lines } = this.spool.read(REPLAY_BATCH);
      if (!lines) return 200; // only an append still being flushed
      if (!records.length) {
        // Only corrupt lines (counted as rejected by the spool): step over them.
        this.spool.commit(next, lines);
        return 0;
      }
      let added = 0;
      try {
        added = await this.xadd(records);
      } catch (error) {
        this.failures++;
        this.noteError(`Spool replay failed (retrying in ${backoffMs(this.failures)} ms): ${(error as Error).message}`);
        return backoffMs(this.failures);
      }
      if (added < records.length) {
        // Commit only what made it; the rest is retried (the processor drops duplicates by mid).
        if (added) {
          // Lines up to and including the last record that made it (corrupt lines in between count as lines).
          let partial = this.spool.read(added);
          for (let n = added + 1; partial.records.length < added && n <= lines; n++) partial = this.spool.read(n);
          this.spool.commit(partial.next, partial.lines);
        }
        this.counters.replayed += added;
        this.failures++;
        return backoffMs(this.failures);
      }
      this.spool.commit(next, lines);
      this.counters.replayed += records.length;
      if (this.failures) this.logger.log(`Spool replay resumed after ${this.failures} failed attempt(s)`);
      this.failures = 0;
      if (this.spool.pending === 0) this.logger.log(`Spool replay caught up (${this.counters.replayed} replayed since start)`);
      return Math.ceil((records.length * 1000) / this.opts.replayPerSec);
    } catch (error) {
      this.noteError(`Spool replay error: ${(error as Error).message}`);
      return 5000;
    } finally {
      this.replaying = false;
    }
  }

  /**
   * Backpressure: when the processor is far behind, new positions wait in the spool instead of growing the stream to
   * its MAXLEN, where XADD would trim (silently drop) the oldest unprocessed entries.
   */
  async checkBacklog(): Promise<void> {
    if (!this.cacheReady) return;
    try {
      const groups = (await this.redis.xinfo('GROUPS', RedisKeys.positionsStream)) as unknown[][];
      let backlog: number | null = null;
      for (const g of groups) {
        const info = new Map<string, unknown>();
        for (let i = 0; i + 1 < g.length; i += 2) info.set(String(g[i]), g[i + 1]);
        if (info.get('name') !== RedisKeys.processorGroup) continue;
        const lag = Number(info.get('lag') ?? 0);
        const pending = Number(info.get('pending') ?? 0);
        backlog = (Number.isFinite(lag) ? lag : 0) + (Number.isFinite(pending) ? pending : 0);
      }
      if (backlog === null) return;
      const cap = positionsStreamMaxLen();
      if (!this.backpressure && backlog > cap * this.opts.backpressureHigh) {
        this.backpressure = true;
        this.noteError(`Processor backlog ${backlog} > ${Math.round(this.opts.backpressureHigh * 100)}% of the stream cap ${cap}: spooling new positions`);
      } else if (this.backpressure && backlog < cap * this.opts.backpressureLow) {
        this.backpressure = false;
        this.logger.log(`Processor backlog down to ${backlog}; replaying the spool`);
        this.scheduleReplay(0);
      }
    } catch {
      // stream not created yet or cache just went away: nothing to decide
    }
  }

  /** Stops timers and flushes pending appends (call before closing the cache connection). */
  close(): void {
    this.stopped = true;
    if (this.replayTimer) clearTimeout(this.replayTimer);
    if (this.backlogTimer) clearInterval(this.backlogTimer);
    this.spool?.close();
  }
}

import { Logger } from '@nestjs/common';
import { ProcessorMetrics } from '@veetracer/shared';
import type Redis from 'ioredis';
import { RateMeter } from '../monitoring/heartbeat';
import { RedisKeys } from '../redis/keys';
import { PositionProcessor, StreamEntry } from './position-processor';

const BATCH_SIZE = 500;
const BLOCK_MS = 1000;
const CLAIM_IDLE_MS = 30_000;
const CLAIM_EVERY_MS = 30_000;
const STATS_EVERY_MS = 10_000;
/** Retry delay after a failed batch: 1 s, doubling per consecutive failure, capped at 30 s. */
const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 30_000;

export function retryDelayMs(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return 0;
  return Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** (consecutiveFailures - 1));
}

/** Prisma errors (connection, query) — as opposed to Valkey or data errors. */
export function isDatabaseError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const name = (error as { name?: unknown }).name;
  return (typeof name === 'string' && name.startsWith('PrismaClient')) || 'clientVersion' in error;
}

/** The database can't be reached (vs a statement that failed): retry the same batch instead of reading new entries. */
export function isConnectivityError(error: unknown): boolean {
  if (!isDatabaseError(error)) return false;
  const e = error as { name?: string; code?: string; message?: string };
  if (e.name === 'PrismaClientInitializationError') return true;
  if (e.code && ['P1001', 'P1002', 'P1008', 'P1017', 'P2024'].includes(e.code)) return true;
  return /can't reach database|connection|ECONNREFUSED|timed out|terminating/i.test(e.message ?? '');
}

type RawEntry = [id: string, fields: string[] | null];

function toEntries(raw: RawEntry[]): StreamEntry[] {
  return raw.map(([id, fields]) => {
    const entry: StreamEntry = { id, data: null, remote: null };
    for (let i = 0; fields && i < fields.length; i += 2) {
      if (fields[i] === 'data') entry.data = fields[i + 1];
      else if (fields[i] === 'remote') entry.remote = fields[i + 1];
    }
    return entry;
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Consumer-group loop on `vt:positions`: own pending first, then new entries, plus periodic XAUTOCLAIM. */
export class StreamConsumer {
  private readonly logger = new Logger('Processor');
  private stopping = false;
  private lastClaimAt = Date.now();
  private window = { processed: 0, batches: 0, busyMs: 0, startedAt: Date.now() };
  // Since start, for the System Health heartbeat.
  private totals = { processed: 0, dbErrors: 0 };
  private lastAvgBatchMs = 0;
  private lastBatchAt: number | null = null;
  private lastDbError: { message: string; at: string } | null = null;
  private lastDbOkAt: number | null = null;
  private failures = 0;
  private lastPending: number | null = null;
  private lastLag: number | null = null;
  private readonly rate = new RateMeter();

  constructor(
    private readonly redis: Redis,
    private readonly processor: PositionProcessor,
    private readonly consumer: string,
  ) {}

  stop(): void {
    this.stopping = true;
  }

  /** Numbers for the System Health heartbeat (reuses the 10-second stats window). */
  metrics(): ProcessorMetrics {
    return {
      processed: this.totals.processed,
      processedPerSec: this.rate.rate(this.totals.processed),
      avgBatchMs: this.lastAvgBatchMs,
      lastBatchAt: this.lastBatchAt ? new Date(this.lastBatchAt).toISOString() : null,
      dbErrors: this.totals.dbErrors,
      lastDbError: this.lastDbError,
      lastDbOkAt: this.lastDbOkAt ? new Date(this.lastDbOkAt).toISOString() : null,
      backoffMs: retryDelayMs(this.failures),
      pending: this.lastPending,
      lag: this.lastLag,
    };
  }

  async run(): Promise<void> {
    await this.ensureGroup();
    const stats = setInterval(() => void this.logStats(), STATS_EVERY_MS);
    try {
      // Entries delivered to this consumer before a restart and never acknowledged.
      let backlog = true;
      while (!this.stopping) {
        try {
          if (Date.now() - this.lastClaimAt > CLAIM_EVERY_MS) await this.claimStale();
          const entries = await this.read(backlog ? '0' : '>');
          if (backlog && !entries.length) backlog = false;
          await this.process(entries);
          if (this.failures) this.logger.log(`Recovered after ${this.failures} failed attempt(s)`);
          this.failures = 0;
        } catch (error) {
          this.failures++;
          const delay = retryDelayMs(this.failures);
          const db = isDatabaseError(error);
          if (db) {
            this.totals.dbErrors++;
            this.lastDbError = { message: (error as Error).message.trim().split('\n').pop()!.slice(0, 300), at: new Date().toISOString() };
          }
          // Database unreachable: retry our own pending batch (no new entries pile up in the PEL while it is down).
          if (isConnectivityError(error)) backlog = true;
          this.logger.error(
            `Batch failed (${db ? 'database' : 'other'}; entries stay pending and will be retried in ${delay / 1000}s): ${(error as Error).message}`,
          );
          await this.sleepUnlessStopping(delay);
        }
      }
    } finally {
      clearInterval(stats);
    }
  }

  private async sleepUnlessStopping(ms: number): Promise<void> {
    const end = Date.now() + ms;
    while (!this.stopping && Date.now() < end) await sleep(Math.min(500, end - Date.now()));
  }

  private async ensureGroup(): Promise<void> {
    try {
      await this.redis.xgroup('CREATE', RedisKeys.positionsStream, RedisKeys.processorGroup, '0', 'MKSTREAM');
      this.logger.log(`Created consumer group ${RedisKeys.processorGroup}`);
    } catch (error) {
      if (!(error as Error).message.includes('BUSYGROUP')) throw error;
    }
  }

  private async read(id: '0' | '>'): Promise<StreamEntry[]> {
    const args = ['GROUP', RedisKeys.processorGroup, this.consumer, 'COUNT', BATCH_SIZE] as const;
    const reply = (
      id === '>'
        ? await this.redis.xreadgroup(...args, 'BLOCK', BLOCK_MS, 'STREAMS', RedisKeys.positionsStream, id)
        : await this.redis.xreadgroup(...args, 'STREAMS', RedisKeys.positionsStream, id)
    ) as [string, RawEntry[]][] | null;
    return reply?.[0] ? toEntries(reply[0][1]) : [];
  }

  /** Take over entries another (crashed) consumer — or a failed batch of ours — left pending for > 30 s. */
  private async claimStale(): Promise<void> {
    this.lastClaimAt = Date.now();
    let cursor = '0-0';
    do {
      const [next, raw] = (await this.redis.xautoclaim(
        RedisKeys.positionsStream,
        RedisKeys.processorGroup,
        this.consumer,
        CLAIM_IDLE_MS,
        cursor,
        'COUNT',
        BATCH_SIZE,
      )) as [string, RawEntry[]];
      cursor = next;
      const entries = toEntries(raw.filter(([, fields]) => fields !== null));
      if (entries.length) {
        this.logger.warn(`Re-claimed ${entries.length} stale pending entries`);
        await this.process(entries);
      }
    } while (cursor !== '0-0' && !this.stopping);
  }

  private async process(entries: StreamEntry[]): Promise<void> {
    if (!entries.length) return;
    const started = Date.now();
    const count = await this.processor.handle(entries);
    this.window.processed += count;
    this.window.batches += 1;
    this.window.busyMs += Date.now() - started;
    this.totals.processed += count;
    this.lastBatchAt = Date.now();
    this.lastDbOkAt = this.lastBatchAt;
  }

  private async logStats(): Promise<void> {
    const w = this.window;
    this.window = { processed: 0, batches: 0, busyMs: 0, startedAt: Date.now() };
    const seconds = (Date.now() - w.startedAt) / 1000;
    try {
      if (w.batches) this.lastAvgBatchMs = Math.round((w.busyMs / w.batches) * 10) / 10;
      const pending = (await this.redis.xpending(RedisKeys.positionsStream, RedisKeys.processorGroup)) as [number, ...unknown[]];
      const lag = await this.groupLag();
      this.lastPending = pending[0];
      this.lastLag = lag;
      this.logger.log(
        `processed=${w.processed} rate=${(w.processed / seconds).toFixed(1)}/s batches=${w.batches} ` +
          `avgBatchMs=${w.batches ? (w.busyMs / w.batches).toFixed(1) : '0'} pending=${pending[0]} lag=${lag ?? 'n/a'}`,
      );
    } catch (error) {
      this.logger.error(`Stats failed: ${(error as Error).message}`);
    }
  }

  /** Entries in the stream not yet delivered to the group (XINFO GROUPS `lag`, Redis/Valkey ≥ 7). */
  private async groupLag(): Promise<number | null> {
    const groups = (await this.redis.xinfo('GROUPS', RedisKeys.positionsStream)) as unknown[][];
    for (const group of groups) {
      const info = new Map<string, unknown>();
      for (let i = 0; i < group.length; i += 2) info.set(String(group[i]), group[i + 1]);
      if (info.get('name') === RedisKeys.processorGroup) {
        const lag = info.get('lag');
        return typeof lag === 'number' ? lag : null;
      }
    }
    return null;
  }
}

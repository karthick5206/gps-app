import { Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { RedisKeys } from '../redis/keys';
import { PositionProcessor, StreamEntry } from './position-processor';

const BATCH_SIZE = 500;
const BLOCK_MS = 1000;
const CLAIM_IDLE_MS = 30_000;
const CLAIM_EVERY_MS = 30_000;
const STATS_EVERY_MS = 10_000;
const RETRY_DELAY_MS = 1000;

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

  constructor(
    private readonly redis: Redis,
    private readonly processor: PositionProcessor,
    private readonly consumer: string,
  ) {}

  stop(): void {
    this.stopping = true;
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
        } catch (error) {
          this.logger.error(`Batch failed (entries stay pending and will be retried): ${(error as Error).message}`);
          await sleep(RETRY_DELAY_MS);
        }
      }
    } finally {
      clearInterval(stats);
    }
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
  }

  private async logStats(): Promise<void> {
    const w = this.window;
    this.window = { processed: 0, batches: 0, busyMs: 0, startedAt: Date.now() };
    const seconds = (Date.now() - w.startedAt) / 1000;
    try {
      const pending = (await this.redis.xpending(RedisKeys.positionsStream, RedisKeys.processorGroup)) as [number, ...unknown[]];
      const lag = await this.groupLag();
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

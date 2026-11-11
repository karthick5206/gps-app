import { Logger } from '@nestjs/common';
import type Redis from 'ioredis';

/**
 * Delivery port of the optimisation jobs: "job X is ready". Durable state lives in `RoutingJob` (job-store.ts); a lost
 * delivery is harmless because the sweeper re-publishes due QUEUED jobs, and a duplicate one is harmless because only
 * one conditional claim can win.
 */
export interface JobQueue {
  publish(jobId: string): Promise<void>;
  /**
   * Reads deliveries for `consumer` until `stopping()` is true and calls `handle` for each (one at a time per call).
   * A delivery is acknowledged after `handle` settled; unacknowledged ones (a killed consumer) are claimed by another
   * consumer after `reclaimIdleMs` (XAUTOCLAIM).
   */
  consume(consumer: string, handle: (jobId: string) => Promise<void>, stopping: () => boolean): Promise<void>;
  close(): Promise<void>;
}

/** Valkey stream of the routing jobs (one consumer group shared by every routing-worker process). */
export const ROUTING_JOB_STREAM = 'vt:routing:jobs';
export const ROUTING_JOB_GROUP = 'routing-workers';
/** One sweeper at a time (SET NX PX). */
export const ROUTING_SWEEP_LOCK = 'vt:routing:jobs:sweeper';
/** Per-user submit counter (rate limit), `vt:routing:rl:<userId>:<minute>`. */
export const routingRateKey = (userId: string, minute: number) => `vt:routing:rl:${userId}:${minute}`;
const STREAM_MAXLEN = 10_000;
const BLOCK_MS = 5_000;

export class ValkeyJobQueue implements JobQueue {
  private readonly logger = new Logger('RoutingJobQueue');
  private readonly conns: Redis[] = [];

  constructor(
    private readonly redis: Redis,
    private readonly reclaimIdleMs = 60_000,
  ) {}

  async publish(jobId: string): Promise<void> {
    await this.redis.xadd(ROUTING_JOB_STREAM, 'MAXLEN', '~', STREAM_MAXLEN, '*', 'jobId', jobId);
  }

  async consume(consumer: string, handle: (jobId: string) => Promise<void>, stopping: () => boolean): Promise<void> {
    const conn = this.redis.duplicate(); // BLOCKing reads need their own connection
    this.conns.push(conn);
    try {
      await conn.xgroup('CREATE', ROUTING_JOB_STREAM, ROUTING_JOB_GROUP, '0', 'MKSTREAM');
    } catch (e) {
      if (!(e as Error).message.includes('BUSYGROUP')) this.logger.error(`xgroup: ${(e as Error).message}`);
    }
    let lastReclaim = 0;
    while (!stopping()) {
      try {
        let entries: [string, string[]][] = [];
        if (Date.now() - lastReclaim > this.reclaimIdleMs) {
          lastReclaim = Date.now();
          const reply = (await conn.xautoclaim(ROUTING_JOB_STREAM, ROUTING_JOB_GROUP, consumer, this.reclaimIdleMs, '0-0', 'COUNT', 10)) as [string, [string, string[]][]];
          entries = (reply?.[1] ?? []).filter((e) => Array.isArray(e?.[1]));
        }
        if (!entries.length) {
          const reply = (await conn.xreadgroup('GROUP', ROUTING_JOB_GROUP, consumer, 'COUNT', 1, 'BLOCK', BLOCK_MS, 'STREAMS', ROUTING_JOB_STREAM, '>')) as
            | [string, [string, string[]][]][]
            | null;
          entries = reply?.[0]?.[1] ?? [];
        }
        for (const [id, fields] of entries) {
          if (stopping()) break; // left pending: another consumer reclaims it
          const k = fields.indexOf('jobId');
          if (k >= 0) await handle(fields[k + 1]);
          await conn.xack(ROUTING_JOB_STREAM, ROUTING_JOB_GROUP, id);
        }
      } catch (e) {
        if (stopping()) break;
        this.logger.warn(`consumer ${consumer}: ${(e as Error).message}`);
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  async close(): Promise<void> {
    await Promise.all(this.conns.map((c) => c.quit().catch(() => c.disconnect())));
    this.conns.length = 0;
  }
}

/** In-process queue for tests: FIFO, deliveries handed to waiting consumers; no redelivery (the sweeper covers it). */
export class MemoryJobQueue implements JobQueue {
  readonly published: string[] = [];
  private readonly pending: string[] = [];
  private readonly waiters: ((id: string | null) => void)[] = [];

  async publish(jobId: string): Promise<void> {
    this.published.push(jobId);
    const w = this.waiters.shift();
    if (w) w(jobId);
    else this.pending.push(jobId);
  }

  private next(timeoutMs: number): Promise<string | null> {
    const id = this.pending.shift();
    if (id) return Promise.resolve(id);
    return new Promise((resolve) => {
      const waiter = (v: string | null) => {
        clearTimeout(t);
        resolve(v);
      };
      const t = setTimeout(() => {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) this.waiters.splice(i, 1);
        resolve(null);
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  async consume(_consumer: string, handle: (jobId: string) => Promise<void>, stopping: () => boolean): Promise<void> {
    while (!stopping()) {
      const id = await this.next(20);
      if (id && !stopping()) await handle(id);
      else if (id) this.pending.unshift(id);
    }
  }

  async close(): Promise<void> {
    for (const w of this.waiters.splice(0)) w(null);
  }
}

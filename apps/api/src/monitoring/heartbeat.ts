import { Logger } from '@nestjs/common';
import { ProcessHeartbeat, ProcessRole, RoleMetrics } from '@veetracer/shared';
import type Redis from 'ioredis';
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { APP_ROOT } from '../config/env';
import { RedisKeys } from '../redis/keys';

export const HEARTBEAT_INTERVAL_MS = 5000;
export const HEARTBEAT_TTL_SEC = 20;

let version: string | null = null;
/** apps/api package.json version. */
export function appVersion(): string {
  if (version === null) {
    try {
      version = (JSON.parse(readFileSync(join(APP_ROOT, 'package.json'), 'utf8')) as { version?: string }).version ?? '0.0.0';
    } catch {
      version = '0.0.0';
    }
  }
  return version;
}

export const instanceId = (): string => `${hostname()}-${process.pid}`;

/** Per-second rate of a monotonically increasing counter between two calls (restarts → 0). */
export class RateMeter {
  private last: { value: number; at: number } | null = null;

  rate(value: number, now = Date.now()): number {
    const prev = this.last;
    this.last = { value, at: now };
    if (!prev || now <= prev.at || value < prev.value) return 0;
    return Math.round(((value - prev.value) * 1000 * 10) / (now - prev.at)) / 10;
  }
}

export interface HeartbeatHandle {
  /** Stops and deletes the key (call before closing the Valkey connection). */
  stop(): Promise<void>;
  /** Writes one heartbeat now (also used on start). */
  beat(): Promise<void>;
}

/**
 * Writes `vt:health:proc:<role>:<instanceId>` every 5 s (EX 20 s): process resources plus the role's metrics.
 * A missing key means the instance is gone; the API's System Health page reads all of them.
 */
export function startHeartbeat<R extends ProcessRole>(
  redis: Redis,
  role: R,
  metrics: () => RoleMetrics[R] | Promise<RoleMetrics[R]>,
): HeartbeatHandle {
  const logger = new Logger(`Heartbeat:${role}`);
  const id = instanceId();
  const key = RedisKeys.healthProcess(role, id);
  const startedAt = new Date(Date.now() - Math.round(process.uptime() * 1000)).toISOString();
  const loop = monitorEventLoopDelay({ resolution: 20 });
  loop.enable();
  let cpu = process.cpuUsage();
  let cpuAt = process.hrtime.bigint();
  let failing = false;

  const beat = async () => {
    try {
      const now = process.hrtime.bigint();
      const used = process.cpuUsage(cpu);
      const elapsedUs = Number(now - cpuAt) / 1000;
      cpu = process.cpuUsage();
      cpuAt = now;
      const mem = process.memoryUsage();
      const lag = loop.count ? loop.percentile(99) / 1e6 : 0;
      loop.reset();
      const hb: ProcessHeartbeat<R> = {
        role,
        instanceId: id,
        host: hostname(),
        pid: process.pid,
        version: appVersion(),
        startedAt,
        at: new Date().toISOString(),
        uptimeSec: Math.round(process.uptime()),
        rssBytes: mem.rss,
        heapUsed: mem.heapUsed,
        cpuPercent: elapsedUs > 0 ? Math.round(((used.user + used.system) / elapsedUs) * 1000) / 10 : 0,
        eventLoopLagMs: Math.round(lag * 10) / 10,
        metrics: await metrics(),
      };
      const results = await redis
        .multi()
        .set(key, JSON.stringify(hb), 'EX', HEARTBEAT_TTL_SEC)
        .zadd(RedisKeys.healthProcessIndex, Date.now(), key)
        .exec();
      const failed = results?.find(([error]) => error);
      if (failed) throw failed[0] as Error;
      if (failing) logger.log('Heartbeat restored');
      failing = false;
    } catch (error) {
      if (!failing) logger.warn(`Heartbeat failed: ${(error as Error).message}`);
      failing = true;
    }
  };

  void beat();
  const timer = setInterval(() => void beat(), HEARTBEAT_INTERVAL_MS);
  timer.unref();
  return {
    beat,
    stop: async () => {
      clearInterval(timer);
      loop.disable();
      // Gone immediately on a clean shutdown (otherwise the key expires after 20 s).
      await redis
        .multi()
        .del(key)
        .zrem(RedisKeys.healthProcessIndex, key)
        .exec()
        .catch(() => undefined);
    },
  };
}

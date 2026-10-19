import { Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { SummarizerMetrics } from '@veetracer/shared';
import { loadEnv } from '../config/env';
import { startHeartbeat } from '../monitoring/heartbeat';
import { GeocodingService } from '../geocoding/geocoding.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisKeys } from '../redis/keys';
import { AddressFiller } from './address-filler';
import { SUMMARIZER_LOCK_KEY } from './late-detector';
import { RunStats, Summarizer } from './summarizer';

const RELEASE_LOCK = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`;

function describe(s: RunStats): string {
  return (
    `objects=${s.objects} written=${s.written} (incremental=${s.incremental} dirty=${s.dirty} rebuild=${s.rebuilds}) positions=${s.positions} ` +
    `trips=${s.trips} stops=${s.stops} days=${s.days} late=${s.lateObjects} streamEntries=${s.scannedEntries}` +
    `${s.fallback ? ` fallback="${s.fallback}"` : ''} ms=${s.ms}`
  );
}

/**
 * Summarizer process: every SUMMARIZER_INTERVAL_MS (default 60 s) turns new positions into trips, stops and daily
 * summaries, recomputes days that received late data and fills addresses in the background.
 * `--once` runs a single pass and exits (backfills / timing).
 */
async function main(): Promise<void> {
  const env = loadEnv();
  const logger = new Logger('Summarizer');
  const once = process.argv.includes('--once');
  const intervalMs = Number(process.env.SUMMARIZER_INTERVAL_MS ?? 60_000);
  const instance = randomUUID();

  const prisma = new PrismaClient();
  // PostgreSQL down at start: keep running (runs fail and are retried every interval; System Health shows it).
  await prisma.$connect().catch((error: Error) => logger.error(`Database not reachable at start (will retry): ${error.message}`));
  const redis = new Redis(env.redisUrl, { maxRetriesPerRequest: null });
  const subscriber = new Redis(env.redisUrl);
  for (const conn of [redis, subscriber]) conn.on('error', (error) => logger.error(`Valkey error: ${error.message}`));

  const summarizer = new Summarizer(prisma, redis);
  subscriber.on('message', () => summarizer.detector.invalidateDevices());
  await subscriber.subscribe(RedisKeys.cacheInvalidate);
  const addresses = new AddressFiller(prisma, new GeocodingService(prisma as PrismaService));

  let stopping = false;
  let wake: (() => void) | null = null;
  const shutdown = () => {
    logger.log('Stopping after the current run…');
    stopping = true;
    wake?.();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  logger.log(once ? 'Single run' : `Running every ${intervalMs / 1000}s`);
  let run = 0;
  const health: SummarizerMetrics = { runs: 0, lastRunAt: null, lastRunMs: null, lastError: null };
  const heartbeat = once ? null : startHeartbeat(redis, 'summarizer', () => ({ ...health }));
  while (!stopping) {
    const started = Date.now();
    const locked = await redis.set(SUMMARIZER_LOCK_KEY, instance, 'PX', 10 * 60_000, 'NX');
    if (locked) {
      try {
        run++;
        const stats = await summarizer.runOnce();
        logger.log(`run #${run}: ${describe(stats)}`);
        addresses.kick();
        Object.assign(health, { runs: run, lastRunAt: new Date().toISOString(), lastRunMs: Date.now() - started });
      } catch (error) {
        logger.error(`Run failed: ${(error as Error).stack ?? (error as Error).message}`);
        health.lastError = { message: (error as Error).message.trim().split('\n').pop()!.slice(0, 300), at: new Date().toISOString() };
      } finally {
        await redis.eval(RELEASE_LOCK, 1, SUMMARIZER_LOCK_KEY, instance);
      }
    } else {
      logger.warn('Another summarizer instance holds the lock; skipping this run');
    }
    if (once) break;
    const wait = Math.max(1000, intervalMs - (Date.now() - started));
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, wait);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    wake = null;
  }
  await heartbeat?.stop();
  await Promise.all([redis.quit(), subscriber.quit(), prisma.$disconnect()]);
  process.exit(0);
}

void main();

import { Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import { hostname } from 'node:os';
import { loadEnv } from '../config/env';
import { startHeartbeat } from '../monitoring/heartbeat';
import { RedisKeys } from '../redis/keys';
import { RulesRepository } from '../alerts/rules-data';
import { DeviceCache } from './device-cache';
import { DriverIdentification } from './driver-identification';
import { PositionProcessor } from './position-processor';
import { RulesEngine } from './rules/rules-engine';
import { StreamConsumer } from './stream-consumer';

async function main(): Promise<void> {
  const env = loadEnv();
  const logger = new Logger('Processor');
  const consumerName = process.env.PROCESSOR_CONSUMER ?? `processor-${hostname()}`;

  const prisma = new PrismaClient();
  // Don't exit when PostgreSQL is down at start: Prisma connects lazily and the consumer backs off until it is back.
  await prisma.$connect().catch((error: Error) => logger.error(`Database not reachable at start (will retry): ${error.message}`));
  const redis = new Redis(env.redisUrl, { maxRetriesPerRequest: null });
  const subscriber = new Redis(env.redisUrl);
  for (const conn of [redis, subscriber]) conn.on('error', (error) => logger.error(`Valkey error: ${error.message}`));

  const cache = new DeviceCache(prisma);
  const rulesRepo = new RulesRepository(prisma);
  const drivers = new DriverIdentification(prisma);
  subscriber.on('message', (channel: string, message: string) => {
    if (channel === RedisKeys.rulesInvalidate) {
      rulesRepo.invalidate(parseCompanyId(message));
      return;
    }
    cache.clear();
    drivers.clear();
    rulesRepo.invalidate();
  });
  await subscriber.subscribe(RedisKeys.cacheInvalidate, RedisKeys.rulesInvalidate);

  const rules = process.env.RULES_ENGINE === 'off' ? null : new RulesEngine(redis, rulesRepo);
  const consumer = new StreamConsumer(redis, new PositionProcessor(prisma, redis, cache, rules, drivers), consumerName);
  const heartbeat = startHeartbeat(redis, 'processor', () => consumer.metrics());
  const shutdown = () => {
    logger.log('Stopping after the current batch…');
    consumer.stop();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  logger.log(`Consumer ${consumerName} reading ${RedisKeys.positionsStream} (group ${RedisKeys.processorGroup})`);
  await consumer.run();
  await heartbeat.stop();
  await Promise.all([redis.quit(), subscriber.quit(), prisma.$disconnect()]);
  process.exit(0);
}

function parseCompanyId(message: string): string | null {
  try {
    const body = JSON.parse(message) as { companyId?: unknown };
    return typeof body.companyId === 'string' ? body.companyId : null;
  } catch {
    return null;
  }
}

void main();

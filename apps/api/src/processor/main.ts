import { Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import { hostname } from 'node:os';
import { loadEnv } from '../config/env';
import { RedisKeys } from '../redis/keys';
import { DeviceCache } from './device-cache';
import { PositionProcessor } from './position-processor';
import { StreamConsumer } from './stream-consumer';

async function main(): Promise<void> {
  const env = loadEnv();
  const logger = new Logger('Processor');
  const consumerName = process.env.PROCESSOR_CONSUMER ?? `processor-${hostname()}`;

  const prisma = new PrismaClient();
  await prisma.$connect();
  const redis = new Redis(env.redisUrl, { maxRetriesPerRequest: null });
  const subscriber = new Redis(env.redisUrl);
  for (const conn of [redis, subscriber]) conn.on('error', (error) => logger.error(`Valkey error: ${error.message}`));

  const cache = new DeviceCache(prisma);
  subscriber.on('message', () => cache.clear());
  await subscriber.subscribe(RedisKeys.cacheInvalidate);

  const consumer = new StreamConsumer(redis, new PositionProcessor(prisma, redis, cache), consumerName);
  const shutdown = () => {
    logger.log('Stopping after the current batch…');
    consumer.stop();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  logger.log(`Consumer ${consumerName} reading ${RedisKeys.positionsStream} (group ${RedisKeys.processorGroup})`);
  await consumer.run();
  await Promise.all([redis.quit(), subscriber.quit(), prisma.$disconnect()]);
  process.exit(0);
}

void main();

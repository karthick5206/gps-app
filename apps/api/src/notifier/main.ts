import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { loadEnv } from '../config/env';
import { RedisKeys } from '../redis/keys';
import { RedisService } from '../redis/redis.service';
import { NotifierModule } from './notifier.module';
import { NotifierService } from './notifier.service';

/** Notifier process: consumes `vt:notify`, renders templates, sends e-mail/SMS and writes NotificationLog. */
async function main(): Promise<void> {
  loadEnv();
  const app = await NestFactory.createApplicationContext(NotifierModule, { logger: ['log', 'warn', 'error'] });
  app.enableShutdownHooks();
  const notifier = app.get(NotifierService);
  const redis = app.get(RedisService);
  redis.subscribe([RedisKeys.rulesInvalidate, RedisKeys.cacheInvalidate], (channel, message) => {
    if (channel === RedisKeys.cacheInvalidate) return notifier.invalidate(null);
    try {
      notifier.invalidate((JSON.parse(message) as { companyId?: string }).companyId ?? null);
    } catch {
      notifier.invalidate(null);
    }
  });
  const shutdown = () => {
    Logger.log('Stopping after the current jobs…', 'Notifier');
    notifier.stop();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  await notifier.run();
  await app.close();
  process.exit(0);
}

void main();

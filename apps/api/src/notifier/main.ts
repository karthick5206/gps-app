import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { loadEnv } from '../config/env';
import { RedisKeys } from '../redis/keys';
import { RedisService } from '../redis/redis.service';
import { NotifierModule } from './notifier.module';
import { NotifierService } from './notifier.service';
import { WebhookWorkerService } from '../webhooks/webhook-worker.service';
import { DriverEventWorkerService } from '../driver-events/driver-event-worker.service';

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
    webhooks.stop();
    driverEvents.stop();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  // Webhook deliveries run in this process too (consumer group `webhooks` on `vt:webhooks`); no extra service.
  const webhooks = app.get(WebhookWorkerService);
  // Driver event media (vt:driver-media → DriverEventMedia) also runs here.
  const driverEvents = app.get(DriverEventWorkerService);
  await Promise.all([notifier.run(), webhooks.run(), driverEvents.run()]);
  await notifier.drain();
  await app.close();
  process.exit(0);
}

void main();

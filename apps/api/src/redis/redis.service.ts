import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { APP_ENV } from '../config/config.module';
import { AppEnv } from '../config/env';
import { RedisKeys } from './keys';

@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  /** Connection for regular commands. */
  readonly client: Redis;
  private readonly subscribers: Redis[] = [];

  constructor(@Inject(APP_ENV) private readonly env: AppEnv) {
    this.client = new Redis(env.redisUrl, { maxRetriesPerRequest: 3 });
    this.client.on('error', (err) => this.logger.error(`Valkey error: ${err.message}`));
  }

  /** Dedicated connection in subscriber mode; closed with the module. */
  subscribe(channels: string[], onMessage: (channel: string, message: string) => void): Redis {
    const sub = new Redis(this.env.redisUrl);
    sub.on('error', (err) => this.logger.error(`Valkey subscriber error: ${err.message}`));
    sub.on('message', onMessage);
    void sub.subscribe(...channels);
    this.subscribers.push(sub);
    return sub;
  }

  /** Tell the processor and realtime layer that device/object/assignment/scope data changed. */
  async invalidateCache(reason: string): Promise<void> {
    await this.client.publish(RedisKeys.cacheInvalidate, JSON.stringify({ reason, at: Date.now() }));
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all([this.client, ...this.subscribers].map((c) => c.quit().catch(() => undefined)));
  }
}

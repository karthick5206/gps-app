import { Inject, Injectable, Logger } from '@nestjs/common';
import { AlertDto, NormalizedPosition, RelayTargetStats } from '@veetracer/shared';
import type Redis from 'ioredis';
import { hostname } from 'node:os';
import { APP_ENV } from '../config/config.module';
import { AppEnv } from '../config/env';
import { RedisKeys } from '../redis/keys';
import { RedisService } from '../redis/redis.service';
import { postJson } from '../webhooks/http-post';
import { relayPolicy } from './guard';
import { HttpForwarder } from './http-forwarder';
import { RELAY_LIMITS } from './guard';
import { watchRuleSet } from './sync';

const READ_COUNT = 500;
const BLOCK_MS = 2000;
const IDLE_MS = 2000;
const POST_TIMEOUT_MS = 15_000;

type RawEntry = [id: string, fields: string[] | null];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * HTTP_JSON data forwarding in the notifier process: its own consumer group `relay` on `vt:positions` (the processor's
 * group is untouched, so forwarding never slows position processing) plus alerts from the `vt:alerts` channel.
 * While no HTTP_JSON target exists nothing is read; when the first one appears the group jumps to the stream's end,
 * so old positions are not replayed.
 */
@Injectable()
export class RelayWorkerService {
  private readonly logger = new Logger('Relay');
  private readonly consumer = `${process.env.NOTIFIER_CONSUMER ?? `notifier-${hostname()}`}-relay`;
  readonly forwarder: HttpForwarder;
  private stopping = false;
  private sub: Redis | null = null;
  private stopSync: (() => void) | null = null;

  constructor(
    private readonly redis: RedisService,
    @Inject(APP_ENV) env: AppEnv,
  ) {
    const policy = relayPolicy(env);
    this.forwarder = new HttpForwarder({
      post: (url, body, headers) => postJson(url, body, headers, { timeoutMs: POST_TIMEOUT_MS, allowPrivate: policy.allowPrivate }),
      maxQueue: RELAY_LIMITS.httpQueueItems(),
    });
  }

  snapshot(): RelayTargetStats[] {
    return this.forwarder.snapshot();
  }

  stop(): void {
    this.stopping = true;
  }

  async run(): Promise<void> {
    const client = this.redis.client;
    try {
      await client.xgroup('CREATE', RedisKeys.positionsStream, RedisKeys.relayGroup, '$', 'MKSTREAM');
    } catch (error) {
      if (!(error as Error).message.includes('BUSYGROUP')) throw error;
    }
    this.sub = client.duplicate();
    this.sub.on('error', (error) => this.logger.error(`Valkey (relay) error: ${error.message}`));
    this.stopSync = await watchRuleSet(client, this.sub, (set) => this.forwarder.setRules(set));
    this.redis.subscribe([RedisKeys.alertsChannel], (_channel, message) => this.onAlert(message));
    let active = false;
    try {
      while (!this.stopping) {
        if (!this.forwarder.size) {
          active = false;
          await sleep(IDLE_MS);
          continue;
        }
        try {
          if (!active) {
            // Start from now: positions received while nothing was forwarded are not replayed.
            await client.xgroup('SETID', RedisKeys.positionsStream, RedisKeys.relayGroup, '$');
            active = true;
          }
          await this.readOnce(client);
        } catch (error) {
          this.logger.error(`Relay loop error: ${(error as Error).message}`);
          await sleep(1000);
        }
      }
    } finally {
      this.stopSync?.();
      this.forwarder.flushAll();
      this.forwarder.stop();
      await this.sub.quit().catch(() => undefined);
    }
  }

  private async readOnce(client: Redis): Promise<void> {
    const reply = (await client.xreadgroup('GROUP', RedisKeys.relayGroup, this.consumer, 'COUNT', READ_COUNT, 'BLOCK', BLOCK_MS, 'STREAMS', RedisKeys.positionsStream, '>')) as
      | [string, RawEntry[]][]
      | null;
    const entries = reply?.[0]?.[1] ?? [];
    if (!entries.length) return;
    for (const [, fields] of entries) {
      for (let i = 0; fields && i < fields.length; i += 2) {
        if (fields[i] !== 'data') continue;
        try {
          this.forwarder.addPosition(JSON.parse(fields[i + 1]) as NormalizedPosition);
        } catch {
          // malformed entry
        }
      }
    }
    // Queued in memory: acknowledge at once (the copy is best-effort; the processor's group is the source of truth).
    await client.xack(RedisKeys.positionsStream, RedisKeys.relayGroup, ...entries.map(([id]) => id));
  }

  private onAlert(message: string): void {
    if (!this.forwarder.size) return;
    try {
      const { companyId, alert } = JSON.parse(message) as { companyId: string; alert: AlertDto };
      if (companyId && alert) this.forwarder.addAlert(companyId, alert);
    } catch {
      // ignore
    }
  }
}

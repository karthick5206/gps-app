import { Logger } from '@nestjs/common';
import { RelayRuleSet } from '@veetracer/shared';
import type Redis from 'ioredis';
import { RedisKeys } from '../redis/keys';
import { parseRuleSet } from './rules';

const RELOAD_EVERY_MS = 60_000;

/**
 * Keeps a process's forwarding rules current without a database: reads `vt:relay:rules` now, on every
 * `vt:relay:invalidate` message and once a minute (in case a message was missed). `sub` must be a dedicated
 * subscriber connection. Returns a stop function.
 */
export async function watchRuleSet(redis: Redis, sub: Redis, onSet: (set: RelayRuleSet | null) => void): Promise<() => void> {
  const logger = new Logger('Relay');
  let last = '';
  const load = async () => {
    try {
      const raw = (await redis.get(RedisKeys.relayRules)) ?? '';
      if (raw === last) return;
      last = raw;
      const set = parseRuleSet(raw || null);
      onSet(set);
      if (set) logger.log(`Forwarding rules loaded (${set.rules.length} target(s))`);
    } catch (error) {
      logger.warn(`Could not load forwarding rules: ${(error as Error).message}`);
    }
  };
  sub.on('message', (channel) => {
    if (channel === RedisKeys.relayInvalidate) void load();
  });
  await sub.subscribe(RedisKeys.relayInvalidate);
  await load();
  const timer = setInterval(() => void load(), RELOAD_EVERY_MS);
  timer.unref();
  return () => clearInterval(timer);
}

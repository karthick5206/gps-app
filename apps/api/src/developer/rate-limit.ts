import type Redis from 'ioredis';

/**
 * Per-key fixed windows in Valkey: one per UTC minute and one per UTC day. Both counters are incremented atomically;
 * a refused request still counts, so a client hammering the API stays blocked until the window ends.
 */
const SCRIPT = `
local m = redis.call('INCR', KEYS[1])
if m == 1 then redis.call('EXPIRE', KEYS[1], 120) end
local d = redis.call('INCR', KEYS[2])
if d == 1 then redis.call('EXPIRE', KEYS[2], 172800) end
return {m, d}`;

export interface RateDecision {
  allowed: boolean;
  /** Seconds until the window that refused the request resets (0 when allowed). */
  retryAfterSec: number;
  limitMinute: number;
  remainingMinute: number;
  limitDay: number;
  remainingDay: number;
}

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

export const rateKeys = (keyId: string, now: number): [string, string] => [
  `vt:apikey:rl:m:${keyId}:${Math.floor(now / MINUTE_MS)}`,
  `vt:apikey:rl:d:${keyId}:${Math.floor(now / DAY_MS)}`,
];

/** Pure decision from the window counts after this request. */
export function decide(minuteCount: number, dayCount: number, perMinute: number, perDay: number, now: number): RateDecision {
  const base = {
    limitMinute: perMinute,
    remainingMinute: Math.max(0, perMinute - minuteCount),
    limitDay: perDay,
    remainingDay: Math.max(0, perDay - dayCount),
  };
  if (dayCount > perDay) {
    return { ...base, allowed: false, retryAfterSec: Math.max(1, Math.ceil((DAY_MS - (now % DAY_MS)) / 1000)) };
  }
  if (minuteCount > perMinute) {
    return { ...base, allowed: false, retryAfterSec: Math.max(1, Math.ceil((MINUTE_MS - (now % MINUTE_MS)) / 1000)) };
  }
  return { ...base, allowed: true, retryAfterSec: 0 };
}

export class ApiRateLimiter {
  constructor(private readonly redis: Pick<Redis, 'eval'>) {}

  async hit(keyId: string, perMinute: number, perDay: number, now = Date.now()): Promise<RateDecision> {
    const [mKey, dKey] = rateKeys(keyId, now);
    const [m, d] = (await this.redis.eval(SCRIPT, 2, mKey, dKey)) as [number, number];
    return decide(Number(m), Number(d), perMinute, perDay, now);
  }
}

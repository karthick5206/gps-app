import { HttpException, HttpStatus } from '@nestjs/common';
import type Redis from 'ioredis';

/** INCR the window counter and give it a TTL on first use; returns the count after this request. */
const SCRIPT = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return n`;

export interface WindowDecision {
  allowed: boolean;
  /** Seconds until the window resets (0 when allowed). */
  retryAfterSec: number;
}

/**
 * Per-key fixed window (doc 05 §1 "Rate limits": Valkey-backed). A refused request still counts. When Valkey is
 * unreachable it falls back to an in-process window, so an outage never turns the limit off (per API instance then).
 */
export class FixedWindowLimiter {
  private readonly memory = new Map<string, { window: number; count: number }>();

  constructor(
    private readonly redis: Pick<Redis, 'eval'> | null,
    private readonly prefix: string,
    readonly limit: number,
    readonly windowMs: number,
  ) {}

  async hit(key: string, now: number = Date.now()): Promise<WindowDecision> {
    const window = Math.floor(now / this.windowMs);
    let count: number;
    try {
      if (!this.redis) throw new Error('no valkey');
      count = Number(await this.redis.eval(SCRIPT, 1, `${this.prefix}:${key}:${window}`, String(this.windowMs * 2)));
    } catch {
      count = this.memoryHit(key, window);
    }
    if (count <= this.limit) return { allowed: true, retryAfterSec: 0 };
    return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((this.windowMs - (now % this.windowMs)) / 1000)) };
  }

  private memoryHit(key: string, window: number): number {
    const cur = this.memory.get(key);
    const next = cur && cur.window === window ? { window, count: cur.count + 1 } : { window, count: 1 };
    this.memory.set(key, next);
    if (this.memory.size > 10_000) {
      for (const [k, v] of this.memory) if (v.window !== window) this.memory.delete(k);
    }
    return next.count;
  }
}

/** 429 with the ETMS error shape and a Retry-After hint in the body. */
export function rateLimited(retryAfterSec: number): HttpException {
  return new HttpException({ message: `Too many searches; try again in ${retryAfterSec} s`, code: 'RATE_LIMITED', retryAfterSec }, HttpStatus.TOO_MANY_REQUESTS);
}

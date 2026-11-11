import { randomUUID } from 'crypto';

/**
 * T3-D4: one cap on matrix requests in flight to the shared GraphHopper across every process that builds matrices
 * (the API's MatrixBuilder and each routing-worker process), not 3 per process. A Valkey sorted set holds one member
 * per request in flight, scored with its expiry; a member of a crashed process expires after `ttlMs`. Tracking ETAs
 * (RoutingService) never pass through it.
 *
 * Fails open: when Valkey errors or does not answer within `opTimeoutMs`, the request runs under the per-process
 * limit only (AdaptiveLimiter), so a Valkey outage never stops planning. GraphHopper's own protection is unchanged.
 */
export const GLOBAL_SLOTS_KEY = 'vt:etms:mx:inflight';

/** The two commands it needs (ioredis `Redis` satisfies this). */
export interface SemaphoreClient {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
  zrem(key: string, member: string): Promise<unknown>;
}

/**
 * KEYS[1] = set; ARGV = ttlMs, limit, token. Server time (TIME), so the processes' clocks do not matter. Drops expired
 * members, then adds the token when fewer than `limit` remain. Returns 1 (got a slot) or 0.
 */
const ACQUIRE = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
if redis.call('ZCARD', KEYS[1]) < tonumber(ARGV[2]) then
  redis.call('ZADD', KEYS[1], now + tonumber(ARGV[1]), ARGV[3])
  redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[1]))
  return 1
end
return 0`;

export interface GlobalSlots {
  /** Resolves with a release function once a slot is held (or immediately when failing open). */
  acquire(signal?: AbortSignal): Promise<() => void>;
}

export class ValkeySemaphore implements GlobalSlots {
  private readonly ttlMs: number;
  private readonly pollMs: number;
  private readonly opTimeoutMs: number;
  private readonly key: string;
  /** Requests that ran without the shared cap because Valkey failed (for logs / metrics). */
  failOpen = 0;

  constructor(
    private readonly client: SemaphoreClient,
    readonly limit: number,
    opts: { ttlMs?: number; pollMs?: number; opTimeoutMs?: number; key?: string } = {},
  ) {
    this.ttlMs = opts.ttlMs ?? 60_000;
    this.pollMs = opts.pollMs ?? 25;
    this.opTimeoutMs = opts.opTimeoutMs ?? 250;
    this.key = opts.key ?? GLOBAL_SLOTS_KEY;
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    const token = randomUUID();
    for (;;) {
      if (signal?.aborted) throw signal.reason ?? new Error('aborted');
      let got: unknown;
      try {
        got = await withTimeout(this.client.eval(ACQUIRE, 1, this.key, this.ttlMs, this.limit, token), this.opTimeoutMs);
      } catch {
        this.failOpen++;
        return () => undefined; // fail open: the per-process cap still applies
      }
      if (Number(got) === 1) {
        let done = false;
        return () => {
          if (done) return;
          done = true;
          void withTimeout(this.client.zrem(this.key, token), this.opTimeoutMs).catch(() => undefined); // else it expires (TTL)
        };
      }
      await sleep(this.pollMs * (0.5 + Math.random()), signal);
    }
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('valkey timeout')), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e as Error);
      },
    );
  });
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason ?? new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

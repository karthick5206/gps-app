import Redis from 'ioredis';
import { AdaptiveLimiter } from './limiter';
import { GLOBAL_SLOTS_KEY, ValkeySemaphore, type SemaphoreClient } from './global-slots';
import { GraphHopperMatrixStub } from './testing/gh-matrix-stub';
import { syntheticPoints, testBuilder } from './testing/matrix-test-kit';

/**
 * T3 E2E (load test, 2026-11-11) matrix defects, synthetic points only:
 * - T3-D3: a build's time budget started before it waited in the build queue, so a queued build could spend its
 *   whole budget waiting and report ENGINE_TIMEOUT after 0 engine calls.
 * - T3-D5: the adaptive limiter judged latency per leg (a 50-leg walk queued 400 ms looked like 8 ms per leg) and,
 *   once at 1 on a slow graph, never grew again.
 * - T3-D4: the in-flight cap was per process; N processes (API + workers) gave 3N GraphHopper requests in flight.
 *   Now a Valkey semaphore (TTL) caps them across processes and fails open to the per-process cap.
 */

describe('T3-D3 matrix budget and the build queue', () => {
  const stub = new GraphHopperMatrixStub();
  let url = '';
  beforeAll(async () => {
    url = await stub.start();
  });
  afterAll(() => stub.stop());
  beforeEach(() => {
    Object.assign(stub, { mode: 'up', hangRoute: false, failEvery: 0, legDelayMs: 0, legDetails: true, walkSkew: 1 });
    stub.reset();
  });

  it('a build that waits in the queue for its whole budget is MATRIX_BUSY-style (LIMIT_EXCEEDED + retryAfterS, 0 engine calls), never ENGINE_TIMEOUT', async () => {
    const { builder } = testBuilder(url, { maxBuilds: 1, queue: 4 });
    stub.hangRoute = true;
    const a = builder.buildMatrix(syntheticPoints(6), 'car', { budgetMs: 2_500 });
    await new Promise((r) => setTimeout(r, 50));
    const t0 = Date.now();
    const b = await builder.buildMatrix(syntheticPoints(6, undefined, 0.03, 11), 'car', { budgetMs: 700 });
    const waited = Date.now() - t0;
    expect(b.status).toBe('UNAVAILABLE');
    expect(b.degraded?.reason).toBe('LIMIT_EXCEEDED');
    expect(b.degraded?.retryAfterS).toBeGreaterThan(0);
    expect(b.stats.engineCalls).toEqual({ snap: 0, pair: 0, walk: 0 });
    expect(waited).toBeLessThan(2_000); // gave up after its own budget, not after the running build
    await a;
  });

  it('the budget of a queued build starts when it leaves the queue', async () => {
    jest.setTimeout(20_000);
    const { builder } = testBuilder(url, { maxBuilds: 1, queue: 4 });
    stub.hangRoute = true;
    const a = builder.buildMatrix(syntheticPoints(5), 'car', { budgetMs: 2_000 });
    await new Promise((r) => setTimeout(r, 50));
    const b = builder.buildMatrix(syntheticPoints(5, undefined, 0.03, 13), 'car', { budgetMs: 3_000 });
    // The running build hangs; the engine recovers while b still waits in the queue.
    setTimeout(() => (stub.hangRoute = false), 1_800);
    stub.legDelayMs = 60;
    await a;
    const done = await b;
    // b waited ~2 s; it still had its full 3 s to compute (before: about 1 s left, too little at 60 ms per leg).
    expect(done.status).toBe('COMPLETE');
  });
});

/** Feeds `n` requests of `legs` legs taking `ms(i)` each into the limiter's statistics. */
function feed(l: AdaptiveLimiter, n: number, legs: number, ms: (i: number) => number) {
  for (let i = 0; i < n; i++) l.observe(ms(i), legs);
}
/** ±spread around base (a 50-leg walk averages its legs: ±5 %; one leg ±20 %). */
const jitter = (base: number, spread = 0.2) => (i: number) => base * (1 - spread + 2 * spread * (((i * 7919) % 101) / 100));

describe('T3-D5 adaptive limiter', () => {
  it('walks queued behind other GraphHopper work halve the limit (per-leg view hid a 400 ms queue)', () => {
    const l = new AdaptiveLimiter(3, 60, 20);
    feed(l, 40, 50, jitter(10 * 50, 0.05)); // a normal engine: 10 ms per leg, 50-leg walks
    expect(l.limit).toBe(3);
    feed(l, 20, 50, (i) => jitter(10 * 50, 0.05)(i) + 400); // the same walks, each queued 400 ms
    expect(l.limit).toBe(1);
  });

  it('a uniformly slow graph (30 ms per leg, no queue) keeps the limit; after a slow spell the limit recovers', () => {
    const l = new AdaptiveLimiter(3, 60, 20);
    feed(l, 60, 1, jitter(30));
    feed(l, 60, 50, jitter(30 * 50, 0.05));
    expect(l.limit).toBe(3);
    feed(l, 40, 1, () => 250); // GraphHopper saturated by other users: yield
    expect(l.limit).toBe(1);
    feed(l, 200, 1, jitter(32)); // back to its normal 30 ms per leg: probe upward again
    expect(l.limit).toBe(3);
  });

  it('model regression (30 ms per leg): skewed single-leg snaps first (median 24 ms), then normal 50-leg walks: no halving', () => {
    const l = new AdaptiveLimiter(3, 60, 20);
    feed(l, 150, 1, (i) => [16, 20, 22, 24, 24, 26, 36, 44, 52][i % 9]); // lognormal-like: median 24 ms, mean ~29 ms
    let min = l.limit;
    for (let k = 0; k < 10; k++) {
      feed(l, 20, 50, jitter(30 * 50, 0.05));
      min = Math.min(min, l.limit);
    }
    expect(min).toBe(3); // never halved (a dip throttled 30 ms builds into PARTIAL in the T3 model)
  });

  it('sustained saturation of single-leg requests keeps the limit at 1 (no probing into a slow engine)', () => {
    const l = new AdaptiveLimiter(3, 60, 20);
    feed(l, 20, 1, jitter(12));
    feed(l, 200, 1, jitter(150));
    expect(l.limit).toBe(1);
  });

  it('a fast engine grows back to the maximum as before', () => {
    const l = new AdaptiveLimiter(3, 60, 20);
    feed(l, 20, 1, () => 300);
    expect(l.limit).toBe(1);
    feed(l, 60, 1, () => 5);
    expect(l.limit).toBe(3);
  });
});

/** In-memory stand-in for the semaphore script (same arguments; ZSET of token → expiry). */
function fakeValkey(): SemaphoreClient & { held: Map<string, number>; fail: boolean } {
  const held = new Map<string, number>();
  return {
    held,
    fail: false,
    async eval(_script: string, _n: number, _key: string, ttlMs: string | number, limit: string | number, token: string) {
      if (this.fail) throw new Error('valkey down');
      const now = Date.now();
      for (const [t, exp] of held) if (exp <= now) held.delete(t);
      if (held.size < Number(limit)) {
        held.set(token, now + Number(ttlMs));
        return 1;
      }
      return 0;
    },
    async zrem(_key: string, token: string) {
      held.delete(token);
      return 1;
    },
  };
}

async function concurrency(limiters: AdaptiveLimiter[], tasksEach: number, ms: number): Promise<number> {
  let now = 0;
  let max = 0;
  const task = () => async () => {
    now++;
    max = Math.max(max, now);
    await new Promise((r) => setTimeout(r, ms));
    now--;
  };
  await Promise.all(limiters.flatMap((l) => Array.from({ length: tasksEach }, () => l.run(1, task()))));
  return max;
}

describe('T3-D4 one GraphHopper in-flight cap across processes (Valkey semaphore, fails open)', () => {
  it('two processes (two limiters of 3) share one cap of 3 in flight', async () => {
    const v = fakeValkey();
    const a = new AdaptiveLimiter(3, 60, 20, 20, new ValkeySemaphore(v, 3, { pollMs: 5 }));
    const b = new AdaptiveLimiter(3, 60, 20, 20, new ValkeySemaphore(v, 3, { pollMs: 5 }));
    expect(await concurrency([a, b], 12, 15)).toBeLessThanOrEqual(3);
    expect(v.held.size).toBe(0); // every slot given back
  });

  it('Valkey down: each process falls back to its own cap (fail open, nothing blocks)', async () => {
    const v = fakeValkey();
    v.fail = true;
    const a = new AdaptiveLimiter(3, 60, 20, 20, new ValkeySemaphore(v, 3, { pollMs: 5 }));
    const b = new AdaptiveLimiter(3, 60, 20, 20, new ValkeySemaphore(v, 3, { pollMs: 5 }));
    const max = await concurrency([a, b], 6, 10);
    expect(max).toBeLessThanOrEqual(6);
    expect(max).toBeGreaterThan(3);
  });

  it('a slot of a crashed process expires after its TTL', async () => {
    const v = fakeValkey();
    v.held.set('dead-process', Date.now() + 40);
    v.held.set('dead-process-2', Date.now() + 40);
    v.held.set('dead-process-3', Date.now() + 40);
    const l = new AdaptiveLimiter(3, 60, 20, 20, new ValkeySemaphore(v, 3, { pollMs: 5 }));
    const t0 = Date.now();
    await l.run(1, async () => undefined);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(30);
  });

  const url = process.env.MATRIX_VALKEY_TEST_URL ?? '';
  const db = Number(/\/(\d+)$/.exec(url)?.[1] ?? 0);
  (url && db > 0 ? it : it.skip)('on a real Valkey (private db index): two processes share the cap; the script runs', async () => {
    const r1 = new Redis(url, { maxRetriesPerRequest: 1 });
    const r2 = new Redis(url, { maxRetriesPerRequest: 1 });
    try {
      const a = new AdaptiveLimiter(3, 60, 20, 20, new ValkeySemaphore(r1, 3, { pollMs: 5 }));
      const b = new AdaptiveLimiter(3, 60, 20, 20, new ValkeySemaphore(r2, 3, { pollMs: 5 }));
      expect(await concurrency([a, b], 10, 15)).toBeLessThanOrEqual(3);
      expect(await r1.zcard(GLOBAL_SLOTS_KEY)).toBe(0);
    } finally {
      await r1.del(GLOBAL_SLOTS_KEY);
      await r1.quit();
      await r2.quit();
    }
  });
});

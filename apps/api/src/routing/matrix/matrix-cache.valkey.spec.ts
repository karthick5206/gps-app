import Redis from 'ioredis';
import { MatrixCache, redisCacheClient } from './matrix-cache';
import { GraphHopperMatrixStub } from './testing/gh-matrix-stub';
import { syntheticPoints, testConfig } from './testing/matrix-test-kit';
import { MatrixBuilder } from './matrix-builder';
import { GraphHopperMatrixEngine } from './gh-matrix-client';
import { MatrixMetrics } from './matrix-metrics';

/**
 * Live Valkey check of the matrix cache. Runs only with MATRIX_VALKEY_TEST_URL pointing at a PRIVATE db index
 * (e.g. redis://127.0.0.1:6379/13); db 0 is refused. Deletes only the keys it created (prefix vt:etms:mx:).
 */
const url = process.env.MATRIX_VALKEY_TEST_URL ?? '';
const db = Number(/\/(\d+)$/.exec(url)?.[1] ?? 0);
const run = url && db > 0 ? describe : describe.skip;

run('MatrixCache on a real Valkey (private db index)', () => {
  let redis: Redis;
  const stub = new GraphHopperMatrixStub();
  let ghUrl = '';
  beforeAll(async () => {
    redis = new Redis(url, { maxRetriesPerRequest: 1 });
    ghUrl = await stub.start();
  });
  afterAll(async () => {
    const keys = await redis.keys('vt:etms:mx:*');
    if (keys.length) await redis.del(...keys);
    await redis.quit();
    await stub.stop();
  });

  it('writes TTL-bound hashed keys, serves the second build from Valkey, and respects the cap', async () => {
    const config = testConfig({ graphVersion: `valkey-test-${Date.now()}`, cacheTtlSec: 120, cacheMaxCells: 60 });
    const cache = new MatrixCache(redisCacheClient(redis), config.cacheSecret, config.cacheTtlSec, config.cacheMaxCells);
    const builder = new MatrixBuilder(config, { engine: new GraphHopperMatrixEngine(ghUrl) }, cache, new MatrixMetrics());
    const pts = syntheticPoints(6, { lat: 12.9716, lng: 77.5946 });
    const first = await builder.buildMatrix(pts, 'car');
    expect(first.status).toBe('COMPLETE');
    expect(first.stats.cacheWrites).toBe(36); // 30 cells + 6 snaps
    const keys = await redis.keys('vt:etms:mx:*');
    expect(keys.some((k) => /12\.9|77\.5|valkey-test/.test(k))).toBe(false);
    const ttl = await redis.ttl(keys.find((k) => k.includes(':c:'))!);
    expect(ttl).toBeGreaterThan(100);
    stub.reset();
    const second = await builder.buildMatrix(pts, 'car');
    expect(second.stats.cached).toBe(30);
    expect(stub.calls.pair + stub.calls.walk + stub.calls.snap).toBe(0);
    expect(second.durationsS).toEqual(first.durationsS);
    // Cap 60: a bigger matrix stores only up to the cap.
    const big = await builder.buildMatrix(syntheticPoints(9, { lat: 12.9716, lng: 77.5946 }, 0.04, 99), 'car');
    expect(big.status).toBe('COMPLETE');
    expect(big.stats.cacheFull).toBe(true);
    expect(Number(await redis.get(cache.counterKey(config.graphVersion!)))).toBe(60);
  });
});

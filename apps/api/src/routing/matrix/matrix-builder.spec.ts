import { inCoverage, graphVersionOf, legsAgree, MatrixBuilder, sampleLegs, validPoint } from './matrix-builder';
import { MatrixCache } from './matrix-cache';
import { readMatrixConfig } from './matrix-config';
import { GraphHopperMatrixStub, stubLeg } from './testing/gh-matrix-stub';
import { MemoryCacheClient, syntheticPoints, testBuilder, testConfig } from './testing/matrix-test-kit';
import type { MatrixPoint } from './matrix-types';

const expected = (a: MatrixPoint, b: MatrixPoint) => {
  const l = stubLeg([a.lat, a.lng], [b.lat, b.lng]);
  return { s: l.time / 1000, m: l.distance };
};

function expectExact(points: MatrixPoint[], durations: (number | null)[][], distances: (number | null)[][], skip: (i: number, j: number) => boolean = () => false) {
  for (let i = 0; i < points.length; i++) {
    for (let j = 0; j < points.length; j++) {
      if (skip(i, j)) continue;
      if (i === j) {
        expect(durations[i][j]).toBe(0);
        continue;
      }
      const e = expected(points[i], points[j]);
      expect(durations[i][j]).toBeCloseTo(e.s, 3);
      expect(distances[i][j]).toBeCloseTo(e.m, 1);
    }
  }
}

describe('pure helpers', () => {
  it('coverage and validity', () => {
    expect(inCoverage({ lat: 13, lng: 80 })).toBe(true);
    expect(inCoverage({ lat: 80, lng: 13 })).toBe(false); // swapped lat/lng
    expect(validPoint({ lat: Number.NaN, lng: 1 })).toBe(false);
    expect(validPoint({ lat: 91, lng: 1 })).toBe(false);
    expect(validPoint(null)).toBe(false);
  });
  it('graph version from /info needs a data or import date', () => {
    expect(graphVersionOf({ version: '11.1', dataDate: 'd', importDate: 'i', profiles: [] })).toBe('gh-11.1|d|i');
    expect(graphVersionOf({ version: '11.1', dataDate: null, importDate: null, profiles: [] })).toBeNull();
  });
  it('legsAgree tolerances and sampleLegs spread', () => {
    expect(legsAgree({ s: 100, m: 1000 }, { s: 100.4, m: 1001 })).toBe(true);
    expect(legsAgree({ s: 100, m: 1000 }, { s: 103, m: 1000 })).toBe(false);
    expect(legsAgree({ s: 100, m: 1000 }, { s: 100, m: 1030 })).toBe(false);
    expect(sampleLegs(2, 3)).toEqual([0, 1]);
    expect(sampleLegs(50, 3)).toEqual([8, 25, 41]);
  });
});

describe('MatrixBuilder against the matrix stub', () => {
  const stub = new GraphHopperMatrixStub();
  let url = '';
  beforeAll(async () => {
    url = await stub.start();
  });
  afterAll(() => stub.stop());
  beforeEach(() => {
    Object.assign(stub, { mode: 'up', hangRoute: false, failEvery: 0, legDelayMs: 0, legDetails: true, walkSkew: 1 });
    stub.offRoad = () => false;
    stub.island = () => 'main';
    stub.noExit = () => false;
    stub.snapOffsetM = () => 3;
    stub.reset();
  });

  const pts = syntheticPoints(8);

  it('full matrix: exact engine numbers, asymmetric, diagonal 0, provenance, via walks', async () => {
    const { builder } = testBuilder(url);
    const b = await builder.buildMatrix(pts, 'car');
    expect(b.status).toBe('COMPLETE');
    expect(b.degraded).toBeNull();
    expect(b.unknownCells).toEqual([]);
    expectExact(pts, b.durationsS, b.distancesM);
    expect(b.durationsS[0][1]).not.toBe(b.durationsS[1][0]); // no symmetric shortcut
    expect(b.graphVersion).toBe('gh-11.1|2026-11-01T00:00:00Z|2026-11-10T02:00:00Z');
    expect(b.eta).toEqual({ source: 'engine_free_flow', calibrated: false, liveTraffic: false });
    expect(b.stats).toMatchObject({ requested: 56, computed: 56, cached: 0, unknown: 0, strategy: 'walk' });
    expect(b.points.every((p) => p.issue === null && p.snapDistanceM !== null && p.snapDistanceM < 5)).toBe(true);
    // 8 snaps + probe walk + check pairs + Euler walks: far fewer than 56 single routes.
    expect(stub.calls.snap).toBe(8);
    expect(stub.calls.walk + stub.calls.pair).toBeLessThan(15);
    expect(builder.walkTrustOf(b.graphVersion!)).toBe('trusted');
  });

  it('pairwise strategy gives the same numbers with one request per cell', async () => {
    const { builder } = testBuilder(url, { strategy: 'pairwise' });
    const b = await builder.buildMatrix(pts, 'car');
    expect(b.status).toBe('COMPLETE');
    expectExact(pts, b.durationsS, b.distancesM);
    expect(stub.calls.walk).toBe(0);
    expect(stub.calls.pair).toBe(56);
    expect(b.stats.strategy).toBe('pairwise');
  });

  it('second build is served from the cache (no route calls); a new graph version misses', async () => {
    const client = new MemoryCacheClient();
    const { builder } = testBuilder(url, {}, client);
    await builder.buildMatrix(pts, 'car');
    stub.reset();
    const again = await builder.buildMatrix(pts, 'car');
    expect(again.status).toBe('COMPLETE');
    expect(again.stats).toMatchObject({ cached: 56, computed: 0 });
    expect(stub.calls.pair + stub.calls.walk + stub.calls.snap).toBe(0);
    expectExact(pts, again.durationsS, again.distancesM);
    // No coordinate in any key.
    expect([...client.data.keys()].some((k) => /13\.|80\./.test(k))).toBe(false);

    const { builder: other } = testBuilder(url, { graphVersion: 'gh-11.1|reimported' }, client);
    stub.reset();
    const fresh = await other.buildMatrix(pts, 'car');
    expect(fresh.stats.cached).toBe(0);
    expect(fresh.graphVersion).toBe('gh-11.1|reimported');
    expect(stub.calls.snap).toBe(8);
  });

  it('noCacheRead recomputes but still writes', async () => {
    const client = new MemoryCacheClient();
    const { builder } = testBuilder(url, {}, client);
    await builder.buildMatrix(pts.slice(0, 4), 'car');
    stub.reset();
    const b = await builder.buildMatrix(pts.slice(0, 4), 'car', { noCacheRead: true });
    expect(b.stats.cached).toBe(0);
    expect(stub.calls.snap).toBe(4);
  });

  it('reports bad points instead of dropping them: invalid, outside coverage, off road, far from road', async () => {
    const input: MatrixPoint[] = [pts[0], { lat: Number.NaN, lng: 80 }, { lat: 80.27, lng: 13.08 }, pts[3], pts[4], pts[5]];
    stub.offRoad = (lat) => lat === pts[3].lat;
    stub.snapOffsetM = (lat) => (lat === pts[4].lat ? 900 : 3);
    const { builder } = testBuilder(url);
    const b = await builder.buildMatrix(input, 'car');
    expect(b.status).toBe('COMPLETE');
    expect(b.points.map((p) => p.issue)).toEqual([null, 'INVALID_INPUT', 'OUTSIDE_COVERAGE', 'POINT_NOT_ON_ROAD', 'FAR_FROM_ROAD', null]);
    expect(b.points[4]).toMatchObject({ excluded: true, snapDistanceM: expect.closeTo(900, 0) });
    for (const i of [1, 2, 3, 4]) {
      expect(b.durationsS[i].every((v) => v === null)).toBe(true);
      expect(b.durationsS.every((row) => row[i] === null)).toBe(true);
    }
    expect(b.durationsS[0][5]).toBeCloseTo(expected(input[0], input[5]).s, 3);
    expect(b.stats.excluded).toBe(30 - 2);
  });

  it('per-call snap limit override', async () => {
    stub.snapOffsetM = () => 80;
    const { builder } = testBuilder(url);
    const b = await builder.buildMatrix(pts.slice(0, 3), 'car', { maxSnapDistanceM: 50 });
    expect(b.points.every((p) => p.issue === 'FAR_FROM_ROAD')).toBe(true);
  });

  it('isolates a disconnected point: proven no-route cells without asking, the rest exact', async () => {
    const island = pts[5];
    stub.island = (lat) => (lat === island.lat ? 'island' : 'main');
    const { builder } = testBuilder(url);
    const b = await builder.buildMatrix(pts, 'car');
    expect(b.status).toBe('COMPLETE');
    expect(b.points[5]).toMatchObject({ issue: 'DISCONNECTED', excluded: true });
    expect(b.durationsS[5].filter((v, j) => j !== 5 && v !== null)).toEqual([]);
    expect(b.durationsS.filter((row, i) => i !== 5 && row[5] !== null)).toEqual([]);
    expect(b.stats.inferred).toBeGreaterThan(0);
    expect(b.stats.noRoute).toBe(14);
    expectExact(pts, b.durationsS, b.distancesM, (i, j) => i === 5 || j === 5);
  });

  it('a one-way trap (reachable, cannot leave) keeps its incoming cells and gets proven no-route outgoing cells', async () => {
    const trap = pts[2];
    stub.noExit = (lat) => lat === trap.lat;
    const { builder } = testBuilder(url);
    const b = await builder.buildMatrix(pts, 'car');
    expect(b.status).toBe('COMPLETE');
    expect(b.points[2].issue).toBeNull();
    for (let j = 0; j < 8; j++) if (j !== 2) expect(b.durationsS[2][j]).toBeNull();
    for (let i = 0; i < 8; i++) if (i !== 2) expect(b.durationsS[i][2]).toBeCloseTo(expected(pts[i], trap).s, 3);
    expect(b.stats.inferred).toBeGreaterThan(0);
  });

  it('the island anchor case: when the first point is the island the probe moves to another anchor', async () => {
    stub.island = (lat) => (lat === pts[0].lat ? 'island' : 'main');
    const { builder } = testBuilder(url);
    const b = await builder.buildMatrix(pts, 'car');
    expect(b.status).toBe('COMPLETE');
    expect(b.points[0].issue).toBe('DISCONNECTED');
    expectExact(pts, b.durationsS, b.distancesM, (i, j) => i === 0 || j === 0);
  });

  it('sparse pairs: only those cells are computed, everything else is null', async () => {
    const pairs: [number, number][] = [
      [0, 1],
      [1, 0],
      [2, 7],
      [7, 2],
      [3, 3],
    ];
    const { builder } = testBuilder(url, { strategy: 'pairwise' });
    const b = await builder.buildMatrix(pts, 'car', { pairs });
    expect(b.status).toBe('COMPLETE');
    expect(b.stats.requested).toBe(4);
    expect(b.durationsS[0][1]).toBeCloseTo(expected(pts[0], pts[1]).s, 3);
    expect(b.durationsS[2][7]).toBeCloseTo(expected(pts[2], pts[7]).s, 3);
    expect(b.durationsS[0][2]).toBeNull();
    expect(stub.calls.snap).toBe(4); // only involved points
  });

  it('walk check: walks that disagree with single routes are rejected for the graph; numbers come from pairs', async () => {
    stub.walkSkew = 1.5;
    const { builder } = testBuilder(url);
    const b = await builder.buildMatrix(pts, 'car');
    expect(b.status).toBe('COMPLETE');
    expectExact(pts, b.durationsS, b.distancesM);
    expect(builder.walkTrustOf(b.graphVersion!)).toBe('rejected');
    expect(b.stats.walkLegs).toBe(0);
  });

  it('walks without leg details: graph marked unsupported, pairs used, numbers exact', async () => {
    stub.legDetails = false;
    const { builder } = testBuilder(url);
    const b = await builder.buildMatrix(pts.slice(0, 5), 'car');
    expect(b.status).toBe('COMPLETE');
    expectExact(pts.slice(0, 5), b.durationsS, b.distancesM);
    expect(builder.walkTrustOf(b.graphVersion!)).toBe('unsupported');
    expect(stub.calls.walk).toBe(1);
  });

  it('partial engine failures are retried once and the matrix completes', async () => {
    stub.failEvery = 7;
    const { builder } = testBuilder(url, { strategy: 'pairwise' });
    const b = await builder.buildMatrix(pts, 'car');
    expect(stub.calls.failed).toBeGreaterThan(0);
    expect(b.status).toBe('COMPLETE');
    expectExact(pts, b.durationsS, b.distancesM);
  });

  it('engine down before the build → UNAVAILABLE, no numbers', async () => {
    const { builder } = testBuilder('http://127.0.0.1:1');
    const b = await builder.buildMatrix(pts, 'car');
    expect(b.status).toBe('UNAVAILABLE');
    expect(b.degraded).toMatchObject({ reason: 'ENGINE_UNREACHABLE', retryAfterS: 60 });
    expect(b.durationsS.flat().every((v) => v === null)).toBe(true);
  });

  it('engine failing every route mid-build → breaker stops it, cells unknown (not no-route)', async () => {
    stub.failEvery = 1;
    const { builder } = testBuilder(url, { failLimit: 5 });
    const b = await builder.buildMatrix(pts, 'car');
    expect(b.status).toBe('UNAVAILABLE');
    expect(b.degraded?.reason).toBe('ENGINE_UNREACHABLE');
    expect(b.degraded?.message).toMatch(/Stopped after 5/);
    expect(b.unknownCells).toHaveLength(56);
    expect(b.stats.noRoute).toBe(0);
    expect(stub.calls.failed).toBeLessThan(20);
  });

  it('engine hanging on routes → the budget ends the build with unknown cells', async () => {
    stub.hangRoute = true;
    const { builder } = testBuilder(url, { budgetMs: 400 });
    const t0 = Date.now();
    const b = await builder.buildMatrix(pts.slice(0, 4), 'car');
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(b.status).toBe('UNAVAILABLE');
    expect(b.degraded?.reason).toBe('ENGINE_TIMEOUT');
    expect(b.unknownCells.length).toBe(12);
    expect(b.degraded?.message).not.toMatch(/\.\./); // QA B7: no double full stop
    expect(b.points.every((p) => p.issue === 'NOT_CHECKED')).toBe(true);
  });

  it('a whole-engine hang (health too) answers UNAVAILABLE within the health timeout', async () => {
    stub.mode = 'hang';
    const { builder } = testBuilder(url);
    const b = await builder.buildMatrix(pts.slice(0, 3), 'car');
    expect(b.status).toBe('UNAVAILABLE');
    expect(b.degraded?.reason).toBe('ENGINE_TIMEOUT');
  }, 10_000);

  it('a slow engine mid-build gives a PARTIAL result that a retry completes from the cache', async () => {
    stub.legDelayMs = 40;
    const client = new MemoryCacheClient();
    const { builder } = testBuilder(url, { strategy: 'pairwise', budgetMs: 700, concurrency: 2 }, client);
    const first = await builder.buildMatrix(pts, 'car');
    expect(first.status).toBe('PARTIAL');
    expect(first.degraded?.reason).toBe('ENGINE_TIMEOUT');
    expect(first.unknownCells.length).toBeGreaterThan(0);
    for (const [i, j] of first.unknownCells) expect(first.durationsS[i][j]).toBeNull();
    stub.legDelayMs = 0;
    const second = await builder.buildMatrix(pts, 'car', { budgetMs: 20_000 });
    expect(second.status).toBe('COMPLETE');
    expect(second.stats.cached).toBeGreaterThan(0);
    expectExact(pts, second.durationsS, second.distancesM);
  });

  it('cancel signal stops the build', async () => {
    stub.legDelayMs = 30;
    const ac = new AbortController();
    const { builder } = testBuilder(url, { strategy: 'pairwise', concurrency: 1 });
    const p = builder.buildMatrix(pts, 'car', { signal: ac.signal });
    setTimeout(() => ac.abort(), 250);
    const b = await p;
    expect(b.status).not.toBe('COMPLETE');
    expect(b.degraded?.reason).toBe('LIMIT_EXCEEDED');
    expect(b.degraded?.message).toMatch(/cancelled/);
  });

  it('keeps engine requests in flight at or below the concurrency cap', async () => {
    await new Promise((r) => setTimeout(r, 400)); // let requests abandoned by earlier tests finish on the stub
    stub.reset();
    stub.legDelayMs = 5;
    const { builder } = testBuilder(url, { strategy: 'pairwise', concurrency: 2 });
    await builder.buildMatrix(pts, 'car');
    expect(stub.maxInFlight).toBeLessThanOrEqual(2);
    expect(stub.maxInFlight).toBeGreaterThan(0);
  });

  it('progress callback reaches requested / requested', async () => {
    const seen: [number, number][] = [];
    const { builder } = testBuilder(url);
    await builder.buildMatrix(pts.slice(0, 5), 'car', { onProgress: (d, t) => void seen.push([d, t]) });
    expect(seen[seen.length - 1]).toEqual([20, 20]);
  });

  it('gating and limits: ETMS_ROUTING off, no engine, profile, size, pairs, busy', async () => {
    const off = new MatrixBuilder(readMatrixConfig({}), { engine: null, reason: 'ENGINE_DISABLED', message: 'x' }, new MatrixCache(null, 's', 60, 0));
    expect(off.enabled).toBe(false);
    expect((await off.buildMatrix(pts, 'car')).degraded?.reason).toBe('ENGINE_DISABLED');
    expect((await off.snapPoints(pts.slice(0, 1))).ok).toBe(false);
    const noEngine = new MatrixBuilder(testConfig(), { engine: null, reason: 'ENGINE_NOT_SUPPORTED', message: 'valhalla' }, new MatrixCache(null, 's', 60, 0));
    expect((await noEngine.buildMatrix(pts, 'car')).degraded).toMatchObject({ reason: 'ENGINE_NOT_SUPPORTED', message: 'valhalla' });
    const { builder } = testBuilder(url, { maxPoints: 5, maxBuilds: 1, queue: 0 });
    expect((await builder.buildMatrix(pts.slice(0, 3), 'foot')).degraded?.reason).toBe('PROFILE_NOT_AVAILABLE');
    expect((await builder.buildMatrix(pts, 'car')).degraded?.reason).toBe('LIMIT_EXCEEDED');
    expect((await builder.buildMatrix(pts.slice(0, 3), 'car', { pairs: [[0, 9]] })).degraded?.reason).toBe('INVALID_INPUT');
    stub.legDelayMs = 50;
    const running = builder.buildMatrix(pts.slice(0, 4), 'car');
    const busy = await builder.buildMatrix(pts.slice(0, 3), 'car');
    expect(busy.degraded).toMatchObject({ reason: 'LIMIT_EXCEEDED', retryAfterS: 30 });
    expect((await running).status).toBe('COMPLETE');
    expect(stub.calls.pair + stub.calls.walk).toBeGreaterThan(0);
  });

  it('records metrics for every build', async () => {
    const { builder } = testBuilder(url);
    await builder.buildMatrix(pts.slice(0, 4), 'car');
    await builder.buildMatrix(pts.slice(0, 4), 'car');
    const s = builder.metrics.snapshot();
    expect(s.builds).toBe(2);
    expect(s.degraded).toBe(0);
    expect(s.cacheHitRatio).toBe(0.5);
    expect(s.last?.status).toBe('COMPLETE');
  });

  it('snapPoints (locate): on-road flags and distances; engine down fails the whole call', async () => {
    stub.offRoad = (lat) => lat === pts[1].lat;
    const { builder } = testBuilder(url);
    const r = await builder.snapPoints([pts[0], pts[1], { lat: 50, lng: 10 }]);
    expect(r).toEqual({ ok: true, value: [{ onRoad: true, snapDistanceM: expect.closeTo(3, 0) }, { onRoad: false, snapDistanceM: -1 }, { onRoad: false, snapDistanceM: -1 }] });
    expect(await builder.snapPoints([{ lat: Number.NaN, lng: 1 }])).toMatchObject({ ok: false, reason: 'INVALID_INPUT' });
    const { builder: down } = testBuilder('http://127.0.0.1:1');
    expect(await down.snapPoints([pts[0]])).toMatchObject({ ok: false, reason: 'ENGINE_UNREACHABLE' });
  });

  it('graph version: configured value wins; /info failure disables the cache but not the build', async () => {
    const { builder: fixed } = testBuilder(url, { graphVersion: 'fixed-v1' });
    expect((await fixed.buildMatrix(pts.slice(0, 3), 'car')).graphVersion).toBe('fixed-v1');
    stub.info = { version: '11.1', profiles: [{ name: 'car' }] }; // no dates
    const client = new MemoryCacheClient();
    const { builder } = testBuilder(url, {}, client);
    const b = await builder.buildMatrix(pts.slice(0, 3), 'car');
    expect(b.status).toBe('COMPLETE');
    expect(b.graphVersion).toBeNull();
    expect(client.data.size).toBe(0);
    stub.info = { version: '11.1', data_date: '2026-11-01T00:00:00Z', import_date: '2026-11-10T02:00:00Z', profiles: [{ name: 'car' }] };
  });
});

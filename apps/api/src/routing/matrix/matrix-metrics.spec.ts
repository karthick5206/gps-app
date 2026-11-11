import { readMatrixConfig } from './matrix-config';
import { matrixHealthIssues, MatrixMetrics, parseMatrixStats } from './matrix-metrics';
import type { MatrixBuild } from './matrix-types';

function build(status: MatrixBuild['status'], computed: number, durationMs: number, cached = 0, reason: MatrixBuild['degraded'] = null): MatrixBuild {
  return {
    status,
    degraded: reason,
    graphVersion: 'g',
    profile: 'car',
    durationsS: [],
    distancesM: [],
    unknownCells: [],
    points: [],
    stats: {
      points: 10,
      requested: 90,
      cached,
      computed,
      inferred: 0,
      noRoute: 0,
      unknown: status === 'COMPLETE' ? 0 : 90 - computed - cached,
      excluded: 0,
      engineCalls: { snap: 0, pair: 0, walk: 0 },
      walkLegs: 0,
      strategy: 'walk',
      cacheWrites: 0,
      cacheFull: false,
      durationMs,
    },
    eta: { source: 'engine_free_flow', calibrated: false, liveTraffic: false },
  };
}

describe('MatrixMetrics', () => {
  it('summarises builds: ms per cell percentiles, cache hit ratio, degraded reasons, publish hook', async () => {
    const m = new MatrixMetrics();
    const published: unknown[] = [];
    m.publish = async (s) => published.push(s);
    m.recordBuild(build('COMPLETE', 90, 900), 1000);
    m.recordBuild(build('COMPLETE', 0, 5, 90), 2000);
    m.recordBuild(build('PARTIAL', 45, 9000, 0, { reason: 'ENGINE_TIMEOUT', message: 'slow' }), 3000);
    const s = m.snapshot(4000);
    expect(s).toMatchObject({ builds: 3, degraded: 1, reasons: { ENGINE_TIMEOUT: 1 }, p50MsPerCell: 10, p95MsPerCell: 200, lastOkAt: 2000, lastDegradedAt: 3000 });
    expect(s.cacheHitRatio).toBeCloseTo(90 / 270, 3);
    expect(s.last).toMatchObject({ status: 'PARTIAL', reason: 'ENGINE_TIMEOUT', msPerCell: 200 });
    expect(published).toHaveLength(3);
    expect(parseMatrixStats(JSON.stringify(s))).toEqual(s);
    expect(parseMatrixStats('nope')).toBeNull();
    expect(parseMatrixStats(null)).toBeNull();
    expect(parseMatrixStats('{"x":1}')).toBeNull();
  });

  it('keeps a bounded window and survives a failing publish', () => {
    const m = new MatrixMetrics();
    m.publish = () => Promise.reject(new Error('valkey down'));
    for (let i = 0; i < 80; i++) m.recordBuild(build('COMPLETE', 90, 90));
    expect(m.snapshot().builds).toBe(50);
  });
});

describe('matrixHealthIssues', () => {
  const now = 10_000_000;
  it('nothing without a recent snapshot', () => {
    expect(matrixHealthIssues(null, now)).toEqual([]);
    const m = new MatrixMetrics();
    m.recordBuild(build('PARTIAL', 0, 10), now - 2 * 3600_000);
    expect(matrixHealthIssues(m.snapshot(now - 2 * 3600_000), now)).toEqual([]);
  });
  it('WARN for a degraded last build and for slow cells', () => {
    const m = new MatrixMetrics();
    m.recordBuild(build('PARTIAL', 10, 5000, 0, { reason: 'ENGINE_TIMEOUT', message: 'x' }), now);
    const issues = matrixHealthIssues(m.snapshot(now), now);
    expect(issues.map((i) => `${i.id}:${i.severity}`)).toEqual(['maps.etms-matrix:WARN', 'maps.etms-matrix-slow:WARN']);
    expect(issues[0].message).toMatch(/partial \(ENGINE_TIMEOUT\)/);
    const ok = new MatrixMetrics();
    ok.recordBuild(build('COMPLETE', 90, 450), now);
    expect(matrixHealthIssues(ok.snapshot(now), now)).toEqual([]);
  });
});

describe('readMatrixConfig', () => {
  it('defaults: off, 3 in flight, 120 s budget, auto strategy, 200k cached cells', () => {
    const c = readMatrixConfig({});
    expect(c).toMatchObject({ enabled: false, concurrency: 3, maxBuilds: 2, budgetMs: 120_000, strategy: 'auto', legsPerRequest: 50, maxPoints: 600, cacheMaxCells: 200_000, graphVersion: null, cacheSecret: null });
  });
  it('clamps numbers, reads the secret fallback and the strategy', () => {
    const c = readMatrixConfig({ ETMS_ROUTING: 'ON', ETMS_MATRIX_CONCURRENCY: '64', ETMS_MATRIX_STRATEGY: 'pairwise', JWT_SECRET: 'j', ETMS_MATRIX_BUDGET_MS: 'x', ETMS_ROUTING_GRAPH_VERSION: ' gv ' });
    expect(c).toMatchObject({ enabled: true, concurrency: 8, strategy: 'pairwise', cacheSecret: 'j', budgetMs: 120_000, graphVersion: 'gv' });
    expect(readMatrixConfig({ ETMS_MATRIX_STRATEGY: 'weird' }).strategy).toBe('auto');
    expect(readMatrixConfig({ ETMS_ROUTING_CACHE_SECRET: 's', JWT_SECRET: 'j' }).cacheSecret).toBe('s');
  });
});

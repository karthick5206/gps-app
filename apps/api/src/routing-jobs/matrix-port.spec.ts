import type { MatrixBuild } from '../routing/matrix/matrix-types';
import { JobError } from './job-worker';
import { builderMatrixPort, SPARSE_ABOVE_POINTS } from './matrix-port';
import { planPoints, solverProblem } from './optimize-problem';
import { syntheticPlan, testMatrix } from './testing/fakes';

const pts = (n: number) => Array.from({ length: n }, (_, i) => ({ lat: 13 + i / 1000, lng: 80.2 + i / 1000 }));

function build(n: number, over: Partial<MatrixBuild> = {}): MatrixBuild {
  const m = testMatrix(n, 'gh-11.1/2026-11-10');
  return {
    status: 'COMPLETE',
    degraded: null,
    graphVersion: m.graphVersion,
    profile: 'car',
    durationsS: m.durationsS,
    distancesM: m.distancesM,
    unknownCells: [],
    points: Array.from({ length: n }, (_, index) => ({ index, snapDistanceM: 12.4, issue: null, excluded: false })),
    stats: { points: n, requested: n * (n - 1), cached: 2, computed: n * (n - 1) - 2, inferred: 0, noRoute: 0, unknown: 0, excluded: 0, engineCalls: { snap: 1, pair: 0, walk: 1 }, walkLegs: 0, strategy: 'walk', cacheWrites: 0, cacheFull: false, durationMs: 5 },
    eta: { source: 'engine_free_flow', calibrated: false, liveTraffic: false },
    ...over,
  };
}

describe('builderMatrixPort (E4-B MatrixBuilder → worker)', () => {
  it('COMPLETE: matrix, snap distances, graph version and cell counts pass through; small plans are dense', async () => {
    const buildMatrix = jest.fn(async (p: { lat: number; lng: number }[]) => build(p.length));
    const r = await builderMatrixPort({ buildMatrix } as never).build(pts(4), 'car', { depots: [0, 1] });
    expect(r.ok && r.value).toMatchObject({ graphVersion: 'gh-11.1/2026-11-10', cells: { requested: 12, cached: 2, computed: 10 }, invalid: [] });
    expect(r.ok && r.value.snapped[0]).toEqual({ snapDistanceM: 12.4 });
    expect((buildMatrix.mock.calls[0] as unknown[])[2]).not.toHaveProperty('pairs');
  });

  it('large plans use k-nearest pairs that always include the depot / site legs', async () => {
    const buildMatrix = jest.fn(async (p: { lat: number; lng: number }[]) => build(p.length));
    await builderMatrixPort({ buildMatrix } as never).build(pts(SPARSE_ABOVE_POINTS + 5), 'car', { depots: [0, 1] });
    const pairs = ((buildMatrix.mock.calls[0] as unknown[])[2] as { pairs: [number, number][] }).pairs;
    expect(pairs.length).toBeGreaterThan(0);
    expect(pairs).toContainEqual([0, SPARSE_ABOVE_POINTS + 4]);
    expect(pairs).toContainEqual([SPARSE_ABOVE_POINTS + 4, 1]);
  });

  it('excluded points become per-stop reasons (never dropped silently)', async () => {
    const b = build(5, {
      points: [
        { index: 0, snapDistanceM: 3, issue: null, excluded: false },
        { index: 1, snapDistanceM: 4, issue: null, excluded: false },
        { index: 2, snapDistanceM: 900, issue: 'FAR_FROM_ROAD', excluded: true },
        { index: 3, snapDistanceM: null, issue: 'OUTSIDE_COVERAGE', excluded: true },
        { index: 4, snapDistanceM: 5, issue: 'DISCONNECTED', excluded: true },
      ],
    });
    const r = await builderMatrixPort({ buildMatrix: async () => b } as never).build(pts(5), 'car');
    expect(r.ok && r.value.invalid).toEqual([
      { index: 2, reason: 'far_from_road' },
      { index: 3, reason: 'outside_coverage' },
      { index: 4, reason: 'unreachable_location' },
    ]);
  });

  it('PARTIAL is never solved on: MATRIX_INCOMPLETE (retried; the cache resumes)', async () => {
    const b = build(3, { status: 'PARTIAL', degraded: { reason: 'ENGINE_TIMEOUT', message: 'budget' }, unknownCells: [[0, 2]] });
    expect(await builderMatrixPort({ buildMatrix: async () => b } as never).build(pts(3), 'car')).toMatchObject({ ok: false, degraded: 'MATRIX_INCOMPLETE' });
  });

  it('builder queue full (LIMIT_EXCEEDED + retryAfterS) → MATRIX_BUSY (retried); engine down → ENGINE_UNREACHABLE; disabled → final reason', async () => {
    const port = (d: MatrixBuild['degraded']) => builderMatrixPort({ buildMatrix: async () => build(2, { status: 'UNAVAILABLE', degraded: d }) } as never);
    expect(await port({ reason: 'LIMIT_EXCEEDED', message: 'queue full', retryAfterS: 5 }).build(pts(2), 'car')).toMatchObject({ ok: false, degraded: 'MATRIX_BUSY', retryAfterS: 5 });
    expect(await port({ reason: 'ENGINE_UNREACHABLE', message: 'down' }).build(pts(2), 'car')).toMatchObject({ ok: false, degraded: 'ENGINE_UNREACHABLE' });
    expect(await port({ reason: 'ENGINE_DISABLED', message: 'off' }).build(pts(2), 'car')).toMatchObject({ ok: false, degraded: 'ENGINE_DISABLED' });
  });

  it('a cancelled job does not use the answer', async () => {
    const ac = new AbortController();
    const port = builderMatrixPort({
      buildMatrix: async () => {
        ac.abort(new JobError('CANCELLED', 'c'));
        return build(2);
      },
    } as never);
    await expect(port.build(pts(2), 'car', { signal: ac.signal })).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});

describe('locks and pins in the solver problem', () => {
  it('a pinned stop is sent with pinnedVehicleId (only for a vehicle in the solve)', () => {
    const inp = syntheticPlan();
    inp.stops[0].pinnedAssignmentId = 'veh-b';
    inp.stops[1].pinnedAssignmentId = 'veh-locked';
    const p = solverProblem(inp, planPoints(inp), testMatrix(5), { timeLimitS: 5 });
    expect(p.stops[0]).toMatchObject({ id: 'pick-1', pinnedVehicleId: 'veh-b' });
    expect(p.stops[1]).not.toHaveProperty('pinnedVehicleId');
  });
  it('every vehicle locked → a clear INVALID_INPUT', () => {
    expect(() => planPoints(syntheticPlan({ vehicles: [], lockedAssignmentIds: ['veh-a'] }))).toThrow(/Every vehicle of the plan is locked/);
  });
});

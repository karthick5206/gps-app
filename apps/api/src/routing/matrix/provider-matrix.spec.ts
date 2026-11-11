import { GraphHopperProvider } from '../provider/graphhopper.provider';
import { createMatrixBuilder, matrixEngineSource } from './matrix.factory';
import { squareOf } from './provider-matrix';
import { GraphHopperMatrixStub, stubLeg } from './testing/gh-matrix-stub';
import { syntheticPoints, testBuilder } from './testing/matrix-test-kit';

const [A, B, C, D] = syntheticPoints(4);
const exp = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => stubLeg([a.lat, a.lng], [b.lat, b.lng]).time / 1000;

describe('squareOf', () => {
  it('a square request with identical sources and targets stays a full matrix', () => {
    expect(squareOf({ sources: [A, B, C], targets: [A, B, C], profile: 'car' })).toEqual({ points: [A, B, C], srcIndex: [0, 1, 2], tgtIndex: [0, 1, 2], pairs: undefined });
  });
  it('rectangular requests merge points (dedupe at ~1 m) and request only sources × targets', () => {
    const sq = squareOf({ sources: [A, B], targets: [{ lat: B.lat + 0.000001, lng: B.lng }, C], profile: 'car' });
    expect(sq.points).toHaveLength(3);
    expect(sq.tgtIndex).toEqual([1, 2]);
    expect(sq.pairs).toEqual([
      [0, 1],
      [0, 2],
      [1, 1],
      [1, 2],
    ]);
  });
  it('sparse pairs map through the merged indexes', () => {
    expect(squareOf({ sources: [A, B], targets: [C, D], profile: 'car', pairs: [[1, 0]] }).pairs).toEqual([[1, 2]]);
  });
});

describe('GraphHopperProvider.matrix / locate with the M1 builder', () => {
  const stub = new GraphHopperMatrixStub();
  let url = '';
  beforeAll(async () => {
    url = await stub.start();
  });
  afterAll(() => stub.stop());
  beforeEach(() => {
    stub.mode = 'up';
    stub.offRoad = () => false;
    stub.reset();
  });

  const provider = (over = {}) => new GraphHopperProvider({ state: 'graphhopper', baseUrl: url }).attachMatrix(testBuilder(url, over).builder);

  it('returns sources × targets numbers with provenance and cell counts', async () => {
    const r = await provider().matrix({ sources: [A, B], targets: [C, D], profile: 'car' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.durationsS[0][1]).toBeCloseTo(exp(A, D), 3);
    expect(r.value.durationsS[1][0]).toBeCloseTo(exp(B, C), 3);
    expect(r.value.cells).toEqual({ requested: 4, computed: 4, cached: 0 });
    expect(r.eta).toMatchObject({ source: 'engine_free_flow', calibrated: false, graphVersion: 'gh-11.1|2026-11-01T00:00:00Z|2026-11-10T02:00:00Z' });
    expect(r.attribution).toMatch(/OpenStreetMap/);
  });

  it('a source equal to a target gets 0 on its own cell; unrequested sparse cells are null', async () => {
    const r = await provider().matrix({ sources: [A, B], targets: [A, C], profile: 'car', pairs: [[1, 1]] });
    expect(r.ok && r.value.durationsS).toEqual([
      [null, null],
      [null, expect.closeTo(exp(B, C), 3)],
    ]);
    const full = await provider().matrix({ sources: [A], targets: [A, B], profile: 'car' });
    expect(full.ok && full.value.durationsS[0][0]).toBe(0);
  });

  it('lists excluded points per side with a provider reason', async () => {
    stub.offRoad = (lat) => lat === D.lat;
    const r = await provider().matrix({ sources: [A, D], targets: [B, { lat: 80, lng: 13 }], profile: 'car' });
    expect(r.ok && r.value.invalid).toEqual([
      { side: 'source', index: 1, reason: 'POINT_NOT_ON_ROAD' },
      { side: 'target', index: 1, reason: 'OUTSIDE_COVERAGE' },
    ]);
  });

  it('anything but a complete build is ok:false with the reason (no partial numbers)', async () => {
    stub.mode = 'error';
    expect(await provider().matrix({ sources: [A, B], targets: [C], profile: 'car' })).toMatchObject({ ok: false, degraded: 'ENGINE_UNREACHABLE', retryAfterS: 60 });
    stub.mode = 'up';
    expect(await provider().matrix({ sources: [A], targets: [B], profile: 'car', pairs: [[0, 5]] })).toMatchObject({ ok: false, degraded: 'INVALID_INPUT' });
    expect(await provider({ enabled: false }).matrix({ sources: [A], targets: [B], profile: 'car' })).toMatchObject({ ok: false, degraded: 'ENGINE_DISABLED' });
    expect(await provider().matrix({ sources: [A], targets: [B], profile: 'bus' })).toMatchObject({ ok: false, degraded: 'PROFILE_NOT_AVAILABLE' });
  });

  it('locate and capabilities', async () => {
    stub.offRoad = (lat) => lat === B.lat;
    expect(await provider().locate([A, B])).toMatchObject({ ok: true, value: [{ onRoad: true }, { onRoad: false, snapDistanceM: -1 }] });
    const caps = await provider().capabilities();
    expect(caps.ok && caps.value.matrix).toEqual({ native: false, maxSyncCells: 2500, maxAsyncCells: 360_000 });
    const plain = await new GraphHopperProvider({ state: 'graphhopper', baseUrl: url }).capabilities();
    expect(plain.ok && plain.value.matrix.maxSyncCells).toBe(0);
  });
});

describe('matrix.factory', () => {
  it('engine source follows the single ROUTER_URL / ROUTER_ENGINE config', () => {
    expect(matrixEngineSource({ state: 'graphhopper', baseUrl: 'http://127.0.0.1:8989' }).engine).not.toBeNull();
    expect(matrixEngineSource({ state: 'disabled', message: 'off' })).toMatchObject({ engine: null, reason: 'ENGINE_DISABLED' });
    expect(matrixEngineSource({ state: 'refused', engine: 'valhalla', message: 'no' })).toMatchObject({ engine: null, reason: 'ENGINE_NOT_SUPPORTED' });
  });
  it('off by default; on with ETMS_ROUTING=on and a GraphHopper ROUTER_URL', () => {
    expect(createMatrixBuilder(null, {}).enabled).toBe(false);
    expect(createMatrixBuilder(null, { ETMS_ROUTING: 'on' }).enabled).toBe(false); // no ROUTER_URL
    expect(createMatrixBuilder(null, { ETMS_ROUTING: 'on', ROUTER_URL: 'http://127.0.0.1:8989', ROUTER_ENGINE: 'graphhopper' }).enabled).toBe(true);
    expect(createMatrixBuilder(null, { ETMS: 'off', ETMS_ROUTING: 'on', ROUTER_URL: 'http://127.0.0.1:8989', ROUTER_ENGINE: 'graphhopper' }).enabled).toBe(false);
    expect(createMatrixBuilder(null, { ETMS_ROUTING: 'on', ROUTER_URL: 'http://127.0.0.1:8989' }).enabled).toBe(false); // R-3: engine unset
  });
});

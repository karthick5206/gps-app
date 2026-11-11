import { classifyError, GraphHopperMatrixEngine, legDetail, thrownFailure, walkTimeoutMs } from './gh-matrix-client';
import { GraphHopperMatrixStub, stubLeg } from './testing/gh-matrix-stub';

const A = { lat: 13.0827, lng: 80.2707 };
const B = { lat: 13.0604, lng: 80.2496 };
const C = { lat: 13.1, lng: 80.29 };

describe('classifyError (GraphHopper 11 error JSON)', () => {
  it('maps point-not-found with its index (hint or message)', () => {
    expect(classifyError(400, { message: 'Cannot find point 1: 13.0,80.0', hints: [{ point_index: 1, details: 'com.graphhopper.util.exceptions.PointNotFoundException' }] })).toEqual({ kind: 'nopoint', pointIndex: 1 });
    expect(classifyError(400, { message: 'Cannot find point 3: 1,2' })).toEqual({ kind: 'nopoint', pointIndex: 3 });
  });
  it('maps no connection to noroute, out of bounds to outside', () => {
    expect(classifyError(400, { message: 'Connection between locations not found' })).toEqual({ kind: 'noroute' });
    expect(classifyError(400, { message: 'x', hints: [{ details: 'com.graphhopper.util.exceptions.ConnectionNotFoundException' }] })).toEqual({ kind: 'noroute' });
    expect(classifyError(400, { message: 'Point 0 is out of bounds: 50,10' })).toEqual({ kind: 'outside' });
  });
  it('never reads another 400 as no-route; 5xx is an engine fault', () => {
    expect(classifyError(400, { message: 'No path found due to maximum nodes exceeded 1000000' })).toMatchObject({ kind: 'failure', reason: 'LIMIT_EXCEEDED', transport: false });
    expect(classifyError(400, null)).toMatchObject({ kind: 'failure', reason: 'LIMIT_EXCEEDED' });
    expect(classifyError(503, { message: 'busy' })).toMatchObject({ kind: 'failure', reason: 'ENGINE_UNREACHABLE', transport: true, message: 'GraphHopper returned 503: busy' });
  });
});

describe('helpers', () => {
  it('legDetail needs exactly one valid entry per leg', () => {
    expect(legDetail([[0, 1, 5], [1, 2, 7]], 2)).toEqual([5, 7]);
    expect(legDetail([[0, 2, 5]], 2)).toBeNull(); // merged entries
    expect(legDetail([[0, 1, -1]], 1)).toBeNull();
    expect(legDetail(undefined, 1)).toBeNull();
    expect(legDetail([[0, 1]], 1)).toBeNull();
  });
  it('thrownFailure separates timeout, cancel and connection errors', () => {
    expect(thrownFailure(new DOMException('t', 'TimeoutError'))).toMatchObject({ reason: 'ENGINE_TIMEOUT', transport: true });
    expect(thrownFailure(new DOMException('a', 'AbortError'))).toMatchObject({ reason: 'LIMIT_EXCEEDED', transport: false });
    expect(thrownFailure(new TypeError('fetch failed'))).toMatchObject({ reason: 'ENGINE_UNREACHABLE', transport: true });
  });
  it('walk timeout grows with legs and is capped', () => {
    expect(walkTimeoutMs(1)).toBe(2100);
    expect(walkTimeoutMs(1000)).toBe(20_000);
  });
});

describe('GraphHopperMatrixEngine against the matrix stub', () => {
  const stub = new GraphHopperMatrixStub();
  let engine: GraphHopperMatrixEngine;
  beforeAll(async () => {
    engine = new GraphHopperMatrixEngine(await stub.start());
  });
  afterAll(() => stub.stop());
  beforeEach(() => {
    stub.mode = 'up';
    stub.offRoad = () => false;
    stub.legDetails = true;
    stub.hangRoute = false;
    stub.reset();
  });

  it('pair: seconds and metres of one cell, direction-sensitive', async () => {
    const ab = await engine.pair(A, B, 'car');
    const ba = await engine.pair(B, A, 'car');
    const l = stubLeg([A.lat, A.lng], [B.lat, B.lng]);
    expect(ab).toEqual({ kind: 'ok', s: l.time / 1000, m: l.distance });
    expect(ba).not.toEqual(ab);
    expect(stub.calls.pair).toBe(2);
  });

  it('walk: one request, per-leg values equal to pairs', async () => {
    const w = await engine.walk([A, B, C, A], 'car');
    expect(w.kind).toBe('ok');
    if (w.kind !== 'ok') return;
    expect(w.legs).toHaveLength(3);
    expect(w.legs[1]).toEqual(await engine.pair(B, C, 'car').then((p) => (p.kind === 'ok' ? { s: p.s, m: p.m } : null)));
    expect(stub.calls.walk).toBe(1);
  });

  it('walk without leg details → nodetails', async () => {
    stub.legDetails = false;
    expect((await engine.walk([A, B, C], 'car')).kind).toBe('nodetails');
  });

  it('snap: distance to the snapped waypoint; off-road → nopoint', async () => {
    const s = await engine.snap(A, 'car');
    expect(s).toEqual({ kind: 'ok', snapDistanceM: expect.closeTo(3, 0) });
    stub.offRoad = () => true;
    expect(await engine.snap(A, 'car')).toEqual({ kind: 'nopoint' });
    expect(await engine.pair(A, B, 'car')).toEqual({ kind: 'nopoint', pointIndex: 0 });
  });

  it('no route, engine error, info and health', async () => {
    stub.mode = 'noroute';
    expect(await engine.pair(A, B, 'car')).toEqual({ kind: 'noroute' });
    expect(await engine.walk([A, B, C], 'car')).toEqual({ kind: 'noroute' });
    stub.mode = 'error';
    expect(await engine.pair(A, B, 'car')).toMatchObject({ kind: 'failure', reason: 'ENGINE_UNREACHABLE' });
    expect(await engine.health()).toMatchObject({ kind: 'failure' });
    expect(await engine.info()).toMatchObject({ kind: 'failure' });
    stub.mode = 'up';
    expect(await engine.info()).toEqual({ version: '11.1', dataDate: '2026-11-01T00:00:00Z', importDate: '2026-11-10T02:00:00Z', profiles: ['car'] });
    expect(await engine.health()).toMatchObject({ ok: true });
  });

  it('a hanging engine is cut by the caller signal; a stopped engine is unreachable', async () => {
    stub.hangRoute = true;
    const r = await engine.pair(A, B, 'car', AbortSignal.timeout(150));
    expect(r).toMatchObject({ kind: 'failure', reason: 'ENGINE_TIMEOUT', transport: true });
    const down = new GraphHopperMatrixEngine('http://127.0.0.1:1');
    expect(await down.pair(A, B, 'car')).toMatchObject({ kind: 'failure', reason: 'ENGINE_UNREACHABLE', transport: true });
    expect(await down.health()).toMatchObject({ kind: 'failure', reason: 'ENGINE_UNREACHABLE' });
  });
});

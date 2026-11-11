import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PlannedTripDto, PlannedTripStopDto, TrackPoint } from '@veetracer/shared';
import { buildPlanFeatures, circleRing, corridorWidth, deviationFeatures, deviationSegments, lineLatitude, planBounds, plannedLine } from './trip-map.ts';

function stop(seq: number, lng: number, lat: number, over: Partial<PlannedTripStopDto> = {}): PlannedTripStopDto {
  return {
    id: `s${seq}`,
    seq,
    name: `Stop ${seq}`,
    lat,
    lng,
    radiusM: 100,
    plannedArrival: '2026-11-10T04:00:00.000Z',
    plannedDeparture: '2026-11-10T04:05:00.000Z',
    actualArrival: null,
    actualDeparture: null,
    status: 'PENDING',
    delaySec: null,
    ...over,
  };
}

type Trip = Pick<PlannedTripDto, 'path' | 'stops' | 'status' | 'nextStopSeq'>;
const stops = [stop(1, 80.1, 13.1), stop(0, 80.0, 13.0, { status: 'DEPARTED', actualDeparture: '2026-11-10T04:06:00.000Z' }), stop(2, 80.2, 13.2)];

test('planned line: the snapshot path, or straight legs in stop order when null', () => {
  const withPath: Trip = { path: [[80, 13], [80.05, 13.02], [80.2, 13.2]], stops, status: 'SCHEDULED', nextStopSeq: 0 };
  assert.deepEqual(plannedLine(withPath), [[80, 13], [80.05, 13.02], [80.2, 13.2]]);
  assert.deepEqual(plannedLine({ path: null, stops }), [[80, 13], [80.1, 13.1], [80.2, 13.2]]);
  // A one-point path is not a line.
  assert.deepEqual(plannedLine({ path: [[1, 2]], stops }), [[80, 13], [80.1, 13.1], [80.2, 13.2]]);
});

test('plan features: line, a radius circle and a numbered point per stop', () => {
  const fc = buildPlanFeatures({ path: null, stops, status: 'IN_PROGRESS', nextStopSeq: 1 });
  const kinds = fc.features.map((f) => f.properties.kind);
  assert.deepEqual(kinds, ['plan', 'radius', 'radius', 'radius', 'stop', 'stop', 'stop']);
  const points = fc.features.filter((f) => f.properties.kind === 'stop');
  assert.deepEqual(points.map((f) => (f.properties as { label: string }).label), ['1', '2', '3']);
  assert.deepEqual(points.map((f) => (f.properties as { tone: string }).tone), ['ontime', 'next', 'pending']);
  const circle = fc.features[1].geometry;
  assert.equal(circle.type, 'Polygon');
});

test('circle ring is closed and about radius metres from the centre', () => {
  const ring = circleRing(80, 13, 100, 16);
  assert.equal(ring.length, 17);
  assert.deepEqual(ring[0], ring[16]);
  const [lng, lat] = ring[4]; // 90°: due north
  assert.ok(Math.abs(lng - 80) < 1e-9);
  const metres = (lat - 13) * (Math.PI / 180) * 6_371_008.8;
  assert.ok(Math.abs(metres - 100) < 0.01);
});

test('corridor width doubles per zoom level and is 2 × corridor in pixels', () => {
  const expr = corridorWidth(200, 0) as [string, unknown, unknown, number, number, number, number];
  assert.equal(expr[0], 'interpolate');
  assert.deepEqual(expr[1], ['exponential', 2]);
  const px0 = expr[4];
  assert.ok(Math.abs(px0 - 400 / (40_075_016.686 / 512)) < 1e-12);
  assert.ok(Math.abs(expr[6] / px0 - 2 ** 24) < 1e-3);
  // Wider in pixels at higher latitude (fewer metres per pixel).
  assert.ok((corridorWidth(200, 60)[4] as number) > px0 * 1.9);
  assert.equal(lineLatitude([]), 0);
  assert.equal(lineLatitude([[0, 10], [0, 20]]), 15);
});

test('plan bounds include the stop circles', () => {
  const b = planBounds({ path: null, stops })!;
  assert.equal(b[0][0], 80);
  assert.equal(b[1][0], 80.2);
  assert.ok(b[0][1] < 13 && b[1][1] > 13.2);
  assert.equal(planBounds({ path: null, stops: [] }), null);
});

test('deviation segments follow the track during each episode', () => {
  const t0 = Date.parse('2026-11-10T04:00:00.000Z');
  const pts: TrackPoint[] = [0, 1, 2, 3, 4, 5].map((i) => [t0 + i * 60_000, 13 + i * 0.01, 80 + i * 0.01, 40, 0, 1, 0]);
  const events = [
    { kind: 'DEVIATION' as const, startAt: new Date(t0 + 60_000).toISOString(), endAt: new Date(t0 + 3 * 60_000).toISOString() },
    { kind: 'UNSCHEDULED_STOP' as const, startAt: new Date(t0).toISOString(), endAt: null },
    { kind: 'DEVIATION' as const, startAt: new Date(t0 + 4 * 60_000).toISOString(), endAt: null },
    { kind: 'DEVIATION' as const, startAt: new Date(t0 + 30 * 60_000).toISOString(), endAt: null },
  ];
  const segs = deviationSegments(pts, events);
  assert.equal(segs.length, 2);
  assert.deepEqual(segs[0], [
    [80.01, 13.01],
    [80.02, 13.02],
    [80.03, 13.03],
  ]);
  assert.equal(segs[1].length, 2);
  const f = deviationFeatures(segs);
  assert.equal(f[0].properties.kind, 'deviation');
  assert.equal(f[0].geometry.type, 'LineString');
});

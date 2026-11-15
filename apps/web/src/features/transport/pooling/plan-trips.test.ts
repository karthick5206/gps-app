import assert from 'node:assert/strict';
import { test } from 'node:test';
import { areaPlanRequest, groupStopsByTrip, hasTripSplit, tripSplit, type TripStop } from './plan-trips.ts';

const s = (id: string, a: string | null, tripIndex: number | undefined, kind: 'PICKUP' | 'DROP', at?: string): TripStop => ({ id, assignmentId: a, tripIndex, stopKind: kind, plannedArrival: at ?? null });

test('stops group by trip index in route order, keeping the route index', () => {
  const stops = [s('p1', 'A', 0, 'PICKUP', '08:00'), s('d1', 'A', 0, 'DROP', '08:20'), s('p2', 'A', 1, 'PICKUP', '08:30'), s('p3', 'A', 1, 'PICKUP'), s('d2', 'A', 1, 'DROP', '09:00')];
  const g = groupStopsByTrip(stops);
  assert.equal(g.length, 2);
  assert.deepEqual(g[1].stops.map((x) => x.index), [2, 3, 4]);
  assert.equal(g[1].pickups, 2);
  assert.equal(g[1].drops, 1);
  assert.equal(g[0].firstArrival, '08:00');
  assert.equal(g[1].lastArrival, '09:00');
});

test('SITE plans (no trip index) are one group', () => {
  const g = groupStopsByTrip([s('p1', 'A', undefined, 'PICKUP'), s('d1', 'A', undefined, 'DROP')]);
  assert.equal(g.length, 1);
  assert.equal(g[0].tripIndex, 0);
});

test('trip split per selected route', () => {
  const stops = [s('a', 'A', 0, 'PICKUP'), s('b', 'A', 1, 'DROP'), s('c', 'B', undefined, 'PICKUP')];
  assert.equal(hasTripSplit(stops), true);
  assert.equal(hasTripSplit([s('c', 'B', 0, 'PICKUP')]), false);
  assert.deepEqual(tripSplit(stops, ['A', 'B', 'C']), [
    { assignmentId: 'A', trips: 2 },
    { assignmentId: 'B', trips: 1 },
    { assignmentId: 'C', trips: 0 },
  ]);
});

const fromWall = (w: string) => Date.parse(`${w}:00Z`);
const depot = { id: 'p', name: 'Depot', lat: 12.9, lng: 77.6 };

test('AREA request: window, depot, vehicles; overnight end is the next day', () => {
  const r = areaPlanRequest({ day: '2026-11-20', startTime: '22:00', endTime: '02:00', depot, vehicleIds: ['v1'], name: '' }, fromWall, 'br1');
  assert.ok(r.ok);
  assert.equal(r.value.scope, 'AREA');
  assert.equal(r.value.windowStart, '2026-11-20T22:00:00.000Z');
  assert.equal(r.value.windowEnd, '2026-11-21T02:00:00.000Z');
  assert.deepEqual(r.value.depot, { lat: 12.9, lng: 77.6 });
  assert.equal(r.value.branchId, 'br1');
  assert.equal(r.value.name, 'Area plan {{day}} {{from}}–{{to}}');
});

test('AREA request refuses a missing depot / vehicles / window', () => {
  const r = areaPlanRequest({ day: '2026-11-20', startTime: '', endTime: '10:00', depot: null, vehicleIds: [], name: 'x' }, fromWall, null);
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.errors.length, 3);
});

test('peak load of a pickup-and-delivery route', async () => {
  const { peakLoad } = await import('./plan-trips.ts');
  assert.equal(peakLoad([{ stopKind: 'PICKUP', seats: 1 }, { stopKind: 'PICKUP', seats: 2 }, { stopKind: 'DROP', seats: 1 }, { stopKind: 'PICKUP', seats: 1 }, { stopKind: 'DROP', seats: 2 }, { stopKind: 'DROP', seats: 1 }]), 3);
});

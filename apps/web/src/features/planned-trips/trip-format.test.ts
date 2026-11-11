import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PlannedTripDto, PlannedTripStopDto, PlannedTripSummaryDto } from '@veetracer/shared';
import {
  actualDwellSec,
  applyLiveUpdate,
  classifyDelay,
  dayRange,
  formatClock,
  formatDelay,
  fromZonedWall,
  plannedDwellSec,
  progressLabel,
  shiftDay,
  statusCounts,
  stopTiming,
  toZonedWall,
  trackWindow,
  tripActions,
  tripProgress,
  isEtmsTrip,
  tripSourceLabel,
} from './trip-format.ts';

function summary(over: Partial<PlannedTripSummaryDto> = {}): PlannedTripSummaryDto {
  return {
    id: 't1',
    routeId: 'r1',
    origin: 'ROUTE',
    scheduleId: null,
    routeName: 'Route A',
    objectId: 'o1',
    objectName: 'TN 01',
    driverId: null,
    driverName: null,
    branchId: null,
    corridorM: 200,
    plannedStart: '2026-11-10T03:30:00.000Z',
    plannedEnd: '2026-11-10T05:00:00.000Z',
    status: 'SCHEDULED',
    actualStart: null,
    actualEnd: null,
    closedBy: null,
    cancelReason: null,
    notes: null,
    distanceKm: null,
    deviationCount: 0,
    maxDeviationM: null,
    nextStopSeq: 0,
    etaNextStop: null,
    delaySec: null,
    stopCount: 5,
    skippedStops: 0,
    createdAt: '2026-11-09T00:00:00.000Z',
    updatedAt: '2026-11-09T00:00:00.000Z',
    ...over,
  };
}

function stop(seq: number, over: Partial<PlannedTripStopDto> = {}): PlannedTripStopDto {
  return {
    id: `s${seq}`,
    seq,
    name: `Stop ${seq}`,
    lat: 13,
    lng: 80,
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

test('classifyDelay: on time within ±5 min, late / early beyond', () => {
  assert.equal(classifyDelay(null), null);
  assert.equal(classifyDelay(undefined), null);
  assert.equal(classifyDelay(Number.NaN), null);
  assert.equal(classifyDelay(0), 'ontime');
  assert.equal(classifyDelay(300), 'ontime');
  assert.equal(classifyDelay(-300), 'ontime');
  assert.equal(classifyDelay(301), 'late');
  assert.equal(classifyDelay(-301), 'early');
});

test('formatDelay: signed, rounded to minutes', () => {
  assert.equal(formatDelay(null), '—');
  assert.equal(formatDelay(20), '0 s');
  assert.equal(formatDelay(12 * 60), '+12 min');
  assert.equal(formatDelay(-3 * 60 - 20), '−3 min');
  assert.equal(formatDelay(65 * 60), '+1 h 5 min');
  assert.equal(formatDelay(89), '+1 min');
});

test('progress: next stop while active, count otherwise', () => {
  assert.deepEqual(tripProgress(summary({ status: 'IN_PROGRESS', nextStopSeq: 2 })), { next: 3, total: 5 });
  assert.equal(progressLabel(summary({ status: 'IN_PROGRESS', nextStopSeq: 2 })), 'Stop 3 of 5');
  assert.equal(progressLabel(summary({ status: 'STARTED', nextStopSeq: 0 })), 'Stop 1 of 5');
  assert.equal(progressLabel(summary({ status: 'IN_PROGRESS', nextStopSeq: 9 })), 'Stop 5 of 5');
  assert.equal(progressLabel(summary({ status: 'IN_PROGRESS', nextStopSeq: null })), '5 stops');
  assert.equal(progressLabel(summary({ status: 'SCHEDULED' })), '5 stops');
  assert.equal(progressLabel(summary({ status: 'COMPLETED', nextStopSeq: null })), 'All 5 stops');
  // Completed with skipped stops (passed by, or closed by hand): never "All".
  assert.equal(progressLabel(summary({ status: 'COMPLETED', nextStopSeq: null, skippedStops: 1 })), '4 of 5 stops');
  assert.equal(progressLabel(summary({ status: 'COMPLETED', nextStopSeq: null, skippedStops: 4 })), '1 of 5 stops');
  assert.equal(
    progressLabel(summary({ status: 'IN_PROGRESS', nextStopSeq: 1 }), (k, v) => `${k}|${v?.n}|${v?.total}`),
    'Stop {{n}} of {{total}}|2|5',
  );
});

test('status → actions matrix', () => {
  assert.deepEqual(tripActions('SCHEDULED'), ['edit', 'start', 'cancel']);
  assert.deepEqual(tripActions('STARTED'), ['complete', 'cancel']);
  assert.deepEqual(tripActions('IN_PROGRESS'), ['complete', 'cancel']);
  assert.deepEqual(tripActions('COMPLETED'), []);
  assert.deepEqual(tripActions('INCOMPLETE'), []);
  assert.deepEqual(tripActions('CANCELLED'), []);
});

test('status counts fold STARTED into In progress', () => {
  const c = statusCounts([{ status: 'SCHEDULED' }, { status: 'STARTED' }, { status: 'IN_PROGRESS' }, { status: 'CANCELLED' }, { status: 'COMPLETED' }, { status: 'COMPLETED' }]);
  assert.deepEqual(c, { SCHEDULED: 1, IN_PROGRESS: 2, COMPLETED: 2, INCOMPLETE: 0, CANCELLED: 1 });
});

test('stop timing and dwell', () => {
  assert.equal(stopTiming(stop(1)), 'pending');
  assert.equal(stopTiming(stop(1, { status: 'SKIPPED' })), 'skipped');
  assert.equal(stopTiming(stop(1, { status: 'ARRIVED', actualArrival: '2026-11-10T04:12:00.000Z', delaySec: 720 })), 'late');
  assert.equal(stopTiming(stop(1, { status: 'DEPARTED', actualArrival: '2026-11-10T03:50:00.000Z', delaySec: -600 })), 'early');
  assert.equal(stopTiming(stop(1, { status: 'ARRIVED', delaySec: 120 })), 'ontime');
  // Start stop: only a departure.
  assert.equal(stopTiming(stop(0, { status: 'DEPARTED', actualDeparture: '2026-11-10T04:15:00.000Z' })), 'late');
  assert.equal(stopTiming(stop(0, { status: 'DEPARTED', actualDeparture: '2026-11-10T04:06:00.000Z' })), 'ontime');
  assert.equal(actualDwellSec(stop(1)), null);
  assert.equal(actualDwellSec(stop(1, { actualArrival: '2026-11-10T04:00:00.000Z', actualDeparture: '2026-11-10T04:07:30.000Z' })), 450);
  assert.equal(plannedDwellSec(stop(1)), 300);
});

test('applyLiveUpdate patches the matching trip and its stops', () => {
  const detail: PlannedTripDto = { ...summary({ status: 'STARTED' }), path: null, stops: [stop(0), stop(1), stop(2)], events: [] };
  const u = {
    id: 't1',
    status: 'IN_PROGRESS' as const,
    nextStopSeq: 2,
    etaNextStop: '2026-11-10T04:40:00.000Z',
    delaySec: 420,
    actualStart: '2026-11-10T03:35:00.000Z',
    actualEnd: null,
    deviationCount: 1,
    maxDeviationM: 340,
    stops: [{ seq: 1, status: 'DEPARTED' as const, actualArrival: '2026-11-10T04:02:00.000Z', actualDeparture: '2026-11-10T04:06:00.000Z', delaySec: 120 }],
  };
  const next = applyLiveUpdate(detail, u);
  assert.notEqual(next, detail);
  assert.equal(next.status, 'IN_PROGRESS');
  assert.equal(next.nextStopSeq, 2);
  assert.equal(next.deviationCount, 1);
  assert.equal(next.stops[1].status, 'DEPARTED');
  assert.equal(next.stops[1].delaySec, 120);
  assert.equal(next.stops[0], detail.stops[0]);
  assert.equal(next.skippedStops, 0);
  assert.equal(applyLiveUpdate(detail, { ...u, stops: [{ ...u.stops[0], status: 'SKIPPED' as const }] }).skippedStops, 1);
  assert.equal(next.routeName, 'Route A');
  // A list row (no stops) only gets the trip fields; another trip is untouched.
  const row = applyLiveUpdate(summary(), u);
  assert.equal(row.delaySec, 420);
  assert.equal('stops' in row, false);
  const other = summary({ id: 't2' });
  assert.equal(applyLiveUpdate(other, u), other);
});

test('track window: actual start → end, now while active, capped when abandoned', () => {
  const now = Date.parse('2026-11-10T04:30:00.000Z');
  assert.equal(trackWindow(summary(), now), null);
  assert.deepEqual(trackWindow(summary({ status: 'IN_PROGRESS', actualStart: '2026-11-10T03:35:00.000Z' }), now), { from: Date.parse('2026-11-10T03:35:00.000Z'), to: now });
  assert.deepEqual(trackWindow(summary({ status: 'COMPLETED', actualStart: '2026-11-10T03:35:00.000Z', actualEnd: '2026-11-10T04:55:00.000Z' }), now), {
    from: Date.parse('2026-11-10T03:35:00.000Z'),
    to: Date.parse('2026-11-10T04:55:00.000Z'),
  });
  const later = Date.parse('2026-11-11T00:00:00.000Z');
  assert.deepEqual(trackWindow(summary({ status: 'INCOMPLETE', actualStart: '2026-11-10T03:35:00.000Z' }), later), {
    from: Date.parse('2026-11-10T03:35:00.000Z'),
    to: Date.parse('2026-11-10T07:00:00.000Z'),
  });
});

test('company time zone: wall time ↔ instant and day ranges', () => {
  assert.equal(new Date(fromZonedWall('2026-11-10T09:00', 'Asia/Kolkata')).toISOString(), '2026-11-10T03:30:00.000Z');
  assert.equal(toZonedWall(Date.parse('2026-11-10T03:30:00.000Z'), 'Asia/Kolkata'), '2026-11-10T09:00');
  assert.ok(Number.isNaN(fromZonedWall('bad', 'UTC')));
  assert.deepEqual(dayRange('2026-11-10', 'Asia/Kolkata'), { from: '2026-11-09T18:30:00.000Z', to: '2026-11-10T18:30:00.000Z' });
  // DST: New York day of the switch back is 25 h long.
  assert.deepEqual(dayRange('2026-11-01', 'America/New_York'), { from: '2026-11-01T04:00:00.000Z', to: '2026-11-02T05:00:00.000Z' });
  assert.equal(shiftDay('2026-12-31', 1), '2027-01-01');
  assert.equal(shiftDay('2026-03-01', -1), '2026-02-28');
  assert.equal(formatClock('2026-11-10T03:30:00.000Z', 'Asia/Kolkata', '2026-11-10'), '09:00');
  assert.equal(formatClock(null, 'Asia/Kolkata'), '—');
  assert.match(formatClock('2026-11-10T20:00:00.000Z', 'Asia/Kolkata', '2026-11-10', 'en-GB'), /^11 Nov 01:30$/);
});

// ETMS trips (migration planned_trip_origin): door-to-door ones have no Route.
const etmsDoorToDoor = summary({ origin: 'ETMS', routeId: null, routeName: 'Transport 2026-11-10 login' });

test('null-route ETMS fixture: label, actions, progress and live update', () => {
  assert.equal(isEtmsTrip(etmsDoorToDoor), true);
  assert.equal(isEtmsTrip(summary()), false);
  assert.equal(tripSourceLabel(etmsDoorToDoor), 'Employee transport · door to door');
  assert.equal(tripSourceLabel(summary({ origin: 'ETMS', routeId: 'r9', routeName: 'Shuttle A' })), 'Employee transport · Shuttle A');
  assert.equal(tripSourceLabel(summary()), 'Route A');
  // Planned-trips edit / cancel refuse ETMS trips (409 MANAGED_BY_ETMS): only start / complete are offered.
  assert.deepEqual(tripActions('SCHEDULED', 'ETMS'), ['start']);
  assert.deepEqual(tripActions('IN_PROGRESS', 'ETMS'), ['complete']);
  assert.deepEqual(tripActions('COMPLETED', 'ETMS'), []);
  assert.deepEqual(tripActions('SCHEDULED', 'ROUTE'), ['edit', 'start', 'cancel']);
  assert.equal(progressLabel(etmsDoorToDoor), '5 stops');
  const live = applyLiveUpdate(etmsDoorToDoor, { id: 't1', status: 'STARTED', nextStopSeq: 1, etaNextStop: null, delaySec: 60, actualStart: '2026-11-10T03:31:00.000Z', actualEnd: null, deviationCount: 0, maxDeviationM: null });
  assert.equal(live.routeId, null);
  assert.equal(live.status, 'STARTED');
});

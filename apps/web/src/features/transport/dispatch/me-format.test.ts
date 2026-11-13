import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MeTripDto } from '@veetracer/shared';
import { hiddenVehicleText, ME_POLL_MS, myMapStops, shouldPollVehicle, sortMyTrips, vehicleWindowOf } from './me-format.ts';

function trip(over: Partial<MeTripDto> = {}): MeTripDto {
  return {
    id: 't1',
    passengerTripId: 'p1',
    serviceDate: '2026-11-10',
    direction: 'IN',
    journey: 'COMMUTE',
    timeZone: 'Asia/Kolkata',
    window: { start: '2026-11-10T02:00:00.000Z', end: '2026-11-10T03:30:00.000Z' },
    derivedState: 'PUBLISHED',
    myStatus: 'PENDING',
    vehicle: { name: 'Van 1', plate: 'TN 01' },
    driverFirstName: 'Ravi',
    myStop: { seq: 0, label: 'Home', plannedAt: '2026-11-10T02:40:00.000Z', status: 'PENDING', eta: { at: null, model: null } },
    myDrop: { seq: 2, label: 'Office', plannedAt: '2026-11-10T03:20:00.000Z' },
    plannedStart: null,
    plannedEnd: null,
    myPickupPoint: null,
    myDropPoint: null,
    pointsHidden: null,
    coRiders: 3,
    liveVisible: false,
    deskPhone: null,
    ...over,
  };
}
const at = (iso: string) => Date.parse(iso);

test('vehicle window: polls every 15 s, only around the trip', () => {
  assert.equal(ME_POLL_MS, 15_000);
  // Opens 30 min before the earlier of window start / planned pickup, closes 10 min after the window end.
  assert.equal(shouldPollVehicle(trip(), at('2026-11-10T01:29:00Z')), false);
  assert.equal(shouldPollVehicle(trip(), at('2026-11-10T01:31:00Z')), true);
  assert.equal(shouldPollVehicle(trip(), at('2026-11-10T03:39:00Z')), true);
  assert.equal(shouldPollVehicle(trip(), at('2026-11-10T03:41:00Z')), false);
  // The server's liveVisible wins inside the trip (e.g. a late trip running past the window).
  assert.equal(shouldPollVehicle(trip({ liveVisible: true, derivedState: 'EN_ROUTE' }), at('2026-11-10T05:00:00Z')), true);
});

test('vehicle window: never for cancelled / detached trips or a no-show / removed passenger', () => {
  const inside = at('2026-11-10T02:30:00Z');
  assert.equal(shouldPollVehicle(trip({ derivedState: 'CANCELLED', liveVisible: true }), inside), false);
  assert.equal(shouldPollVehicle(trip({ derivedState: 'DETACHED' }), inside), false);
  assert.equal(shouldPollVehicle(trip({ myStatus: 'NO_SHOW', liveVisible: true }), inside), false);
  assert.equal(shouldPollVehicle(trip({ myStatus: 'CANCELLED' }), inside), false);
  // Dropped / completed: only while the server still says visible (10 min grace), never by the local rule.
  assert.equal(shouldPollVehicle(trip({ myStatus: 'DROPPED' }), inside), false);
  assert.equal(shouldPollVehicle(trip({ derivedState: 'COMPLETED', liveVisible: true }), inside), true);
  assert.equal(shouldPollVehicle(trip({ myStop: null, window: { start: 'bad', end: 'bad' } }), inside), false);
});

test('vehicle window from the trip’s planned start / end (server rule: start − 30 min … end + 10 min)', () => {
  const t = trip({ plannedStart: '2026-11-10T02:10:00.000Z', plannedEnd: '2026-11-10T03:20:00.000Z' });
  assert.deepEqual(vehicleWindowOf(t), { open: at('2026-11-10T01:40:00Z'), close: at('2026-11-10T03:30:00Z') });
  // Earlier than the booking window would allow, later than the trip allows: the trip times decide.
  assert.equal(shouldPollVehicle(t, at('2026-11-10T01:39:00Z')), false);
  assert.equal(shouldPollVehicle(t, at('2026-11-10T01:41:00Z')), true);
  assert.equal(shouldPollVehicle(t, at('2026-11-10T03:31:00Z')), false);
  // Without trip times: the old pickup / booking-window rule.
  assert.deepEqual(vehicleWindowOf(trip()), { open: at('2026-11-10T01:30:00Z'), close: at('2026-11-10T03:40:00Z') });
});

test('my map shows only my own points, and only when the server sent them (my consent)', () => {
  assert.deepEqual(myMapStops(trip()), []);
  const mine = myMapStops(trip({ myPickupPoint: { lat: 13.06, lng: 80.24 }, myDropPoint: { lat: 13.05, lng: 80.25 } }));
  assert.deepEqual(mine, [
    { seq: 0, lat: 13.06, lng: 80.24, label: 'Home', mine: true },
    { seq: 2, lat: 13.05, lng: 80.25, label: 'Office' },
  ]);
});

test('hidden vehicle text and trip order', () => {
  assert.match(hiddenVehicleText({ visible: false, reason: 'OUTSIDE_WINDOW' }), /30 minutes before/);
  assert.match(hiddenVehicleText({ visible: false, reason: 'NO_FIX' }), /not reported/);
  assert.equal(hiddenVehicleText(undefined), '');
  const now = at('2026-11-10T02:30:00Z');
  const past = trip({ id: 'past', window: { start: '2026-11-09T02:00:00.000Z', end: '2026-11-09T03:30:00.000Z' }, derivedState: 'COMPLETED' });
  const later = trip({ id: 'later', window: { start: '2026-11-11T02:00:00.000Z', end: '2026-11-11T03:30:00.000Z' } });
  const today = trip({ id: 'today' });
  assert.deepEqual(sortMyTrips([past, later, today], now).map((x) => x.id), ['today', 'later', 'past']);
});

/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MeTripDto, MeVehicleDto, PermissionMap } from '@veetracer/shared';
import { actionAllowed, INITIAL_MOTION, nextMotion, RELEASE_MS, STALE_MS } from './motion.ts';
import { geoUri, validLatLng } from './nav-handoff.ts';
import { isTransportPush, transportPushTarget } from './push-target.ts';
import { transportRoles } from './roles.ts';
import { clockIn, dayIn, hiddenVehicleText, ME_POLL_MS, myMapStops, nextTrip, shouldPollVehicle, sortMyTrips, tripBuckets, vehicleWindowOf } from './trip-window.ts';

// ───────────── roles ─────────────

function me(permissions: PermissionMap, features: string[] = ['etms'], isSuperAdmin = false) {
  return { permissions, company: { features }, user: { isSuperAdmin } };
}

test('roles: passenger-only user gets the Passenger shell', () => {
  const r = transportRoles(me({ etms_self: ['view', 'create', 'edit'] }));
  assert.deepEqual(r, { etms: true, passenger: true, driver: false, fleet: false, shell: 'passenger' });
});

test('roles: driver-only user gets the Driver shell; driver + passenger keys still the Driver shell', () => {
  assert.equal(transportRoles(me({ etms_driver: ['view', 'edit'] })).shell, 'driver');
  const both = transportRoles(me({ etms_driver: ['view', 'edit'], etms_self: ['view'] }));
  assert.equal(both.shell, 'driver');
  assert.equal(both.passenger, true);
});

test('roles: nothing ETMS without the company add-on', () => {
  const r = transportRoles(me({ etms_self: ['view'], etms_driver: ['view'] }, []));
  assert.equal(r.passenger, false);
  assert.equal(r.driver, false);
  assert.equal(r.shell, 'fleet');
});

test('roles: dual-role (fleet + etms_self) stays in the fleet shell with My commute (P3)', () => {
  const r = transportRoles(me({ live_map: ['view'], etms_self: ['view'] }));
  assert.equal(r.shell, 'fleet');
  assert.equal(r.passenger, true);
  assert.equal(r.fleet, true);
});

test('roles: a dispatcher with only ETMS admin keys is a fleet user; a super admin always is', () => {
  assert.equal(transportRoles(me({ etms_dispatch: ['view'], etms_self: ['view'] })).shell, 'fleet');
  assert.equal(transportRoles(me({ etms_self: ['view'] }, ['etms'], true)).shell, 'fleet');
});

test('roles: empty action lists do not count; no Me = fleet (loading)', () => {
  assert.equal(transportRoles(me({ live_map: [], etms_self: ['view'] })).shell, 'passenger');
  assert.equal(transportRoles(undefined).shell, 'fleet');
  assert.equal(transportRoles(me({})).shell, 'fleet');
});

// ───────────── trip window ─────────────

function trip(over: Partial<MeTripDto> = {}): MeTripDto {
  return {
    id: 't1',
    passengerTripId: 'p1',
    serviceDate: '2026-11-11',
    direction: 'IN',
    timeZone: 'Asia/Kolkata',
    window: { start: '2026-11-11T03:00:00Z', end: '2026-11-11T04:00:00Z' },
    derivedState: 'PUBLISHED',
    myStatus: 'PENDING',
    vehicle: { name: 'Cab 5', plate: 'KA01AB1234' },
    driverFirstName: 'Ravi',
    myStop: { seq: 1, label: 'Gate 2', plannedAt: '2026-11-11T03:10:00Z', status: null, eta: { at: null, model: null } },
    myDrop: { seq: 3, label: 'Office', plannedAt: '2026-11-11T03:50:00Z' },
    plannedStart: '2026-11-11T03:00:00Z',
    plannedEnd: '2026-11-11T04:00:00Z',
    myPickupPoint: { lat: 12.9, lng: 77.6 },
    myDropPoint: null,
    pointsHidden: null,
    coRiders: 3,
    liveVisible: false,
    deskPhone: null,
    ...over,
  };
}

const T = (iso: string) => Date.parse(iso);

test('window: planned start − 30 min to planned end + 10 min', () => {
  const w = vehicleWindowOf(trip());
  assert.deepEqual(w, { open: T('2026-11-11T02:30:00Z'), close: T('2026-11-11T04:10:00Z') });
  const fallback = vehicleWindowOf(trip({ plannedStart: null, plannedEnd: null }));
  assert.deepEqual(fallback, { open: T('2026-11-11T02:30:00Z'), close: T('2026-11-11T04:10:00Z') });
  assert.equal(vehicleWindowOf(trip({ plannedStart: null, plannedEnd: null, window: { start: 'x', end: 'y' }, myStop: null })), null);
  assert.equal(ME_POLL_MS, 15_000);
});

test('poll only inside the window; never for cancelled, no-show, removed; stops after drop', () => {
  assert.equal(shouldPollVehicle(trip(), T('2026-11-11T02:29:00Z')), false);
  assert.equal(shouldPollVehicle(trip(), T('2026-11-11T02:31:00Z')), true);
  assert.equal(shouldPollVehicle(trip(), T('2026-11-11T04:11:00Z')), false);
  assert.equal(shouldPollVehicle(trip({ liveVisible: true }), T('2026-11-11T01:00:00Z')), true);
  assert.equal(shouldPollVehicle(trip({ derivedState: 'CANCELLED', liveVisible: true }), T('2026-11-11T03:00:00Z')), false);
  assert.equal(shouldPollVehicle(trip({ myStatus: 'NO_SHOW' }), T('2026-11-11T03:00:00Z')), false);
  assert.equal(shouldPollVehicle(trip({ myStatus: 'CANCELLED' }), T('2026-11-11T03:00:00Z')), false);
  assert.equal(shouldPollVehicle(trip({ myStatus: 'DROPPED' }), T('2026-11-11T03:55:00Z')), false);
  assert.equal(shouldPollVehicle(trip({ derivedState: 'COMPLETED' }), T('2026-11-11T03:55:00Z')), false);
});

test('hidden vehicle texts', () => {
  assert.equal(hiddenVehicleText(undefined), '');
  assert.match(hiddenVehicleText({ visible: false, reason: 'NO_FIX' }), /not reported/);
  assert.match(hiddenVehicleText({ visible: false, reason: 'NOT_ON_TRIP' }), /no longer/);
  assert.match(hiddenVehicleText({ visible: false, reason: 'OUTSIDE_WINDOW' }), /30 minutes/);
  const v: MeVehicleDto = { visible: true, lat: 1, lng: 2, heading: null, speedKph: null, fixAt: 'x', eta: { at: null, model: null } };
  assert.equal(hiddenVehicleText(v), '');
});

test('map stops: only my own points the server sent', () => {
  assert.deepEqual(myMapStops(trip()), [{ kind: 'pickup', lat: 12.9, lng: 77.6, label: 'Gate 2' }]);
  assert.deepEqual(myMapStops(trip({ myPickupPoint: null, pointsHidden: 'CONSENT_REQUIRED' })), []);
});

test('buckets: today (trip zone), upcoming, past; next trip prefers the live one', () => {
  const now = T('2026-11-10T20:00:00Z'); // 01:30 on 11 Nov in Asia/Kolkata
  assert.equal(dayIn('Asia/Kolkata', now), '2026-11-11');
  assert.equal(dayIn('Not/AZone', now), '2026-11-10');
  const today = trip({ id: 'a' });
  const tomorrow = trip({ id: 'b', serviceDate: '2026-11-12', window: { start: '2026-11-12T03:00:00Z', end: '2026-11-12T04:00:00Z' } });
  const past = trip({ id: 'c', serviceDate: '2026-11-09', derivedState: 'COMPLETED', window: { start: '2026-11-09T03:00:00Z', end: '2026-11-09T04:00:00Z' } });
  const b = tripBuckets([tomorrow, past, today], now);
  assert.deepEqual([b.today.map((t) => t.id), b.upcoming.map((t) => t.id), b.past.map((t) => t.id)], [['a'], ['b'], ['c']]);
  assert.deepEqual(sortMyTrips([past, tomorrow, today], now).map((t) => t.id), ['a', 'b', 'c']);
  assert.equal(nextTrip([tomorrow, today], now)?.id, 'a');
  assert.equal(nextTrip([today, { ...tomorrow, liveVisible: true }], now)?.id, 'b');
  assert.equal(nextTrip([past], now), null);
});

test('clock in the trip zone', () => {
  assert.equal(clockIn('2026-11-11T03:10:00Z', 'Asia/Kolkata'), '08:40');
  assert.equal(clockIn(null, 'Asia/Kolkata'), '—');
});

// ───────────── push target ─────────────

const ID = '0f8e4a52-4f53-4c55-9a0e-4d6b2a3c1e77';

test('push: generic ETMS payload opens the trip screen (details fetched there)', () => {
  assert.equal(transportPushTarget({ kind: 'TRIP_ARRIVING', tripId: ID }, { passenger: true, driver: false }), `/commute/trip/${ID}`);
  assert.equal(transportPushTarget({ kind: 'DRIVER_TRIP_ASSIGNED', tripId: ID }, { passenger: false, driver: true }), `/duty/trip/${ID}`);
  assert.equal(transportPushTarget({ kind: 'BOOKING_CHANGED', bookingId: ID }, { passenger: true, driver: false }), '/commute/bookings');
});

test('push: contract kinds (transport-driver.ts) route by audience; shared kinds by the roles held', () => {
  assert.equal(transportPushTarget({ kind: 'VEHICLE_APPROACHING', tripId: ID, notificationId: ID }, { passenger: true, driver: false }), `/commute/trip/${ID}`);
  assert.equal(transportPushTarget({ kind: 'TRIP_ASSIGNED', tripId: ID, notificationId: ID }, { passenger: true, driver: true }), `/duty/trip/${ID}`);
  assert.equal(transportPushTarget({ kind: 'TRIP_ASSIGNED', tripId: ID, notificationId: ID }, { passenger: true, driver: false }), null);
  assert.equal(transportPushTarget({ kind: 'TRIP_CANCELLED', tripId: ID, notificationId: ID }, { passenger: true, driver: false }), `/commute/trip/${ID}`);
  assert.equal(transportPushTarget({ kind: 'TRIP_CANCELLED', tripId: ID, notificationId: ID }, { passenger: false, driver: true }), `/duty/trip/${ID}`);
  assert.equal(transportPushTarget({ kind: 'TRIP_CANCELLED', tripId: ID, notificationId: ID }, { passenger: true, driver: true }), '/duty');
  assert.equal(transportPushTarget({ kind: 'TRIP_UNASSIGNED', tripId: null, notificationId: ID }, { passenger: false, driver: true }), '/duty');
  assert.equal(isTransportPush({ kind: 'TRIP_DELAYED', tripId: null, notificationId: ID }), true);
});

test('push: fleet alerts, malformed ids and roles the user lacks open nothing ETMS', () => {
  assert.equal(isTransportPush({ alertId: 'x', kind: 'SOS', tripId: ID }), false);
  assert.equal(transportPushTarget({ alertId: 'x' }, { passenger: true, driver: true }), null);
  assert.equal(transportPushTarget({ kind: 'TRIP_ARRIVING', tripId: '../../profile' }, { passenger: true, driver: false }), '/commute/notices');
  assert.equal(transportPushTarget({ kind: 'TRIP_ARRIVING', tripId: ID }, { passenger: false, driver: true }), null);
  assert.equal(transportPushTarget({ kind: 'DRIVER_X', tripId: ID }, { passenger: true, driver: false }), null);
  assert.equal(transportPushTarget(null, { passenger: true, driver: true }), null);
});

// ───────────── motion ─────────────

test('motion: moving above 10 km/h, released after < 5 km/h for 10 s, stale = unknown and not locked', () => {
  const t0 = 1_000_000;
  let m = nextMotion(INITIAL_MOTION, 30, t0, t0);
  assert.equal(m.moving, true);
  m = nextMotion(m, 3, t0 + 1000, t0 + 1000);
  assert.equal(m.moving, true, 'not released at once');
  m = nextMotion(m, 7, t0 + 2000, t0 + 2000);
  assert.equal(m.moving, true);
  assert.equal(m.slowSince, null, 'timer restarts between 5 and 10');
  m = nextMotion(m, 2, t0 + 3000, t0 + 3000);
  m = nextMotion(m, 2, t0 + 3000 + RELEASE_MS, t0 + 3000 + RELEASE_MS);
  assert.equal(m.moving, false);
  assert.equal(nextMotion(INITIAL_MOTION, 8, t0, t0).moving, false, '5–10 km/h from rest is not moving');
  const stale = nextMotion({ moving: true, slowSince: null, known: true }, 50, t0, t0 + STALE_MS + 1);
  assert.deepEqual(stale, { moving: false, slowSince: null, known: false });
  assert.equal(nextMotion(INITIAL_MOTION, null, t0, t0).known, false);
});

test('motion: only navigate / SOS / call / next stop while moving', () => {
  const moving = { moving: true };
  assert.equal(actionAllowed('NAVIGATE', moving), true);
  assert.equal(actionAllowed('SOS', moving), true);
  assert.equal(actionAllowed('ARRIVED', moving), false);
  assert.equal(actionAllowed('BOARDED', moving), false);
  assert.equal(actionAllowed('REPORT', moving), false);
  assert.equal(actionAllowed('VIEW_MANIFEST', moving), false);
  assert.equal(actionAllowed('ARRIVED', { moving: false }), true);
});

// ───────────── navigation hand-off ─────────────

test('geo: URI carries coordinates and a neutral stop label only', () => {
  assert.equal(geoUri(12.9715987, 77.5945627, 3), 'geo:12.971599,77.594563?q=12.971599,77.594563(Stop%203)');
  assert.equal(geoUri(0, 0, 1), null);
  assert.equal(geoUri(91, 0, 1), null);
  assert.equal(validLatLng(Number.NaN, 1), false);
});

test('distance for the text equivalent of the map', async () => {
  const { distanceKm } = await import('./trip-window.ts');
  assert.ok(Math.abs(distanceKm({ lat: 12.9716, lng: 77.5946 }, { lat: 13.0827, lng: 80.2707 }) - 290) < 5);
  assert.equal(distanceKm({ lat: 1, lng: 1 }, { lat: 1, lng: 1 }), 0);
});

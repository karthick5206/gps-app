/// <reference types="node" />
/**
 * WP 3.9 (ad-hoc booking) on the phone: point-to-point / "arranged by the desk" labels, the BOOKING_CREATED push and
 * inbox routing (tripId null), tolerance of an older server without the new fields, and a P2P trip in the driver
 * projection (pickups then drops, no company site).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PASSENGER_NOTIFICATION_KINDS, TRANSLATIONS, TRANSPORT_NOTIFICATION_KINDS, TRANSPORT_NOTIFICATION_TEXT } from '@veetracer/shared';
import { currentStop, passengerButtons, pickupUnlocked } from './driver-projection.ts';
import {
  ARRANGED_BY_DESK_LABEL,
  arrangedByDesk,
  bookedForYou,
  bookingKindLabel,
  bookingRoute,
  focusBookings,
  isPointToPoint,
  MAP_POINT_LABEL,
  placeLabel,
  POINT_TO_POINT_LABEL,
  WP39_MOBILE_LABELS,
} from './labels.ts';
import { bookingsRoute, inboxTarget, isTransportPush, transportPushTarget } from './push-target.ts';

const B = '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const T = '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a6c';
const N = '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a7d';
const PASSENGER = { passenger: true, driver: false };
const BOTH = { passenger: true, driver: true };
const DRIVER = { passenger: false, driver: true };

// ───────────── Labels ─────────────

test('journey label: POINT_TO_POINT says "Point-to-point", COMMUTE keeps the to / from site wording', () => {
  assert.equal(bookingKindLabel({ journey: 'POINT_TO_POINT', direction: 'IN' }), POINT_TO_POINT_LABEL);
  assert.equal(POINT_TO_POINT_LABEL, 'Point-to-point');
  assert.equal(bookingKindLabel({ journey: 'COMMUTE', direction: 'IN' }), 'To site (login)');
  assert.equal(bookingKindLabel({ journey: 'COMMUTE', direction: 'OUT' }), 'From site (logout)');
  assert.equal(isPointToPoint({ journey: 'POINT_TO_POINT' }), true);
  assert.equal(isPointToPoint({ journey: 'COMMUTE' }), false);
});

test('older server: no journey / arrangedByDesk fields -> commute wording, no desk line, no crash', () => {
  const old = { direction: 'OUT', pickupLabel: 'Office', dropLabel: 'Home' };
  assert.equal(bookingKindLabel(old), 'From site (logout)');
  assert.equal(arrangedByDesk(old as { arrangedByDesk?: unknown }), false);
  // Unknown future values and missing direction are tolerated too.
  assert.equal(bookingKindLabel({ journey: 'SOMETHING_NEW', direction: 'IN' }), 'To site (login)');
  assert.equal(bookingKindLabel({ journey: null, direction: null }), null);
  assert.equal(bookingKindLabel({}), null);
  assert.equal(bookingKindLabel({ direction: 'SIDEWAYS' }), null);
});

test('arranged by the desk only when the server says true', () => {
  assert.equal(arrangedByDesk({ arrangedByDesk: true }), true);
  assert.equal(arrangedByDesk({ arrangedByDesk: false }), false);
  assert.equal(arrangedByDesk({ arrangedByDesk: 'true' }), false);
  assert.equal(arrangedByDesk({}), false);
  assert.equal(ARRANGED_BY_DESK_LABEL, 'Arranged by the transport desk');
});

test('pickup -> destination from the labels only; a bare coordinate pair is never shown', () => {
  assert.equal(bookingRoute({ pickupLabel: 'Tech Park Gate 2', dropLabel: 'Central Station' }), 'Tech Park Gate 2 → Central Station');
  assert.equal(bookingRoute({ pickupLabel: '  Gate 2 ', dropLabel: null }), 'Gate 2');
  assert.equal(bookingRoute({ pickupLabel: null, dropLabel: '' }), null);
  assert.equal(bookingRoute({}), null);
  for (const coords of ['12.9716, 77.5946', '-33.8688,151.2093', '12.97 77.59', '+12.9;77.5']) {
    assert.deepEqual(placeLabel(coords), { text: MAP_POINT_LABEL, translate: true }, coords);
    assert.ok(!bookingRoute({ pickupLabel: coords, dropLabel: 'Central Station' }, (s) => `[${s}]`)!.match(/\d+\.\d+/), coords);
  }
  assert.equal(bookingRoute({ pickupLabel: '12.9716, 77.5946', dropLabel: 'Central Station' }, (s) => `[${s}]`), '[Map point] → Central Station');
  // A label with numbers in it is still a label.
  assert.deepEqual(placeLabel('Building 12, Floor 3'), { text: 'Building 12, Floor 3', translate: false });
});

test('focused booking (from the notification) is listed first; a missing one is reported, nothing else fetched', () => {
  const list = [{ id: 'aaa' }, { id: B.toUpperCase() }, { id: 'ccc' }];
  assert.deepEqual(focusBookings(list, B).rows.map((b) => b.id), [B.toUpperCase(), 'aaa', 'ccc']);
  assert.equal(focusBookings(list, B).focusMissing, false);
  assert.deepEqual(focusBookings(list, null), { rows: list, focusMissing: false });
  assert.deepEqual(focusBookings(list, T), { rows: list, focusMissing: true });
  assert.deepEqual(focusBookings([], T), { rows: [], focusMissing: true });
});

test('Commute home "Booked for you": active desk bookings not on a trip yet; none from an older server', () => {
  const base = { direction: 'IN', status: 'PENDING_ASSIGNMENT', tripId: null as string | null };
  const list = [
    { ...base, id: '1', arrangedByDesk: true, journey: 'POINT_TO_POINT' },
    { ...base, id: '2', arrangedByDesk: false },
    { ...base, id: '3', arrangedByDesk: true, tripId: T },
    { ...base, id: '4', arrangedByDesk: true, status: 'CANCELLED' },
    { ...base, id: '5' }, // older server: no field
    { ...base, id: '6', arrangedByDesk: true, status: 'REQUESTED' },
  ];
  assert.deepEqual(bookedForYou(list).map((b) => b.id), ['1', '6']);
  assert.deepEqual(bookedForYou(list.map((b) => ({ ...b, arrangedByDesk: undefined }))), []);
  assert.deepEqual(bookedForYou(undefined), []);
  assert.equal(bookedForYou(Array.from({ length: 9 }, (_, i) => ({ ...base, id: String(i), arrangedByDesk: true }))).length, 3);
});

// ───────────── BOOKING_CREATED push and inbox ─────────────

test('contract: BOOKING_CREATED is a passenger kind with a generic text', () => {
  assert.ok((TRANSPORT_NOTIFICATION_KINDS as readonly string[]).includes('BOOKING_CREATED'));
  assert.ok(PASSENGER_NOTIFICATION_KINDS.includes('BOOKING_CREATED'));
  assert.equal(TRANSPORT_NOTIFICATION_TEXT.BOOKING_CREATED.title, 'Ride booked for you');
});

test('BOOKING_CREATED push (tripId null) opens the passenger booking, never a trip or the duty screen', () => {
  const data = { kind: 'BOOKING_CREATED', bookingId: B, notificationId: N, tripId: null };
  assert.equal(isTransportPush(data), true);
  assert.equal(transportPushTarget(data, PASSENGER), `/commute/bookings?bookingId=${B}`);
  // A user with both sections still gets the passenger booking (it is a passenger-only kind).
  assert.equal(transportPushTarget(data, BOTH), `/commute/bookings?bookingId=${B}`);
  // Without tripId at all.
  assert.equal(transportPushTarget({ kind: 'BOOKING_CREATED', bookingId: B, notificationId: N }, PASSENGER), `/commute/bookings?bookingId=${B}`);
  // Even if a trip id were present the booking is what was announced.
  assert.equal(transportPushTarget({ ...data, tripId: T }, PASSENGER), `/commute/bookings?bookingId=${B}`);
  // A driver-only login has nothing to open.
  assert.equal(transportPushTarget(data, DRIVER), null);
  // Upper-case id is normalised; a malformed id falls back to the list (never put into a route).
  assert.equal(transportPushTarget({ ...data, bookingId: B.toUpperCase() }, PASSENGER), `/commute/bookings?bookingId=${B}`);
  assert.equal(transportPushTarget({ ...data, bookingId: '../../admin' }, PASSENGER), '/commute/bookings');
  assert.equal(transportPushTarget({ kind: 'BOOKING_CREATED', bookingId: 'x', notificationId: N }, PASSENGER), '/commute/bookings');
  assert.equal(bookingsRoute(undefined), '/commute/bookings');
  assert.equal(bookingsRoute(`${B}?x=1`), '/commute/bookings');
});

test('existing trip pushes are unchanged', () => {
  assert.equal(transportPushTarget({ kind: 'TRIP_STARTING_SOON', tripId: T, notificationId: N }, PASSENGER), `/commute/trip/${T}`);
  assert.equal(transportPushTarget({ kind: 'TRIP_ASSIGNED', tripId: T, notificationId: N }, DRIVER), `/duty/trip/${T}`);
  assert.equal(transportPushTarget({ kind: 'TRIP_CANCELLED', tripId: T, notificationId: N }, BOTH), '/duty');
});

test('inbox row: BOOKING_CREATED (tripId null) opens My bookings; trip rows open the trip as before', () => {
  assert.equal(inboxTarget({ kind: 'BOOKING_CREATED', tripId: null }, 'passenger'), '/commute/bookings');
  assert.equal(inboxTarget({ kind: 'BOOKING_CREATED', tripId: null, bookingId: B }, 'passenger'), `/commute/bookings?bookingId=${B}`);
  assert.equal(inboxTarget({ kind: 'BOOKING_CREATED', tripId: null }, 'driver'), null);
  assert.equal(inboxTarget({ kind: 'TRIP_DELAYED', tripId: T }, 'passenger'), `/commute/trip/${T}`);
  assert.equal(inboxTarget({ kind: 'TRIP_ASSIGNED', tripId: T }, 'driver'), `/duty/trip/${T}`);
  assert.equal(inboxTarget({ kind: 'TRIP_DELAYED', tripId: null }, 'passenger'), null);
  assert.equal(inboxTarget({ kind: 'TRIP_DELAYED', tripId: 'not-a-uuid' }, 'passenger'), null);
});

// ───────────── i18n ─────────────

test('i18n: WP 3.9 mobile strings have hi and ta', () => {
  const keys = [...WP39_MOBILE_LABELS, 'Ride booked for you', 'Booked for you', 'Opens the booking', 'This booking is no longer in your list. It may have been cancelled or already taken place.'];
  for (const lang of ['hi', 'ta'] as const) assert.deepEqual(keys.filter((k) => !TRANSLATIONS[lang][k]), [], lang);
});

// ───────────── Driver: a point-to-point trip ─────────────

test('driver projection: a P2P trip (pickups then drops, no company site) runs stop by stop with the right buttons', () => {
  // Stops 1, 2 = pickups of p1, p2; stops 3, 4 = their drops. Labels are neutral ("Passenger pickup" / "drop").
  const stops = [1, 2, 3, 4].map((seq) => ({ seq, status: 'PENDING' as const }));
  const p1 = { passengerTripId: 'p1', status: 'PENDING' as const, allowedEvents: ['BOARDED', 'NO_SHOW'] as ('BOARDED' | 'NO_SHOW' | 'DROPPED')[], pickupSeq: 1, dropSeq: 3 };
  const p2 = { ...p1, passengerTripId: 'p2', pickupSeq: 2, dropSeq: 4 };
  assert.equal(currentStop(stops, [])?.seq, 1);
  assert.equal(pickupUnlocked(stops[0], []), false);
  assert.deepEqual(passengerButtons(p1, [], 1), ['BOARDED', 'NO_SHOW']);
  assert.deepEqual(passengerButtons(p2, [], 1), [], 'p2 is not picked up at stop 1');
  // p1 boarded (pending) and stop 1 left: stop 2 is current; p1 can be dropped only at stop 3.
  const local = [
    { type: 'ARRIVED', state: 'PENDING' as const, stopSeq: 1, code: null },
    { type: 'BOARDED', state: 'PENDING' as const, passengerTripId: 'p1', code: null },
    { type: 'DEPARTED', state: 'PENDING' as const, stopSeq: 1, code: null },
  ];
  assert.equal(currentStop(stops, local)?.seq, 2);
  assert.deepEqual(passengerButtons(p1, local, 2), []);
  assert.deepEqual(passengerButtons(p1, local, 3), ['DROPPED']);
  assert.deepEqual(passengerButtons(p2, local, 2), ['BOARDED', 'NO_SHOW']);
  // Server confirms p1 boarded: DROPPED allowed at the drop stop only (no office end assumed: any stop seq works).
  const p1Boarded = { ...p1, status: 'BOARDED' as const, allowedEvents: ['DROPPED'] as ('BOARDED' | 'NO_SHOW' | 'DROPPED')[] };
  assert.deepEqual(passengerButtons(p1Boarded, [], 3), ['DROPPED']);
  assert.deepEqual(passengerButtons(p1Boarded, [], 4), []);
  // All stops departed: no current stop (trip can be completed).
  const done = stops.map((s) => ({ ...s, status: 'DEPARTED' as const }));
  assert.equal(currentStop(done, []), null);
});

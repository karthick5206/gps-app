import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addNewTrip,
  addReassign,
  addRemove,
  addToNewTrip,
  addToTrip,
  buildChangeSet,
  defaultNewTripStart,
  defaultSeqs,
  diffDraft,
  draftBookingIds,
  draftChangeCount,
  emptyDraft,
  idempotencyFor,
  isDraftEmpty,
  newTripStops,
  rebaseDraft,
  stableStringify,
  undoRemove,
  withoutBookings,
  type DraftBooking,
  type DraftTripRef,
} from './dispatch-draft.ts';

const SITE = { lat: 13.0, lng: 80.2, label: 'Office' };
function booking(id: string, over: Partial<DraftBooking> = {}): DraftBooking {
  return { id, name: `P ${id}`, pickup: { lat: 13.1 + Number(id.length) * 0.01, lng: 80.25 }, drop: SITE, windowStart: '2026-11-10T02:00:00.000Z', windowEnd: '2026-11-10T03:30:00.000Z', seats: 1, ...over };
}
const A = booking('a', { pickup: { lat: 13.11, lng: 80.25, label: 'A home' }, windowStart: '2026-11-10T02:10:00.000Z' });
const B = booking('b', { pickup: { lat: 13.12, lng: 80.26 }, windowStart: '2026-11-10T02:00:00.000Z', seats: 2 });
const TRIP: DraftTripRef = { id: '11111111-1111-4111-8111-111111111111', name: 'Morning', vehicleName: 'Van 1', version: 3, occupiedSeats: 2, seatCapacity: 4 };

test('new trip stops: IN = pickups by window, then one shared site stop; times are start + i × gap', () => {
  const { stops, seqs } = newTripStops({ startMs: Date.parse('2026-11-10T02:30:00Z'), gapMin: 10, bookingIds: ['a', 'b'] }, { a: A, b: B }, 'IN');
  assert.equal(stops.length, 3);
  assert.deepEqual(stops.map((s) => s.seq), [0, 1, 2]);
  assert.deepEqual(stops.map((s) => s.plannedArrival), ['2026-11-10T02:30:00.000Z', '2026-11-10T02:40:00.000Z', '2026-11-10T02:50:00.000Z']);
  assert.deepEqual(seqs, { b: { pickupSeq: 0, dropSeq: 2 }, a: { pickupSeq: 1, dropSeq: 2 } });
  assert.equal(stops[2].point.label, 'Office');
});

test('new trip stops: OUT = site first, then drops; identical points share a stop', () => {
  const out1 = booking('x', { pickup: SITE, drop: { lat: 13.2, lng: 80.3 }, windowEnd: '2026-11-10T13:00:00.000Z' });
  const out2 = booking('y', { pickup: SITE, drop: { lat: 13.2, lng: 80.3 }, windowEnd: '2026-11-10T13:10:00.000Z' });
  const { stops, seqs } = newTripStops({ startMs: Date.parse('2026-11-10T12:30:00Z'), gapMin: 5, bookingIds: ['x', 'y'] }, { x: out1, y: out2 }, 'OUT');
  assert.equal(stops.length, 2);
  assert.deepEqual(seqs, { x: { pickupSeq: 0, dropSeq: 1 }, y: { pickupSeq: 0, dropSeq: 1 } });
  // Bookings without a point are left out (the server would refuse NEEDS_LOCATION).
  const none = newTripStops({ startMs: 0, gapMin: 5, bookingIds: ['z'] }, { z: booking('z', { pickup: null }) }, 'IN');
  assert.equal(none.stops.length, 0);
});

test('default start: IN reaches the site by the earliest window end; OUT leaves at the latest window start', () => {
  assert.equal(new Date(defaultNewTripStart([A, B], 'IN', 10)).toISOString(), '2026-11-10T03:10:00.000Z');
  assert.equal(new Date(defaultNewTripStart([A, B], 'OUT', 10)).toISOString(), '2026-11-10T02:10:00.000Z');
});

test('existing trip: nearest pickup stop, drop after it', () => {
  const stops = [
    { seq: 0, lat: 13.11, lng: 80.25 },
    { seq: 1, lat: 13.15, lng: 80.25 },
    { seq: 2, lat: 13.0, lng: 80.2 },
  ];
  assert.deepEqual(defaultSeqs(stops, A), { pickupSeq: 0, dropSeq: 2 });
  assert.deepEqual(defaultSeqs(stops, { pickup: { lat: 13.16, lng: 80.25 }, drop: SITE }), { pickupSeq: 1, dropSeq: 2 });
  // The site (last stop) is never a pickup on an IN trip, even when the point is nearest to it.
  assert.deepEqual(defaultSeqs(stops, { pickup: { lat: 13.0, lng: 80.2 }, drop: SITE }), { pickupSeq: 0, dropSeq: 2 });
  assert.equal(defaultSeqs([stops[0]], A), null);
});

test('change set: removals, reassigns, creates with their adds, adds; expectedVersions for every existing trip', () => {
  let d = emptyDraft('2026-11-10', 'IN');
  assert.equal(isDraftEmpty(d), true);
  d = addNewTrip(d, { objectId: '22222222-2222-4222-8222-222222222222', label: 'Van 2', seats: 6 }, [A], { startMs: Date.parse('2026-11-10T02:30:00Z'), gapMin: 10 });
  d = addToNewTrip(d, 'new-1', [B]);
  const C = booking('c');
  d = addToTrip(d, TRIP, [C], { c: { pickupSeq: 1, dropSeq: 3 } });
  d = addRemove(d, { passengerTripId: '33333333-3333-4333-8333-333333333333', tripId: TRIP.id, bookingId: 'old', name: 'Old', seats: 1, reason: 'Leave' }, TRIP.version);
  d = addReassign(d, { tripId: TRIP.id, kind: 'DRIVER', targetId: null, label: 'No driver' }, TRIP.version);
  assert.equal(draftChangeCount(d), 1 + 2 + 1 + 1 + 1);
  assert.deepEqual([...draftBookingIds(d)].sort(), ['a', 'b', 'c']);
  const cs = buildChangeSet(d, '  morning wave ');
  assert.deepEqual(cs.changes.map((c) => c.op), ['REMOVE_PASSENGER', 'REASSIGN_DRIVER', 'CREATE_TRIP', 'ADD_PASSENGER', 'ADD_PASSENGER', 'ADD_PASSENGER']);
  assert.deepEqual(cs.expectedVersions, { [TRIP.id]: 3 });
  assert.equal(cs.reason, 'morning wave');
  const create = cs.changes[2];
  assert.ok(create.op === 'CREATE_TRIP' && create.stops?.length === 3 && create.tempId === 'new-1');
  const adds = cs.changes.filter((c) => c.op === 'ADD_PASSENGER');
  assert.deepEqual(
    adds.map((c) => c.op === 'ADD_PASSENGER' && [c.tripId, c.bookingId, c.pickupSeq, c.dropSeq]),
    [
      ['new-1', 'a', 1, 2],
      ['new-1', 'b', 0, 2],
      [TRIP.id, 'c', 1, 3],
    ],
  );
});

test('undo: a booking moves between trips once; empty new trips and untouched versions disappear', () => {
  let d = emptyDraft('2026-11-10', 'IN');
  d = addToTrip(d, TRIP, [A], { a: { pickupSeq: 0, dropSeq: 2 } });
  d = addNewTrip(d, { objectId: 'o', label: 'Van', seats: 4 }, [A]);
  assert.equal(d.adds.length, 0);
  assert.deepEqual(d.versions, {});
  d = withoutBookings(d, ['a']);
  assert.equal(d.newTrips.length, 0);
  d = addRemove(d, { passengerTripId: 'p1', tripId: TRIP.id, bookingId: 'x', name: 'X', seats: 1, reason: 'r' }, 3);
  d = addRemove(d, { passengerTripId: 'p1', tripId: TRIP.id, bookingId: 'x', name: 'X', seats: 1, reason: 'r' }, 3);
  assert.equal(d.removes.length, 1);
  d = undoRemove(d, 'p1');
  assert.equal(isDraftEmpty(d), true);
  assert.deepEqual(d.versions, {});
});

test('diff: before / after seats, names, capacity of a new vehicle, over capacity', () => {
  let d = emptyDraft('2026-11-10', 'IN');
  d = addToTrip(d, TRIP, [B, booking('c')], { b: { pickupSeq: 0, dropSeq: 1 }, c: { pickupSeq: 0, dropSeq: 1 } });
  d = addRemove(d, { passengerTripId: 'p1', tripId: TRIP.id, bookingId: 'x', name: 'Xavier', seats: 1, reason: 'r' }, 3);
  d = addNewTrip(d, { objectId: 'o', label: 'Car', seats: 1 }, [A, booking('dd')]);
  const rows = diffDraft(d, [TRIP]);
  const trip = rows.find((r) => r.key === TRIP.id)!;
  assert.equal(trip.before, 2);
  assert.equal(trip.after, 2 - 1 + 2 + 1);
  assert.equal(trip.overCapacity, false);
  assert.deepEqual(trip.added, ['P b', 'P c']);
  assert.deepEqual(trip.removed, ['Xavier']);
  assert.equal(trip.label, 'Van 1 · Morning');
  const car = rows.find((r) => r.isNew)!;
  assert.equal(car.after, 2);
  assert.equal(car.overCapacity, true);
  const smaller = diffDraft(addReassign(d, { tripId: TRIP.id, kind: 'VEHICLE', targetId: 'v2', label: 'Mini', seats: 3 }, 3), [TRIP]).find((r) => r.key === TRIP.id)!;
  assert.equal(smaller.capacity, 3);
  assert.equal(smaller.overCapacity, true);
  assert.deepEqual(smaller.notes, [{ kind: 'VEHICLE', label: 'Mini' }]);
});

test('rebase after VERSION_CONFLICT: latest versions, changes that no longer apply are dropped', () => {
  let d = emptyDraft('2026-11-10', 'IN');
  d = addToTrip(d, TRIP, [A, B], { a: { pickupSeq: 0, dropSeq: 1 }, b: { pickupSeq: 0, dropSeq: 1 } });
  d = addNewTrip(d, { objectId: 'o', label: 'Van', seats: 4 }, [booking('c')]);
  const r = rebaseDraft(d, { queueIds: ['a', 'c'], trips: [{ id: TRIP.id, version: 5, editable: true }] });
  assert.equal(r.dropped, 1);
  assert.deepEqual(r.draft.versions, { [TRIP.id]: 5 });
  assert.deepEqual(r.draft.adds.map((a) => a.bookingId), ['a']);
  const started = rebaseDraft(d, { queueIds: ['a', 'b', 'c'], trips: [{ id: TRIP.id, version: 5, editable: false }] });
  assert.equal(started.draft.adds.length, 0);
  assert.equal(started.draft.newTrips.length, 1);
  assert.deepEqual(started.draft.versions, {});
});

test('idempotency key: same body retried → same key; any change → new key', () => {
  let n = 0;
  const gen = () => `key-${++n}`;
  const body = { serviceDate: '2026-11-10', direction: 'IN', changes: [{ op: 'REMOVE_PASSENGER', passengerTripId: 'p', reason: 'r' }], expectedVersions: { t: 1 } };
  const first = idempotencyFor(null, body, gen);
  assert.equal(first.key, 'key-1');
  // Same content with keys in another order (and an undefined field) is the same body.
  const again = idempotencyFor(first, { expectedVersions: { t: 1 }, changes: body.changes, direction: 'IN', serviceDate: '2026-11-10', reason: undefined }, gen);
  assert.equal(again, first);
  const changed = idempotencyFor(first, { ...body, expectedVersions: { t: 2 } }, gen);
  assert.equal(changed.key, 'key-2');
  assert.equal(stableStringify({ b: [1, { d: 1, c: 2 }], a: null }), '{"a":null,"b":[1,{"c":2,"d":1}]}');
});

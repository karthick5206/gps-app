import assert from 'node:assert/strict';
import { test } from 'node:test';
import { copyDay, type CopyBooking, type SourceTrip } from './copy-day.ts';

const OFFICE = { lat: 13.0, lng: 80.2 };
const today = (id: string, profileId: string, over: Partial<CopyBooking> = {}): CopyBooking => ({
  id,
  profileId,
  name: profileId.toUpperCase(),
  pickup: { lat: 13.1, lng: 80.2 },
  drop: OFFICE,
  windowStart: '2026-11-16T02:00:00.000Z',
  windowEnd: '2026-11-16T03:30:00.000Z',
  seats: 1,
  shiftId: 's1',
  groupId: null,
  ...over,
});
const trip = (over: Partial<SourceTrip> = {}): SourceTrip => ({
  id: 't1',
  name: 'Morning',
  objectId: 'van',
  vehicleName: 'Van',
  driverId: 'd1',
  driverName: 'Ravi',
  shiftId: 's1',
  plannedStart: '2026-11-15T02:20:00.000Z',
  cancelled: false,
  passengers: [
    { profileId: 'c', name: 'C', pickupSeq: 2, dropSeq: 3, cancelled: false },
    { profileId: 'a', name: 'A', pickupSeq: 0, dropSeq: 3, cancelled: false },
    { profileId: 'b', name: 'B', pickupSeq: 1, dropSeq: 3, cancelled: false },
  ],
  ...over,
});
const van = { objectId: 'van', label: 'Van', seats: 6, busy: [] };

test('same vehicle, driver, order and clock time; absent people are reported', () => {
  const r = copyDay([trip()], [today('x1', 'a'), today('x3', 'c')], [van], [], 'IN');
  assert.equal(r.trips.length, 1);
  const t = r.trips[0];
  assert.deepEqual(t.bookings.map((b) => b.profileId), ['a', 'c']);
  assert.equal(t.driver?.id, 'd1');
  assert.equal(t.startMs, Date.parse('2026-11-16T02:20:00.000Z'));
  assert.deepEqual(r.notWaiting, ['B']);
});

test('vehicle gone / busy / nobody waiting / cancelled trips are skipped', () => {
  assert.equal(copyDay([trip({ objectId: 'gone' })], [today('x1', 'a')], [van], [], 'IN').skipped[0].reason, 'NO_VEHICLE');
  const busyVan = { ...van, busy: [{ plannedStart: '2026-11-16T01:00:00.000Z', plannedEnd: '2026-11-16T05:00:00.000Z' }] };
  assert.equal(copyDay([trip()], [today('x1', 'a')], [busyVan], [], 'IN').skipped[0].reason, 'BUSY');
  assert.equal(copyDay([trip()], [], [van], [], 'IN').skipped[0].reason, 'NOBODY_WAITING');
  assert.equal(copyDay([trip({ cancelled: true })], [today('x1', 'a')], [van], [], 'IN').trips.length, 0);
});

test('fewer seats today: the rest are listed as overflow; another shift does not match', () => {
  const small = { ...van, seats: 1 };
  const r = copyDay([trip()], [today('x1', 'a'), today('x2', 'b')], [small], [], 'IN');
  assert.deepEqual(r.trips[0].bookings.map((b) => b.profileId), ['a']);
  assert.deepEqual(r.overflow, ['B']);
  const other = copyDay([trip()], [today('x1', 'a', { shiftId: 's2' })], [van], [], 'IN');
  assert.equal(other.trips.length, 0);
});

test('OUT follows the drop order', () => {
  const t = trip({ passengers: [{ profileId: 'a', name: 'A', pickupSeq: 0, dropSeq: 3, cancelled: false }, { profileId: 'b', name: 'B', pickupSeq: 0, dropSeq: 1, cancelled: false }] });
  const r = copyDay([t], [today('x1', 'a'), today('x2', 'b')], [van], [], 'OUT');
  assert.deepEqual(r.trips[0].bookings.map((b) => b.profileId), ['b', 'a']);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { allocateRoutes, autoAllocate, chooseVehicles, metres, routeGroups, type AllocBooking, type AllocVehicle } from './auto-allocate.ts';
import { addNewTrip, buildChangeSet, emptyDraft, moveInNewTrip, moveToNewTrip, newTripOrder, newTripStops, setNewTripVehicle } from './dispatch-draft.ts';

const OFFICE = { lat: 13.0, lng: 80.2, label: 'Office' };
const W0 = '2026-11-16T02:00:00.000Z';
const W1 = '2026-11-16T03:30:00.000Z';
let n = 0;
function b(over: Partial<AllocBooking> = {}): AllocBooking {
  n += 1;
  return { id: `b${n}`, name: `P${String(n).padStart(2, '0')}`, pickup: { lat: 13.05 + n * 0.001, lng: 80.25 }, drop: OFFICE, windowStart: W0, windowEnd: W1, seats: 1, shiftId: 's1', groupId: null, ...over };
}
const v = (id: string, seats: number | null, busy: AllocVehicle['busy'] = []): AllocVehicle => ({ objectId: id, label: id, seats, busy });

test('chooseVehicles: smallest single fit, else largest first with the last downsized', () => {
  const free = [{ id: 'car', seats: 5 }, { id: 'van1', seats: 6 }, { id: 'van2', seats: 12 }];
  assert.deepEqual(chooseVehicles(free, 4).map((x) => x.id), ['car']);
  assert.deepEqual(chooseVehicles(free, 11).map((x) => x.id), ['van2']);
  assert.deepEqual(chooseVehicles(free, 15).map((x) => x.id), ['van2', 'car']);
  assert.deepEqual(chooseVehicles(free, 30).map((x) => x.id), ['van2', 'van1', 'car']);
});

test('a group of 10 and one more go in the 12-seat van together (the screenshot case)', () => {
  const group = Array.from({ length: 10 }, () => b({ groupId: 'g1' }));
  const one = b();
  const r = autoAllocate([...group, one], [v('car', 5), v('van1', 6), v('van2', 12)], [], 'IN');
  assert.equal(r.trips.length, 1);
  assert.equal(r.trips[0].vehicle.objectId, 'van2');
  assert.equal(r.trips[0].bookings.length, 11);
  assert.equal(r.unplaced.length, 0);
});

test('IN picks up the farthest first; OUT drops the nearest first', () => {
  const near = b({ pickup: { lat: 13.01, lng: 80.2 } });
  const far = b({ pickup: { lat: 13.2, lng: 80.2 } });
  const r = autoAllocate([near, far], [v('car', 5)], [], 'IN');
  assert.deepEqual(r.trips[0].bookings.map((x) => x.id), [far.id, near.id]);
  const nearOut = b({ pickup: OFFICE, drop: { lat: 13.01, lng: 80.2 } });
  const farOut = b({ pickup: OFFICE, drop: { lat: 13.2, lng: 80.2 } });
  const o = autoAllocate([farOut, nearOut], [v('car', 5)], [], 'OUT');
  assert.deepEqual(o.trips[0].bookings.map((x) => x.id), [nearOut.id, farOut.id]);
});

test('different shifts or windows never share a vehicle; a busy or seatless vehicle is skipped', () => {
  const a = b({ shiftId: 's1' });
  const c = b({ shiftId: 's2', windowStart: '2026-11-16T10:00:00.000Z', windowEnd: '2026-11-16T11:30:00.000Z' });
  const r = autoAllocate([a, c], [v('car', 5), v('noseats', null), v('busy', 12, [{ plannedStart: '2026-11-16T01:00:00.000Z', plannedEnd: '2026-11-16T12:00:00.000Z' }])], [], 'IN');
  assert.equal(r.trips.length, 2);
  // The car is free again after the first batch's window, so both batches use it.
  assert.deepEqual(r.trips.map((t) => t.vehicle.objectId), ['car', 'car']);
});

test('more passengers than free seats: the rest stay waiting with a reason', () => {
  const list = Array.from({ length: 7 }, () => b());
  const r = autoAllocate(list, [v('car', 5)], [], 'IN');
  assert.equal(r.trips[0].bookings.length, 5);
  assert.equal(r.unplaced.length, 2);
  assert.equal(r.unplaced[0].reason, 'NO_VEHICLE');
  const noPts = autoAllocate([b({ pickup: null })], [v('car', 5)], [], 'IN');
  assert.equal(noPts.unplaced[0].reason, 'NO_POINTS');
});

test('a vehicle already used by the draft in the window is not used again', () => {
  const r = autoAllocate([b()], [v('car', 5), v('van', 6)], [{ objectId: 'car', startMs: Date.parse(W0), endMs: Date.parse(W1) }], 'IN');
  assert.equal(r.trips[0].vehicle.objectId, 'van');
});

test('metres is about right for 0.01° latitude', () => {
  assert.ok(Math.abs(metres({ lat: 13, lng: 80 }, { lat: 13.01, lng: 80 }) - 1113) < 5);
});

test('ordered new trips keep the given pickup order; move / reorder / vehicle edits', () => {
  const x = b({ pickup: { lat: 13.1, lng: 80.2 }, windowStart: W0 });
  const y = b({ pickup: { lat: 13.2, lng: 80.2 }, windowStart: '2026-11-16T01:00:00.000Z' });
  let d = addNewTrip(emptyDraft('2026-11-16', 'IN'), { objectId: 'car', label: 'Car', seats: 5 }, [x, y], { ordered: true, driverId: 'drv', driverLabel: 'Ravi' });
  const t = d.newTrips[0];
  // Window order would put y first; ordered keeps x first.
  assert.deepEqual(newTripOrder(t, d.bookings, 'IN'), [x.id, y.id]);
  const { seqs } = newTripStops(t, d.bookings, 'IN');
  assert.equal(seqs[x.id].pickupSeq, 0);
  d = moveInNewTrip(d, t.tempId, y.id, -1);
  assert.deepEqual(d.newTrips[0].bookingIds, [y.id, x.id]);
  const cs = buildChangeSet(d);
  assert.equal((cs.changes[0] as { driverId?: string }).driverId, 'drv');
  d = addNewTrip(d, { objectId: 'van', label: 'Van', seats: 6 }, [b()]);
  d = moveToNewTrip(d, [x.id], d.newTrips[1].tempId);
  assert.deepEqual(d.newTrips[0].bookingIds, [y.id]);
  assert.equal(d.newTrips[1].bookingIds.at(-1), x.id);
  d = setNewTripVehicle(d, d.newTrips[0].tempId, { objectId: 'van2', label: 'Van 2', seats: 12 });
  assert.equal(d.newTrips[0].objectId, 'van2');
});

test('routing: homes on opposite sides of the office make separate routes; a route never exceeds maxSeats', () => {
  const north = Array.from({ length: 3 }, (_, i) => b({ pickup: { lat: 13.1 + i * 0.002, lng: 80.2 } }));
  const south = Array.from({ length: 2 }, (_, i) => b({ pickup: { lat: 12.9 - i * 0.002, lng: 80.2 } }));
  const r = routeGroups([...north, ...south], 'IN', 12);
  assert.equal(r.routes.length, 2);
  assert.deepEqual(r.routes.map((x) => x.seats).sort(), [2, 3]);
  assert.match(r.routes[0].label, /^Route 1 · (N|S) · ~\d+ km$/);
  const capped = routeGroups(north, 'IN', 2);
  assert.deepEqual(capped.routes.map((x) => x.seats), [2, 1]);
});

test('allocate vehicles: smallest vehicle that fits each route; a big route is split', () => {
  const north = Array.from({ length: 3 }, (_, i) => b({ pickup: { lat: 13.1 + i * 0.002, lng: 80.2 } }));
  const south = Array.from({ length: 2 }, (_, i) => b({ pickup: { lat: 12.9 - i * 0.002, lng: 80.2 } }));
  const { routes } = routeGroups([...north, ...south], 'IN', 12);
  const a = allocateRoutes(routes, [v('car', 4), v('auto', 2), v('van', 12)], [], 'IN');
  assert.deepEqual(a.trips.map((t) => `${t.vehicle.objectId}:${t.bookings.length}`).sort(), ['auto:2', 'car:3']);
  const big = routeGroups(Array.from({ length: 7 }, () => b()), 'IN', 12);
  const s = allocateRoutes(big.routes, [v('car', 5), v('auto', 2)], [], 'IN');
  assert.deepEqual(s.trips.map((t) => t.bookings.length), [5, 2]);
  assert.equal(s.unplaced.length, 0);
});

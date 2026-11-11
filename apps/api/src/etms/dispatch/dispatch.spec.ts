// PlannedTripsService → drivers.service → @nestjs/mapped-types (ESM-only; jest cannot load it). Not exercised here.
jest.mock('@nestjs/mapped-types', () => ({ PartialType: (c: new () => object) => class extends c {} }));

import { HttpException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { DispatchChangeOp } from '@veetracer/shared';
import { AuditService } from '../../audit/audit.service';
import { PlannedTripsService } from '../../planned-trips/planned-trips.service';
import { MemoryStore, type Obj } from '../testing/memory-store';
import { BookingGeneratorService } from './booking-generator.service';
import { BookingsService } from './bookings.service';
import { DispatchService } from './dispatch.service';
import { TripLiveService } from './trip-live';
import { TripsService } from './trips.service';

/**
 * Dispatch rules on the services' real queries (MemoryStore evaluates their where-clauses): capacity, vehicle / driver
 * overlap, consent gating, missing locations, idempotent publish and booking create, passenger outcomes recorded only by
 * the dispatcher, and GPS stop arrivals never boarding anyone. The database backstops for the same rules are exercised
 * on PostgreSQL in etms-bookings-trips.db-test.ts.
 */

const H = 3_600_000;
const DAY = '2026-12-01';
const T0 = Date.parse(`${DAY}T02:00:00Z`); // 07:30 IST

function world(opts: { seats?: number; consent?: boolean } = {}) {
  const store = new MemoryStore();
  store.insert('company', { id: 'c1', name: 'Corp', timezone: 'Asia/Kolkata', status: 'ACTIVE', settings: { features: ['etms'] }, isPlatform: false });
  const v1 = store.insert('trackedObject', { companyId: 'c1', branchId: null, name: 'Van 1', plateNumber: 'TN01', isActive: true }).id as string;
  const v2 = store.insert('trackedObject', { companyId: 'c1', branchId: null, name: 'Van 2', plateNumber: 'TN02', isActive: true }).id as string;
  store.insert('transportVehicleProfile', { objectId: v1, companyId: 'c1', seats: opts.seats ?? 2 });
  store.insert('transportVehicleProfile', { objectId: v2, companyId: 'c1', seats: 6 });
  const d1 = store.insert('driver', { companyId: 'c1', branchId: null, name: 'Ravi Kumar', isActive: true }).id as string;
  const passenger = (code: string, consent = opts.consent ?? true) => {
    const id = store.insert('employeeTransportProfile', { companyId: 'c1', employeeCode: code, displayName: `P ${code}`, homeLat: 13.06, homeLng: 80.24 }).id as string;
    if (consent) store.insert('employeeTransportConsent', { companyId: 'c1', profileId: id, purpose: 'TRANSPORT_PROFILE', noticeVersion: 'v1', granted: true, channel: 'WEB', occurredAt: new Date(Date.now() - H) });
    return id;
  };
  const booking = (profileId: string, o: Obj = {}) =>
    store.insert('transportBooking', {
      customerCompanyId: 'c1',
      profileId,
      source: 'ADHOC',
      serviceDate: new Date(`${DAY}T00:00:00Z`),
      direction: 'IN',
      timeZone: 'Asia/Kolkata',
      pickupLat: 13.06,
      pickupLng: 80.24,
      dropLat: 13.05,
      dropLng: 80.25,
      windowStart: new Date(T0),
      windowEnd: new Date(T0 + 1.5 * H),
      status: 'PENDING_ASSIGNMENT',
      cutoffAt: new Date(T0 - H),
      ...o,
    }).id as string;

  const prisma = store.client();
  const audit = new AuditService(prisma as never);
  const published: string[] = [];
  const redis = { client: { get: async () => null, mget: async (...k: string[]) => k.map(() => null), set: async () => 'OK', eval: async () => 1, publish: async (_c: string, m: string) => published.push(m) } };
  const plannedTrips = new PlannedTripsService(prisma as never, audit, { invalidate: async () => undefined } as never);
  const routing = { enabled: false, route: async () => null, routeVia: async () => null };
  const live = new TripLiveService(prisma as never, redis as never, plannedTrips);
  const dispatch = new DispatchService(prisma as never, audit, routing as never, live, redis as never);
  const trips = new TripsService(prisma as never, audit, plannedTrips, dispatch, live);
  const bookings = new BookingsService(prisma as never, audit, redis as never);
  const generator = new BookingGeneratorService(prisma as never, redis as never);
  const ctx = { userId: 'u1', companyId: 'c1', homeCompanyId: 'c1', isSuperAdmin: false, permissions: {}, dataScope: 'COMPANY', branchIds: [], objectIds: [], features: ['etms'], agreements: [], ip: null } as never;
  return { store, ctx, dispatch, trips, bookings, generator, v1, v2, d1, passenger, booking, published };
}

const stops = (from = T0) => [
  { seq: 0, point: { lat: 13.06, lng: 80.24, label: 'Home' }, plannedArrival: new Date(from).toISOString() },
  { seq: 1, point: { lat: 13.05, lng: 80.25, label: 'Office' }, plannedArrival: new Date(from + H).toISOString() },
];
const createTrip = (objectId: string, o: Partial<Extract<DispatchChangeOp, { op: 'CREATE_TRIP' }>> = {}): DispatchChangeOp => ({ op: 'CREATE_TRIP', tempId: 't', objectId, plannedStart: new Date(T0).toISOString(), stops: stops(), ...o });
const add = (bookingId: string, tripId = 't'): DispatchChangeOp => ({ op: 'ADD_PASSENGER', tripId, bookingId, pickupSeq: 0, dropSeq: 1 });
const code = async (p: Promise<unknown>) => {
  const e = await p.then(() => null, (x: unknown) => x);
  if (!(e instanceof HttpException)) throw e ?? new Error('expected an error');
  return [e.getStatus(), (e.getResponse() as { code?: string }).code];
};

describe('dispatch change sets (02 §5.4, 15 §8.1)', () => {
  it('publishes PlannedTrip (origin ETMS, no route) + header + passengers atomically and seats the bookings', async () => {
    const w = world();
    const b1 = w.booking(w.passenger('A'));
    const r = await w.dispatch.submit(w.ctx, { serviceDate: DAY, direction: 'IN', changes: [createTrip(w.v1, { driverId: w.d1 }), add(b1)] }, randomUUID());
    expect(r.replay).toBe(false);
    expect(r.value).toMatchObject({ status: 'PUBLISHED', bookings: [{ id: b1, status: 'ASSIGNED' }], trips: [{ tempId: 't', version: 1 }] });
    const pt = w.store.table('plannedTrip')[0];
    expect(pt).toMatchObject({ origin: 'ETMS', routeId: null, objectId: w.v1, driverId: w.d1, status: 'SCHEDULED' });
    expect(w.store.table('plannedTripStop').filter((s) => s.tripId === pt.id)).toHaveLength(2);
    expect(w.store.table('transportTrip')[0]).toMatchObject({ plannedTripId: pt.id, seatCapacity: 2, occupiedSeats: 1, providerCompanyId: 'c1', customerCompanyId: 'c1' });
    expect(w.store.table('transportTripPassenger')[0]).toMatchObject({ bookingId: b1, status: 'PENDING', pickupSeq: 0, dropSeq: 1 });
    expect(w.store.table('transportChangeSet')[0]).toMatchObject({ status: 'PUBLISHED' });
    expect(w.store.table('transportTripEvent').map((e) => e.kind)).toEqual(['PUBLISHED', 'PASSENGER_ADDED']);
    // The existing plannedTrip.update push tells dispatcher screens (no passenger data on the socket).
    expect(JSON.parse(w.published[0])).toMatchObject({ companyId: 'c1', objectId: w.v1, update: { id: pt.id, status: 'SCHEDULED' } });
    expect(w.published[0]).not.toContain('P A');
  });

  it('never exceeds the seat capacity (409 CAPACITY_EXCEEDED), also when adding to an existing trip', async () => {
    const w = world({ seats: 2 });
    const [b1, b2, b3] = ['A', 'B', 'C'].map((c) => w.booking(w.passenger(c)));
    expect(await code(w.dispatch.submit(w.ctx, { serviceDate: DAY, direction: 'IN', changes: [createTrip(w.v1), add(b1), add(b2), add(b3)] }, randomUUID()))).toEqual([409, 'CAPACITY_EXCEEDED']);
    const r = await w.dispatch.submit(w.ctx, { serviceDate: DAY, direction: 'IN', changes: [createTrip(w.v1), add(b1), add(b2)] }, randomUUID());
    const tripId = r.value.trips[0].id;
    expect(await code(w.dispatch.submit(w.ctx, { serviceDate: DAY, direction: 'IN', changes: [add(b3, tripId)], expectedVersions: { [tripId]: 1 } }, randomUUID()))).toEqual([409, 'CAPACITY_EXCEEDED']);
    // A passenger with 2 seats counts twice.
    const big = w.booking(w.passenger('D'), { passengerCount: 3 });
    expect(await code(w.dispatch.submit(w.ctx, { serviceDate: DAY, direction: 'IN', changes: [createTrip(w.v1, { plannedStart: new Date(T0 + 5 * H).toISOString(), stops: stops(T0 + 5 * H) }), add(big)] }, randomUUID()))).toEqual([409, 'CAPACITY_EXCEEDED']);
  });

  it('refuses a vehicle / driver already planned at that time (any origin) and a vehicle without seats', async () => {
    const w = world();
    await w.dispatch.submit(w.ctx, { serviceDate: DAY, direction: 'IN', changes: [createTrip(w.v1, { driverId: w.d1 })] }, randomUUID());
    const half = T0 + 0.5 * H;
    expect(await code(w.dispatch.submit(w.ctx, { serviceDate: DAY, direction: 'IN', changes: [createTrip(w.v1, { plannedStart: new Date(half).toISOString(), stops: stops(half) })] }, randomUUID()))).toEqual([409, 'VEHICLE_BUSY']);
    expect(await code(w.dispatch.submit(w.ctx, { serviceDate: DAY, direction: 'IN', changes: [createTrip(w.v2, { driverId: w.d1, plannedStart: new Date(half).toISOString(), stops: stops(half) })] }, randomUUID()))).toEqual([409, 'DRIVER_BUSY']);
    // A v1.8 ROUTE trip of v2 overlapping also blocks (overlap across all origins, 15 §8.4).
    w.store.insert('plannedTrip', { companyId: 'c1', objectId: w.v2, origin: 'ROUTE', routeId: 'r', routeName: 'Shuttle', corridorM: 200, plannedStart: new Date(T0), plannedEnd: new Date(T0 + 2 * H), status: 'SCHEDULED' });
    expect(await code(w.dispatch.submit(w.ctx, { serviceDate: DAY, direction: 'IN', changes: [createTrip(w.v2)] }, randomUUID()))).toEqual([409, 'VEHICLE_BUSY']);
    // Back-to-back is fine ([start, end) ranges).
    const after = T0 + H;
    await expect(w.dispatch.submit(w.ctx, { serviceDate: DAY, direction: 'IN', changes: [createTrip(w.v1, { plannedStart: new Date(after).toISOString(), stops: stops(after) })] }, randomUUID())).resolves.toBeDefined();
    const v3 = w.store.insert('trackedObject', { companyId: 'c1', name: 'No seats', isActive: true }).id as string;
    expect(await code(w.dispatch.submit(w.ctx, { serviceDate: DAY, direction: 'IN', changes: [createTrip(v3, { plannedStart: new Date(T0 + 9 * H).toISOString(), stops: stops(T0 + 9 * H) })] }, randomUUID()))).toEqual([409, 'NO_SEATS_SET']);
  });

  it('no pickup without consent (403 CONSENT_REQUIRED) and no seat without both points (409 NEEDS_LOCATION)', async () => {
    const w = world();
    const noConsent = w.booking(w.passenger('A', false));
    expect(await code(w.dispatch.submit(w.ctx, { serviceDate: DAY, direction: 'IN', changes: [createTrip(w.v1), add(noConsent)] }, randomUUID()))).toEqual([403, 'CONSENT_REQUIRED']);
    // A withdrawn consent counts as none (latest row wins).
    const withdrawn = w.passenger('B');
    w.store.insert('employeeTransportConsent', { companyId: 'c1', profileId: withdrawn, purpose: 'TRANSPORT_PROFILE', noticeVersion: 'v1', granted: false, channel: 'WEB', occurredAt: new Date() });
    expect(await code(w.dispatch.submit(w.ctx, { serviceDate: DAY, direction: 'IN', changes: [createTrip(w.v1), add(w.booking(withdrawn))] }, randomUUID()))).toEqual([403, 'CONSENT_REQUIRED']);
    const noPoint = w.booking(w.passenger('C'), { pickupLat: null, pickupLng: null });
    expect(await code(w.dispatch.submit(w.ctx, { serviceDate: DAY, direction: 'IN', changes: [createTrip(w.v1), add(noPoint)] }, randomUUID()))).toEqual([409, 'NEEDS_LOCATION']);
    // Nothing was written by the refused change sets.
    expect(w.store.table('plannedTrip')).toHaveLength(0);
  });

  it('a booking already seated / not approved cannot be added (409 INVALID_STATE); a stale trip version is refused (409 VERSION_CONFLICT)', async () => {
    const w = world({ seats: 4 });
    const b1 = w.booking(w.passenger('A'));
    const r = await w.dispatch.submit(w.ctx, { serviceDate: DAY, direction: 'IN', changes: [createTrip(w.v1), add(b1)] }, randomUUID());
    const tripId = r.value.trips[0].id;
    expect(await code(w.dispatch.submit(w.ctx, { serviceDate: DAY, direction: 'IN', changes: [add(b1, tripId)], expectedVersions: { [tripId]: 1 } }, randomUUID()))).toEqual([409, 'INVALID_STATE']);
    const held = w.booking(w.passenger('B'), { status: 'REQUESTED' });
    expect(await code(w.dispatch.submit(w.ctx, { serviceDate: DAY, direction: 'IN', changes: [add(held, tripId)], expectedVersions: { [tripId]: 1 } }, randomUUID()))).toEqual([409, 'INVALID_STATE']);
    const b3 = w.booking(w.passenger('C'));
    await w.dispatch.submit(w.ctx, { serviceDate: DAY, direction: 'IN', changes: [add(b3, tripId)], expectedVersions: { [tripId]: 1 } }, randomUUID());
    expect(await code(w.dispatch.submit(w.ctx, { serviceDate: DAY, direction: 'IN', changes: [{ op: 'REASSIGN_DRIVER', tripId, driverId: null }], expectedVersions: { [tripId]: 1 } }, randomUUID()))).toEqual([409, 'VERSION_CONFLICT']);
  });

  it('same Idempotency-Key + same body replays the result; other body → 422 IDEMPOTENCY_KEY_REUSED', async () => {
    const w = world();
    const key = randomUUID();
    const body = { serviceDate: DAY, direction: 'IN' as const, changes: [createTrip(w.v1)] };
    const first = await w.dispatch.submit(w.ctx, body, key);
    const again = await w.dispatch.submit(w.ctx, structuredClone(body), key);
    expect(again.replay).toBe(true);
    expect(again.value).toEqual(first.value);
    expect(w.store.table('plannedTrip')).toHaveLength(1);
    expect(await code(w.dispatch.submit(w.ctx, { ...body, direction: 'OUT' }, key))).toEqual([422, 'IDEMPOTENCY_KEY_REUSED']);
    expect(await code(w.dispatch.submit(w.ctx, body, undefined))).toEqual([400, 'IDEMPOTENCY_KEY_REQUIRED']);
  });

  it('REMOVE_PASSENGER frees the seat and returns the booking to the queue; REASSIGN_VEHICLE re-snapshots capacity', async () => {
    const w = world({ seats: 2 });
    const [b1, b2] = ['A', 'B'].map((c) => w.booking(w.passenger(c)));
    const r = await w.dispatch.submit(w.ctx, { serviceDate: DAY, direction: 'IN', changes: [createTrip(w.v1), add(b1), add(b2)] }, randomUUID());
    const tripId = r.value.trips[0].id;
    const pax = w.store.table('transportTripPassenger').find((p) => p.bookingId === b1)!;
    const r2 = await w.dispatch.submit(w.ctx, { serviceDate: DAY, direction: 'IN', changes: [{ op: 'REMOVE_PASSENGER', passengerTripId: pax.id as string, reason: 'Moved' }, { op: 'REASSIGN_VEHICLE', tripId, objectId: w.v2 }], expectedVersions: { [tripId]: 1 } }, randomUUID());
    expect(r2.value.trips[0]).toMatchObject({ id: tripId, version: 2 });
    expect(pax.status).toBe('CANCELLED');
    expect(w.store.table('transportBooking').find((b) => b.id === b1)).toMatchObject({ status: 'PENDING_ASSIGNMENT' });
    expect(w.store.table('transportTrip')[0]).toMatchObject({ occupiedSeats: 1, seatCapacity: 6 });
    expect(w.store.table('plannedTrip')[0]).toMatchObject({ objectId: w.v2 });
  });
});

describe('dispatcher progression and outcomes (02 §5.3, condition A)', () => {
  async function published() {
    const w = world({ seats: 3 });
    const b1 = w.booking(w.passenger('A'));
    const b2 = w.booking(w.passenger('B'));
    const r = await w.dispatch.submit(w.ctx, { serviceDate: DAY, direction: 'IN', changes: [createTrip(w.v1), add(b1), add(b2)] }, randomUUID());
    return { w, tripId: r.value.trips[0].id, b1, b2 };
  }

  it('a GPS stop arrival (or a dispatcher-reported arrival) never boards anyone: passengers stay PENDING', async () => {
    const w = world({ seats: 3 });
    const b1 = w.booking(w.passenger('A'));
    const b2 = w.booking(w.passenger('B'));
    const three = [{ seq: 0, point: { lat: 13.07, lng: 80.23, label: 'Depot' }, plannedArrival: new Date(T0).toISOString() }, ...stops(T0 + 600_000).map((s) => ({ ...s, seq: s.seq + 1 }))];
    const r = await w.dispatch.submit(w.ctx, { serviceDate: DAY, direction: 'IN', changes: [createTrip(w.v1, { stops: three }), { op: 'ADD_PASSENGER', tripId: 't', bookingId: b1, pickupSeq: 1, dropSeq: 2 }, { op: 'ADD_PASSENGER', tripId: 't', bookingId: b2, pickupSeq: 1, dropSeq: 2 }] }, randomUUID());
    const tripId = r.value.trips[0].id;
    await w.trips.start(w.ctx, tripId, {});
    const pt = w.store.table('plannedTrip')[0];
    expect(pt.status).toBe('IN_PROGRESS');
    // The processor marks the pickup stop ARRIVED from GPS: it has no write path to passengers.
    Object.assign(w.store.table('plannedTripStop').find((s) => s.tripId === pt.id && s.seq === 1)!, { status: 'ARRIVED', actualArrival: new Date() });
    const t = await w.trips.get(w.ctx, tripId);
    expect(t.passengers.map((p) => p.status)).toEqual(['PENDING', 'PENDING']);
    expect(t.passengers.every((p) => p.outcomeMissing && p.outcomeSource === null && p.boardedAt === null)).toBe(true);
    expect(t.derivedState).toBe('AT_STOP');
    // A dispatcher-reported arrival at the office stop: still nobody boarded or dropped.
    const after = await w.trips.arrive(w.ctx, tripId, { stopSeq: 2 });
    expect(after.stops.find((s) => s.seq === 2)?.status).toBe('ARRIVED');
    expect(after.passengers.map((p) => p.status)).toEqual(['PENDING', 'PENDING']);
  });

  it('records BOARDED / NO_SHOW / DROPPED with source WEB, refuses impossible transitions and outcomes before start', async () => {
    const { w, tripId } = await published();
    const [p1, p2] = w.store.table('transportTripPassenger').map((p) => p.id as string);
    expect(await code(w.trips.outcome(w.ctx, tripId, p1, { outcome: 'BOARDED' }))).toEqual([409, 'INVALID_STATE']);
    await w.trips.start(w.ctx, tripId, {});
    let t = await w.trips.outcome(w.ctx, tripId, p1, { outcome: 'BOARDED' });
    t = await w.trips.outcome(w.ctx, tripId, p2, { outcome: 'NO_SHOW', reasonCode: 'NOT_AT_STOP' });
    expect(await code(w.trips.outcome(w.ctx, tripId, p2, { outcome: 'DROPPED' }))).toEqual([409, 'INVALID_STATE']);
    t = await w.trips.outcome(w.ctx, tripId, p1, { outcome: 'DROPPED' });
    const byId = new Map(t.passengers.map((p) => [p.id, p]));
    expect(byId.get(p1)).toMatchObject({ status: 'DROPPED', outcomeSource: 'WEB' });
    expect(byId.get(p2)).toMatchObject({ status: 'NO_SHOW', outcomeSource: 'WEB', noShowReason: 'NOT_AT_STOP' });
    expect(w.store.table('transportTripEvent').filter((e) => e.passengerTripId).map((e) => [e.kind, e.actorType, e.source])).toEqual([
      ['PASSENGER_ADDED', 'DISPATCHER', 'WEB'],
      ['PASSENGER_ADDED', 'DISPATCHER', 'WEB'],
      ['BOARDED', 'DISPATCHER', 'WEB'],
      ['NO_SHOW', 'DISPATCHER', 'WEB'],
      ['DROPPED', 'DISPATCHER', 'WEB'],
    ]);
    expect(await code(w.trips.outcome(w.ctx, tripId, p2, { outcome: 'BOARDED', occurredAt: new Date(Date.now() + H).toISOString() }))).toEqual([400, 'VALIDATION_FAILED']);
  });

  it('a repeated clientEventId is a no-op', async () => {
    const { w, tripId } = await published();
    await w.trips.start(w.ctx, tripId, {});
    const p1 = w.store.table('transportTripPassenger')[0].id as string;
    const ev = randomUUID();
    await w.trips.outcome(w.ctx, tripId, p1, { outcome: 'BOARDED', clientEventId: ev });
    await w.trips.outcome(w.ctx, tripId, p1, { outcome: 'BOARDED', clientEventId: ev });
    expect(w.store.table('transportTripEvent').filter((e) => e.kind === 'BOARDED')).toHaveLength(1);
  });

  it('complete keeps unrecorded passengers PENDING; cancel frees pending seats and re-queues their bookings', async () => {
    const { w, tripId, b1 } = await published();
    await w.trips.start(w.ctx, tripId, {});
    const done = await w.trips.complete(w.ctx, tripId, {});
    expect(done.plannedTripStatus).toBe('COMPLETED');
    expect(done.passengers.map((p) => p.status)).toEqual(['PENDING', 'PENDING']);
    expect(w.store.table('transportTripEvent').find((e) => e.kind === 'COMPLETED')?.data).toMatchObject({ pendingOutcomes: 2 });

    const second = await published();
    const cancelled = await second.w.trips.cancel(second.w.ctx, second.tripId, { reason: 'Breakdown' });
    expect(cancelled).toMatchObject({ plannedTripStatus: 'CANCELLED', occupiedSeats: 0, cancelReason: 'Breakdown' });
    expect(cancelled.passengers.map((p) => p.status)).toEqual(['CANCELLED', 'CANCELLED']);
    expect(second.w.store.table('transportBooking').find((b) => b.id === second.b1)).toMatchObject({ status: 'PENDING_ASSIGNMENT' });
    expect(b1).toBeDefined();
  });

  it('cancelling a seated booking takes the passenger off the trip in the same transaction', async () => {
    const { w, b1 } = await published();
    const dto = await w.bookings.command(w.ctx, b1, 'cancel', { reason: 'On leave' });
    expect(dto.status).toBe('CANCELLED');
    expect(w.store.table('transportTripPassenger').find((p) => p.bookingId === b1)).toMatchObject({ status: 'CANCELLED' });
    expect(w.store.table('transportTrip')[0]).toMatchObject({ occupiedSeats: 1, version: 2 });
  });
});

describe('bookings (05 §2.5, 15 §5.4)', () => {
  const input = (passengerId: string) => ({ passengerId, serviceDate: '2099-01-05', direction: 'IN' as const, windowStart: '2099-01-05T02:00:00Z', windowEnd: '2099-01-05T03:30:00Z', pickup: { lat: 13.06, lng: 80.24 }, drop: { lat: 13.05, lng: 80.25 } });

  it('double submit = one booking (replay), same key + other body = 422, second active booking = 409 BOOKING_DUPLICATE', async () => {
    jest.useFakeTimers({ now: Date.parse('2099-01-01T00:00:00Z'), doNotFake: ['nextTick', 'setImmediate'] });
    try {
      const w = world();
      const p = w.passenger('A');
      const key = randomUUID();
      const a = await w.bookings.create(w.ctx, input(p), key);
      const b = await w.bookings.create(w.ctx, input(p), key);
      expect([a.replay, b.replay, b.value.id]).toEqual([false, true, a.value.id]);
      expect(w.store.table('transportBooking')).toHaveLength(1);
      expect(a.value).toMatchObject({ status: 'PENDING_ASSIGNMENT', source: 'ADHOC', needsLocation: false, allowedActions: ['edit', 'cancel', 'reject'] });
      expect(await code(w.bookings.create(w.ctx, { ...input(p), passengerCount: 2 }, key))).toEqual([422, 'IDEMPOTENCY_KEY_REUSED']);
      expect(await code(w.bookings.create(w.ctx, input(p), randomUUID()))).toEqual([409, 'BOOKING_DUPLICATE']);
      expect(await code(w.bookings.create(w.ctx, input(p), undefined))).toEqual([400, 'IDEMPOTENCY_KEY_REQUIRED']);
      // hold = needs approval; a cancelled booking frees the day again.
      await w.bookings.command(w.ctx, a.value.id, 'cancel', { reason: 'Changed plan' });
      const held = await w.bookings.create(w.ctx, { ...input(p), hold: true }, randomUUID());
      expect(held.value.status).toBe('REQUESTED');
    } finally {
      jest.useRealTimers();
    }
  });

  it('without a given pickup the passenger point is used only with consent', async () => {
    jest.useFakeTimers({ now: Date.parse('2099-01-01T00:00:00Z'), doNotFake: ['nextTick', 'setImmediate'] });
    try {
      const w = world();
      const noConsent = w.passenger('A', false);
      const r = await w.bookings.create(w.ctx, { ...input(noConsent), pickup: undefined }, randomUUID());
      expect(r.value).toMatchObject({ pickup: null, needsLocation: true });
      const ok = w.passenger('B');
      const r2 = await w.bookings.create(w.ctx, { ...input(ok), pickup: undefined }, randomUUID());
      expect(r2.value.pickup).toMatchObject({ lat: 13.06, lng: 80.24 });
    } finally {
      jest.useRealTimers();
    }
  });

  it('changes need the current version and must come before the cut-off', async () => {
    const w = world();
    const id = w.booking(w.passenger('A'), { cutoffAt: new Date(Date.now() + H), windowStart: new Date(Date.now() + 2 * H), windowEnd: new Date(Date.now() + 3 * H) });
    expect(await code(w.bookings.update(w.ctx, id, { expectedVersion: 7, passengerCount: 2 }))).toEqual([409, 'VERSION_CONFLICT']);
    expect((await w.bookings.update(w.ctx, id, { expectedVersion: 1, passengerCount: 2 })).version).toBe(2);
    Object.assign(w.store.table('transportBooking').find((b) => b.id === id)!, { cutoffAt: new Date(Date.now() - 1) });
    expect(await code(w.bookings.update(w.ctx, id, { expectedVersion: 2, passengerCount: 1 }))).toEqual([409, 'AFTER_CUTOFF']);
    expect(await code(w.bookings.command(w.ctx, id, 'approve', {}))).toEqual([409, 'INVALID_STATE']);
    expect(await code(w.bookings.command(w.ctx, id, 'reject', {}))).toEqual([400, 'VALIDATION_FAILED']);
  });
});

describe('booking generator (12 WP 3.2)', () => {
  it('plans the same legs twice (idempotent keys) and expires unseated bookings whose window ended', async () => {
    const w = world();
    const p = w.passenger('A');
    const site = w.store.insert('poi', { companyId: 'c1', name: 'HQ', lat: 13.05, lng: 80.25, isActive: true }).id as string;
    const shift = w.store.insert('transportShift', { companyId: 'c1', sitePoiId: site, name: 'Day', startMin: 540, endMin: 1080, overnight: false, days: [0, 1, 2, 3, 4, 5, 6], timeZone: 'Asia/Kolkata' });
    w.store.insert('transportSchedule', { companyId: 'c1', profileId: p, shiftId: shift.id, direction: 'IN', days: [0, 1, 2, 3, 4, 5, 6], pickupMode: 'HOME', validFrom: new Date('2026-01-01T00:00:00Z') });
    const sched = await w.generator.loadSchedules({});
    const now = Date.parse('2026-12-01T00:00:00Z');
    const a = await w.generator.plan(sched, now, now + 72 * H);
    const b = await w.generator.plan(sched, now, now + 72 * H);
    const keys = (rows: typeof a.rows) => rows.map((r) => `${r.scheduleId}|${(r.serviceDate as Date).toISOString()}|${r.direction}`);
    expect(keys(a.rows)).toEqual(keys(b.rows));
    expect(a.rows).toHaveLength(3);
    expect(a.rows[0]).toMatchObject({ pickupLat: 13.06, dropPoiId: site, status: 'PENDING_ASSIGNMENT' });
    w.booking(p, { windowEnd: new Date(Date.now() - 1), status: 'PENDING_ASSIGNMENT' });
    w.booking(p, { windowEnd: new Date(Date.now() - 1), status: 'ASSIGNED', direction: 'OUT' });
    expect(await w.generator.expire(Date.now())).toBe(1);
  });
});

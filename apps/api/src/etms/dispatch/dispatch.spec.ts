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
  // Company places (a stop that is not one must be a consenting passenger's point: E3 security review M2).
  store.insert('poi', { id: OFFICE, companyId: 'c1', name: 'Office', lat: 13.05, lng: 80.25, isActive: true });
  store.insert('poi', { id: DEPOT, companyId: 'c1', name: 'Depot', lat: 13.07, lng: 80.23, isActive: true });
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

const OFFICE = '00000000-0000-4000-8000-0000000000aa';
const DEPOT = '00000000-0000-4000-8000-0000000000bb';
const stops = (from = T0) => [
  { seq: 0, point: { lat: 13.06, lng: 80.24, label: 'Home' }, plannedArrival: new Date(from).toISOString() },
  { seq: 1, point: { lat: 13.05, lng: 80.25, label: 'Office', poiId: OFFICE }, plannedArrival: new Date(from + H).toISOString() },
];
/** A trip between two company places (no passenger yet: no personal stop allowed). */
const siteStops = (from = T0) => [
  { seq: 0, point: { lat: 13.07, lng: 80.23, label: 'Depot', poiId: DEPOT }, plannedArrival: new Date(from).toISOString() },
  { seq: 1, point: { lat: 13.05, lng: 80.25, label: 'Office', poiId: OFFICE }, plannedArrival: new Date(from + H).toISOString() },
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
    // QA B1: every event of the change set carries its id (the notification relay groups on it).
    expect(w.store.table('transportTripEvent').map((e) => (e.data as { changeSetId?: string }).changeSetId)).toEqual([r.value.changeSetId, r.value.changeSetId]);
    expect(w.store.table('transportChangeSet')[0].id).toBe(r.value.changeSetId);
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
    await w.dispatch.submit(w.ctx, { serviceDate: DAY, direction: 'IN', changes: [createTrip(w.v1, { driverId: w.d1, stops: siteStops() })] }, randomUUID());
    const half = T0 + 0.5 * H;
    expect(await code(w.dispatch.submit(w.ctx, { serviceDate: DAY, direction: 'IN', changes: [createTrip(w.v1, { plannedStart: new Date(half).toISOString(), stops: siteStops(half) })] }, randomUUID()))).toEqual([409, 'VEHICLE_BUSY']);
    expect(await code(w.dispatch.submit(w.ctx, { serviceDate: DAY, direction: 'IN', changes: [createTrip(w.v2, { driverId: w.d1, plannedStart: new Date(half).toISOString(), stops: siteStops(half) })] }, randomUUID()))).toEqual([409, 'DRIVER_BUSY']);
    // A v1.8 ROUTE trip of v2 overlapping also blocks (overlap across all origins, 15 §8.4).
    w.store.insert('plannedTrip', { companyId: 'c1', objectId: w.v2, origin: 'ROUTE', routeId: 'r', routeName: 'Shuttle', corridorM: 200, plannedStart: new Date(T0), plannedEnd: new Date(T0 + 2 * H), status: 'SCHEDULED' });
    expect(await code(w.dispatch.submit(w.ctx, { serviceDate: DAY, direction: 'IN', changes: [createTrip(w.v2, { stops: siteStops() })] }, randomUUID()))).toEqual([409, 'VEHICLE_BUSY']);
    // Back-to-back is fine ([start, end) ranges).
    const after = T0 + H;
    await expect(w.dispatch.submit(w.ctx, { serviceDate: DAY, direction: 'IN', changes: [createTrip(w.v1, { plannedStart: new Date(after).toISOString(), stops: siteStops(after) })] }, randomUUID())).resolves.toBeDefined();
    const v3 = w.store.insert('trackedObject', { companyId: 'c1', name: 'No seats', isActive: true }).id as string;
    expect(await code(w.dispatch.submit(w.ctx, { serviceDate: DAY, direction: 'IN', changes: [createTrip(v3, { plannedStart: new Date(T0 + 9 * H).toISOString(), stops: siteStops(T0 + 9 * H) })] }, randomUUID()))).toEqual([409, 'NO_SEATS_SET']);
  });

  it('M2: a stop that is not a company place must be a consenting passenger’s point added in the same change set; places must be the company’s', async () => {
    const w = world();
    // A home point with nobody seated there (e.g. a repeat draft after the passenger withdrew): refused.
    expect(await code(w.dispatch.submit(w.ctx, { serviceDate: DAY, direction: 'IN', changes: [createTrip(w.v1)] }, randomUUID()))).toEqual([403, 'CONSENT_REQUIRED']);
    // A stop claiming a place far from that place (a home dressed up as a site): refused.
    const fake = [{ ...siteStops()[0], point: { lat: 13.2, lng: 80.4, label: 'Depot', poiId: DEPOT } }, siteStops()[1]];
    expect(await code(w.dispatch.submit(w.ctx, { serviceDate: DAY, direction: 'IN', changes: [createTrip(w.v1, { stops: fake })] }, randomUUID()))).toEqual([400, 'VALIDATION_FAILED']);
    // With the consenting passenger seated at the stop: published; the stop carries its owner and a neutral name.
    const p = w.passenger('A');
    const b1 = w.booking(p);
    await w.dispatch.submit(w.ctx, { serviceDate: DAY, direction: 'IN', changes: [createTrip(w.v1), add(b1)] }, randomUUID());
    const home = w.store.table('plannedTripStop').find((s) => s.seq === 0)!;
    expect(home).toMatchObject({ profileId: p, poiId: null, name: 'Passenger pickup' });
    expect(w.store.table('plannedTripStop').find((s) => s.seq === 1)).toMatchObject({ profileId: null, poiId: OFFICE, name: 'Office' });
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
    const body = { serviceDate: DAY, direction: 'IN' as const, changes: [createTrip(w.v1, { stops: siteStops() })] };
    const first = await w.dispatch.submit(w.ctx, body, key);
    const again = await w.dispatch.submit(w.ctx, structuredClone(body), key);
    expect(again.replay).toBe(true);
    expect(again.value).toEqual(first.value);
    expect(w.store.table('plannedTrip')).toHaveLength(1);
    expect(await code(w.dispatch.submit(w.ctx, { ...body, direction: 'OUT' }, key))).toEqual([422, 'IDEMPOTENCY_KEY_REUSED']);
    // L3: another user of the company with the same key and body gets 422, never the first user's result.
    expect(await code(w.dispatch.submit({ ...(w.ctx as object), userId: 'u2' } as never, structuredClone(body), key))).toEqual([422, 'IDEMPOTENCY_KEY_REUSED']);
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
    const three = [{ seq: 0, point: { lat: 13.07, lng: 80.23, label: 'Depot', poiId: DEPOT }, plannedArrival: new Date(T0).toISOString() }, ...stops(T0 + 600_000).map((s) => ({ ...s, seq: s.seq + 1 }))];
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
      // WP 3.9 (D-A3): a personal drop without consent is refused and nothing is stored; a company place is fine.
      expect(await code(w.bookings.create(w.ctx, { ...input(noConsent), pickup: undefined }, randomUUID()))).toEqual([409, 'CONSENT_REQUIRED']);
      expect(w.store.table('transportBooking')).toHaveLength(0);
      const r = await w.bookings.create(w.ctx, { ...input(noConsent), pickup: undefined, drop: { lat: 0, lng: 0, poiId: OFFICE } }, randomUUID());
      expect(r.value).toMatchObject({ pickup: null, needsLocation: true, drop: { poiId: OFFICE, lat: 13.05 } });
      const ok = w.passenger('B');
      const r2 = await w.bookings.create(w.ctx, { ...input(ok), pickup: undefined }, randomUUID());
      expect(r2.value.pickup).toMatchObject({ lat: 13.06, lng: 80.24 });
    } finally {
      jest.useRealTimers();
    }
  });

  it('changes need the current version; after the cut-off the desk needs a late reason (WP 3.9 D-A1)', async () => {
    const w = world();
    const id = w.booking(w.passenger('A'), { cutoffAt: new Date(Date.now() + H), windowStart: new Date(Date.now() + 2 * H), windowEnd: new Date(Date.now() + 3 * H) });
    expect(await code(w.bookings.update(w.ctx, id, { expectedVersion: 7, passengerCount: 2 }))).toEqual([409, 'VERSION_CONFLICT']);
    expect((await w.bookings.update(w.ctx, id, { expectedVersion: 1, passengerCount: 2 })).version).toBe(2);
    Object.assign(w.store.table('transportBooking').find((b) => b.id === id)!, { cutoffAt: new Date(Date.now() - 1) });
    expect(await code(w.bookings.update(w.ctx, id, { expectedVersion: 2, passengerCount: 1 }))).toEqual([409, 'LATE_REASON_REQUIRED']);
    expect(await code(w.bookings.update(w.ctx, id, { expectedVersion: 2, passengerCount: 1, lateReason: '  short ' }))).toEqual([409, 'LATE_REASON_REQUIRED']);
    const late = await w.bookings.update(w.ctx, id, { expectedVersion: 2, passengerCount: 1, lateReason: '  Client visit moved earlier ' });
    expect(late).toMatchObject({ version: 3, afterCutoff: true, lateReason: 'Client visit moved earlier', passengerCount: 1 });
    expect(late.allowedActions).toContain('edit');
    const audit = w.store.table('auditLog').filter((a) => a.entityId === id).pop()!;
    expect(JSON.stringify(audit)).toContain('Client visit moved earlier');
    expect(JSON.stringify(audit)).toContain('dispatcherUserId');
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

  it('v1.15 L4: skips (and counts) a generated commute leg that would overlap an active point-to-point booking', async () => {
    const w = world();
    const p = w.passenger('A');
    const site = w.store.insert('poi', { companyId: 'c1', name: 'HQ', lat: 13.05, lng: 80.25, isActive: true }).id as string;
    const shift = w.store.insert('transportShift', { companyId: 'c1', sitePoiId: site, name: 'Day', startMin: 540, endMin: 1080, overnight: false, days: [0, 1, 2, 3, 4, 5, 6], timeZone: 'Asia/Kolkata' });
    w.store.insert('transportSchedule', { companyId: 'c1', profileId: p, shiftId: shift.id, direction: 'IN', days: [0, 1, 2, 3, 4, 5, 6], pickupMode: 'HOME', validFrom: new Date('2026-01-01T00:00:00Z') });
    // IN legs are [07:30, 09:00) IST = [02:00, 03:30) UTC. A P2P ride on 12-02 at 02:30–03:00 UTC clashes; a cancelled one on 12-03 does not.
    w.booking(p, { journey: 'POINT_TO_POINT', serviceDate: new Date('2026-12-02T00:00:00Z'), windowStart: new Date('2026-12-02T02:30:00Z'), windowEnd: new Date('2026-12-02T03:00:00Z') });
    w.booking(p, { journey: 'POINT_TO_POINT', serviceDate: new Date('2026-12-03T00:00:00Z'), windowStart: new Date('2026-12-03T02:30:00Z'), windowEnd: new Date('2026-12-03T03:00:00Z'), status: 'CANCELLED' });
    const r = await w.generator.generate(Date.parse('2026-12-01T00:00:00Z'));
    expect(r).toEqual({ created: 2, skippedByException: 0, skippedByOverlap: 1 });
    const generated = w.store.table('transportBooking').filter((b) => b.scheduleId);
    expect(generated.map((b) => (b.serviceDate as Date).toISOString().slice(0, 10)).sort()).toEqual(['2026-12-01', '2026-12-03']);
  });
});

describe('branch scope on every change-set op (QA B1 / E3 security review M6)', () => {
  /** North dispatcher (branch N): North van / driver / passenger vs South (branch S) ones. 404 everywhere, nothing written. */
  async function northSouth() {
    const w = world({ seats: 4 });
    const north = { ...(w.ctx as object), userId: 'north', dataScope: 'ASSIGNED', branchIds: ['N'] } as never;
    const vn = w.store.insert('trackedObject', { companyId: 'c1', branchId: 'N', name: 'North van', isActive: true }).id as string;
    const vs = w.store.insert('trackedObject', { companyId: 'c1', branchId: 'S', name: 'South van', isActive: true }).id as string;
    for (const v of [vn, vs]) w.store.insert('transportVehicleProfile', { objectId: v, companyId: 'c1', seats: 4 });
    const ds = w.store.insert('driver', { companyId: 'c1', branchId: 'S', name: 'South driver', isActive: true }).id as string;
    const branch = (id: string, b: string) => Object.assign(w.store.table('employeeTransportProfile').find((p) => p.id === id)!, { branchId: b });
    const pn = w.passenger('N1');
    const ps = w.passenger('S1');
    branch(pn, 'N');
    branch(ps, 'S');
    const bn = w.booking(pn);
    const bs = w.booking(ps);
    // A North trip (published by a whole-company dispatcher) with the North passenger, and the South passenger seated on a South trip.
    const rn = await w.dispatch.submit(w.ctx, { serviceDate: DAY, direction: 'IN', changes: [createTrip(vn), add(bn)] }, randomUUID());
    await w.dispatch.submit(w.ctx, { serviceDate: DAY, direction: 'IN', changes: [createTrip(vs), add(bs)] }, randomUUID());
    return { w, north, vn, vs, ds, ps, northTrip: rn.value.trips[0].id, southSeat: w.store.table('transportTripPassenger').find((p) => p.bookingId === bs)!.id as string, newSouth: () => w.booking(ps, { pickupLat: 13.09, pickupLng: 80.29 }) };
  }
  const snapshot = (w: ReturnType<typeof world>) => JSON.stringify(['plannedTrip', 'plannedTripStop', 'transportTrip', 'transportTripPassenger', 'transportBooking'].map((t) => w.store.table(t)));

  it('ADD_PASSENGER of another branch’s booking (on a new North trip: the QA repro) → 404 and the whole change set rolls back', async () => {
    const x = await northSouth();
    const southBooking = x.newSouth();
    {
      const before = snapshot(x.w);
      expect(await code(x.w.dispatch.submit(x.north, { serviceDate: DAY, direction: 'IN', changes: [createTrip(x.vn, { plannedStart: new Date(T0 + 5 * H).toISOString(), stops: stops(T0 + 5 * H) }), add(southBooking)] }, randomUUID()))).toEqual([404, 'NOT_FOUND']);
      expect(snapshot(x.w)).toBe(before);
    }
    expect(await code(x.w.dispatch.submit(x.north, { serviceDate: DAY, direction: 'IN', changes: [add(southBooking, x.northTrip)], expectedVersions: { [x.northTrip]: 1 } }, randomUUID()))).toEqual([404, 'NOT_FOUND']);
  });

  it('ADD_STOP with another branch’s booking → 404', async () => {
    const x = await northSouth();
    const southBooking = x.newSouth();
    const before = snapshot(x.w);
    expect(await code(x.w.dispatch.submit(x.north, { serviceDate: DAY, direction: 'IN', changes: [{ op: 'ADD_STOP', tripId: x.northTrip, bookingId: southBooking, end: 'PICKUP', afterSeq: 0 }], expectedVersions: { [x.northTrip]: 1 } }, randomUUID()))).toEqual([404, 'NOT_FOUND']);
    expect(x.w.store.table('plannedTripStop').some((s) => s.lat === 13.09)).toBe(false);
    expect(snapshot(x.w)).toBe(before);
  });

  it('REMOVE_PASSENGER of another branch’s seat, CREATE_TRIP / REASSIGN_VEHICLE with another branch’s van, REASSIGN_DRIVER to another branch’s driver → 404', async () => {
    const x = await northSouth();
    const before = snapshot(x.w);
    const v = { [x.northTrip]: 1 };
    expect(await code(x.w.dispatch.submit(x.north, { serviceDate: DAY, direction: 'IN', changes: [{ op: 'REMOVE_PASSENGER', passengerTripId: x.southSeat, reason: 'x' }] }, randomUUID()))).toEqual([404, 'NOT_FOUND']);
    expect(await code(x.w.dispatch.submit(x.north, { serviceDate: DAY, direction: 'IN', changes: [createTrip(x.vs, { plannedStart: new Date(T0 + 7 * H).toISOString(), stops: siteStops(T0 + 7 * H) })] }, randomUUID()))).toEqual([404, 'NOT_FOUND']);
    expect(await code(x.w.dispatch.submit(x.north, { serviceDate: DAY, direction: 'IN', changes: [{ op: 'REASSIGN_VEHICLE', tripId: x.northTrip, objectId: x.vs }], expectedVersions: v }, randomUUID()))).toEqual([404, 'NOT_FOUND']);
    expect(await code(x.w.dispatch.submit(x.north, { serviceDate: DAY, direction: 'IN', changes: [{ op: 'REASSIGN_DRIVER', tripId: x.northTrip, driverId: x.ds }], expectedVersions: v }, randomUUID()))).toEqual([404, 'NOT_FOUND']);
    expect(snapshot(x.w)).toBe(before);
  });
});

describe('dispatcher start of an ETMS trip (QA B5)', () => {
  it('keeps the first pickup PENDING (next stop = first stop) until the van is reported there', async () => {
    const w = world();
    const b1 = w.booking(w.passenger('A'));
    const r = await w.dispatch.submit(w.ctx, { serviceDate: DAY, direction: 'IN', changes: [createTrip(w.v1), add(b1)] }, randomUUID());
    const t = await w.trips.start(w.ctx, r.value.trips[0].id, {});
    expect(t.plannedTripStatus).toBe('IN_PROGRESS');
    expect(t.stops.find((s) => s.seq === 0)).toMatchObject({ status: 'PENDING', actualDeparture: null });
    expect(t.nextStopSeq).toBe(0);
  });
});

describe('place claims (E3 security re-check N5)', () => {
  it('a stop naming a place must be within 25 m of it, and the place must pre-date the saved draft', async () => {
    const w = world();
    // Within 200 m (the old tolerance) but 50 m off: refused now.
    const off = [{ ...siteStops()[0], point: { lat: 13.07045, lng: 80.23, label: 'Depot', poiId: DEPOT } }, siteStops()[1]];
    expect(await code(w.dispatch.submit(w.ctx, { serviceDate: DAY, direction: 'IN', changes: [createTrip(w.v1, { stops: off })] }, randomUUID()))).toEqual([400, 'VALIDATION_FAILED']);
    // A draft saved before a place existed cannot claim that place (e.g. a place created later at a home).
    for (const p of w.store.table('poi')) p.createdAt = new Date(Date.now() - 2 * 86_400_000);
    const LATE = '00000000-0000-4000-8000-0000000000cc';
    w.store.insert('poi', { id: LATE, companyId: 'c1', name: 'New place', lat: 13.06, lng: 80.24, isActive: true });
    const draft = w.store.insert('transportChangeSet', {
      companyId: 'c1',
      status: 'DRAFT',
      createdById: 'u1',
      createdAt: new Date(Date.now() - 86_400_000),
      serviceDate: new Date(`${DAY}T00:00:00Z`),
      direction: 'IN',
      draft: { serviceDate: DAY, direction: 'IN', expectedVersions: {}, changes: [createTrip(w.v1, { stops: [{ seq: 0, point: { lat: 13.06, lng: 80.24, label: 'Home', poiId: LATE }, plannedArrival: new Date(T0).toISOString() }, siteStops()[1]] })] },
    });
    expect(await code(w.dispatch.publishDraft(w.ctx, draft.id as string, randomUUID()))).toEqual([400, 'VALIDATION_FAILED']);
    expect(w.store.table('plannedTrip')).toHaveLength(0);
  });
});

describe('WP 3.9 ad-hoc booking: journeys, eligibility, consent, cut-off, notification (unit, MemoryStore)', () => {
  const NOW = Date.parse('2099-01-01T00:00:00Z');
  const MON = '2099-01-05'; // a Monday
  const at = (h: number) => new Date(Date.parse(`${MON}T00:00:00Z`) + h * H).toISOString();
  const run = async (fn: () => Promise<void>) => {
    jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate'] });
    try {
      await fn();
    } finally {
      jest.useRealTimers();
    }
  };
  const OFFICE_PT = { lat: 0, lng: 0, poiId: OFFICE };
  const DEPOT_PT = { lat: 0, lng: 0, poiId: DEPOT };
  const p2p = (passengerId: string, o: Obj = {}) => ({ passengerId, serviceDate: MON, journey: 'POINT_TO_POINT' as const, pickup: DEPOT_PT, drop: { lat: 12.99, lng: 80.17, label: 'Airport' }, windowStart: at(10), windowEnd: at(12), ...o });
  const commute = (passengerId: string, o: Obj = {}) => ({ passengerId, serviceDate: MON, direction: 'IN' as const, pickup: DEPOT_PT, drop: OFFICE_PT, windowStart: at(2), windowEnd: at(3.5), ...o });
  const reason = (p: Promise<unknown>) =>
    p.then(
      () => null,
      (e: HttpException) => [e.getStatus(), (e.getResponse() as { reason?: string }).reason ?? (e.getResponse() as { code: string }).code],
    );

  it('POINT_TO_POINT: pickup, drop and window required; stored IN, shift optional; not a COMMUTE duplicate', () =>
    run(async () => {
      const w = world();
      const a = w.passenger('A');
      expect(await code(w.bookings.create(w.ctx, p2p(a, { pickup: undefined }) as never, randomUUID()))).toEqual([400, 'VALIDATION_FAILED']);
      expect(await code(w.bookings.create(w.ctx, p2p(a, { windowEnd: undefined }) as never, randomUUID()))).toEqual([400, 'VALIDATION_FAILED']);
      const r = await w.bookings.create(w.ctx, p2p(a) as never, randomUUID());
      expect(r.value).toMatchObject({ journey: 'POINT_TO_POINT', direction: 'IN', shiftId: null, status: 'PENDING_ASSIGNMENT', afterCutoff: false, lateReason: null, needsLocation: false });
      // A commute the same day and direction (other time) is fine: the duplicate index covers COMMUTE only.
      expect((await w.bookings.create(w.ctx, commute(a) as never, randomUUID())).value.journey).toBe('COMMUTE');
      expect(await code(w.bookings.create(w.ctx, commute(w.passenger('B'), { direction: undefined }) as never, randomUUID()))).toEqual([400, 'VALIDATION_FAILED']);
    }));

  it('BOOKING_OVERLAP: a P2P overlapping any active booking, a COMMUTE overlapping a P2P; COMMUTE duplicate stays BOOKING_DUPLICATE', () =>
    run(async () => {
      const w = world();
      const a = w.passenger('A');
      const first = (await w.bookings.create(w.ctx, p2p(a) as never, randomUUID())).value;
      const e = (await w.bookings.create(w.ctx, p2p(a, { windowStart: at(11), windowEnd: at(13) }) as never, randomUUID()).catch((x: unknown) => x)) as HttpException;
      expect(e.getStatus()).toBe(409);
      expect(e.getResponse()).toMatchObject({ code: 'BOOKING_OVERLAP', bookingId: first.id });
      // Touching windows ('[)') do not overlap.
      expect((await w.bookings.create(w.ctx, p2p(a, { windowStart: at(12), windowEnd: at(13) }) as never, randomUUID())).value.journey).toBe('POINT_TO_POINT');
      expect(await code(w.bookings.create(w.ctx, commute(a, { direction: 'OUT', pickup: OFFICE_PT, drop: DEPOT_PT, windowStart: at(11.5), windowEnd: at(12.5) }) as never, randomUUID()))).toEqual([409, 'BOOKING_OVERLAP']);
      const c = await w.bookings.create(w.ctx, commute(a) as never, randomUUID());
      expect(await code(w.bookings.create(w.ctx, commute(a, { windowStart: at(4), windowEnd: at(5) }) as never, randomUUID()))).toEqual([409, 'BOOKING_DUPLICATE']);
      expect(await code(w.bookings.create(w.ctx, p2p(a, { windowStart: at(3), windowEnd: at(4) }) as never, randomUUID()))).toEqual([409, 'BOOKING_OVERLAP']);
      // Cancelled bookings hold no time.
      await w.bookings.command(w.ctx, c.value.id, 'cancel', { reason: 'Leave' });
      expect((await w.bookings.create(w.ctx, p2p(a, { windowStart: at(3), windowEnd: at(4) }) as never, randomUUID())).value.status).toBe('PENDING_ASSIGNMENT');
      // PATCH moving a P2P onto another booking's time: overlap.
      expect(await code(w.bookings.update(w.ctx, first.id, { expectedVersion: first.version, windowStart: at(12.5), windowEnd: at(13.5) }))).toEqual([409, 'BOOKING_OVERLAP']);
    }));

  it('eligibility (422 NOT_ELIGIBLE + reason) on create and PATCH; other company / other branch passenger 404', () =>
    run(async () => {
      const w = world();
      const a = w.passenger('A');
      const prof = (id: string) => w.store.table('employeeTransportProfile').find((p) => p.id === id)!;
      const sh = w.store.insert('transportShift', { companyId: 'c1', sitePoiId: OFFICE, name: 'Weekdays', startMin: 540, endMin: 1080, overnight: false, days: [1, 2, 3, 4, 5], timeZone: 'Asia/Kolkata', isActive: true }).id as string;
      expect(await reason(w.bookings.create(w.ctx, commute(a, { shiftId: sh, serviceDate: '2099-01-04', windowStart: undefined, windowEnd: undefined, drop: undefined }) as never, randomUUID()))).toEqual([422, 'SHIFT_NOT_RUNNING']);
      const ok = await w.bookings.create(w.ctx, commute(a, { shiftId: sh, windowStart: undefined, windowEnd: undefined, drop: undefined }) as never, randomUUID());
      expect(ok.value).toMatchObject({ shiftId: sh, drop: { poiId: OFFICE } });
      Object.assign(w.store.table('transportShift').find((s) => s.id === sh)!, { isActive: false });
      expect(await reason(w.bookings.create(w.ctx, commute(w.passenger('B'), { shiftId: sh }) as never, randomUUID()))).toEqual([422, 'SHIFT_INACTIVE']);
      expect(await reason(w.bookings.update(w.ctx, ok.value.id, { expectedVersion: ok.value.version, passengerCount: 2 }))).toEqual([422, 'SHIFT_INACTIVE']);
      const otherPoi = w.store.insert('poi', { companyId: 'c2', name: 'Elsewhere', lat: 13.1, lng: 80.2, isActive: true }).id as string;
      expect(await reason(w.bookings.create(w.ctx, commute(w.passenger('C'), { drop: { lat: 0, lng: 0, poiId: otherPoi } }) as never, randomUUID()))).toEqual([422, 'PLACE_NOT_ALLOWED']);
      const d = w.passenger('D');
      expect(await reason(w.bookings.create(w.ctx, commute(d, { passengerCount: 7 }) as never, randomUUID()))).toEqual([422, 'SEATS_NOT_ALLOWED']);
      Object.assign(prof(d), { isActive: false });
      expect(await reason(w.bookings.create(w.ctx, commute(d) as never, randomUUID()))).toEqual([422, 'PASSENGER_INACTIVE']);
      Object.assign(prof(d), { anonymisedAt: new Date() });
      expect(await reason(w.bookings.create(w.ctx, commute(d) as never, randomUUID()))).toEqual([422, 'PASSENGER_ANONYMISED']);
      // Isolation: another company's passenger, and a passenger outside a branch-scoped dispatcher's branches: 404.
      const foreign = w.store.insert('employeeTransportProfile', { companyId: 'c2', employeeCode: 'X', displayName: 'X', isActive: true }).id as string;
      expect(await code(w.bookings.create(w.ctx, commute(foreign) as never, randomUUID()))).toEqual([404, 'NOT_FOUND']);
      const e = w.passenger('E');
      Object.assign(prof(e), { branchId: 'br2' });
      const branchCtx = { ...(w.ctx as object), dataScope: 'ASSIGNED', branchIds: ['br1'] } as never;
      expect(await code(w.bookings.create(branchCtx, commute(e) as never, randomUUID()))).toEqual([404, 'NOT_FOUND']);
      expect(w.store.table('transportBooking').filter((b) => b.profileId === e || b.profileId === foreign || b.profileId === d)).toHaveLength(0);
    }));

  it('D-A3: a one-time map point needs consent on create and PATCH (409 CONSENT_REQUIRED, never stored); company places do not', () =>
    run(async () => {
      const w = world({ consent: false });
      const a = w.passenger('A');
      expect(await code(w.bookings.create(w.ctx, p2p(a) as never, randomUUID()))).toEqual([409, 'CONSENT_REQUIRED']);
      const r = await w.bookings.create(w.ctx, commute(a) as never, randomUUID());
      expect(await code(w.bookings.update(w.ctx, r.value.id, { expectedVersion: r.value.version, pickup: { lat: 13.06, lng: 80.24, label: 'Somewhere' } }))).toEqual([409, 'CONSENT_REQUIRED']);
      expect(JSON.stringify(w.store.table('transportBooking'))).not.toContain('Somewhere');
      expect(JSON.stringify(w.store.table('transportBooking'))).not.toContain('12.99');
    }));

  it('PATCH sets a missing location (needs location to located) and never creates a trip or seat', () =>
    run(async () => {
      const w = world();
      const a = w.passenger('A');
      Object.assign(w.store.table('employeeTransportProfile').find((p) => p.id === a)!, { homeLat: null, homeLng: null });
      const r = await w.bookings.create(w.ctx, commute(a, { pickup: undefined }) as never, randomUUID());
      expect(r.value.needsLocation).toBe(true);
      const u = await w.bookings.update(w.ctx, r.value.id, { expectedVersion: r.value.version, pickup: { lat: 13.061, lng: 80.241, label: 'Gate 2' } });
      expect(u).toMatchObject({ needsLocation: false, pickup: { lat: 13.061, label: 'Gate 2' }, status: 'PENDING_ASSIGNMENT' });
      expect(w.store.table('transportTrip')).toHaveLength(0);
      expect(w.store.table('transportTripPassenger')).toHaveLength(0);
      Object.assign(w.store.table('transportBooking').find((b) => b.id === r.value.id)!, { status: 'ASSIGNED' });
      expect(await code(w.bookings.update(w.ctx, r.value.id, { expectedVersion: u.version, passengerCount: 2 }))).toEqual([409, 'INVALID_STATE']);
    }));

  it('D-A1 cut-off on create: desk needs a reason (stored, flagged, audited); the passenger path stays AFTER_CUTOFF', () =>
    run(async () => {
      const w = world();
      const a = w.passenger('A');
      // Window starts in 30 min: inside the default cut-off.
      const soon = { windowStart: new Date(NOW + 30 * 60_000).toISOString(), windowEnd: new Date(NOW + 90 * 60_000).toISOString(), serviceDate: '2099-01-01' };
      expect(await code(w.bookings.create(w.ctx, commute(a, soon) as never, randomUUID()))).toEqual([409, 'LATE_REASON_REQUIRED']);
      expect(await code(w.bookings.create(w.ctx, commute(a, soon) as never, randomUUID(), { actor: 'PASSENGER' }))).toEqual([409, 'AFTER_CUTOFF']);
      const r = await w.bookings.create(w.ctx, commute(a, { ...soon, lateReason: 'Urgent client visit today' }) as never, randomUUID());
      expect(r.value).toMatchObject({ afterCutoff: true, lateReason: 'Urgent client visit today' });
      const entry = w.store.table('auditLog').find((x) => x.entityId === r.value.id)!;
      const late = (entry.changes as { late: { to: Record<string, string> } }).late.to;
      expect(late).toMatchObject({ reason: 'Urgent client visit today', dispatcherUserId: 'u1', cutoffAt: r.value.cutoffAt });
      expect(typeof late.createdAt).toBe('string');
      expect(((await w.bookings.list(w.ctx, { afterCutoff: 'true' } as never)) as { items: { id: string }[] }).items.map((b: { id: string }) => b.id)).toEqual([r.value.id]);
      expect(((await w.bookings.list(w.ctx, { afterCutoff: 'false' } as never)) as { items: { id: string }[] }).items).toHaveLength(0);
      expect(((await w.bookings.list(w.ctx, { journey: 'POINT_TO_POINT' } as never)) as { items: { id: string }[] }).items).toHaveLength(0);
      // Before the cut-off a reason is ignored (not late).
      const b = w.passenger('B');
      expect((await w.bookings.create(w.ctx, commute(b, { lateReason: 'Not needed at all here' }) as never, randomUUID())).value).toMatchObject({ afterCutoff: false, lateReason: null });
    }));

  it('D-A4 BOOKING_CREATED: generic inbox row + queued push when the desk books; replay and self-booking never notify', () =>
    run(async () => {
      const w = world();
      const a = w.passenger('A');
      Object.assign(w.store.table('employeeTransportProfile').find((p) => p.id === a)!, { userId: 'pax-user' });
      w.store.insert('user', { id: 'pax-user', companyId: 'c1', name: 'Pax', preferences: {} });
      w.store.insert('pushToken', { userId: 'pax-user', token: 'ExponentPushToken[fake]', sessionId: null });
      const key = randomUUID();
      const r = await w.bookings.create(w.ctx, p2p(a) as never, key);
      const again = await w.bookings.create(w.ctx, p2p(a) as never, key);
      expect(again.replay).toBe(true);
      const rows = w.store.table('transportNotification');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ userId: 'pax-user', audience: 'PASSENGER', kind: 'BOOKING_CREATED', tripId: null, bookingId: r.value.id, title: 'Ride booked for you', pushQueued: true });
      const log = w.store.table('notificationLog');
      expect(log).toHaveLength(1);
      expect(log[0]).toMatchObject({ channel: 'PUSH', status: 'QUEUED', refType: 'TRANSPORT_NOTIFICATION', refId: rows[0].id });
      for (const t of [rows[0].title, rows[0].body, log[0].subject, log[0].body]) for (const leak of ['Airport', 'P A', 'Depot', '2099']) expect(String(t)).not.toContain(leak);
      // Self-booking (the passenger's own login): no notification.
      const selfCtx = { ...(w.ctx as object), userId: 'pax-user' } as never;
      await w.bookings.create(selfCtx, commute(a) as never, randomUUID(), { actor: 'PASSENGER' });
      expect(w.store.table('transportNotification')).toHaveLength(1);
      // Push preference off: inbox row only.
      const b = w.passenger('B');
      Object.assign(w.store.table('employeeTransportProfile').find((p) => p.id === b)!, { userId: 'pax-b', preferences: { notifications: { push: false } } });
      w.store.insert('user', { id: 'pax-b', companyId: 'c1', name: 'B', preferences: {} });
      w.store.insert('pushToken', { userId: 'pax-b', token: 'ExponentPushToken[b]', sessionId: null });
      await w.bookings.create(w.ctx, commute(b) as never, randomUUID());
      expect(w.store.table('transportNotification').filter((n) => n.userId === 'pax-b')).toMatchObject([{ pushQueued: false }]);
      expect(w.store.table('notificationLog')).toHaveLength(1);
    }));

  it('places: active company places only, name search, at most 50', () =>
    run(async () => {
      const w = world();
      w.store.insert('poi', { companyId: 'c1', name: 'Old site', lat: 13, lng: 80, isActive: false });
      w.store.insert('poi', { companyId: 'c2', name: 'Office of c2', lat: 13, lng: 80, isActive: true });
      expect((await w.bookings.places(w.ctx, undefined)).map((p) => p.name).sort()).toEqual(['Depot', 'Office']);
      expect((await w.bookings.places(w.ctx, 'off')).map((p) => p.id)).toEqual([OFFICE]);
    }));
});

// PlannedTripsService → drivers.service → @nestjs/mapped-types (ESM-only; jest cannot load it). Not exercised here.
jest.mock('@nestjs/mapped-types', () => ({ PartialType: (c: new () => object) => class extends c {} }));

import { HttpException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { DispatchChangeOp } from '@veetracer/shared';
import { AuditService } from '../../audit/audit.service';
import { PlannedTripsService } from '../../planned-trips/planned-trips.service';
import { MemoryStore, type Obj } from '../testing/memory-store';
import { parseChangeOps } from './change-ops';
import { DispatchService, insertedArrival } from './dispatch.service';
import { TripLiveService } from './trip-live';

/**
 * E3 backend gaps: ADD_STOP on an existing trip (capacity / overlap / consent, Idempotency-Key, expectedVersions, audit),
 * the saved change-set detail (dispatcher-scoped), and the road ETA of TRIP candidates (RoutingService; null with a
 * reason when routing does not answer). The passenger's own points in MeTripDto are checked in the isolation matrix.
 */

const H = 3_600_000;
const MIN = 60_000;
const DAY = '2026-12-01';
const T0 = Date.parse(`${DAY}T02:00:00Z`);

type Routing = { enabled: boolean; route: (a: unknown, b: unknown) => Promise<{ m: number; s: number; shape: [number, number][] } | null>; routeVia: (p: unknown[]) => Promise<{ path: unknown } | null> };

function world(opts: { seats?: number; routing?: Partial<Routing> } = {}) {
  const store = new MemoryStore();
  store.insert('company', { id: 'c1', name: 'Corp', timezone: 'Asia/Kolkata', status: 'ACTIVE', settings: { features: ['etms'] }, isPlatform: false });
  store.insert('branch', { id: 'br1', companyId: 'c1', name: 'North', isActive: true });
  store.insert('branch', { id: 'br2', companyId: 'c1', name: 'South', isActive: true });
  const v1 = store.insert('trackedObject', { companyId: 'c1', branchId: 'br1', name: 'Van 1', plateNumber: 'TN01', isActive: true }).id as string;
  const v2 = store.insert('trackedObject', { companyId: 'c1', branchId: 'br2', name: 'Van 2', plateNumber: 'TN02', isActive: true }).id as string;
  store.insert('transportVehicleProfile', { objectId: v1, companyId: 'c1', seats: opts.seats ?? 3 });
  store.insert('transportVehicleProfile', { objectId: v2, companyId: 'c1', seats: 6 });
  const passenger = (code: string, consent = true, branchId: string | null = 'br1') => {
    const id = store.insert('employeeTransportProfile', { companyId: 'c1', branchId, employeeCode: code, displayName: `P ${code}`, homeLat: 13.06, homeLng: 80.24 }).id as string;
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
  const redis = { client: { get: async () => null, mget: async (...k: string[]) => k.map(() => null), set: async () => 'OK', eval: async () => 1, publish: async () => 1 } };
  const plannedTrips = new PlannedTripsService(prisma as never, audit, { invalidate: async () => undefined } as never);
  const routing: Routing = { enabled: false, route: async () => null, routeVia: async () => null, ...opts.routing };
  const live = new TripLiveService(prisma as never, redis as never, plannedTrips);
  const dispatch = new DispatchService(prisma as never, audit, routing as never, live, redis as never);
  const ctx = { userId: 'u1', companyId: 'c1', homeCompanyId: 'c1', isSuperAdmin: false, permissions: {}, dataScope: 'COMPANY', branchIds: [], objectIds: [], features: ['etms'], agreements: [], ip: null } as never;
  return { store, ctx, dispatch, v1, v2, passenger, booking };
}

const stops = (from = T0) => [
  { seq: 0, point: { lat: 13.06, lng: 80.24, label: 'Home' }, plannedArrival: new Date(from).toISOString() },
  { seq: 1, point: { lat: 13.05, lng: 80.25, label: 'Office', poiId: null }, plannedArrival: new Date(from + H).toISOString() },
];
const createTrip = (objectId: string, o: Partial<Extract<DispatchChangeOp, { op: 'CREATE_TRIP' }>> = {}): DispatchChangeOp => ({ op: 'CREATE_TRIP', tempId: 't', objectId, plannedStart: new Date(T0).toISOString(), stops: stops(), ...o });
const code = async (p: Promise<unknown>) => {
  const e = await p.then(() => null, (x: unknown) => x);
  if (!(e instanceof HttpException)) throw e ?? new Error('expected an error');
  return [e.getStatus(), (e.getResponse() as { code?: string }).code];
};

/** A published trip (Home 07:30 → Office 08:30) with passenger A seated 0 → 1; plus booking B far from both stops. */
async function seeded(opts: Parameters<typeof world>[0] = {}) {
  const w = world(opts);
  const a = w.booking(w.passenger('A'));
  const r = await w.dispatch.submit(w.ctx, { serviceDate: DAY, direction: 'IN', changes: [createTrip(w.v1), { op: 'ADD_PASSENGER', tripId: 't', bookingId: a, pickupSeq: 0, dropSeq: 1 }] }, randomUUID());
  const tripId = r.value.trips[0].id;
  const b = w.booking(w.passenger('B'), { pickupLat: 13.08, pickupLng: 80.27, pickupLabel: '7 Lake Road' });
  return { ...w, a, b, tripId, plannedTripId: r.value.trips[0].plannedTripId as string };
}

const addStop = (tripId: string, bookingId: string, afterSeq: number, o: Partial<Extract<DispatchChangeOp, { op: 'ADD_STOP' }>> = {}): DispatchChangeOp => ({ op: 'ADD_STOP', tripId, bookingId, end: 'PICKUP', afterSeq, ...o });

describe('ADD_STOP: a new stop on an existing ETMS trip (E3 gap 3)', () => {
  it('inserts the booking’s own point, shifts later stops and seats, then seats the booking; versioned, evented, audited', async () => {
    const w = await seeded();
    const body = { serviceDate: DAY, direction: 'IN' as const, expectedVersions: { [w.tripId]: 1 }, changes: [addStop(w.tripId, w.b, 0), { op: 'ADD_PASSENGER' as const, tripId: w.tripId, bookingId: w.b, pickupSeq: 1, dropSeq: 2 }] };
    const key = randomUUID();
    const r = await w.dispatch.submit(w.ctx, body, key);
    expect(r.value).toMatchObject({ status: 'PUBLISHED', trips: [{ id: w.tripId, version: 2 }], bookings: [{ id: w.b, status: 'ASSIGNED' }] });
    const st = w.store.table('plannedTripStop').filter((s) => s.tripId === w.plannedTripId).sort((x, y) => (x.seq as number) - (y.seq as number));
    expect(st.map((s) => [s.seq, s.name, s.lat, s.lng])).toEqual([
      [0, 'Home', 13.06, 80.24],
      [1, '7 Lake Road', 13.08, 80.27],
      [2, 'Office', 13.05, 80.25],
    ]);
    // Planned between its neighbours (07:30 departure … 08:30 arrival → 08:00).
    expect((st[1].plannedArrival as Date).toISOString()).toBe(new Date(T0 + 0.5 * H).toISOString());
    const seats = w.store.table('transportTripPassenger');
    expect(seats.find((p) => p.bookingId === w.a)).toMatchObject({ pickupSeq: 0, dropSeq: 2 });
    expect(seats.find((p) => p.bookingId === w.b)).toMatchObject({ pickupSeq: 1, dropSeq: 2, pickupStopId: st[1].id, dropStopId: st[2].id });
    expect(w.store.table('transportTrip')[0]).toMatchObject({ occupiedSeats: 2, version: 2 });
    const ev = w.store.table('transportTripEvent').find((e) => e.kind === 'STOP_ADDED')!;
    expect(ev).toMatchObject({ stopSeq: 1, data: { bookingId: w.b, end: 'PICKUP' } });
    expect(JSON.stringify(ev.data)).not.toContain('13.08'); // no coordinates in the event
    const audit = w.store.table('auditLog').find((x) => x.entity === 'TransportTrip' && x.action === 'UPDATE')!;
    expect(audit.changes).toMatchObject({ stops: { to: 3 }, stopsAdded: { to: 1 } });
    // Same key + body replays; the stop is not inserted twice.
    const again = await w.dispatch.submit(w.ctx, structuredClone(body), key);
    expect(again.replay).toBe(true);
    expect(w.store.table('plannedTripStop').filter((s) => s.tripId === w.plannedTripId)).toHaveLength(3);
    // A stale version is refused.
    const c = w.booking(w.passenger('C'), { pickupLat: 13.09, pickupLng: 80.28 });
    expect(await code(w.dispatch.submit(w.ctx, { ...body, changes: [addStop(w.tripId, c, 0)] }, randomUUID()))).toEqual([409, 'VERSION_CONFLICT']);
  });

  it('refuses without consent, without a point, over capacity, out of order, on a new trip; nothing is written', async () => {
    const w = await seeded({ seats: 1 });
    const v = { [w.tripId]: 1 };
    const noConsent = w.booking(w.passenger('N', false), { pickupLat: 13.1, pickupLng: 80.3 });
    const stopsBefore = w.store.table('plannedTripStop').length;
    const send = (changes: DispatchChangeOp[], expectedVersions: Record<string, number> = v) => w.dispatch.submit(w.ctx, { serviceDate: DAY, direction: 'IN', expectedVersions, changes }, randomUUID());
    expect(await code(send([addStop(w.tripId, noConsent, 0)]))).toEqual([403, 'CONSENT_REQUIRED']);
    expect(await code(send([addStop(w.tripId, w.b, 0)]))).toEqual([409, 'CAPACITY_EXCEEDED']); // 1 seat, A holds it
    const noPoint = w.booking(w.passenger('P'), { pickupLat: null, pickupLng: null });
    expect(await code(send([addStop(w.tripId, noPoint, 0)]))).toEqual([409, 'NEEDS_LOCATION']);
    expect(w.store.table('plannedTripStop')).toHaveLength(stopsBefore);
    // Shape / order (a trip with free seats).
    const x = await seeded();
    const sendX = (changes: DispatchChangeOp[], expectedVersions: Record<string, number> = { [x.tripId]: 1 }) => x.dispatch.submit(x.ctx, { serviceDate: DAY, direction: 'IN', expectedVersions, changes }, randomUUID());
    expect(await code(sendX([addStop(x.tripId, x.b, 5)]))).toEqual([400, 'VALIDATION_FAILED']);
    expect(await code(sendX([addStop(x.tripId, x.b, 0, { plannedArrival: new Date(T0 + 2 * H).toISOString() })]))).toEqual([400, 'VALIDATION_FAILED']);
    expect(await code(sendX([createTrip(x.v2, { tempId: 'n' }), { op: 'ADD_STOP', tripId: 'n', bookingId: x.b, end: 'PICKUP', afterSeq: 0 } as DispatchChangeOp], {}))).toEqual([400, 'VALIDATION_FAILED']);
    const xStops = x.store.table('plannedTripStop').length;
    expect(await code(sendX([addStop(x.tripId, x.b, 0, { plannedArrival: new Date(T0 - H).toISOString() })]))).toEqual([400, 'VALIDATION_FAILED']);
    expect(x.store.table('plannedTripStop')).toHaveLength(xStops);
    // The point never comes from the client.
    expect(() => parseChangeOps([{ op: 'ADD_STOP', tripId: w.tripId, bookingId: w.b, end: 'PICKUP', afterSeq: 0, point: { lat: 1, lng: 1 } }])).toThrow(HttpException);
  });

  it('a trip that grows longer is checked for vehicle overlap (409 VEHICLE_BUSY); the route path is re-planned or cleared', async () => {
    const via: unknown[][] = [];
    const w = await seeded({ routing: { enabled: true, routeVia: async (p) => (via.push(p), { path: { type: 'LineString', coordinates: [[80.24, 13.06]] } }) } });
    // Another trip of the same vehicle starts right after (08:30–09:30).
    w.store.insert('plannedTrip', { companyId: 'c1', objectId: w.v1, origin: 'ROUTE', routeId: 'r', routeName: 'Shuttle', corridorM: 200, plannedStart: new Date(T0 + H), plannedEnd: new Date(T0 + 2 * H), status: 'SCHEDULED' });
    const late = { serviceDate: DAY, direction: 'IN' as const, expectedVersions: { [w.tripId]: 1 }, changes: [addStop(w.tripId, w.b, 1, { plannedArrival: new Date(T0 + 1.25 * H).toISOString() })] };
    expect(await code(w.dispatch.submit(w.ctx, late, randomUUID()))).toEqual([409, 'VEHICLE_BUSY']);
    const ok = await w.dispatch.submit(w.ctx, { ...late, changes: [addStop(w.tripId, w.b, 0)] }, randomUUID());
    expect(ok.value.trips[0].version).toBe(2);
    expect(via.at(-1)).toEqual([
      { lat: 13.06, lng: 80.24 },
      { lat: 13.08, lng: 80.27 },
      { lat: 13.05, lng: 80.25 },
    ]);
    expect(w.store.table('plannedTrip').find((p) => p.id === w.plannedTripId)!.path).toEqual({ type: 'LineString', coordinates: [[80.24, 13.06]] });
  });

  it('default planned arrival: middle between neighbours, 10 min before the first / after the last stop', () => {
    const at = (ms: number) => new Date(ms);
    expect(insertedArrival({ plannedDeparture: at(T0) }, { plannedArrival: at(T0 + H) }).getTime()).toBe(T0 + 0.5 * H);
    expect(insertedArrival({ plannedDeparture: at(T0) }, undefined).getTime()).toBe(T0 + 10 * MIN);
    expect(insertedArrival(undefined, { plannedArrival: at(T0) }).getTime()).toBe(T0 - 10 * MIN);
  });
});

describe('candidates: road ETA for TRIP candidates (E3 gap 4)', () => {
  it('ROAD estimate from the planned stop before the insertion point (stop departure + road time), never invented', async () => {
    const calls: unknown[][] = [];
    const w = await seeded({ routing: { enabled: true, route: async (a, b) => (calls.push([a, b]), { m: 4200, s: 600, shape: [] }) } });
    const c = await w.dispatch.candidates(w.ctx, { bookingIds: [w.b] });
    const trip = c.candidates.find((x) => x.kind === 'TRIP')!;
    expect(trip.eta).toEqual({ at: new Date(T0 + 10 * MIN).toISOString(), model: 'ROAD', durationSec: 600, from: 'TRIP_STOP', fromStopSeq: 0 });
    expect(calls[0]).toEqual([{ lat: 13.06, lng: 80.24 }, { lat: 13.08, lng: 80.27 }]);
    expect(c.routingAvailable).toBe(true);
  });

  it('routing off → null + ROUTING_UNAVAILABLE; no route → NO_ROUTE; no consent → NO_PICKUP (the point is not used)', async () => {
    const off = await seeded();
    expect((await off.dispatch.candidates(off.ctx, { bookingIds: [off.b] })).candidates.find((x) => x.kind === 'TRIP')!.eta).toEqual({ at: null, model: null, degraded: 'ROUTING_UNAVAILABLE' });
    const none = await seeded({ routing: { enabled: true, route: async () => null } });
    expect((await none.dispatch.candidates(none.ctx, { bookingIds: [none.b] })).candidates.find((x) => x.kind === 'TRIP')!.eta).toEqual({ at: null, model: null, degraded: 'NO_ROUTE' });
    const calls: unknown[] = [];
    const nc = await seeded({ routing: { enabled: true, route: async (a, b) => (calls.push([a, b]), { m: 1, s: 1, shape: [] }) } });
    const nb = nc.booking(nc.passenger('Z', false), { pickupLat: 13.2, pickupLng: 80.4 });
    const res = await nc.dispatch.candidates(nc.ctx, { bookingIds: [nb] });
    expect(res.candidates.find((x) => x.kind === 'TRIP')).toMatchObject({ eta: { at: null, degraded: 'NO_PICKUP' }, straightM: null, reasons: expect.arrayContaining(['CONSENT_REQUIRED']) });
    expect(calls).toHaveLength(0);
  });
});

describe('saved change-set detail (E3 gap 2)', () => {
  it('shows a draft’s changes with names, issues and M3-safe stop points; 404 for another company or out of the dispatcher’s scope', async () => {
    const w = await seeded();
    const c = w.booking(w.passenger('C'), { pickupLat: 13.071234, pickupLng: 80.261234 });
    const saved = await w.dispatch.submit(
      w.ctx,
      {
        serviceDate: DAY,
        direction: 'IN',
        draft: true,
        reason: 'Morning plan',
        expectedVersions: { [w.tripId]: 1 },
        changes: [
          addStop(w.tripId, w.b, 0),
          { op: 'ADD_PASSENGER', tripId: w.tripId, bookingId: w.b, pickupSeq: 1, dropSeq: 2 },
          createTrip(w.v2, { tempId: 'n', stops: [{ seq: 0, point: { lat: 13.071234, lng: 80.261234, label: 'Gate' }, plannedArrival: new Date(T0 + 3 * H).toISOString() }, { seq: 1, point: { lat: 13.05, lng: 80.25, label: 'Office' }, plannedArrival: new Date(T0 + 4 * H).toISOString() }], plannedStart: new Date(T0 + 3 * H).toISOString() }),
          { op: 'ADD_PASSENGER', tripId: 'n', bookingId: c, pickupSeq: 0, dropSeq: 1 },
        ],
      },
      undefined,
    );
    const id = saved.value.changeSetId;
    const d = await w.dispatch.changeSet(w.ctx, id);
    expect(d).toMatchObject({ id, status: 'DRAFT', reason: 'Morning plan', expectedVersions: { [w.tripId]: 1 }, changeCount: 4, issues: [] });
    expect(d.changes.map((x) => x.op)).toEqual(['ADD_STOP', 'ADD_PASSENGER', 'CREATE_TRIP', 'ADD_PASSENGER']);
    expect(d.changes[0]).toMatchObject({ tripLabel: expect.stringContaining('Van 1'), passenger: { displayName: 'P B' }, end: 'PICKUP', afterSeq: 0 });
    expect(d.changes[2]).toMatchObject({ vehicleName: 'Van 2', stops: [{ seq: 0, label: 'Gate', point: { lat: 13.071234 } }, { seq: 1 }] }); // whole-company dispatcher: exact
    expect(d.changes[3]).toMatchObject({ tripLabel: 'Van 2 · new trip', passenger: { displayName: 'P C' }, bookingStatus: 'PENDING_ASSIGNMENT' });

    // Branch-scoped dispatcher of br2 (Van 2's branch) cannot see Van 1 / passengers of br1: the whole change set is 404.
    const scoped = { ...(w.ctx as object), dataScope: 'ASSIGNED', branchIds: ['br2'] } as never;
    expect(await code(w.dispatch.changeSet(scoped, id))).toEqual([404, 'NOT_FOUND']);
    expect(await code(w.dispatch.changeSet({ ...(w.ctx as object), companyId: 'c2' } as never, id))).toEqual([404, 'NOT_FOUND']);

    // C withdraws consent and B is seated elsewhere meanwhile: the stop at C's point loses its coordinates; issues say why.
    w.store.insert('employeeTransportConsent', { companyId: 'c1', profileId: w.store.table('transportBooking').find((x) => x.id === c)!.profileId, purpose: 'TRANSPORT_PROFILE', noticeVersion: 'v1', granted: false, channel: 'WEB', occurredAt: new Date() });
    w.store.table('transportBooking').find((x) => x.id === w.b)!.status = 'CANCELLED';
    const again = await w.dispatch.changeSet(w.ctx, id);
    expect((again.changes[2] as { stops: { point: unknown }[] }).stops[0].point).toBeNull();
    expect(again.issues).toEqual(expect.arrayContaining([expect.stringContaining('P B: the booking is cancelled'), expect.stringContaining('P C: no active routing consent')]));
    // A published change set keeps no changes.
    const pub = w.store.table('transportChangeSet').find((x) => x.status === 'PUBLISHED')!;
    expect(await w.dispatch.changeSet(w.ctx, pub.id as string)).toMatchObject({ status: 'PUBLISHED', changes: [] });
  });
});

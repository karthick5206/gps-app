jest.mock('@nestjs/mapped-types', () => ({ PartialType: (c: new () => object) => class extends c {} }));

import { HttpException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { TRANSPORT_NOTIFICATION_TEXT, type DriverTripEventInput } from '@veetracer/shared';
import type { AuthContext } from '../../access/auth-context';
import { AuditService } from '../../audit/audit.service';
import { PlannedTripsService } from '../../planned-trips/planned-trips.service';
import { TripLiveService } from '../dispatch/trip-live';
import { TransportNotificationsService } from '../notifications/transport-notifications.service';
import { TransportNotifyRelayService } from '../notifications/transport-notify-relay.service';
import { MemoryStore, type Obj } from '../testing/memory-store';
import { makeNotifier, fakePrisma } from '../../notifier/notifier.spec-helpers';
import type { PushMessage, PushProvider, PushResult } from '../../notifier/push';
import { DriverApiService } from './driver-api.service';

const MIN = 60_000;

/**
 * Driver API on the in-memory Prisma stand-in (real services, real where-clauses): authorisation, the minimum
 * manifest, online-only start, offline replay / idempotency / ordering, reassignment, duty, sync, and the notification
 * relay with generic push payloads.
 */
function world(opts: { plannedStartInMin?: number } = {}) {
  const store = new MemoryStore();
  for (const id of ['custA', 'custB']) store.insert('company', { id, name: id, timezone: 'Asia/Kolkata', settings: { features: ['etms'] } });
  for (const [id, companyId] of [['u-dA', 'custA'], ['u-dA2', 'custA'], ['u-dB', 'custB'], ['u-pA', 'custA'], ['u-nobody', 'custA']]) store.insert('user', { id, companyId, name: id });
  const driver = (companyId: string, userId: string, name: string) => store.insert('driver', { companyId, name, userId, isActive: true, licenseExpiry: null, employeeId: null }).id as string;
  const dA = driver('custA', 'u-dA', 'Ravi Kumar');
  const dA2 = driver('custA', 'u-dA2', 'Second Driver');
  const dB = driver('custB', 'u-dB', 'Other Co Driver');
  const vehicle = store.insert('trackedObject', { companyId: 'custA', name: 'Van 7', plateNumber: 'TN01AB1234', isActive: true }).id as string;
  const profile = (name: string, code: string, userId: string | null, wheelchair: boolean) =>
    store.insert('employeeTransportProfile', { companyId: 'custA', employeeCode: code, displayName: name, userId, mobile: '+919876500001', email: `${code}@corp.test`, homeAddress: '12 Secret Lane', homeLat: 13.061234, homeLng: 80.241234, accessibility: { wheelchair, notes: 'knee surgery' }, preferences: {} }).id as string;
  const pAsha = profile('Asha Kumari Rao', 'EMP7', 'u-pA', true);
  const pBala = profile('Bala Subramanian', 'EMP8', null, false);
  const start = Date.now() + (opts.plannedStartInMin ?? 10) * MIN;
  const pt = store.insert('plannedTrip', { companyId: 'custA', origin: 'ETMS', routeId: null, objectId: vehicle, driverId: dA, routeName: 'Login 09:00', corridorM: 200, plannedStart: new Date(start), plannedEnd: new Date(start + 60 * MIN), status: 'SCHEDULED', nextStopSeq: null });
  const s0 = store.insert('plannedTripStop', { tripId: pt.id, seq: 0, name: 'Pickup 1', lat: 13.06, lng: 80.24, radiusM: 100, plannedArrival: new Date(start), plannedDeparture: new Date(start) });
  const s1 = store.insert('plannedTripStop', { tripId: pt.id, seq: 1, name: 'Office', lat: 13.05, lng: 80.25, radiusM: 100, plannedArrival: new Date(start + 60 * MIN), plannedDeparture: new Date(start + 60 * MIN) });
  const tt = store.insert('transportTrip', { plannedTripId: pt.id, providerCompanyId: 'custA', customerCompanyId: 'custA', serviceDate: new Date(new Date(start).toISOString().slice(0, 10) + 'T00:00:00Z'), direction: 'IN', seatCapacity: 4, occupiedSeats: 2, publishedAt: new Date() });
  const seat = (profileId: string) => {
    const b = store.insert('transportBooking', { customerCompanyId: 'custA', providerCompanyId: 'custA', profileId, status: 'ASSIGNED', serviceDate: tt.serviceDate, direction: 'IN', timeZone: 'Asia/Kolkata', windowStart: new Date(start - 30 * MIN), windowEnd: new Date(start + 60 * MIN) });
    return store.insert('transportTripPassenger', { tripId: tt.id, bookingId: b.id, customerCompanyId: 'custA', providerCompanyId: 'custA', pickupStopId: s0.id, dropStopId: s1.id, pickupSeq: 0, dropSeq: 1, seats: 1, createdAt: new Date(Date.now() + store.table('transportTripPassenger').length) }).id as string;
  };
  const pax1 = seat(pAsha);
  const pax2 = seat(pBala);

  const prisma = store.client();
  const audit = new AuditService(prisma as never);
  let liveJson: string | null = null;
  const xadds: string[][] = [];
  const redis = { client: { get: async () => liveJson, set: async () => 'OK', publish: async () => 1, eval: async () => 1, xadd: async (...a: string[]) => (xadds.push(a), '1-0') } };
  const plannedTrips = new PlannedTripsService(prisma as never, audit, { invalidate: async () => undefined } as never);
  const live = new TripLiveService(prisma as never, redis as never, plannedTrips);
  const notifications = new TransportNotificationsService(prisma as never, redis as never);
  const svc = new DriverApiService(prisma as never, audit, redis as never, live, notifications);
  const relay = new TransportNotifyRelayService(prisma as never, redis as never, notifications);
  const ctx = (userId: string, companyId = 'custA'): AuthContext => ({
    userId,
    homeCompanyId: companyId,
    companyId,
    isSuperAdmin: false,
    permissions: { etms_driver: ['view', 'edit'] },
    dataScope: 'ASSIGNED',
    branchIds: [],
    objectIds: [],
    features: ['etms'],
    agreements: [],
    ip: null,
  });
  const setLive = (lat: number, lng: number, at = new Date()) => (liveJson = JSON.stringify({ lat, lng, fixTime: at.toISOString(), licenceLocked: false }));
  const row = (model: string, id: string) => store.table(model).find((r) => r.id === id)!;
  return { store, svc, relay, notifications, ctx, setLive, row, xadds, ids: { dA, dA2, dB, vehicle, pt: pt.id as string, tt: tt.id as string, s0: s0.id as string, s1: s1.id as string, pax1, pax2, pAsha, pBala } };
}

const codeOf = async (p: Promise<unknown>) => p.then(() => 'OK', (e: HttpException) => (e.getResponse() as { code?: string }).code ?? String(e.getStatus()));
const ev = (type: string, seq: number, extra: Partial<DriverTripEventInput> = {}) => ({ clientEventId: randomUUID(), seq, type, occurredAt: new Date().toISOString(), ...extra }) as DriverTripEventInput;
const outcomes = (r: { results: { outcome: string; code: string | null }[] }) => r.results.map((x) => (x.outcome === 'ACCEPTED' ? 'ACCEPTED' : `${x.outcome}:${x.code}`));
const started = (w: ReturnType<typeof world>) => w.svc.startTrip(w.ctx('u-dA'), w.ids.tt, { clientEventId: randomUUID(), occurredAt: new Date().toISOString() });

describe('driver API: relationship authorisation (D5)', () => {
  it('the menu alone is not enough: no linked driver → 403 NOT_A_DRIVER; inactive → DRIVER_INACTIVE', async () => {
    const w = world();
    expect(await codeOf(w.svc.me(w.ctx('u-nobody')))).toBe('NOT_A_DRIVER');
    expect(await codeOf(w.svc.trips(w.ctx('u-pA'), {}))).toBe('NOT_A_DRIVER');
    // A linked driver acting in another company (e.g. a switched context) is not a driver there.
    expect(await codeOf(w.svc.me(w.ctx('u-dA', 'custB')))).toBe('NOT_A_DRIVER');
    w.row('driver', w.ids.dA).isActive = false;
    expect(await codeOf(w.svc.trip(w.ctx('u-dA'), w.ids.tt))).toBe('DRIVER_INACTIVE');
  });

  it('only the assigned driver sees the trip; another driver of the company and other companies get 404', async () => {
    const w = world();
    expect((await w.svc.trips(w.ctx('u-dA'), {})).map((t) => t.id)).toEqual([w.ids.tt]);
    expect(await w.svc.trips(w.ctx('u-dA2'), {})).toEqual([]);
    expect(await w.svc.trips(w.ctx('u-dB', 'custB'), {})).toEqual([]);
    for (const [u, c] of [['u-dA2', 'custA'], ['u-dB', 'custB']]) {
      expect(await codeOf(w.svc.trip(w.ctx(u, c), w.ids.tt))).toBe('NOT_FOUND');
      expect(await codeOf(w.svc.startTrip(w.ctx(u, c), w.ids.tt, { clientEventId: randomUUID(), occurredAt: new Date().toISOString() }))).toBe('NOT_FOUND');
      expect(await codeOf(w.svc.events(w.ctx(u, c), w.ids.tt, { events: [ev('ACKNOWLEDGE', 1)] }))).toBe('NOT_FOUND');
    }
    // Unpublished, or outside the window: not visible either.
    w.row('transportTrip', w.ids.tt).publishedAt = null;
    expect(await codeOf(w.svc.trip(w.ctx('u-dA'), w.ids.tt))).toBe('NOT_FOUND');
  });

  it('a trip outside the window (planned more than 36 h ahead) is 404 until it comes into the window', async () => {
    const w = world({ plannedStartInMin: 40 * 60 });
    expect(await codeOf(w.svc.trip(w.ctx('u-dA'), w.ids.tt))).toBe('NOT_FOUND');
    expect(await w.svc.trips(w.ctx('u-dA'), {})).toEqual([]);
  });
});

describe('driver API: minimum manifest and hiding after completion (09 §3.4 / §7)', () => {
  it('first name + last initial, wheelchair flag, counts per stop; no codes, contacts, addresses, notes', async () => {
    const w = world();
    const d = await w.svc.trip(w.ctx('u-dA'), w.ids.tt);
    expect(d.passengers.map((p) => [p.number, p.displayName, p.accessibility, p.contact, p.contactPolicy])).toEqual([
      [1, 'Asha R.', true, null, 'NONE_R1'],
      [2, 'Bala S.', false, null, 'NONE_R1'],
    ]);
    expect(d.stops[0]).toMatchObject({ seq: 0, label: 'Pickup 1', lat: 13.06, pickups: 2, pending: 2 });
    const text = JSON.stringify(d);
    for (const leak of ['EMP7', 'EMP8', '+91', '@corp.test', 'Secret Lane', '13.061234', 'knee', 'Asha Kumari', 'Rao', 'Subramanian']) expect([leak, text.includes(leak)]).toEqual([leak, false]);
    // Manifest reads are ACCESS-audited (throttled per trip / hour by the cache).
    expect(w.store.table('auditLog').some((a) => a.action === 'ACCESS' && (a.changes as { what?: string } | undefined)?.what === 'driver-manifest')).toBe(true);
  });

  it('a recorded outcome collapses the name to "Passenger <n>"; a closed trip shows counts only', async () => {
    const w = world();
    await started(w);
    await w.svc.events(w.ctx('u-dA'), w.ids.tt, { events: [ev('ARRIVED', 1, { stopSeq: 0 }), ev('BOARDED', 2, { passengerTripId: w.ids.pax1 })] });
    const mid = await w.svc.trip(w.ctx('u-dA'), w.ids.tt);
    expect(mid.passengers.map((p) => p.displayName)).toEqual(['Passenger 1', 'Bala S.']);
    expect(mid.passengers[0].allowedEvents).toEqual(['DROPPED']);
    Object.assign(w.row('plannedTrip', w.ids.pt), { status: 'COMPLETED' });
    const closed = await w.svc.trip(w.ctx('u-dA'), w.ids.tt);
    expect(closed).toMatchObject({ manifestHidden: 'TRIP_CLOSED', passengers: [], counts: { passengers: 2, boarded: 1, pending: 1 } });
    expect(closed.stops.every((s) => s.lat === null && s.lng === null && s.label === null)).toBe(true);
    const history = await w.svc.history(w.ctx('u-dA'), { from: new Date(Date.now() - 86_400_000).toISOString(), to: new Date(Date.now() + 86_400_000).toISOString() });
    expect(history).toHaveLength(1);
    expect(JSON.stringify(history)).not.toMatch(/Asha|Bala|13\.06/);
  });
});

describe('driver API: start is online only (09 §4.4)', () => {
  it('a replayed (stale) start is refused; a fresh start is a compare-and-set; the same clientEventId is idempotent', async () => {
    const w = world();
    const d = w.ctx('u-dA');
    expect(await codeOf(w.svc.startTrip(d, w.ids.tt, { clientEventId: randomUUID(), occurredAt: new Date(Date.now() - 5 * MIN).toISOString() }))).toBe('STALE_COMMAND');
    expect(w.row('plannedTrip', w.ids.pt).status).toBe('SCHEDULED');
    const key = randomUUID();
    const first = await w.svc.startTrip(d, w.ids.tt, { clientEventId: key, occurredAt: new Date().toISOString() });
    expect(first).toMatchObject({ outcome: 'STARTED', warnings: ['TELEMETRY_STALE'] });
    expect(w.row('plannedTrip', w.ids.pt)).toMatchObject({ status: 'IN_PROGRESS', nextStopSeq: 0 });
    expect(w.row('plannedTripStop', w.ids.s0).status).toBe('PENDING'); // the first pickup is still to be reached
    expect((await w.svc.startTrip(d, w.ids.tt, { clientEventId: key, occurredAt: new Date().toISOString() })).outcome).toBe('STARTED');
    expect((await w.svc.startTrip(d, w.ids.tt, { clientEventId: randomUUID(), occurredAt: new Date().toISOString() })).outcome).toBe('ALREADY_STARTED');
    expect(w.store.table('transportTripEvent').filter((e) => e.kind === 'STARTED').map((e) => e.outcome)).toEqual(['ACCEPTED', 'DUPLICATE']);
  });

  it('guards: start window, vehicle busy, expired licence', async () => {
    const early = world({ plannedStartInMin: 3 * 60 });
    expect(await codeOf(started(early))).toBe('OUTSIDE_START_WINDOW');
    const busy = world();
    busy.store.insert('plannedTrip', { companyId: 'custA', origin: 'ROUTE', objectId: busy.ids.vehicle, routeName: 'Other', corridorM: 100, plannedStart: new Date(), plannedEnd: new Date(), status: 'IN_PROGRESS' });
    expect(await codeOf(started(busy))).toBe('VEHICLE_BUSY');
    const lic = world();
    lic.row('driver', lic.ids.dA).licenseExpiry = new Date(Date.now() - 3 * 86_400_000);
    expect(await codeOf(started(lic))).toBe('DRIVER_DOCUMENTS_EXPIRED');
  });
});

describe('driver API: offline event sync (09 §6)', () => {
  it('replay of a whole batch returns the original outcomes (DUPLICATE) and changes nothing twice', async () => {
    const w = world();
    await started(w);
    const batch = { events: [ev('ARRIVED', 1, { stopSeq: 0 }), ev('BOARDED', 2, { passengerTripId: w.ids.pax1 })] };
    expect(outcomes(await w.svc.events(w.ctx('u-dA'), w.ids.tt, batch))).toEqual(['ACCEPTED', 'ACCEPTED']);
    const count = w.store.table('transportTripEvent').length;
    const again = await w.svc.events(w.ctx('u-dA'), w.ids.tt, batch);
    expect(again.results.map((r) => [r.outcome, r.original])).toEqual([
      ['DUPLICATE', 'ACCEPTED'],
      ['DUPLICATE', 'ACCEPTED'],
    ]);
    expect(w.store.table('transportTripEvent')).toHaveLength(count);
    expect(w.row('transportTripPassenger', w.ids.pax1)).toMatchObject({ status: 'BOARDED', outcomeSource: 'DRIVER_APP', outcomeByUserId: 'u-dA' });
    expect(w.row('plannedTripStop', w.ids.s0)).toMatchObject({ status: 'ARRIVED' });
  });

  it('shuffled order inside a batch is evaluated by seq; across batches a gap is RETRY (not stored) and converges', async () => {
    const w = world();
    await started(w);
    const arrive = ev('ARRIVED', 1, { stopSeq: 0 });
    const board = ev('BOARDED', 2, { passengerTripId: w.ids.pax1 });
    // Only the later event arrives first (e.g. after a reinstall the queue was replayed partly).
    const r1 = await w.svc.events(w.ctx('u-dA'), w.ids.tt, { events: [board] });
    expect(outcomes(r1)).toEqual(['RETRY:OUT_OF_ORDER']);
    expect(w.store.table('transportTripEvent').some((e) => e.clientEventId === board.clientEventId)).toBe(false);
    // Both, shuffled: seq order wins.
    expect(outcomes(await w.svc.events(w.ctx('u-dA'), w.ids.tt, { events: [board, arrive] }))).toEqual(['ACCEPTED', 'ACCEPTED']);
    expect(w.row('transportTripPassenger', w.ids.pax1).status).toBe('BOARDED');
  });

  it('per-event rejections are terminal and stored; START_TRIP in a batch is ONLINE_ONLY; a reused clientEventId is refused', async () => {
    const w = world();
    await started(w);
    const arrive = ev('ARRIVED', 1, { stopSeq: 0 });
    const r = await w.svc.events(w.ctx('u-dA'), w.ids.tt, { events: [arrive, ev('NO_SHOW', 2, { passengerTripId: w.ids.pax2 }), ev('START_TRIP', 3), ev('COMPLETE_TRIP', 4)] });
    expect(outcomes(r)).toEqual(['ACCEPTED', 'REJECTED:WAIT_NOT_ELAPSED', 'REJECTED:ONLINE_ONLY', 'ACCEPTED']);
    expect(w.store.table('transportTripEvent').filter((e) => e.outcome === 'REJECTED').map((e) => (e.data as { code: string }).code).sort()).toEqual(['ONLINE_ONLY', 'WAIT_NOT_ELAPSED']);
    // The trip is completed now: the manifest is gone from the answer, later events are LATE.
    expect(r.trip).toMatchObject({ manifestHidden: 'TRIP_CLOSED', plannedTripStatus: 'COMPLETED' });
    const late = await w.svc.events(w.ctx('u-dA'), w.ids.tt, { events: [ev('BOARDED', 5, { passengerTripId: w.ids.pax2 })] });
    expect(outcomes(late)).toEqual(['LATE:TRIP_CLOSED']);
    const reused = await w.svc.events(w.ctx('u-dA'), w.ids.tt, { events: [{ ...arrive, type: 'DEPARTED' } as DriverTripEventInput] });
    expect(outcomes(reused)).toEqual(['REJECTED:IDEMPOTENCY_KEY_REUSED']);
  });

  it('dispatcher wins: after a reassignment, queued events get NOT_ASSIGNED (kept for audit) and sync says REVOKED', async () => {
    const w = world();
    await w.svc.events(w.ctx('u-dA'), w.ids.tt, { events: [ev('ACKNOWLEDGE', 1)] });
    expect(w.row('transportTrip', w.ids.tt)).toMatchObject({ acknowledgedSource: 'DRIVER_APP', acknowledgedByUserId: 'u-dA' });
    w.row('plannedTrip', w.ids.pt).driverId = w.ids.dA2;
    w.store.insert('transportTripEvent', { tripId: w.ids.tt, providerCompanyId: 'custA', customerCompanyId: 'custA', kind: 'DRIVER_CHANGED', actorType: 'DISPATCHER', source: 'WEB', occurredAt: new Date(), data: { from: w.ids.dA, to: w.ids.dA2 } });
    const r = await w.svc.events(w.ctx('u-dA'), w.ids.tt, { events: [ev('REPORT_DELAY', 2, { etaMin: 10 })] });
    expect(outcomes(r)).toEqual(['REJECTED:NOT_ASSIGNED']);
    expect(r.trip).toBeNull();
    const sync = await w.svc.sync(w.ctx('u-dA'), {});
    expect(sync.trips).toEqual([{ id: w.ids.tt, version: 0, change: 'REVOKED', plannedTripStatus: null }]);
    expect(sync.events.map((e) => e.outcome).sort()).toEqual(['ACCEPTED', 'REJECTED']);
    // The new driver sees it; the old one gets 404 on the detail.
    expect(await codeOf(w.svc.trip(w.ctx('u-dA'), w.ids.tt))).toBe('NOT_FOUND');
    expect((await w.svc.trip(w.ctx('u-dA2'), w.ids.tt)).id).toBe(w.ids.tt);
  });

  it('ARRIVED is checked against the vehicle GPS fix: far away → NOT_AT_STOP; near → verified gps', async () => {
    const w = world();
    await started(w);
    w.setLive(13.3, 80.5);
    expect(outcomes(await w.svc.events(w.ctx('u-dA'), w.ids.tt, { events: [ev('ARRIVED', 1, { stopSeq: 0 })] }))).toEqual(['REJECTED:NOT_AT_STOP']);
    w.setLive(13.0601, 80.2401);
    const r = await w.svc.events(w.ctx('u-dA'), w.ids.tt, { events: [ev('ARRIVED', 2, { stopSeq: 0 })] });
    expect(r.results[0]).toMatchObject({ outcome: 'ACCEPTED', verified: 'gps' });
  });
});

describe('driver API: duty', () => {
  it('start (online only, idempotent), one open duty, end (idempotent)', async () => {
    const w = world();
    const d = w.ctx('u-dA');
    expect(await codeOf(w.svc.startDuty(d, { clientEventId: randomUUID(), occurredAt: new Date(Date.now() - 10 * MIN).toISOString() }))).toBe('STALE_COMMAND');
    const key = randomUUID();
    const duty = await w.svc.startDuty(d, { clientEventId: key, occurredAt: new Date().toISOString(), objectId: w.ids.vehicle });
    expect(duty).toMatchObject({ status: 'OPEN', vehicle: { id: w.ids.vehicle, name: 'Van 7' } });
    expect((await w.svc.startDuty(d, { clientEventId: key, occurredAt: new Date().toISOString() })).id).toBe(duty.id);
    expect(await codeOf(w.svc.startDuty(d, { clientEventId: randomUUID(), occurredAt: new Date().toISOString() }))).toBe('DUTY_OPEN');
    // Another company's vehicle is never bound.
    expect(await codeOf(w.svc.startDuty(w.ctx('u-dB', 'custB'), { clientEventId: randomUUID(), occurredAt: new Date().toISOString(), objectId: w.ids.vehicle }))).toBe('NOT_FOUND');
    const endKey = randomUUID();
    expect((await w.svc.endDuty(d, { clientEventId: endKey, occurredAt: new Date().toISOString() })).status).toBe('ENDED');
    expect((await w.svc.endDuty(d, { clientEventId: endKey, occurredAt: new Date().toISOString() })).status).toBe('ENDED');
    expect(await codeOf(w.svc.endDuty(d, { clientEventId: randomUUID(), occurredAt: new Date().toISOString() }))).toBe('NO_OPEN_DUTY');
    expect((await w.svc.dutyToday(d)).trips.map((t) => t.id)).toEqual([w.ids.tt]);
  });
});

describe('transport notifications (D7 / L4): relay, generic payloads, preferences', () => {
  it('assignment, reassignment and change set: driver inbox + one generic push each; re-runs never duplicate', async () => {
    const w = world({ plannedStartInMin: 120 }); // beyond the 30-min reminder: only the event-driven notifications
    w.store.insert('pushToken', { userId: 'u-dA', sessionId: null, token: 'ExponentPushToken[a]', platform: 'android' });
    const at = new Date();
    w.store.insert('transportTripEvent', { tripId: w.ids.tt, providerCompanyId: 'custA', customerCompanyId: 'custA', kind: 'PUBLISHED', actorType: 'DISPATCHER', source: 'WEB', occurredAt: at, receivedAt: at, data: { driverId: w.ids.dA } });
    w.store.insert('transportTripEvent', { tripId: w.ids.tt, providerCompanyId: 'custA', customerCompanyId: 'custA', kind: 'PASSENGER_ADDED', actorType: 'DISPATCHER', source: 'WEB', occurredAt: at, receivedAt: at, data: {} });
    expect(await w.relay.run(Date.now())).toBe(1); // ASSIGNED only (the same change set's PASSENGER_ADDED is not a "change")
    const later = new Date(Date.now() + 1000);
    w.store.insert('transportTripEvent', { tripId: w.ids.tt, providerCompanyId: 'custA', customerCompanyId: 'custA', kind: 'VEHICLE_CHANGED', actorType: 'DISPATCHER', source: 'WEB', occurredAt: later, receivedAt: later, data: {} });
    expect(await w.relay.run(Date.now())).toBe(1); // TRIP_CHANGED
    expect(await w.relay.run(Date.now())).toBe(0); // idempotent
    const inbox = await w.notifications.list(w.ctx('u-dA'), 'DRIVER', {});
    expect(inbox.map((n) => n.kind).sort()).toEqual(['TRIP_ASSIGNED', 'TRIP_CHANGED']);
    expect(inbox.every((n) => n.pushQueued && n.tripId === w.ids.tt)).toBe(true);
    const logs = w.store.table('notificationLog');
    expect(logs).toHaveLength(2);
    for (const l of logs) {
      expect(l).toMatchObject({ channel: 'PUSH', status: 'QUEUED', recipient: 'user:u-dA', refType: 'TRANSPORT_NOTIFICATION' });
      expect([TRANSPORT_NOTIFICATION_TEXT.TRIP_ASSIGNED.title, TRANSPORT_NOTIFICATION_TEXT.TRIP_CHANGED.title]).toContain(l.subject);
      expect(JSON.stringify(l)).not.toMatch(/Asha|Bala|Ravi|Van 7|TN01|13\.0|Pickup 1/);
    }
    expect(w.xadds.length).toBe(2);
    // The other driver and the passenger got nothing.
    expect(await w.notifications.list(w.ctx('u-dA2'), 'DRIVER', {})).toEqual([]);
    // Reassignment: old driver TRIP_UNASSIGNED, new driver TRIP_ASSIGNED (in-app only: no app signed in).
    w.row('plannedTrip', w.ids.pt).driverId = w.ids.dA2;
    const t2 = new Date(Date.now() + 2000);
    w.store.insert('transportTripEvent', { tripId: w.ids.tt, providerCompanyId: 'custA', customerCompanyId: 'custA', kind: 'DRIVER_CHANGED', actorType: 'DISPATCHER', source: 'WEB', occurredAt: t2, receivedAt: t2, data: { from: w.ids.dA, to: w.ids.dA2 } });
    expect(await w.relay.run(Date.now())).toBe(2);
    expect((await w.notifications.list(w.ctx('u-dA'), 'DRIVER', {}))[0]?.kind ?? null).not.toBeNull();
    expect((await w.notifications.list(w.ctx('u-dA2'), 'DRIVER', {})).map((n) => [n.kind, n.pushQueued])).toEqual([['TRIP_ASSIGNED', false]]);
    // Read state is per user.
    expect(await w.notifications.markRead(w.ctx('u-dA'), 'DRIVER', { all: true })).toEqual({ updated: 3 });
    expect(await w.notifications.unread(w.ctx('u-dA2'), 'DRIVER')).toBe(1);
  });

  it('passenger: starting soon, approaching, delay report; push follows the preferences, the inbox always', async () => {
    const w = world({ plannedStartInMin: 20 });
    w.store.insert('pushToken', { userId: 'u-pA', sessionId: null, token: 'ExponentPushToken[p]', platform: 'ios' });
    w.row('employeeTransportProfile', w.ids.pAsha).preferences = { notifications: { push: true, kinds: { TRIP_STARTING_SOON: false } } };
    expect(await w.relay.run(Date.now())).toBe(1); // STARTING_SOON for Asha (Bala has no login)
    await started(w);
    Object.assign(w.row('plannedTrip', w.ids.pt), { nextStopSeq: 0, etaNextStop: new Date(Date.now() + 3 * MIN) });
    await w.svc.events(w.ctx('u-dA'), w.ids.tt, { events: [ev('REPORT_DELAY', 1, { etaMin: 15, reasonCode: 'TRAFFIC' })] });
    expect(await w.relay.run(Date.now())).toBe(2); // VEHICLE_APPROACHING + TRIP_DELAYED
    const inbox = await w.notifications.list(w.ctx('u-pA'), 'PASSENGER', {});
    expect(inbox.map((n) => [n.kind, n.pushQueued]).sort()).toEqual([
      ['TRIP_DELAYED', true],
      ['TRIP_STARTING_SOON', false],
      ['VEHICLE_APPROACHING', true],
    ]);
    // The driver's delay overlay is on the trip; no passenger data in any push.
    expect((await w.svc.trip(w.ctx('u-dA'), w.ids.tt)).overlays).toEqual([expect.objectContaining({ kind: 'DELAY', reasonCode: 'TRAFFIC', etaMin: 15 })]);
    expect(JSON.stringify(w.store.table('notificationLog'))).not.toMatch(/Asha|Ravi|TRAFFIC|Van 7|13\.0/);
  });

  it('cancellation: the driver and the passengers whose seats went with the trip', async () => {
    const w = world({ plannedStartInMin: 120 });
    Object.assign(w.row('transportTrip', w.ids.tt), { cancelledAt: new Date() });
    Object.assign(w.row('plannedTrip', w.ids.pt), { status: 'CANCELLED' });
    for (const p of [w.ids.pax1, w.ids.pax2]) Object.assign(w.row('transportTripPassenger', p), { status: 'CANCELLED', cancelReason: 'Trip cancelled: vehicle' });
    w.store.insert('transportTripEvent', { tripId: w.ids.tt, providerCompanyId: 'custA', customerCompanyId: 'custA', kind: 'CANCELLED', actorType: 'DISPATCHER', source: 'WEB', occurredAt: new Date(), receivedAt: new Date(), data: {} });
    expect(await w.relay.run(Date.now())).toBe(2);
    expect((await w.notifications.list(w.ctx('u-dA'), 'DRIVER', {})).map((n) => n.kind)).toEqual(['TRIP_CANCELLED']);
    expect((await w.notifications.list(w.ctx('u-pA'), 'PASSENGER', {})).map((n) => n.kind)).toEqual(['TRIP_CANCELLED']);
    // A driver never reads the passenger inbox and vice versa.
    expect(await w.notifications.list(w.ctx('u-pA'), 'DRIVER', {})).toEqual([]);
  });
});

describe('notifier: ETMS push payload is generic (D7 / L4)', () => {
  class RecordingPush implements PushProvider {
    readonly name = 'expo';
    readonly enabled = true;
    messages: PushMessage[] = [];
    async send(_t: string[], m: PushMessage): Promise<PushResult> {
      this.messages.push(m);
      return { sent: 1, invalidTokens: [], error: null, ticketIds: ['T1'] };
    }
  }

  it('data is exactly { kind, tripId, notificationId } on the trip channel; a removed notification is SKIPPED', async () => {
    const log: Obj = { id: 'log-1', companyId: 'custA', channel: 'PUSH', recipient: 'user:u-dA', templateId: null, subject: 'New trip assigned', body: 'You have a new trip. Open the app for details.', status: 'QUEUED', refType: 'TRANSPORT_NOTIFICATION', refId: 'n-1' };
    const push = new RecordingPush();
    const prisma = fakePrisma({
      notificationLog: { findMany: jest.fn(async () => [log]), updateMany: jest.fn(async () => ({ count: 1 })), count: jest.fn(async () => 0) },
      transportNotification: { findUnique: jest.fn(async () => ({ id: 'n-1', kind: 'TRIP_ASSIGNED', tripId: 'trip-1' })) },
    });
    const { svc, ledger } = makeNotifier({ prisma, push });
    const finished: Obj[] = [];
    (ledger as unknown as { finish: (id: string, c: number, r: Obj) => Promise<boolean> }).finish = async (_id, _c, r) => (finished.push(r), true);
    await svc.handleLogs(['log-1']);
    expect(push.messages).toHaveLength(1);
    expect(push.messages[0]).toMatchObject({ title: 'New trip assigned', channelId: 'trip' });
    expect(push.messages[0].data).toEqual({ kind: 'TRIP_ASSIGNED', tripId: 'trip-1', notificationId: 'n-1' });
    expect(finished[0]).toMatchObject({ status: 'SENT' });
    ((prisma as unknown as { transportNotification: { findUnique: jest.Mock } }).transportNotification.findUnique).mockResolvedValueOnce(null);
    await svc.handleLogs(['log-1']);
    expect(push.messages).toHaveLength(1);
    expect(finished[1]).toMatchObject({ status: 'SKIPPED' });
  });
});

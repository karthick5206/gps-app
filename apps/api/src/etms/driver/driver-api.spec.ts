jest.mock('@nestjs/mapped-types', () => ({ PartialType: (c: new () => object) => class extends c {} }));

import { HttpException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { TRANSPORT_NOTIFICATION_TEXT, transportNotificationText, type DriverTripEventInput } from '@veetracer/shared';
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
import { MeBookingCancelService } from './me-booking-cancel.service';
import { MeTransportService } from '../dispatch/me-transport.service';
import { PeopleService } from '../people/people.service';
import { ConsentNoticeService } from '../people/consent-notice.service';
import { MyTransportConsentController } from '../people/people.controller';
import { RecordConsentDto } from '../people/people.dto';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';

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
  return { store, svc, relay, notifications, ctx, setLive, row, xadds, redis, audit, ids: { dA, dA2, dB, vehicle, pt: pt.id as string, tt: tt.id as string, s0: s0.id as string, s1: s1.id as string, pax1, pax2, pAsha, pBala } };
}

const codeOf = async (p: Promise<unknown>) => p.then(() => 'OK', (e: HttpException) => (e.getResponse() as { code?: string }).code ?? String(e.getStatus()));
const ev = (type: string, seq: number, extra: Partial<DriverTripEventInput> = {}) => ({ clientEventId: randomUUID(), seq, type, occurredAt: new Date().toISOString(), ...extra }) as DriverTripEventInput;
const outcomes = (r: { results: { outcome: string; code: string | null }[] }) => r.results.map((x) => (x.outcome === 'ACCEPTED' ? 'ACCEPTED' : `${x.outcome}:${x.code}`));
const consent = (w: ReturnType<typeof world>, profileId: string, granted = true, agoMin = 60) =>
  w.store.insert('employeeTransportConsent', { companyId: 'custA', profileId, purpose: 'TRANSPORT_PROFILE', noticeVersion: 'v1', granted, channel: granted ? 'WEB' : 'SELF_WITHDRAWN', occurredAt: new Date(Date.now() - agoMin * MIN) });
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
    // The shared door stop is Asha's personal point (seat link, no place): hidden without her routing consent.
    expect(d.stops[0]).toMatchObject({ seq: 0, label: null, lat: null, lng: null, pointHidden: 'CONSENT_REQUIRED', pickups: 2, pending: 2 });
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

describe('driver API: personal stop points follow the owner’s routing consent (E3 M1 / M2 for the driver)', () => {
  const grant = (w: ReturnType<typeof world>, profileId: string, granted = true, agoMin = 60) =>
    w.store.insert('employeeTransportConsent', { companyId: 'custA', profileId, purpose: 'TRANSPORT_PROFILE', noticeVersion: 'v1', granted, channel: granted ? 'WEB' : 'SELF_WITHDRAWN', occurredAt: new Date(Date.now() - agoMin * MIN) });

  it('exact point + neutral label with consent; hidden for a profileId-owned stop without consent and for an unlinked ad-hoc stop; sites as stored', async () => {
    const w = world();
    grant(w, w.ids.pAsha);
    // Office is a company place (poiId); add an ad-hoc stop nobody is linked to, and a stop owned (profileId) by Bala.
    Object.assign(w.row('plannedTripStop', w.ids.s1), { poiId: randomUUID() });
    const pt = w.row('plannedTrip', w.ids.pt);
    w.store.insert('plannedTripStop', { tripId: pt.id, seq: 2, name: '14 Hidden Road', lat: 13.07, lng: 80.26, radiusM: 100, plannedArrival: new Date(Date.now() + 80 * MIN), plannedDeparture: new Date(Date.now() + 80 * MIN) });
    w.store.insert('plannedTripStop', { tripId: pt.id, seq: 3, name: 'Passenger drop', lat: 13.08, lng: 80.27, radiusM: 100, profileId: w.ids.pBala, plannedArrival: new Date(Date.now() + 90 * MIN), plannedDeparture: new Date(Date.now() + 90 * MIN) });
    const d = await w.svc.trip(w.ctx('u-dA'), w.ids.tt);
    expect(d.stops.map((s) => [s.seq, s.label, s.lat, s.pointHidden])).toEqual([
      [0, 'Passenger pickup', 13.06, null],
      [1, 'Office', 13.05, null],
      [2, null, null, 'CONSENT_REQUIRED'],
      [3, null, null, 'CONSENT_REQUIRED'],
    ]);
    expect(JSON.stringify(d)).not.toMatch(/Hidden Road|13\.07|13\.08/);
  });

  it('withdrawal: the trip is bumped (also once under way), sync reports it after the cursor, and the refetched trip has no point', async () => {
    const { applyRoutingConsentWithdrawal } = await import('../dispatch/consent-withdrawal');
    for (const underWay of [false, true]) {
      const w = world();
      grant(w, w.ids.pAsha);
      if (underWay) await started(w);
      const before = await w.svc.trip(w.ctx('u-dA'), w.ids.tt);
      expect(before.stops[0].lat).toBe(13.06);
      const first = await w.svc.sync(w.ctx('u-dA'), {});
      const v0 = w.row('transportTrip', w.ids.tt).version as number;
      // The cursor of the first sync; the withdrawal happens after it.
      const cursor = new Date(Date.now() - 1).toISOString();
      expect(first.trips.map((t) => t.id)).toContain(w.ids.tt);
      await new Promise((r) => setTimeout(r, 5));
      grant(w, w.ids.pAsha, false, 0);
      const prisma = w.store.client();
      const fx = await (prisma as unknown as { $transaction: <T>(fn: (tx: unknown) => Promise<T>) => Promise<T> }).$transaction((tx) =>
        applyRoutingConsentWithdrawal(tx as never, w.ctx('u-pA'), { record: async () => undefined }, { companyId: 'custA', profileId: w.ids.pAsha, userId: 'u-pA', home: { lat: 13.061234, lng: 80.241234 } }),
      );
      expect(w.row('transportTrip', w.ids.tt).version as number).toBeGreaterThan(v0);
      if (underWay) expect(fx.tripsUnderWayChanged).toBe(1);
      const next = await w.svc.sync(w.ctx('u-dA'), { since: cursor });
      expect(next.trips).toEqual([expect.objectContaining({ id: w.ids.tt, change: 'UPSERT', version: w.row('transportTrip', w.ids.tt).version })]);
      const after = await w.svc.trip(w.ctx('u-dA'), w.ids.tt);
      // The stop is kept (Bala is picked up there too / the run is under way) and stays Asha's point: hidden now.
      expect(after.stops[0]).toMatchObject({ lat: null, lng: null, pointHidden: 'CONSENT_REQUIRED' });
      expect(JSON.stringify(after)).not.toContain('13.06,');
    }
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
    consent(w, w.ids.pAsha); // the stop is Asha's point: shown (and GPS-checked) only with her consent (L2)
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

describe('E5 additions: vehicle motion, desk phone, passenger self-cancel, consent channel', () => {
  const people = (w: ReturnType<typeof world>) => {
    const prisma = w.store.client();
    const audit = new AuditService(prisma as never);
    const redis = { invalidateCache: async () => undefined, client: { get: async () => null, set: async () => 'OK', publish: async () => 1, xadd: async () => '1-0' } };
    const ppl = new PeopleService(prisma as never, audit, redis as never, { enabled: false, search: async () => [] } as never, new ConsentNoticeService(prisma as never, audit));
    const live = new TripLiveService(prisma as never, redis as never, new PlannedTripsService(prisma as never, audit, { invalidate: async () => undefined } as never));
    return { ppl, cancel: new MeBookingCancelService(prisma as never, audit, ppl, new MeTransportService(prisma as never, ppl, redis as never), live) };
  };
  const pax = (w: ReturnType<typeof world>): AuthContext => ({ ...w.ctx('u-pA'), permissions: { etms_self: ['view'] } });
  const bookingOf = (w: ReturnType<typeof world>, paxId: string) => w.row('transportTripPassenger', paxId).bookingId as string;

  it('motion: live speed of my trip’s vehicle, moving above 10 km/h; stale without a fresh fix; 404 for other drivers', async () => {
    const w = world();
    expect(await w.svc.motion(w.ctx('u-dA'), w.ids.tt)).toEqual({ speedKph: null, moving: null, fixAt: null, stale: true });
    const liveJson = (speedKph: number, at: Date) => JSON.stringify({ lat: 13.06, lng: 80.24, speedKph, fixTime: at.toISOString(), licenceLocked: false });
    // Drive the live cache through the service's redis stub.
    const redis = (w.svc as unknown as { redis: { client: { get: () => Promise<string | null> } } }).redis;
    redis.client.get = async () => liveJson(32, new Date());
    expect(await w.svc.motion(w.ctx('u-dA'), w.ids.tt)).toMatchObject({ speedKph: 32, moving: true, stale: false });
    redis.client.get = async () => liveJson(3, new Date());
    expect(await w.svc.motion(w.ctx('u-dA'), w.ids.tt)).toMatchObject({ speedKph: 3, moving: false });
    redis.client.get = async () => liveJson(40, new Date(Date.now() - 10 * MIN));
    expect(await w.svc.motion(w.ctx('u-dA'), w.ids.tt)).toMatchObject({ moving: null, stale: true });
    expect((await w.svc.trip(w.ctx('u-dA'), w.ids.tt)).vehicleMotion).toMatchObject({ stale: true });
    expect(await codeOf(w.svc.motion(w.ctx('u-dA2'), w.ids.tt))).toBe('NOT_FOUND');
  });

  it('desk phone: from Company.settings.etms.deskPhone, to the assigned driver; null when not set', async () => {
    const w = world();
    expect((await w.svc.me(w.ctx('u-dA'))).dispatcherPhone).toBeNull();
    w.row('company', 'custA').settings = { features: ['etms'], etms: { deskPhone: '+91 44 4000 1234' } };
    expect((await w.svc.me(w.ctx('u-dA'))).dispatcherPhone).toBe('+91 44 4000 1234');
    expect((await w.svc.trip(w.ctx('u-dA'), w.ids.tt)).dispatcherPhone).toBe('+91 44 4000 1234');
  });

  it('self-cancel: own booking only, frees the seat under the trip lock, idempotent, audited; the driver hears TRIP_CHANGED', async () => {
    const w = world({ plannedStartInMin: 120 });
    const { cancel } = people(w);
    const b1 = bookingOf(w, w.ids.pax1);
    const b2 = bookingOf(w, w.ids.pax2);
    expect(await codeOf(cancel.cancel(pax(w), b2, undefined))).toBe('NOT_FOUND');
    expect(await codeOf(cancel.cancel(w.ctx('u-dA'), b1, undefined))).toBe('NOT_A_PASSENGER');
    const r = await cancel.cancel(pax(w), b1, 'On leave');
    expect(r).toMatchObject({ status: 'CANCELLED', tripId: null });
    expect(w.row('transportTripPassenger', w.ids.pax1)).toMatchObject({ status: 'CANCELLED' });
    expect(w.row('transportTrip', w.ids.tt).occupiedSeats).toBe(1);
    expect(w.store.table('transportTripEvent').find((e) => e.kind === 'PASSENGER_REMOVED')).toMatchObject({ actorType: 'PASSENGER', source: 'PASSENGER_APP', reasonCode: 'PASSENGER_CANCELLED' });
    // QA I3: the audit keeps who cancelled, the reason and whether a seat was released (booking id = entityId).
    expect(w.store.table('auditLog').find((a) => a.entityId === b1)?.changes).toMatchObject({ status: { to: 'CANCELLED' }, statusReason: { to: 'Cancelled by passenger: On leave' }, by: { to: 'PASSENGER' }, seatReleased: { to: true } });
    expect((await cancel.cancel(pax(w), b1, 'again')).status).toBe('CANCELLED');
    expect(w.row('transportTrip', w.ids.tt).occupiedSeats).toBe(1);
    await w.relay.run(Date.now());
    expect((await w.notifications.list(w.ctx('u-dA'), 'DRIVER', {})).map((n) => n.kind)).toEqual(['TRIP_CHANGED']);
  });

  it('self-cancel: refused after the cut-off and once the trip has started', async () => {
    const w = world({ plannedStartInMin: 120 });
    const { cancel } = people(w);
    const b1 = bookingOf(w, w.ids.pax1);
    w.row('transportBooking', b1).cutoffAt = new Date(Date.now() - MIN);
    expect(await codeOf(cancel.cancel(pax(w), b1, undefined))).toBe('AFTER_CUTOFF');
    w.row('transportBooking', b1).cutoffAt = null;
    w.row('plannedTrip', w.ids.pt).status = 'IN_PROGRESS';
    expect(await codeOf(cancel.cancel(pax(w), b1, undefined))).toBe('INVALID_STATE');
    expect(w.store.table('transportBooking').find((b) => b.id === b1)!.status).toBe('ASSIGNED');
  });

  it('my bookings carry the server-computed cut-off (cutoffAt, ISO), null when the booking has none', async () => {
    const w = world({ plannedStartInMin: 120 });
    const me = new MeTransportService(w.store.client() as never, people(w).ppl, { client: { get: async () => null } } as never);
    const b1 = bookingOf(w, w.ids.pax1);
    const at = new Date(Date.now() + 30 * MIN);
    w.row('transportBooking', b1).cutoffAt = at;
    expect((await me.booking(pax(w), b1)).cutoffAt).toBe(at.toISOString());
    expect((await me.bookings(pax(w), {})).find((b) => b.id === b1)?.cutoffAt).toBe(at.toISOString());
    w.row('transportBooking', b1).cutoffAt = null;
    expect((await me.booking(pax(w), b1)).cutoffAt).toBeNull();
  });

  it('consent from the mobile app is recorded with channel PASSENGER_APP; other channels are refused by validation', async () => {
    const w = world();
    const { ppl } = people(w);
    w.store.insert('transportConsentNotice', { companyId: 'custA', purpose: 'TRANSPORT_PROFILE', seq: 1, version: 'v1', title: 't', body: 'b', locale: 'en', effectiveFrom: new Date(Date.now() - 86_400_000) });
    const controller = new MyTransportConsentController(ppl);
    await controller.record(pax(w), { purpose: 'TRANSPORT_PROFILE', granted: true, channel: 'PASSENGER_APP' } as never);
    expect(w.store.table('employeeTransportConsent').at(-1)).toMatchObject({ channel: 'PASSENGER_APP', granted: true });
    await controller.record(pax(w), { purpose: 'TRANSPORT_PROFILE', granted: false } as never);
    expect(w.store.table('employeeTransportConsent').at(-1)).toMatchObject({ channel: 'WEB', granted: false });
    const bad = await validate(plainToInstance(RecordConsentDto, { purpose: 'TRANSPORT_PROFILE', granted: true, channel: 'ADMIN_RECORDED_OFFLINE' }));
    expect(bad.map((e) => e.property)).toEqual(['channel']);
  });
});

describe('E5 security review fixes (M1, M2, L1, L2, L4, L5, L6, L7)', () => {
  const ago = (min: number) => new Date(Date.now() - min * MIN).toISOString();
  const position = (w: ReturnType<typeof world>, lat: number, lng: number, minAgo: number) =>
    w.store.insert('position', { objectId: w.ids.vehicle, deviceId: randomUUID(), fixTime: new Date(Date.now() - minAgo * MIN), serverTime: new Date(), lat, lng, speedKph: 0, course: 0, valid: true });
  const startedEarlier = async (w: ReturnType<typeof world>, minAgo: number) => {
    await started(w);
    w.row('plannedTrip', w.ids.pt).actualStart = new Date(Date.now() - minAgo * MIN);
  };

  it('M1 repro (P1): a backdated ARRIVED far from the vehicle is clamped to the trip start and does not unlock NO_SHOW', async () => {
    const w = world();
    consent(w, w.ids.pAsha);
    await started(w);
    w.setLive(14.4, 80.5); // about 150 km from stop 0
    expect(outcomes(await w.svc.events(w.ctx('u-dA'), w.ids.tt, { events: [ev('ARRIVED', 1, { stopSeq: 0 })] }))).toEqual(['REJECTED:NOT_AT_STOP']);
    // The report's batch: ARRIVED backdated 10 min, then NO_SHOW for both. Clamped to the trip start (seconds ago), the
    // ARRIVED meets the live fix 150 km away: NOT_AT_STOP; the no-shows have no arrival to wait from.
    const repro = await w.svc.events(w.ctx('u-dA'), w.ids.tt, {
      events: [ev('ARRIVED', 2, { stopSeq: 0, occurredAt: ago(10) }), ev('NO_SHOW', 3, { passengerTripId: w.ids.pax1, reasonCode: 'NOT_AT_PICKUP' }), ev('NO_SHOW', 4, { passengerTripId: w.ids.pax2 })],
    });
    expect(outcomes(repro)).toEqual(['REJECTED:NOT_AT_STOP', 'REJECTED:STOP_NOT_ARRIVED', 'REJECTED:STOP_NOT_ARRIVED']);
    for (const p of [w.ids.pax1, w.ids.pax2]) expect(w.row('transportTripPassenger', p).status).toBe('PENDING');

    // Without any fix (telemetry gap): accepted as unverified, stored at the trip start, and still no immediate no-show.
    const v = world();
    consent(v, v.ids.pAsha);
    await started(v);
    const startAt = v.row('plannedTrip', v.ids.pt).actualStart as Date;
    const r = await v.svc.events(v.ctx('u-dA'), v.ids.tt, {
      events: [ev('ARRIVED', 1, { stopSeq: 0, occurredAt: ago(10) }), ev('NO_SHOW', 2, { passengerTripId: v.ids.pax1, reasonCode: 'NOT_AT_PICKUP' }), ev('NO_SHOW', 3, { passengerTripId: v.ids.pax2 })],
    });
    expect(r.results[0]).toMatchObject({ outcome: 'ACCEPTED', verified: 'unverified_location' });
    expect(outcomes(r).slice(1).every((o) => o.endsWith(':WAIT_NOT_ELAPSED'))).toBe(true);
    for (const p of [v.ids.pax1, v.ids.pax2]) expect(v.row('transportTripPassenger', p).status).toBe('PENDING');
    const arrived = v.store.table('transportTripEvent').find((e) => e.kind === 'ARRIVED' && e.outcome === 'ACCEPTED')!;
    expect((arrived.occurredAt as Date).getTime()).toBe(startAt.getTime());
    expect(arrived.data).toMatchObject({ verified: 'unverified_location', setArrival: true, clampedToStart: true });
    expect((v.row('plannedTripStop', v.ids.s0).actualArrival as Date).getTime()).toBe(startAt.getTime());
  });

  it('M1: after an unverified arrival the 5-min wait runs from its receipt (RETRY, kept in the queue); the no-show then raises a dispatcher review', async () => {
    const w = world();
    consent(w, w.ids.pAsha);
    await startedEarlier(w, 30);
    w.setLive(14.4, 80.5);
    const noShow = ev('NO_SHOW', 2, { passengerTripId: w.ids.pax1, reasonCode: 'UNREACHABLE' });
    const r = await w.svc.events(w.ctx('u-dA'), w.ids.tt, { events: [ev('ARRIVED', 1, { stopSeq: 0, occurredAt: ago(10) }), noShow] });
    expect(outcomes(r)).toEqual(['ACCEPTED', 'RETRY:WAIT_NOT_ELAPSED']);
    expect(w.store.table('transportTripEvent').some((e) => e.clientEventId === noShow.clientEventId)).toBe(false);
    // A later batch, still within 5 min of the server's receipt of the ARRIVED: RETRY again.
    expect(outcomes(await w.svc.events(w.ctx('u-dA'), w.ids.tt, { events: [noShow] }))).toEqual(['RETRY:WAIT_NOT_ELAPSED']);
    // 6 minutes after the receipt: accepted, flagged, and a SYSTEM review event on the dispatcher's timeline.
    w.store.table('transportTripEvent').find((e) => e.kind === 'ARRIVED' && e.outcome === 'ACCEPTED')!.receivedAt = new Date(Date.now() - 6 * MIN);
    expect(outcomes(await w.svc.events(w.ctx('u-dA'), w.ids.tt, { events: [noShow] }))).toEqual(['ACCEPTED']);
    expect(w.row('transportTripPassenger', w.ids.pax1).status).toBe('NO_SHOW');
    expect(w.store.table('transportTripEvent').find((e) => e.clientEventId === noShow.clientEventId)!.data).toMatchObject({ review: 'NO_SHOW_UNVERIFIED_ARRIVAL' });
    const review = w.store.table('transportTripEvent').filter((e) => e.kind === 'NO_SHOW_REVIEW');
    expect(review).toEqual([expect.objectContaining({ actorType: 'SYSTEM', source: 'SYSTEM', passengerTripId: w.ids.pax1, stopSeq: 0, data: { code: 'NO_SHOW_UNVERIFIED_ARRIVAL', noShowClientEventId: noShow.clientEventId } })]);
    expect(w.store.table('auditLog').some((a) => JSON.stringify(a.changes ?? {}).includes('noShowReview'))).toBe(true);
    // The driver never sees the review (sync lists only their own app events).
    expect((await w.svc.sync(w.ctx('u-dA'), {})).events.some((e) => e.code === 'NO_SHOW_UNVERIFIED_ARRIVAL')).toBe(false);
  });

  it('M1: a backdated ARRIVED is checked against the stored track near occurredAt (near: gps, no review; far: NOT_AT_STOP)', async () => {
    const near = world();
    consent(near, near.ids.pAsha);
    await startedEarlier(near, 30);
    near.setLive(14.4, 80.5); // the live fix is elsewhere now; the track at the time was at the stop
    position(near, 13.0601, 80.2401, 10);
    const noShow = ev('NO_SHOW', 2, { passengerTripId: near.ids.pax1, reasonCode: 'NOT_AT_PICKUP' });
    const r = await near.svc.events(near.ctx('u-dA'), near.ids.tt, { events: [ev('ARRIVED', 1, { stopSeq: 0, occurredAt: ago(10) }), noShow] });
    // R-2: verified by the track, but reported 10 min late: the wait starts at receipt (RETRY) and the no-show is reviewed.
    expect(r.results.map((x) => [x.outcome, x.verified ?? null, x.code])).toEqual([
      ['ACCEPTED', 'gps', null],
      ['RETRY', null, 'WAIT_NOT_ELAPSED'],
    ]);
    const arrived = near.store.table('transportTripEvent').find((e) => e.kind === 'ARRIVED' && e.outcome === 'ACCEPTED')!;
    expect(arrived.data).toMatchObject({ verified: 'gps', setArrival: true, lateArrival: true });
    arrived.receivedAt = new Date(Date.now() - 6 * MIN); // 6 minutes later (the history read, not the snapshot)
    expect(outcomes(await near.svc.events(near.ctx('u-dA'), near.ids.tt, { events: [noShow] }))).toEqual(['ACCEPTED']);
    expect(near.store.table('transportTripEvent').filter((e) => e.kind === 'NO_SHOW_REVIEW').map((e) => (e.data as { code: string }).code)).toEqual(['NO_SHOW_LATE_ARRIVAL']);
    // A live tap at the stop (on time, GPS-confirmed): plain rule, no review.
    const live = world();
    consent(live, live.ids.pAsha);
    await startedEarlier(live, 30);
    live.setLive(13.0601, 80.2401);
    expect((await live.svc.events(live.ctx('u-dA'), live.ids.tt, { events: [ev('ARRIVED', 1, { stopSeq: 0 })] })).results[0]).toMatchObject({ outcome: 'ACCEPTED', verified: 'gps' });
    expect(live.store.table('transportTripEvent').find((e) => e.kind === 'ARRIVED')!.data).not.toHaveProperty('lateArrival');

    const far = world();
    consent(far, far.ids.pAsha);
    await startedEarlier(far, 30);
    position(far, 14.4, 80.5, 10);
    expect(outcomes(await far.svc.events(far.ctx('u-dA'), far.ids.tt, { events: [ev('ARRIVED', 1, { stopSeq: 0, occurredAt: ago(10) })] }))).toEqual(['REJECTED:NOT_AT_STOP']);
  });

  it('M2 repro (P2): 50 REPORT_DELAY in one batch: one accepted, the rest DUPLICATE TOO_FREQUENT, one TRIP_DELAYED per passenger', async () => {
    const w = world({ plannedStartInMin: 20 });
    await started(w);
    const r = await w.svc.events(w.ctx('u-dA'), w.ids.tt, { events: Array.from({ length: 50 }, (_, i) => ev('REPORT_DELAY', i + 1, { etaMin: 10, reasonCode: 'TRAFFIC' })) });
    expect(outcomes(r)[0]).toBe('ACCEPTED');
    expect([...new Set(outcomes(r).slice(1))]).toEqual(['DUPLICATE:TOO_FREQUENT']);
    await w.relay.run(Date.now());
    await w.relay.run(Date.now());
    expect(w.store.table('transportNotification').filter((n) => n.kind === 'TRIP_DELAYED').map((n) => n.userId)).toEqual(['u-pA']);
    expect(outcomes(await w.svc.events(w.ctx('u-dA'), w.ids.tt, { events: [ev('REPORT_DELAY', 51, { etaMin: 20 })] }))).toEqual(['DUPLICATE:TOO_FREQUENT']);
  });

  it('M2: relay dedupes TRIP_DELAYED per trip, passenger and 15-min bucket; no passenger notice for a trip far from pickup', async () => {
    const w = world({ plannedStartInMin: 20 });
    await started(w);
    const bucket = Math.floor(Date.now() / (15 * MIN)) * 15 * MIN;
    for (const off of [1000, 2000]) w.store.insert('transportTripEvent', { tripId: w.ids.tt, providerCompanyId: 'custA', customerCompanyId: 'custA', kind: 'REPORT_DELAY', actorType: 'DRIVER', source: 'DRIVER_APP', outcome: 'ACCEPTED', occurredAt: new Date(bucket + off), receivedAt: new Date(bucket + off), data: {} });
    await w.relay.run(Date.now());
    expect(w.store.table('transportNotification').filter((n) => n.kind === 'TRIP_DELAYED')).toHaveLength(1);

    const later = world({ plannedStartInMin: 120 }); // SCHEDULED, pickup in 2 h
    expect(outcomes(await later.svc.events(later.ctx('u-dA'), later.ids.tt, { events: [ev('REPORT_DELAY', 1, { etaMin: 10 })] }))).toEqual(['ACCEPTED']);
    expect(await later.relay.run(Date.now())).toBe(0);
  });

  it('M2: event batches are throttled per driver login (429 RATE_LIMITED; the queue retries)', async () => {
    const w = world();
    w.redis.client.eval = async () => 31; // the 31st batch in this minute
    expect(await codeOf(w.svc.events(w.ctx('u-dA'), w.ids.tt, { events: [ev('ACKNOWLEDGE', 1)] }))).toBe('RATE_LIMITED');
  });

  it('L1: reasonCode only from the closed list of the event type (per-event VALIDATION_FAILED)', async () => {
    const w = world();
    await started(w);
    const r = await w.svc.events(w.ctx('u-dA'), w.ids.tt, {
      events: [ev('REPORT_DELAY', 1, { reasonCode: 'Asha not home' }), ev('REPORT_BREAKDOWN', 2, { reasonCode: 'TRAFFIC' }), ev('ARRIVED', 3, { stopSeq: 0, reasonCode: 'OTHER' }), ev('REPORT_BREAKDOWN', 4, { reasonCode: 'TYRE' })],
    });
    expect(outcomes(r)).toEqual(['REJECTED:VALIDATION_FAILED', 'REJECTED:VALIDATION_FAILED', 'REJECTED:VALIDATION_FAILED', 'ACCEPTED']);
  });

  it('L1: erasure scrubs the driver notes on REPORT_* of the trips the passenger rode and free-text reason codes on their events', async () => {
    const { eraseTransportData } = await import('../dispatch/erasure');
    const w = world();
    await started(w);
    await w.svc.events(w.ctx('u-dA'), w.ids.tt, { events: [ev('REPORT_DELAY', 1, { etaMin: 10, reasonCode: 'TRAFFIC', note: 'Asha not at 12 Anna Salai, unreachable' }), ev('REPORT_BREAKDOWN', 2, { reasonCode: 'TYRE', note: 'Asha asked to wait' })] });
    const base = { tripId: w.ids.tt, providerCompanyId: 'custA', customerCompanyId: 'custA', actorType: 'DISPATCHER', source: 'WEB', occurredAt: new Date(), data: {} };
    const legacy = w.store.insert('transportTripEvent', { ...base, kind: 'NO_SHOW', passengerTripId: w.ids.pax1, reasonCode: 'called Asha twice' });
    const coded = w.store.insert('transportTripEvent', { ...base, kind: 'NO_SHOW', passengerTripId: w.ids.pax1, reasonCode: 'NOT_AT_PICKUP' });
    await eraseTransportData(w.store.client() as never, 'custA', w.ids.pAsha, '[erased]');
    const reports = w.store.table('transportTripEvent').filter((e) => e.kind === 'REPORT_DELAY' || e.kind === 'REPORT_BREAKDOWN');
    expect(reports.map((e) => (e.data as { note?: string }).note)).toEqual(['[erased]', '[erased]']);
    expect(reports.map((e) => e.reasonCode)).toEqual(['TRAFFIC', 'TYRE']);
    expect(w.row('transportTripEvent', legacy.id as string).reasonCode).toBeNull();
    expect(w.row('transportTripEvent', coded.id as string).reasonCode).toBe('NOT_AT_PICKUP');
    expect(JSON.stringify(w.store.table('transportTripEvent'))).not.toMatch(/Anna Salai|Asha/);
  });

  it('L2: a consent-hidden stop is never NOT_AT_STOP (no GPS oracle) and carries no radius', async () => {
    const w = world();
    await started(w);
    w.setLive(14.4, 80.5);
    const far = await w.svc.events(w.ctx('u-dA'), w.ids.tt, { events: [ev('ARRIVED', 1, { stopSeq: 0 })] });
    expect(far.results[0]).toMatchObject({ outcome: 'ACCEPTED', verified: 'unverified_location' });
    expect(far.trip!.stops[0]).toMatchObject({ pointHidden: 'CONSENT_REQUIRED', lat: null, lng: null, radiusM: null });
    const near = world();
    await started(near);
    near.setLive(13.0601, 80.2401);
    expect((await near.svc.events(near.ctx('u-dA'), near.ids.tt, { events: [ev('ARRIVED', 1, { stopSeq: 0 })] })).results[0].verified).toBe('unverified_location');
  });

  it('L4: manifest ACCESS audit also from start / events, and written when Valkey is down (no dedupe)', async () => {
    const w = world();
    consent(w, w.ids.pAsha);
    const access = () => w.store.table('auditLog').filter((a) => a.action === 'ACCESS' && (a.changes as { what?: string } | undefined)?.what === 'driver-manifest');
    await started(w);
    expect(access()).toHaveLength(1);
    expect(access()[0].changes).toMatchObject({ passengers: 2, exactPoints: 2 });
    await w.svc.events(w.ctx('u-dA'), w.ids.tt, { events: [ev('ACKNOWLEDGE', 1)] });
    expect(access()).toHaveLength(2);
    w.redis.client.set = async () => {
      throw new Error('valkey down');
    };
    await w.svc.trip(w.ctx('u-dA'), w.ids.tt);
    await w.svc.trip(w.ctx('u-dA'), w.ids.tt);
    expect(access()).toHaveLength(4);
  });

  it('L5: sync clamps an ancient cursor (full trip list, events within 48 h) and only lists reassignments away from me', async () => {
    const w = world();
    w.store.insert('transportTripEvent', { tripId: w.ids.tt, providerCompanyId: 'custA', customerCompanyId: 'custA', kind: 'DRIVER_CHANGED', actorType: 'DISPATCHER', source: 'WEB', occurredAt: new Date(), data: { from: w.ids.dA2, to: w.ids.dA } });
    const s = await w.svc.sync(w.ctx('u-dA'), { since: '1970-01-01T00:00:00.000Z' });
    expect(s.trips).toEqual([expect.objectContaining({ id: w.ids.tt, change: 'UPSERT' })]);
    // The reassignment was away from dA2: only dA2 is told REVOKED.
    expect((await w.svc.sync(w.ctx('u-dA2'), { since: '1970-01-01T00:00:00.000Z' })).trips).toEqual([{ id: w.ids.tt, version: 0, change: 'REVOKED', plannedTripStatus: null }]);
    expect(await w.svc.sync(w.ctx('u-dB', 'custB'), { since: '1970-01-01T00:00:00.000Z' })).toMatchObject({ trips: [] });
  });

  it('L6: a duplicate clientEventId in one batch is a 400 at the DTO; the service evaluates it once if it gets through', async () => {
    const { DriverTripEventBatchDto } = await import('./driver.dto');
    const e = ev('ACKNOWLEDGE', 1);
    const errors = await validate(plainToInstance(DriverTripEventBatchDto, { events: [e, { ...e }] }));
    expect(errors.map((x) => x.property)).toEqual(['events']);
    expect(await validate(plainToInstance(DriverTripEventBatchDto, { events: [e, ev('REPORT_DELAY', 2)] }))).toEqual([]);
    const w = world();
    const r = await w.svc.events(w.ctx('u-dA'), w.ids.tt, { events: [e, { ...e }] });
    expect(outcomes(r)).toEqual(['ACCEPTED', 'ACCEPTED']);
    expect(w.store.table('transportTripEvent').filter((x) => x.clientEventId === e.clientEventId)).toHaveLength(1);
  });

  it('L7: a personal stop whose only linked seats are cancelled is hidden (PASSENGER_CANCELLED), even with consent', async () => {
    const w = world();
    consent(w, w.ids.pAsha);
    w.row('transportTripPassenger', w.ids.pax1).status = 'CANCELLED';
    expect((await w.svc.trip(w.ctx('u-dA'), w.ids.tt)).stops[0]).toMatchObject({ pointHidden: null, lat: 13.06 }); // Bala is still picked up there
    w.row('transportTripPassenger', w.ids.pax2).status = 'CANCELLED';
    const d = await w.svc.trip(w.ctx('u-dA'), w.ids.tt);
    expect(d.stops.map((s) => [s.seq, s.pointHidden, s.lat, s.radiusM, s.label])).toEqual([
      [0, 'PASSENGER_CANCELLED', null, null, null],
      [1, 'PASSENGER_CANCELLED', null, null, null],
    ]);
  });
});

describe('E5 security review L3: relay high-water mark', () => {
  it('reads from the persisted mark (at most 24 h back) and records each pass for System Health', async () => {
    const w = world({ plannedStartInMin: 120 });
    const kv = new Map<string, string>();
    const redis = { client: { get: async (k: string) => kv.get(k) ?? null, set: async (k: string, v: string) => (kv.set(k, v), 'OK'), eval: async () => 1, xadd: async () => '1-0', publish: async () => 1 } };
    const notifications = new TransportNotificationsService(w.store.client() as never, redis as never);
    const relay = new TransportNotifyRelayService(w.store.client() as never, redis as never, notifications);
    Object.assign(w.row('transportTrip', w.ids.tt), { cancelledAt: new Date() });
    Object.assign(w.row('plannedTrip', w.ids.pt), { status: 'CANCELLED' });
    for (const p of [w.ids.pax1, w.ids.pax2]) Object.assign(w.row('transportTripPassenger', p), { status: 'CANCELLED', cancelReason: 'Trip cancelled: vehicle' });
    const cancelled = (hoursAgo: number) => {
      const at = new Date(Date.now() - hoursAgo * 3_600_000);
      w.store.insert('transportTripEvent', { tripId: w.ids.tt, providerCompanyId: 'custA', customerCompanyId: 'custA', kind: 'CANCELLED', actorType: 'DISPATCHER', source: 'WEB', occurredAt: at, receivedAt: at, data: {} });
    };
    cancelled(25); // beyond the 24 h look-back: never read
    cancelled(3); // the relay was stalled for 3 h (the old 30-min look-back lost this one)
    const now = Date.now();
    expect(await relay.run(now)).toBe(2); // the driver and Asha
    const state = JSON.parse(kv.get('vt:etms:notify:state')!) as { at: number; hwm: number; full: boolean };
    expect(state).toEqual({ at: now, hwm: now - 5 * MIN, full: false });
    expect(Number(kv.get('vt:etms:notify:hwm'))).toBe(now - 5 * MIN);
    cancelled(1); // older than the mark (already covered): not read again
    expect(await relay.run(Date.now())).toBe(0);
    cancelled(0);
    expect(await relay.run(Date.now())).toBe(2);
  });
});

describe('E5 QA fixes: relay grouping (B1), atomic notify (B6), language (B7), starting soon (B8)', () => {
  const event = (w: ReturnType<typeof world>, kind: string, at: number, data: Record<string, unknown>) =>
    w.store.insert('transportTripEvent', { tripId: w.ids.tt, providerCompanyId: 'custA', customerCompanyId: 'custA', kind, actorType: 'DISPATCHER', source: 'WEB', occurredAt: new Date(at), receivedAt: new Date(at), data });

  it('B1: CREATE_TRIP + 4 ADD_PASSENGER (rows a few ms apart) → exactly one driver notice; a later change set → one TRIP_CHANGED', async () => {
    const w = world({ plannedStartInMin: 120 });
    const cs1 = randomUUID();
    const t = Date.now();
    event(w, 'PUBLISHED', t, { changeSetId: cs1, driverId: w.ids.dA });
    for (const ms of [10, 16, 23, 30]) event(w, 'PASSENGER_ADDED', t + ms, { changeSetId: cs1 });
    expect(await w.relay.run(Date.now())).toBe(1);
    expect((await w.notifications.list(w.ctx('u-dA'), 'DRIVER', {})).map((n) => n.kind)).toEqual(['TRIP_ASSIGNED']);
    const cs2 = randomUUID();
    for (const [kind, ms] of [['PASSENGER_ADDED', 1000], ['STOP_ADDED', 1007], ['PASSENGER_ADDED', 1013]] as const) event(w, kind, t + ms, { changeSetId: cs2 });
    expect(await w.relay.run(Date.now())).toBe(1);
    expect(await w.relay.run(Date.now())).toBe(0);
    expect((await w.notifications.list(w.ctx('u-dA'), 'DRIVER', {})).map((n) => n.kind).sort()).toEqual(['TRIP_ASSIGNED', 'TRIP_CHANGED']);
  });

  it('B1: a reassignment change set that also adds passengers → TRIP_ASSIGNED for the new driver only, no TRIP_CHANGED', async () => {
    const w = world({ plannedStartInMin: 120 });
    w.row('plannedTrip', w.ids.pt).driverId = w.ids.dA2;
    const cs = randomUUID();
    const t = Date.now();
    event(w, 'DRIVER_CHANGED', t, { changeSetId: cs, from: w.ids.dA, to: w.ids.dA2 });
    event(w, 'PASSENGER_ADDED', t + 9, { changeSetId: cs });
    await w.relay.run(Date.now());
    expect((await w.notifications.list(w.ctx('u-dA2'), 'DRIVER', {})).map((n) => n.kind)).toEqual(['TRIP_ASSIGNED']);
    expect((await w.notifications.list(w.ctx('u-dA'), 'DRIVER', {})).map((n) => n.kind)).toEqual(['TRIP_UNASSIGNED']);
  });

  it('B6: the inbox row and its push log are written together: a failure leaves neither, the next run writes both', async () => {
    const w = world();
    w.store.insert('pushToken', { userId: 'u-dA', sessionId: null, token: 'ExponentPushToken[a]', platform: 'android' });
    const redis = { client: { xadd: async () => '1-0' } };
    const failing = new TransportNotificationsService(w.store.client({ notificationLog: { createMany: async () => Promise.reject(new Error('connection lost')) } }) as never, redis as never);
    const item = { companyId: 'custA', userId: 'u-dA', audience: 'DRIVER' as const, kind: 'TRIP_ASSIGNED' as const, tripId: w.ids.tt, dedupeKey: 'asg:x:u-dA', push: true };
    await expect(failing.notify([item])).rejects.toThrow('connection lost');
    expect(w.store.table('transportNotification')).toHaveLength(0);
    expect(await w.notifications.notify([item])).toHaveLength(1);
    expect(w.store.table('transportNotification')).toEqual([expect.objectContaining({ dedupeKey: 'asg:x:u-dA', pushQueued: true })]);
    expect(w.store.table('notificationLog')).toEqual([expect.objectContaining({ status: 'QUEUED', dedupeKey: `etms:${w.store.table('transportNotification')[0].id}:PUSH` })]);
  });

  it('B7: title / body in the recipient’s language (hi / ta), English otherwise; nothing else changes', async () => {
    const w = world();
    for (const u of ['u-dA', 'u-dA2']) w.store.insert('pushToken', { userId: u, sessionId: null, token: `ExponentPushToken[${u}]`, platform: 'android' });
    Object.assign(w.store.table('user').find((u) => u.id === 'u-dA')!, { preferences: { theme: 'system', language: 'ta' } });
    const item = (userId: string) => ({ companyId: 'custA', userId, audience: 'DRIVER' as const, kind: 'TRIP_ASSIGNED' as const, tripId: w.ids.tt, dedupeKey: `asg:y:${userId}`, push: true });
    await w.notifications.notify([item('u-dA'), item('u-dA2')]);
    const ta = transportNotificationText('TRIP_ASSIGNED', 'ta');
    expect(ta.title).not.toBe(TRANSPORT_NOTIFICATION_TEXT.TRIP_ASSIGNED.title);
    const byUser = (u: string) => w.store.table('transportNotification').find((n) => n.userId === u)!;
    expect(byUser('u-dA')).toMatchObject({ title: ta.title, body: ta.body });
    expect(byUser('u-dA2')).toMatchObject(TRANSPORT_NOTIFICATION_TEXT.TRIP_ASSIGNED);
    expect(w.store.table('notificationLog').map((l) => l.subject).sort()).toEqual([TRANSPORT_NOTIFICATION_TEXT.TRIP_ASSIGNED.title, ta.title].sort());
    for (const kind of Object.keys(TRANSPORT_NOTIFICATION_TEXT) as (keyof typeof TRANSPORT_NOTIFICATION_TEXT)[]) {
      for (const lang of ['hi', 'ta']) {
        const t = transportNotificationText(kind, lang);
        expect([kind, lang, t.title === TRANSPORT_NOTIFICATION_TEXT[kind].title, t.body === TRANSPORT_NOTIFICATION_TEXT[kind].body]).toEqual([kind, lang, false, false]);
      }
    }
  });

  it('B8: no TRIP_STARTING_SOON once the trip has started or is closed', async () => {
    const w = world({ plannedStartInMin: 20 });
    await started(w);
    expect(await w.relay.run(Date.now())).toBe(0);
    const c = world({ plannedStartInMin: 20 });
    Object.assign(c.row('plannedTrip', c.ids.pt), { status: 'COMPLETED' });
    expect(await c.relay.run(Date.now())).toBe(0);
    const s = world({ plannedStartInMin: 20 });
    expect(await s.relay.run(Date.now())).toBe(1); // still SCHEDULED: Asha is reminded
  });
});

describe('E5 security re-check residuals (R-3 service, R-4)', () => {
  it('R-3: BOARDED after an unverified arrival writes a SYSTEM OUTCOME_REVIEW event and outcomeReview in the audit', async () => {
    const w = world();
    consent(w, w.ids.pAsha);
    await started(w);
    const r = await w.svc.events(w.ctx('u-dA'), w.ids.tt, { events: [ev('ARRIVED', 1, { stopSeq: 0 }), ev('BOARDED', 2, { passengerTripId: w.ids.pax1 })] });
    expect(outcomes(r)).toEqual(['ACCEPTED', 'ACCEPTED']);
    expect(w.store.table('transportTripEvent').filter((e) => e.kind === 'OUTCOME_REVIEW')).toEqual([
      expect.objectContaining({ actorType: 'SYSTEM', source: 'SYSTEM', passengerTripId: w.ids.pax1, stopSeq: 0, data: expect.objectContaining({ code: 'BOARDED_UNVERIFIED_ARRIVAL', outcome: 'BOARDED' }) }),
    ]);
    expect(w.store.table('auditLog').some((a) => JSON.stringify(a.changes ?? {}).includes('outcomeReview'))).toBe(true);
    expect(w.row('transportTripPassenger', w.ids.pax1).status).toBe('BOARDED');
  });

  it('R-4: a high-water mark in the future is ignored (events are not skipped); from never passes now − 5 min', async () => {
    const w = world({ plannedStartInMin: 120 });
    const kv = new Map<string, string>();
    const redis = { client: { get: async (k: string) => kv.get(k) ?? null, set: async (k: string, v: string) => (kv.set(k, v), 'OK'), eval: async () => 1, xadd: async () => '1-0', publish: async () => 1 } };
    const notifications = new TransportNotificationsService(w.store.client() as never, redis as never);
    const relay = new TransportNotifyRelayService(w.store.client() as never, redis as never, notifications);
    const at = new Date(Date.now() - 2 * MIN);
    w.store.insert('transportTripEvent', { tripId: w.ids.tt, providerCompanyId: 'custA', customerCompanyId: 'custA', kind: 'PUBLISHED', actorType: 'DISPATCHER', source: 'WEB', occurredAt: at, receivedAt: at, data: { driverId: w.ids.dA } });
    kv.set('vt:etms:notify:hwm', String(Date.now() + 3_600_000)); // a clock jump wrote a mark 1 h ahead
    expect(await relay.run(Date.now())).toBe(1);
    const now = Date.now();
    expect(Number(kv.get('vt:etms:notify:hwm'))).toBeLessThanOrEqual(now - 5 * MIN);
    // A mark 1 min ago (just under now): still read from now − 5 min, so a writer 4 min behind is not missed.
    const behind = new Date(now - 4 * MIN);
    w.row('plannedTrip', w.ids.pt).driverId = w.ids.dA2;
    w.store.insert('transportTripEvent', { tripId: w.ids.tt, providerCompanyId: 'custA', customerCompanyId: 'custA', kind: 'DRIVER_CHANGED', actorType: 'DISPATCHER', source: 'WEB', occurredAt: behind, receivedAt: behind, data: { from: w.ids.dA, to: w.ids.dA2 } });
    kv.set('vt:etms:notify:hwm', String(now - 60_000));
    expect(await relay.run(now)).toBe(2); // TRIP_UNASSIGNED + TRIP_ASSIGNED
  });
});

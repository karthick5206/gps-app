/**
 * ETMS on-demand pooling (doc 20, phases B–D backend) on a real, freshly migrated PostgreSQL scratch database:
 * migration + P3 backfill + limits trigger, booking with ride preference and accepted limits, dispatcher hold excluded
 * from a run, live insertion that keeps committed stop times (optimiser stubbed: no pdp mode → in-process insertion),
 * PRIVATE exclusivity at publish, concurrent live assignments (no double booking, no vehicle conflict), tenant and branch
 * isolation of the new routes, cancellation updating an unpublished plan.
 *
 * Not part of the normal run (testRegex is *.spec.ts). Against a scratch `*_test` database with every migration applied:
 *   CI=true ETMS_DB_TEST_URL=postgresql://…@localhost:5432/veetrax_pooling_test DATABASE_URL=<same> \
 *     npx jest --testRegex 'etms-pooling\.db-test\.ts$' --runInBand
 * Synthetic data only (tag pool-…). Never veetracer / veetrax_assess (scratch-db guard).
 */
jest.mock('@nestjs/mapped-types', () => ({ PartialType: (c: new () => object) => class extends c {} }));

import { HttpException } from '@nestjs/common';
import { readFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { AuditService } from '../../audit/audit.service';
import { PlannedTripsService } from '../../planned-trips/planned-trips.service';
import { RoutingError } from '../../routing/routing.errors';
import { dbDescribe } from '../../test/scratch-db';
import { BookingsService } from '../dispatch/bookings.service';
import { DispatchService } from '../dispatch/dispatch.service';
import { TripLiveService } from '../dispatch/trip-live';
import { TransportNotificationsService } from '../notifications/transport-notifications.service';
import { RoutePlanCreateService } from '../planning/plan-create';
import { RoutePlansService } from '../planning/plans.service';
import { LiveDispatchService, systemContext } from './live-dispatch.service';
import { PoolingService } from './pooling.service';

const URL_ = process.env.ETMS_DB_TEST_URL ?? '';
const { d, dbName } = dbDescribe(URL_);
const TAG = `pool-${Date.now().toString(36)}`;
const dayPlus = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const DAY = dayPlus(3);
const at = (day: string, hhmm: string) => `${day}T${hhmm}:00.000Z`;

type Err = { code: string; status: number; body: Record<string, unknown> };
const errOf = (p: Promise<unknown>): Promise<Err> =>
  p.then(
    () => ({ code: 'OK', status: 200, body: {} }),
    (e: unknown) => {
      if (!(e instanceof HttpException)) return { code: `unexpected: ${String((e as Error)?.message ?? e)}`, status: 0, body: {} };
      const body = e.getResponse() as Record<string, unknown>;
      return { code: (body.code as string | undefined) ?? `HTTP_${e.getStatus()}`, status: e.getStatus(), body };
    },
  );

d(`ETMS pooling on ${dbName}`, () => {
  jest.setTimeout(300_000);
  const prisma = new PrismaClient({ datasourceUrl: URL_ });
  const redis = { client: { get: async () => null, mget: async (...k: string[]) => k.map(() => null), set: async () => 'OK', eval: async () => Promise.reject(new Error('no valkey')), publish: async () => 1, xadd: async () => '1-0', incr: async () => 1, expire: async () => 1 } };
  const audit = new AuditService(prisma as never);
  const plannedTrips = new PlannedTripsService(prisma as never, audit, { invalidate: async () => undefined } as never);
  const live = new TripLiveService(prisma as never, redis as never, plannedTrips);
  const routing = { enabled: false, route: async () => null, routeVia: async () => null, routeStatus: async () => 'UNAVAILABLE' };
  const dispatch = new DispatchService(prisma as never, audit, routing as never, live, redis as never);
  const notifications = new TransportNotificationsService(prisma as never, redis as never);
  const bookings = new BookingsService(prisma as never, audit, redis as never, notifications);
  const pooling = new PoolingService(prisma as never, audit, bookings);
  // The optimiser stub: configured, but without contract v3 (as the current solver): live dispatch falls back.
  const solverCalls: unknown[] = [];
  const optimizer = {
    configured: true,
    solvePdp: async (p: unknown) => {
      solverCalls.push(p);
      throw new RoutingError('PDP_UNSUPPORTED', 'no pdp mode');
    },
  };
  const liveDispatch = new LiveDispatchService(prisma as never, audit, dispatch, redis as never, optimizer as never);
  const provider = {
    routeVia: async (points: unknown[]) => ({ ok: true, value: { legs: points.slice(1).map(() => ({ durationSec: 300, distanceM: 2000 })), estimatedLegs: [], distanceM: 2000, durationSec: 300, path: { type: 'LineString', coordinates: [] } }, eta: { graphVersion: 'test' } }),
  };
  const plans = new RoutePlansService(prisma as never, audit, dispatch, provider as never);
  const creator = new RoutePlanCreateService(prisma as never, audit, plans);

  const id = () => randomUUID();
  const w = { partner: id(), company: id(), other: id(), branch: id(), branch2: id(), site: id(), otherVehicle: id(), admin: id(), dispatcher2: id(), foreign: id() };
  const perms = { etms_bookings: ['view', 'create', 'edit'], etms_dispatch: ['view', 'edit', 'command'], etms_planning: ['view', 'create', 'edit', 'command'], etms_settings: ['view', 'edit'] };
  const base = { homeCompanyId: w.company, companyId: w.company, isSuperAdmin: false, isCompanyAdmin: false, permissions: perms, objectIds: [], features: ['etms'], agreements: [], ip: null };
  const admin = { ...base, userId: w.admin, dataScope: 'COMPANY', branchIds: [] } as never;
  /** Branch dispatcher of the company's OTHER branch: the branch-1 rows are invisible (404). */
  const dispatcher2 = { ...base, userId: w.dispatcher2, dataScope: 'ASSIGNED', branchIds: [w.branch2] } as never;
  const foreign = { ...base, homeCompanyId: w.other, companyId: w.other, userId: w.foreign, dataScope: 'COMPANY', branchIds: [] } as never;
  const sql = (s: string) => prisma.$executeRawUnsafe(s);
  let n = 0;
  let k = 0;
  const key = () => `${TAG}-${++k}`;

  async function passenger(consent = true): Promise<string> {
    n++;
    const p = id();
    await sql(`INSERT INTO "EmployeeTransportProfile" (id, "companyId", "branchId", "employeeCode", "displayName", "updatedAt") VALUES ('${p}', '${w.company}', '${w.branch}', 'PL${n}', 'Synthetic ${n}', now())`);
    if (consent) await sql(`INSERT INTO "EmployeeTransportConsent" (id, "companyId", "profileId", purpose, "noticeVersion", granted, channel) VALUES (gen_random_uuid(), '${w.company}', '${p}', 'TRANSPORT_PROFILE', 'v1', true, 'WEB')`);
    return p;
  }

  async function vehicle(seats = 4): Promise<string> {
    const v = id();
    await sql(`INSERT INTO "TrackedObject" (id, "companyId", "branchId", name, "isActive", "updatedAt") VALUES ('${v}', '${w.company}', '${w.branch}', 'Van ${TAG} ${v.slice(0, 4)}', true, now())`);
    await sql(`INSERT INTO "TransportVehicleProfile" ("objectId", "companyId", seats, "updatedAt") VALUES ('${v}', '${w.company}', ${seats}, now())`);
    return v;
  }

  /** A point-to-point booking through the desk API (the pooling fields as given). */
  async function p2p(opts: { day?: string; from: number; to: number; start: string; end: string; pref?: 'SHARED' | 'PRIVATE' | 'FLEXIBLE'; accept?: number; limits?: Record<string, unknown> }) {
    const profile = await passenger();
    const day = opts.day ?? DAY;
    const r = await bookings.create(
      admin,
      {
        passengerId: profile,
        serviceDate: day,
        journey: 'POINT_TO_POINT',
        pickup: { lat: opts.from, lng: 80.2, label: 'A', poiId: null },
        drop: { lat: opts.to, lng: 80.2, label: 'B', poiId: null },
        windowStart: at(day, opts.start),
        windowEnd: at(day, opts.end),
        ...(opts.pref ? { ridePreference: opts.pref } : {}),
        ...(opts.accept !== undefined ? { acceptedPolicyVersion: opts.accept } : {}),
        ...(opts.limits ? { limits: opts.limits } : {}),
      } as never,
      key(),
    );
    return r.value;
  }

  /** Publishes a door-to-door trip for one booking (pickup / drop at its own points) through the E3 change set. */
  async function tripFor(b: { id: string }, v: string, pickupAt: string, dropAt: string, day = DAY) {
    const row = await prisma.transportBooking.findUniqueOrThrow({ where: { id: b.id } });
    const r = await dispatch.submit(
      admin,
      {
        serviceDate: day,
        direction: 'IN',
        changes: [
          { op: 'CREATE_TRIP', tempId: 't', objectId: v, plannedStart: pickupAt, stops: [{ seq: 0, point: { lat: row.pickupLat!, lng: row.pickupLng!, label: null, poiId: null }, plannedArrival: pickupAt, waitMin: 1 }, { seq: 1, point: { lat: row.dropLat!, lng: row.dropLng!, label: null, poiId: null }, plannedArrival: dropAt }] },
          { op: 'ADD_PASSENGER', tripId: 't', bookingId: b.id, pickupSeq: 0, dropSeq: 1 },
        ],
      } as never,
      key(),
    );
    return r.value.trips[0].id;
  }

  beforeAll(async () => {
    await sql(`INSERT INTO "Partner" (id, name, slug, "updatedAt") VALUES ('${w.partner}', '${TAG}', '${TAG}', now())`);
    for (const c of [w.company, w.other]) await sql(`INSERT INTO "Company" (id, "partnerId", name, timezone, settings, "updatedAt") VALUES ('${c}', '${w.partner}', '${TAG} ${c.slice(0, 4)}', 'Asia/Kolkata', '{"features":["etms"]}', now())`);
    await sql(`INSERT INTO "Branch" (id, "companyId", name, "updatedAt") VALUES ('${w.branch}', '${w.company}', 'North', now()), ('${w.branch2}', '${w.company}', 'South', now())`);
    for (const [u, c] of [[w.admin, w.company], [w.dispatcher2, w.company], [w.foreign, w.other]]) await sql(`INSERT INTO "User" (id, "companyId", name, "updatedAt") VALUES ('${u}', '${c}', 'User ${TAG}', now())`);
    await sql(`INSERT INTO "Poi" (id, "companyId", name, category, lat, lng, "updatedAt") VALUES ('${w.site}', '${w.company}', 'Garage', 'OFFICE', 13.0, 80.2, now())`);
    await sql(`INSERT INTO "TrackedObject" (id, "companyId", name, "isActive", "updatedAt") VALUES ('${w.otherVehicle}', '${w.other}', 'Foreign van', true, now())`);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('migration: P3 backfill (COMMUTE → SHARED, P2P → PRIVATE), P2P direction nullable, limits trigger', async () => {
    const p = await passenger();
    const c = id();
    const q = id();
    await sql(`INSERT INTO "TransportBooking" (id, "customerCompanyId", "profileId", source, journey, "serviceDate", direction, "timeZone", "windowStart", "windowEnd", status, "updatedAt") VALUES
      ('${c}', '${w.company}', '${p}', 'ADHOC', 'COMMUTE', '${dayPlus(30)}', 'IN', 'Asia/Kolkata', '${at(dayPlus(30), '03:00')}', '${at(dayPlus(30), '04:00')}', 'PENDING_ASSIGNMENT', now()),
      ('${q}', '${w.company}', '${p}', 'ADHOC', 'POINT_TO_POINT', '${dayPlus(30)}', 'IN', 'Asia/Kolkata', '${at(dayPlus(30), '10:00')}', '${at(dayPlus(30), '11:00')}', 'PENDING_ASSIGNMENT', now())`);
    // Raw rows get the column default; the migration's backfill statements (run here on these rows) set P3.
    const updates = readFileSync(join(__dirname, '../../../prisma/migrations/20261129090000_etms_pooling_core/migration.sql'), 'utf8').split('\n').filter((l) => l.startsWith('UPDATE "TransportBooking" SET "ridePreference"'));
    expect(updates).toHaveLength(2);
    for (const u of updates) await sql(u.replace(/;$/, ` AND id IN ('${c}', '${q}');`));
    const rows = await prisma.transportBooking.findMany({ where: { id: { in: [c, q] } }, select: { id: true, ridePreference: true, holdFromPlanning: true, limits: true } });
    expect(Object.fromEntries(rows.map((r) => [r.id, r.ridePreference]))).toEqual({ [c]: 'SHARED', [q]: 'PRIVATE' });
    expect(rows.every((r) => !r.holdFromPlanning && r.limits === null)).toBe(true);
    // COMMUTE needs a direction; POINT_TO_POINT may have none.
    await expect(sql(`UPDATE "TransportBooking" SET direction = NULL WHERE id = '${c}'`)).rejects.toThrow(/direction_check/);
    await sql(`UPDATE "TransportBooking" SET direction = NULL WHERE id = '${q}'`);
    // Limits: set once, then immutable while active; a cancelled booking is no longer guarded.
    await sql(`UPDATE "TransportBooking" SET limits = '{"maxWaitS":900,"maxDetour":{"ratio":1.8,"extraS":900},"maxRideS":null}' WHERE id = '${q}'`);
    await expect(sql(`UPDATE "TransportBooking" SET limits = '{"maxWaitS":1800,"maxDetour":{"ratio":1.8,"extraS":900},"maxRideS":null}' WHERE id = '${q}'`)).rejects.toThrow(/limits_immutable/);
    await expect(sql(`UPDATE "TransportBooking" SET "ridePreference" = 'SHARED' WHERE id = '${q}'`)).rejects.toThrow(/limits_immutable/);
    await sql(`UPDATE "TransportBooking" SET status = 'CANCELLED' WHERE id = '${q}'`);
    await sql(`UPDATE "TransportBooking" SET limits = NULL WHERE id = '${q}'`);
  });

  it('booking with ride preference and accepted limits (desk API): acceptance, snapshot, tighten only, policy version', async () => {
    const privateRide = await p2p({ from: 13.0, to: 13.1, start: '03:30', end: '04:30' });
    expect(privateRide).toMatchObject({ ridePreference: 'PRIVATE', direction: null, sharingPolicyVersion: null, holdFromPlanning: false });
    expect(privateRide.limits).toMatchObject({ maxWaitS: 900, maxDetour: { ratio: 1, extraS: 0 } });
    const profile = await passenger();
    const body = { passengerId: profile, serviceDate: DAY, journey: 'POINT_TO_POINT', pickup: { lat: 13.0, lng: 80.2, label: 'A', poiId: null }, drop: { lat: 13.1, lng: 80.2, label: 'B', poiId: null }, windowStart: at(DAY, '05:00'), windowEnd: at(DAY, '06:00'), ridePreference: 'SHARED' };
    expect((await errOf(bookings.create(admin, body as never, key()))).code).toBe('POLICY_ACCEPTANCE_REQUIRED');
    expect((await errOf(bookings.create(admin, { ...body, acceptedPolicyVersion: 0, limits: { maxWaitS: 1800 } } as never, key()))).code).toBe('LIMITS_ABOVE_POLICY');
    const shared = (await bookings.create(admin, { ...body, acceptedPolicyVersion: 0, limits: { maxWaitS: 600 } } as never, key())).value;
    expect(shared).toMatchObject({ ridePreference: 'SHARED', sharingPolicyVersion: 0, limits: { maxWaitS: 600, maxDetour: { ratio: 1.8, extraS: 900 }, maxRideS: null } });
    // A new policy version: an acceptance of the old one is stale; accepted bookings keep their snapshot.
    const v1 = await pooling.updatePolicy(admin, { text: 'Shared rides may carry other passengers within the limits below.', limits: { SHARED: { maxWaitS: 1200, maxDetour: { ratio: 2, extraS: 1200 }, maxRideS: null }, FLEXIBLE: { maxWaitS: 1200, maxDetour: { ratio: 2, extraS: 1200 }, maxRideS: null } } } as never);
    expect(v1.version).toBe(1);
    expect(await pooling.policy(admin)).toMatchObject({ version: 1, limits: { SHARED: { maxWaitS: 1200 } } });
    const p2 = await passenger();
    expect((await errOf(bookings.create(admin, { ...body, passengerId: p2, acceptedPolicyVersion: 0 } as never, key()))).code).toBe('POLICY_VERSION_STALE');
    const flex = (await bookings.create(admin, { ...body, passengerId: p2, ridePreference: 'FLEXIBLE', acceptedPolicyVersion: 1 } as never, key())).value;
    expect(flex).toMatchObject({ ridePreference: 'FLEXIBLE', sharingPolicyVersion: 1, limits: { maxWaitS: 1200 } });
    expect((await bookings.get(admin, shared.id)).limits).toMatchObject({ maxWaitS: 600 });
  });

  it('dispatcher hold: excluded from an AREA plan and refused by a publish; release makes it plannable again', async () => {
    const b = await p2p({ day: dayPlus(4), from: 13.0, to: 13.05, start: '03:30', end: '04:30', pref: 'SHARED', accept: 1 });
    const v = await vehicle();
    expect((await errOf(pooling.hold(admin, b.id, { hold: true, expectedVersion: b.version } as never))).code).toBe('VALIDATION_FAILED'); // reason required
    const held = await pooling.hold(admin, b.id, { hold: true, reason: 'Passenger asked to wait', expectedVersion: b.version } as never);
    expect(held).toMatchObject({ holdFromPlanning: true, holdReason: 'Passenger asked to wait', version: b.version + 1, status: 'PENDING_ASSIGNMENT' });
    const plan = await creator.create(admin, { name: 'Area hold', planDate: dayPlus(4), scope: 'AREA', windowStart: at(dayPlus(4), '02:00'), windowEnd: at(dayPlus(4), '08:00'), depot: { lat: 13.0, lng: 80.2 }, objectIds: [v] } as never, key());
    expect(plan.value.skippedBookings).toContainEqual({ bookingId: b.id, reason: 'on_hold' });
    expect(plan.value.stops.some((s) => s.bookingId === b.id)).toBe(false);
    const publish = await errOf(tripFor(b, v, at(dayPlus(4), '03:35'), at(dayPlus(4), '04:00'), dayPlus(4)));
    expect(publish.code).toBe('BOOKING_ON_HOLD');
    const released = await pooling.hold(admin, b.id, { hold: false, expectedVersion: held.version } as never);
    expect(released.holdFromPlanning).toBe(false);
    const again = await creator.create(admin, { name: 'Area released', planDate: dayPlus(4), scope: 'AREA', windowStart: at(dayPlus(4), '02:00'), windowEnd: at(dayPlus(4), '08:00'), depot: { lat: 13.0, lng: 80.2 }, objectIds: [v] } as never, key());
    expect(again.value.stops.filter((s) => s.bookingId === b.id).map((s) => s.stopKind).sort()).toEqual(['DROP', 'PICKUP']);
    expect(again.value.scope).toBe('AREA');
  });

  it('live insertion assigns into a published trip without moving any committed stop (optimiser stubbed → in-process)', async () => {
    const day = dayPlus(5);
    const v = await vehicle();
    const a = await p2p({ day, from: 13.0, to: 13.1, start: '03:30', end: '04:30', pref: 'SHARED', accept: 1 });
    const tripId = await tripFor(a, v, at(day, '03:35'), at(day, '04:30'), day);
    const before = await prisma.plannedTripStop.findMany({ where: { trip: { transportTrip: { id: tripId } } }, orderBy: { seq: 'asc' }, select: { id: true, plannedArrival: true } });
    const b = await p2p({ day, from: 13.03, to: 13.07, start: '03:40', end: '04:40', pref: 'SHARED', accept: 1 });
    // Switched off by default (company switch): 409.
    expect((await errOf(liveDispatch.decide(admin, { bookingId: b.id }, undefined))).code).toBe('LIVE_DISPATCH_DISABLED');
    await pooling.updateSettings(admin, { liveDispatch: true } as never);
    const decision = await liveDispatch.decide(admin, { bookingId: b.id, apply: true }, key());
    expect(decision.status).toBe('APPLIED');
    const chosen = decision.options.find((o) => o.optionId === decision.chosenOptionId)!;
    expect(chosen).toMatchObject({ kind: 'INSERT', tripId, target: 'SCHEDULED', engine: 'FALLBACK', servedAs: 'SHARED' });
    expect(solverCalls.length).toBeGreaterThan(0); // asked once, answered "no pdp mode"
    const after = await prisma.plannedTripStop.findMany({ where: { trip: { transportTrip: { id: tripId } } }, orderBy: { seq: 'asc' }, select: { id: true, plannedArrival: true } });
    expect(after).toHaveLength(4);
    for (const s of before) expect(after.find((x) => x.id === s.id)!.plannedArrival.toISOString()).toBe(s.plannedArrival.toISOString());
    const rows = await prisma.transportBooking.findMany({ where: { id: { in: [a.id, b.id] } }, select: { id: true, status: true, assignedService: true } });
    expect(rows.every((r) => r.status === 'ASSIGNED' && r.assignedService === 'SHARED')).toBe(true);
    const events = await prisma.transportTripEvent.findMany({ where: { tripId }, select: { kind: true } });
    expect(events.map((e) => e.kind)).toContain('PASSENGER_INSERTED');
    expect((await prisma.transportDispatchRequest.findUniqueOrThrow({ where: { id: decision.requestId } })).changeSetId).toBe(decision.changeSetId);
    // Worker path: a new booking is queued on creation and auto-assigned by the system actor.
    const c = await p2p({ day, from: 13.04, to: 13.06, start: '03:40', end: '04:40', pref: 'SHARED', accept: 1 });
    const queued = await prisma.transportDispatchRequest.findFirstOrThrow({ where: { bookingId: c.id, trigger: 'NEW_BOOKING' } });
    expect(queued.status).toBe('QUEUED');
    expect(await liveDispatch.process(queued.id)).toBe('APPLIED');
    expect((await prisma.transportBooking.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('ASSIGNED');
    const log = await liveDispatch.requests(admin, { bookingId: c.id });
    expect(log[0]).toMatchObject({ trigger: 'NEW_BOOKING', status: 'APPLIED' });
    // Committed times are still untouched after the second insertion.
    const final = await prisma.plannedTripStop.findMany({ where: { trip: { transportTrip: { id: tripId } } }, select: { id: true, plannedArrival: true } });
    for (const s of before) expect(final.find((x) => x.id === s.id)!.plannedArrival.toISOString()).toBe(s.plannedArrival.toISOString());
  });

  it('PRIVATE stays exclusive at publish and in live options', async () => {
    const day = dayPlus(6);
    const v = await vehicle();
    const priv = await p2p({ day, from: 13.0, to: 13.1, start: '03:30', end: '04:30' });
    const shared = await p2p({ day, from: 13.02, to: 13.08, start: '03:30', end: '04:30', pref: 'SHARED', accept: 1 });
    const rows = await prisma.transportBooking.findMany({ where: { id: { in: [priv.id, shared.id] } } });
    const pt = (bk: string, end: 'p' | 'd') => {
      const r = rows.find((x) => x.id === bk)!;
      return end === 'p' ? { lat: r.pickupLat!, lng: r.pickupLng!, label: null, poiId: null } : { lat: r.dropLat!, lng: r.dropLng!, label: null, poiId: null };
    };
    const together = await errOf(
      dispatch.submit(admin, { serviceDate: day, direction: 'IN', changes: [
        { op: 'CREATE_TRIP', tempId: 't', objectId: v, plannedStart: at(day, '03:35'), stops: [
          { seq: 0, point: pt(priv.id, 'p'), plannedArrival: at(day, '03:35') },
          { seq: 1, point: pt(shared.id, 'p'), plannedArrival: at(day, '03:45') },
          { seq: 2, point: pt(shared.id, 'd'), plannedArrival: at(day, '04:05') },
          { seq: 3, point: pt(priv.id, 'd'), plannedArrival: at(day, '04:15') },
        ] },
        { op: 'ADD_PASSENGER', tripId: 't', bookingId: priv.id, pickupSeq: 0, dropSeq: 3 },
        { op: 'ADD_PASSENGER', tripId: 't', bookingId: shared.id, pickupSeq: 1, dropSeq: 2 },
      ] } as never, key()),
    );
    expect(together).toMatchObject({ status: 409, code: 'PRIVATE_RIDE_NOT_EXCLUSIVE' });
    expect((await prisma.transportBooking.findUniqueOrThrow({ where: { id: priv.id } })).status).toBe('PENDING_ASSIGNMENT'); // rolled back
    const tripId = await tripFor(priv, v, at(day, '03:35'), at(day, '04:20'), day);
    expect((await prisma.transportBooking.findUniqueOrThrow({ where: { id: priv.id } })).assignedService).toBe('PRIVATE');
    const version = (await prisma.transportTrip.findUniqueOrThrow({ where: { id: tripId } })).version;
    const join = await errOf(
      dispatch.submit(admin, { serviceDate: day, direction: 'IN', expectedVersions: { [tripId]: version }, changes: [
        { op: 'ADD_STOP', tripId, bookingId: shared.id, end: 'PICKUP', afterSeq: 0, plannedArrival: at(day, '03:45') },
        { op: 'ADD_STOP', tripId, bookingId: shared.id, end: 'DROP', afterSeq: 1, plannedArrival: at(day, '04:05') },
        { op: 'ADD_PASSENGER', tripId, bookingId: shared.id, pickupSeq: 1, dropSeq: 2 },
      ] } as never, key()),
    );
    expect(join).toMatchObject({ status: 409, code: 'PRIVATE_RIDE_NOT_EXCLUSIVE' });
    // Live options never offer the private trip.
    const sharedRow = await prisma.transportBooking.findUniqueOrThrow({ where: { id: shared.id }, include: { profile: { select: { branchId: true } } } });
    const { options } = await liveDispatch.findOptions(admin, sharedRow);
    expect(options.some((o) => o.tripId === tripId)).toBe(false);
  });

  it('concurrent live assignments: no double booking, no vehicle conflict', async () => {
    const day = dayPlus(7);
    const v = await vehicle();
    const b1 = await p2p({ day, from: 13.2, to: 13.25, start: '06:00', end: '07:00', pref: 'SHARED', accept: 1 });
    const b2 = await p2p({ day, from: 13.21, to: 13.26, start: '06:00', end: '07:00', pref: 'SHARED', accept: 1 });
    const load = (x: string) => prisma.transportBooking.findUniqueOrThrow({ where: { id: x }, include: { profile: { select: { branchId: true } } } });
    const newTripOn = async (bk: string) => (await liveDispatch.findOptions(admin, await load(bk))).options.find((o) => o.kind === 'NEW_TRIP' && o.objectId === v)!;
    const [o1, o2] = await Promise.all([newTripOn(b1.id), newTripOn(b2.id)]);
    expect(o1 && o2).toBeTruthy();
    const req = async (bk: string) => (await prisma.transportDispatchRequest.create({ data: { companyId: w.company, bookingId: bk, trigger: 'MANUAL', idempotencyKey: key() } })).id;
    const sys = systemContext(w.company);
    // Two different bookings onto the same idle vehicle at overlapping times: exactly one wins (VEHICLE_BUSY).
    const r = await Promise.all([errOf(liveDispatch.applyOption(sys, await req(b1.id), await load(b1.id), o1, key(), true)), errOf(liveDispatch.applyOption(sys, await req(b2.id), await load(b2.id), o2, key(), true))]);
    expect(r.map((x) => x.code).sort()).toEqual(['OK', 'VEHICLE_BUSY']);
    const trips = await prisma.plannedTrip.findMany({ where: { objectId: v, status: 'SCHEDULED' } });
    expect(trips).toHaveLength(1);
    // The same booking twice at once (two vehicles): one seat only.
    const v2 = await vehicle();
    const v3 = await vehicle();
    const b3 = await p2p({ day, from: 13.3, to: 13.35, start: '09:00', end: '10:00', pref: 'SHARED', accept: 1 });
    const opts3 = (await liveDispatch.findOptions(admin, await load(b3.id))).options;
    const on = (x: string) => opts3.find((o) => o.kind === 'NEW_TRIP' && o.objectId === x)!;
    const twice = await Promise.all([errOf(liveDispatch.applyOption(sys, await req(b3.id), await load(b3.id), on(v2), key(), true)), errOf(liveDispatch.applyOption(sys, await req(b3.id), await load(b3.id), on(v3), key(), true))]);
    expect(twice.filter((x) => x.code === 'OK')).toHaveLength(1);
    expect(await prisma.transportTripPassenger.count({ where: { bookingId: b3.id, status: { not: 'CANCELLED' } } })).toBe(1);
  });

  it('tenant and branch isolation of the new routes', async () => {
    const b = await p2p({ day: dayPlus(8), from: 13.0, to: 13.05, start: '03:30', end: '04:30', pref: 'SHARED', accept: 1 });
    const v = await vehicle();
    // Another company: every id is a 404 (never a hint), whatever its own switches.
    expect((await errOf(pooling.hold(foreign, b.id, { hold: true, reason: 'not mine', expectedVersion: b.version } as never))).status).toBe(404);
    expect((await errOf(liveDispatch.decide(foreign, { bookingId: b.id }, undefined))).status).toBe(404);
    expect((await errOf(pooling.availability(foreign, v))).status).toBe(404);
    expect((await errOf(pooling.putAvailability(foreign, v, { windows: [] } as never))).status).toBe(404);
    expect((await errOf(pooling.availability(admin, w.otherVehicle))).status).toBe(404);
    expect(await liveDispatch.requests(foreign, {})).toEqual([]);
    expect((await pooling.policy(foreign)).version).toBe(0); // its own (default) policy, never ours
    // A dispatcher of the other branch: the branch-1 booking and vehicle are invisible.
    expect((await errOf(pooling.hold(dispatcher2, b.id, { hold: true, reason: 'other branch', expectedVersion: b.version } as never))).status).toBe(404);
    expect((await errOf(liveDispatch.decide(dispatcher2, { bookingId: b.id }, undefined))).status).toBe(404);
    expect((await errOf(pooling.availability(dispatcher2, v))).status).toBe(404);
    expect((await liveDispatch.requests(dispatcher2, {})).some((r) => r.bookingId === b.id)).toBe(false);
    // Settings and policy are whole-company choices.
    expect((await errOf(pooling.updateSettings(dispatcher2, { liveDispatch: false } as never))).status).toBe(403);
    // Own company: availability round trip (downtime refuses a trip in it at publish).
    const downtime = await pooling.putAvailability(admin, v, { turnaroundS: 300, windows: [{ kind: 'DOWNTIME', startsAt: at(dayPlus(8), '03:00'), endsAt: at(dayPlus(8), '05:00'), reason: 'Service' }] } as never);
    expect(downtime).toMatchObject({ objectId: v, turnaroundS: 300, windows: [{ kind: 'DOWNTIME', reason: 'Service' }] });
    expect((await errOf(tripFor(b, v, at(dayPlus(8), '03:35'), at(dayPlus(8), '04:00'), dayPlus(8)))).code).toBe('VEHICLE_UNAVAILABLE');
  });

  it('cancellation updates an unpublished plan safely (stops removed, version + 1, version row) and releases a seat', async () => {
    const day = dayPlus(9);
    const v = await vehicle();
    const keep = await p2p({ day, from: 13.0, to: 13.05, start: '03:30', end: '04:30', pref: 'SHARED', accept: 1 });
    const gone = await p2p({ day, from: 13.01, to: 13.06, start: '03:30', end: '04:30', pref: 'SHARED', accept: 1 });
    const plan = await creator.create(admin, { name: 'Area cancel', planDate: day, scope: 'AREA', windowStart: at(day, '02:00'), windowEnd: at(day, '08:00'), depot: { lat: 13.0, lng: 80.2 }, objectIds: [v] } as never, key());
    expect(plan.value.version).toBe(1);
    expect(plan.value.stops.filter((s) => s.bookingId === gone.id)).toHaveLength(2);
    await bookings.command(admin, gone.id, 'cancel', { reason: 'Not travelling' } as never);
    const after = await prisma.routePlan.findUniqueOrThrow({ where: { id: plan.value.id }, include: { stops: true } });
    expect(after.version).toBe(2);
    expect(after.stops.some((s) => s.bookingId === gone.id)).toBe(false);
    expect(after.stops.filter((s) => s.bookingId === keep.id)).toHaveLength(2);
    expect((await prisma.routePlanVersion.findFirstOrThrow({ where: { planId: plan.value.id, version: 2 } })).changeType).toBe('EDITED');
    // An assigned booking on a published trip: its seat is released in the same transaction.
    const tripId = await tripFor(keep, await vehicle(), at(day, '03:35'), at(day, '04:10'), day);
    await bookings.command(admin, keep.id, 'cancel', { reason: 'Not travelling' } as never);
    expect((await prisma.transportTrip.findUniqueOrThrow({ where: { id: tripId } })).occupiedSeats).toBe(0);
    expect((await prisma.routePlan.findUniqueOrThrow({ where: { id: plan.value.id } })).version).toBe(3);
  });

  // ───────────────────────────── independent review fixes ─────────────────────────────

  /** A legacy point-to-point booking as E3 stored it (PRIVATE by the P3 backfill, no limits snapshot). */
  async function legacyP2P(day: string, lat: number): Promise<string> {
    const p = await passenger();
    const b = id();
    await sql(`INSERT INTO "TransportBooking" (id, "customerCompanyId", "profileId", source, journey, "serviceDate", direction, "timeZone", "pickupLat", "pickupLng", "dropLat", "dropLng", "windowStart", "windowEnd", status, "ridePreference", "updatedAt")
      VALUES ('${b}', '${w.company}', '${p}', 'ADHOC', 'POINT_TO_POINT', '${day}', 'IN', 'Asia/Kolkata', ${lat}, 80.2, ${lat + 0.08}, 80.2, '${at(day, '03:30')}', '${at(day, '04:30')}', 'PENDING_ASSIGNMENT', 'PRIVATE', now())`);
    return b;
  }

  async function driver(): Promise<string> {
    const dr = id();
    await sql(`INSERT INTO "Driver" (id, "companyId", "branchId", name, "isActive", "updatedAt") VALUES ('${dr}', '${w.company}', '${w.branch}', 'Driver ${TAG}', true, now())`);
    return dr;
  }

  const version = async (tripId: string) => (await prisma.transportTrip.findUniqueOrThrow({ where: { id: tripId } })).version;
  const reassignDriver = (tripId: string, v: number, driverId: string, day: string) => dispatch.submit(admin, { serviceDate: day, direction: 'IN', expectedVersions: { [tripId]: v }, changes: [{ op: 'REASSIGN_DRIVER', tripId, driverId }] } as never, key());
  const pointsOf = async (ids: string[]) => {
    const rows = await prisma.transportBooking.findMany({ where: { id: { in: ids } } });
    return (x: string, end: 'p' | 'd') => {
      const r = rows.find((y) => y.id === x)!;
      return end === 'p' ? { lat: r.pickupLat!, lng: r.pickupLng!, label: null, poiId: null } : { lat: r.dropLat!, lng: r.dropLng!, label: null, poiId: null };
    };
  };
  /** One trip seating `a` (outer) and `b` (inner): a pickup, b pickup, b drop, a drop. */
  const sharedTrip = async (v: string, a: string, b: string, day: string) => {
    const pt = await pointsOf([a, b]);
    const r = await dispatch.submit(admin, { serviceDate: day, direction: 'IN', changes: [
      { op: 'CREATE_TRIP', tempId: 't', objectId: v, plannedStart: at(day, '03:35'), stops: [
        { seq: 0, point: pt(a, 'p'), plannedArrival: at(day, '03:35') },
        { seq: 1, point: pt(b, 'p'), plannedArrival: at(day, '03:40') },
        { seq: 2, point: pt(b, 'd'), plannedArrival: at(day, '04:00') },
        { seq: 3, point: pt(a, 'd'), plannedArrival: at(day, '04:10') },
      ] },
      { op: 'ADD_PASSENGER', tripId: 't', bookingId: a, pickupSeq: 0, dropSeq: 3 },
      { op: 'ADD_PASSENGER', tripId: 't', bookingId: b, pickupSeq: 1, dropSeq: 2 },
    ] } as never, key());
    return r.value.trips[0].id;
  };

  it('review fix 4: legacy P2P riders already sharing a trip stay editable; the backfill guard makes them FLEXIBLE', async () => {
    const day = dayPlus(10);
    const v = await vehicle();
    const a = await legacyP2P(day, 13.0);
    const b = await legacyP2P(day, 13.01);
    // E3 could seat both on one trip; with no limits snapshot they are not bound by P1.
    const tripId = await sharedTrip(v, a, b, day);
    // Later change sets on that trip keep working (they used to fail 409 PRIVATE_RIDE_NOT_EXCLUSIVE).
    expect((await errOf(reassignDriver(tripId, await version(tripId), await driver(), day))).code).toBe('OK');
    const seat = await prisma.transportTripPassenger.findFirstOrThrow({ where: { tripId, bookingId: b } });
    expect((await errOf(dispatch.submit(admin, { serviceDate: day, direction: 'IN', expectedVersions: { [tripId]: await version(tripId) }, changes: [{ op: 'REMOVE_PASSENGER', passengerTripId: seat.id, reason: 'Review fix 4' }] } as never, key()))).code).toBe('OK');
    // The migration guard (20261129090100): seated with another party → FLEXIBLE; an unseated legacy row stays PRIVATE.
    const c = await legacyP2P(day, 13.3);
    await sql(`UPDATE "TransportTripPassenger" SET status = 'PENDING', "cancelReason" = NULL WHERE id = '${seat.id}'`);
    await sql(readFileSync(join(__dirname, '../../../prisma/migrations/20261129090100_etms_pooling_review_fixes/migration.sql'), 'utf8'));
    const after = await prisma.transportBooking.findMany({ where: { id: { in: [a, b, c] } }, select: { id: true, ridePreference: true } });
    expect(Object.fromEntries(after.map((x) => [x.id, x.ridePreference]))).toEqual({ [a]: 'FLEXIBLE', [b]: 'FLEXIBLE', [c]: 'PRIVATE' });
  });

  it('review fix 5: pooling off → a maintenance-flagged vehicle keeps the E3 behaviour; a driver change never runs the vehicle timeline', async () => {
    await pooling.updateSettings(admin, { liveDispatch: false } as never);
    const day = dayPlus(11);
    const v = await vehicle();
    await sql(`UPDATE "TrackedObject" SET "maintenanceSince" = now() WHERE id = '${v}'`);
    const b = await p2p({ day, from: 13.0, to: 13.05, start: '03:30', end: '04:30', pref: 'SHARED', accept: 1 });
    const tripId = await tripFor(b, v, at(day, '03:35'), at(day, '04:00'), day);
    await pooling.updateSettings(admin, { liveDispatch: true } as never);
    expect((await errOf(reassignDriver(tripId, await version(tripId), await driver(), day))).code).toBe('OK');
    // Pooling in use: a new trip on the vehicle under maintenance is refused.
    const b2 = await p2p({ day, from: 13.2, to: 13.25, start: '06:30', end: '07:30', pref: 'SHARED', accept: 1 });
    expect((await errOf(tripFor(b2, v, at(day, '06:35'), at(day, '07:00'), day))).code).toBe('VEHICLE_UNAVAILABLE');
  });

  it('review fixes 7 / 8 / 2: a released hold is re-queued; a shown option is applied by requestId; no live insertion while an ack is pending', async () => {
    const day = dayPlus(12);
    await vehicle();
    const b = await p2p({ day, from: 13.4, to: 13.45, start: '03:30', end: '04:30', pref: 'SHARED', accept: 1 });
    const held = await pooling.hold(admin, b.id, { hold: true, reason: 'Waiting for a call back', expectedVersion: b.version } as never);
    const released = await pooling.hold(admin, b.id, { hold: false, expectedVersion: held.version } as never);
    expect(await prisma.transportDispatchRequest.findFirst({ where: { companyId: w.company, idempotencyKey: `booking:${b.id}:v${released.version}` }, select: { status: true, trigger: true } })).toEqual({ status: 'QUEUED', trigger: 'NEW_BOOKING' });
    // Option ids do not depend on "now" (the pickup time of a new trip moves with it; the option does not).
    const row = await prisma.transportBooking.findUniqueOrThrow({ where: { id: b.id }, include: { profile: { select: { branchId: true } } } });
    const ws = row.windowStart.getTime();
    const early = (await liveDispatch.findOptions(admin, row, { now: ws - 10 * 60_000 })).options.filter((o) => o.kind === 'NEW_TRIP');
    const later = (await liveDispatch.findOptions(admin, row, { now: ws - 8 * 60_000 })).options.filter((o) => o.kind === 'NEW_TRIP');
    expect(early.length).toBeGreaterThan(0);
    const twin = later.find((o) => o.objectId === early[0].objectId)!;
    expect(twin.pickupEta).not.toBe(early[0].pickupEta);
    expect(twin.optionId).toBe(early[0].optionId);
    // Decide, then apply exactly the option shown (stored on the request).
    const shown = await liveDispatch.decide(admin, { bookingId: b.id }, undefined);
    expect(shown.status).toBe('DECIDED');
    const pick = shown.options[shown.options.length - 1];
    const applied = await liveDispatch.decide(admin, { bookingId: b.id, apply: true, requestId: shown.requestId, optionId: pick.optionId }, key());
    expect(applied).toMatchObject({ status: 'APPLIED', chosenOptionId: pick.optionId });
    // The trip starts and its driver has not acknowledged a live change: no further insertion is offered on it.
    const tripId = (await prisma.transportTripPassenger.findFirstOrThrow({ where: { bookingId: b.id, status: 'PENDING' } })).tripId;
    const t = await prisma.transportTrip.findUniqueOrThrow({ where: { id: tripId } });
    await prisma.plannedTrip.update({ where: { id: t.plannedTripId! }, data: { status: 'IN_PROGRESS', actualStart: new Date() } });
    await prisma.transportTrip.update({ where: { id: tripId }, data: { liveRouteVersion: 1 } });
    const c = await p2p({ day, from: 13.41, to: 13.44, start: '03:30', end: '04:30', pref: 'SHARED', accept: 1 });
    const cRow = await prisma.transportBooking.findUniqueOrThrow({ where: { id: c.id }, include: { profile: { select: { branchId: true } } } });
    const { options } = await liveDispatch.findOptions(admin, cRow);
    expect(options.some((o) => o.tripId === tripId)).toBe(false);
  });

  it('review fix 3: a breakdown makes one proposal per passenger; a failed re-seat child retries alone (no grandchildren)', async () => {
    const day = dayPlus(13);
    const v = await vehicle();
    const a = await p2p({ day, from: 13.5, to: 13.6, start: '03:30', end: '04:30', pref: 'SHARED', accept: 1 });
    const c = await p2p({ day, from: 13.52, to: 13.58, start: '03:30', end: '04:30', pref: 'SHARED', accept: 1 });
    const tripId = await sharedTrip(v, a.id, c.id, day);
    const t = await prisma.transportTrip.findUniqueOrThrow({ where: { id: tripId } });
    await prisma.plannedTrip.update({ where: { id: t.plannedTripId! }, data: { status: 'IN_PROGRESS', actualStart: new Date() } });
    await sql(`UPDATE "TransportTripPassenger" SET status = 'BOARDED', "boardedAt" = now(), "outcomeSource" = 'WEB' WHERE "tripId" = '${tripId}' AND "bookingId" = '${a.id}'`);
    const parent = await prisma.transportDispatchRequest.create({ data: { companyId: w.company, tripId, trigger: 'BREAKDOWN', idempotencyKey: key() } });
    expect(await liveDispatch.process(parent.id)).toBe('DECIDED');
    expect((await prisma.transportTrip.findUniqueOrThrow({ where: { id: tripId } })).interruptedAt).not.toBeNull();
    const kids = await prisma.transportDispatchRequest.findMany({ where: { tripId, id: { not: parent.id } } });
    expect(kids).toHaveLength(2);
    expect(kids.find((k) => k.bookingId === a.id)).toMatchObject({ status: 'PROPOSED', reasons: ['ONBOARD_TRANSFER'] });
    const child = kids.find((k) => k.bookingId === c.id)!;
    expect(['PROPOSED', 'REJECTED']).toContain(child.status); // delay policy PROPOSE (default): never applied alone
    // A failed child is retried by the worker on its own re-seat path.
    await prisma.transportDispatchRequest.update({ where: { id: child.id }, data: { status: 'FAILED', attempts: 1 } });
    expect(['PROPOSED', 'REJECTED']).toContain(await liveDispatch.process(child.id));
    expect(await prisma.transportDispatchRequest.count({ where: { tripId } })).toBe(3);
  });
});

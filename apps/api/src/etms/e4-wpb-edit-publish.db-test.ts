/**
 * ETMS E4 WP-B (route planning: edit and publish) on a real, freshly migrated PostgreSQL scratch database:
 * restore (undo / redo) and its conflict, recalculate and the vehicle-change capacity re-check, adding / removing a
 * booking on a draft (scope refusals, consent, the 75-booking limit), availability before publish (busy vehicle / driver),
 * selected-routes publishing with the review confirmation (stale hash, already-published route, concurrent overlapping
 * publishes, idempotent replay), published routes immutable (edit, restore, optimiser load), discard after a partial
 * publish, consent withdrawn before publish, tenant and branch isolation of the new routes.
 *
 * Not part of the normal run (testRegex is *.spec.ts). Against a scratch `*_test` database with every migration applied:
 *   CI=true ETMS_DB_TEST_URL=postgresql://…@localhost:5432/veetrax_e4wpb_test \
 *     npx jest --testRegex 'e4-wpb-edit-publish\.db-test\.ts$' --runInBand
 * Synthetic data only (tag wpb-…). Never veetracer / veetrax_assess (scratch-db guard).
 */
jest.mock('@nestjs/mapped-types', () => ({ PartialType: (c: new () => object) => class extends c {} }));

import { HttpException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { PlannedTripsService } from '../planned-trips/planned-trips.service';
import { PrismaPlanGateway } from '../routing-jobs/prisma-plan-gateway';
import { dbDescribe } from '../test/scratch-db';
import { DispatchService } from './dispatch/dispatch.service';
import { TripLiveService } from './dispatch/trip-live';
import { RoutePlansService } from './planning/plans.service';

const URL_ = process.env.ETMS_DB_TEST_URL ?? '';
const { d, dbName } = dbDescribe(URL_);
const TAG = `wpb-${Date.now().toString(36)}`;
const DAY = '2026-12-03';
const START = '2026-12-03T02:00:00Z';
const startMs = Date.parse(START);

type Err = { code: string; status: number; body: Record<string, unknown> };
const errOf = (p: Promise<unknown>): Promise<Err> =>
  p.then(
    () => ({ code: 'OK', status: 200, body: {} }),
    (e: unknown) => {
      if (!(e instanceof HttpException)) return { code: `unexpected: ${String(e)}`, status: 0, body: {} };
      const body = e.getResponse() as Record<string, unknown>;
      return { code: (body.code as string | undefined) ?? `HTTP_${e.getStatus()}`, status: e.getStatus(), body };
    },
  );

d(`ETMS E4 WP-B edit and publish on ${dbName}`, () => {
  jest.setTimeout(300_000);
  const prisma = new PrismaClient({ datasourceUrl: URL_ });
  const redis = { client: { get: async () => null, mget: async (...k: string[]) => k.map(() => null), set: async () => 'OK', eval: async () => Promise.reject(new Error('no valkey')), publish: async () => 1, xadd: async () => '1-0' } };
  const audit = new AuditService(prisma as never);
  const plannedTrips = new PlannedTripsService(prisma as never, audit, { invalidate: async () => undefined } as never);
  const live = new TripLiveService(prisma as never, redis as never, plannedTrips);
  const routing = { enabled: false, route: async () => null, routeVia: async () => null, routeStatus: async () => 'UNAVAILABLE' };
  const dispatch = new DispatchService(prisma as never, audit, routing as never, live, redis as never);
  // A road engine that answers: every leg 300 s, 2 km.
  const provider = {
    routeVia: async (points: unknown[]) => ({
      ok: true,
      value: { legs: points.slice(1).map(() => ({ durationSec: 300, distanceM: 2000 })), estimatedLegs: [], distanceM: 2000 * (points.length - 1), durationSec: 300 * (points.length - 1), path: { type: 'LineString', coordinates: [] } },
      eta: { graphVersion: 'test-graph' },
    }),
  };
  const plans = new RoutePlansService(prisma as never, audit, dispatch, provider as never);

  const id = () => randomUUID();
  const w = { partner: id(), company: id(), other: id(), branch: id(), branch2: id(), site: id(), site2: id(), admin: id(), dispatcher: id(), outsider: id(), foreign: id() };
  const perms = { etms_planning: ['view', 'edit', 'command', 'delete'], etms_dispatch: ['view', 'edit', 'command'] };
  const base = { homeCompanyId: w.company, companyId: w.company, isSuperAdmin: false, isCompanyAdmin: false, permissions: perms, objectIds: [], features: ['etms'], agreements: [], ip: null };
  const admin = { ...base, userId: w.admin, dataScope: 'COMPANY', branchIds: [] } as never;
  const dispatcher = { ...base, userId: w.dispatcher, dataScope: 'ASSIGNED', branchIds: [w.branch] } as never;
  /** Branch dispatcher of another branch of the same company: the plans are invisible (404). */
  const outsider = { ...base, userId: w.outsider, dataScope: 'ASSIGNED', branchIds: [w.branch2] } as never;
  /** Admin of another company. */
  const foreign = { ...base, homeCompanyId: w.other, companyId: w.other, userId: w.foreign, dataScope: 'COMPANY', branchIds: [] } as never;
  const sql = (s: string) => prisma.$executeRawUnsafe(s);
  let n = 0;
  const iso = (s: number) => new Date(startMs + s * 1000).toISOString();

  /** A consenting passenger with an open IN booking for the site (personal pickup), window [0, 7200 s]. */
  async function booking(opts: { site?: string; day?: string; consent?: boolean; passengers?: number } = {}): Promise<{ booking: string; profile: string; lat: number }> {
    n++;
    const p = id();
    const b = id();
    const lat = 13.0 + (n % 500) * 0.001;
    await sql(`INSERT INTO "EmployeeTransportProfile" (id, "companyId", "branchId", "employeeCode", "displayName", "updatedAt") VALUES ('${p}', '${w.company}', '${w.branch}', 'W${n}', 'Synthetic ${n}', now())`);
    if (opts.consent !== false) await sql(`INSERT INTO "EmployeeTransportConsent" (id, "companyId", "profileId", purpose, "noticeVersion", granted, channel) VALUES (gen_random_uuid(), '${w.company}', '${p}', 'TRANSPORT_PROFILE', 'v1', true, 'WEB')`);
    await sql(`INSERT INTO "TransportBooking" (id, "customerCompanyId", "profileId", source, "serviceDate", direction, "timeZone", "pickupLat", "pickupLng", "pickupLabel", "dropPoiId", "dropLat", "dropLng", "dropLabel", "windowStart", "windowEnd", status, "passengerCount", "updatedAt")
      VALUES ('${b}', '${w.company}', '${p}', 'ADHOC', '${opts.day ?? DAY}', 'IN', 'Asia/Kolkata', ${lat}, 80.24, 'Home', '${opts.site ?? w.site}', 13.05, 80.25, 'HQ', '${iso(0)}', '${iso(7200)}', 'PENDING_ASSIGNMENT', ${opts.passengers ?? 1}, now())`);
    return { booking: b, profile: p, lat };
  }

  /** A vehicle of the branch with `seats` seats (and optionally a driver). */
  async function vehicle(seats = 4): Promise<string> {
    const v = id();
    await sql(`INSERT INTO "TrackedObject" (id, "companyId", "branchId", name, "isActive", "updatedAt") VALUES ('${v}', '${w.company}', '${w.branch}', 'Van ${TAG} ${v.slice(0, 4)}', true, now())`);
    await sql(`INSERT INTO "TransportVehicleProfile" ("objectId", "companyId", seats, "updatedAt") VALUES ('${v}', '${w.company}', ${seats}, now())`);
    return v;
  }

  /** A PLANNED IN plan with `routes` routes, each on its own vehicle carrying one booking (pickup at 600 s, site drop at 1800 s). */
  async function makePlan(routes: number, opts: { driver?: boolean; passengers?: number } = {}) {
    const plan = id();
    await sql(`INSERT INTO "RoutePlan" (id, "companyId", "branchId", name, "planDate", "planStartAt", status, direction, "sitePoiId", "updatedAt") VALUES ('${plan}', '${w.company}', '${w.branch}', 'Login ${TAG}', '${DAY}', '${START}', 'PLANNED', 'IN', '${w.site}', now())`);
    const out: { route: string; vehicle: string; driver: string | null; booking: string; profile: string; pickup: string; drop: string }[] = [];
    for (let i = 0; i < routes; i++) {
      const v = await vehicle();
      const driver = opts.driver ? id() : null;
      if (driver) await sql(`INSERT INTO "Driver" (id, "companyId", "branchId", name, "isActive", "updatedAt") VALUES ('${driver}', '${w.company}', '${w.branch}', 'Driver ${i}', true, now())`);
      const route = id();
      await sql(`INSERT INTO "RouteAssignment" (id, "planId", "companyId", "objectId", "driverId", "vehicleLabel", seq, capacity, "distanceM", "durationS", "startS", "endS", "updatedAt") VALUES ('${route}', '${plan}', '${w.company}', '${v}', ${driver ? `'${driver}'` : 'NULL'}, 'Van ${i}', ${i}, 4, 9000, 2400, 0, 1800, now())`);
      const b = await booking({ passengers: opts.passengers });
      const pickup = id();
      const drop = id();
      await sql(`INSERT INTO "RoutePlanStop" (id, "planId", "companyId", "assignmentId", ref, lat, lng, demand, "serviceS", sequence, "etaS", "stopKind", "customerCompanyId", "bookingId", "profileId", "updatedAt")
        VALUES ('${pickup}', '${plan}', '${w.company}', '${route}', 'p-${b.booking}', ${b.lat}, 80.24, 1, 60, 1, 600, 'PICKUP', '${w.company}', '${b.booking}', '${b.profile}', now())`);
      await sql(`INSERT INTO "RoutePlanStop" (id, "planId", "companyId", "assignmentId", ref, lat, lng, demand, "serviceS", sequence, "etaS", "timeWindows", "stopKind", "customerCompanyId", "bookingId", "poiId", "updatedAt")
        VALUES ('${drop}', '${plan}', '${w.company}', '${route}', 'd-${b.booking}', 13.05, 80.25, 0, 0, 2, 1800, '[[0, 7200]]', 'DROP', '${w.company}', '${b.booking}', '${w.site}', now())`);
      out.push({ route, vehicle: v, driver, booking: b.booking, profile: b.profile, pickup, drop });
    }
    // Version 1 as an optimisation would have recorded it (the baseline of the manual-change diff).
    const snap = { status: 'PLANNED', assignments: out.map((r, i) => ({ id: r.route, vehicleLabel: `Van ${i}`, objectId: r.vehicle, driverId: r.driver, stopIds: [r.pickup, r.drop] })), stops: out.flatMap((r) => [{ id: r.pickup, ref: `p-${r.booking}`, assignmentId: r.route, sequence: 1, etaS: 600, unassignedReason: null }, { id: r.drop, ref: `d-${r.booking}`, assignmentId: r.route, sequence: 2, etaS: 1800, unassignedReason: null }]) };
    await prisma.routePlanVersion.create({ data: { planId: plan, companyId: w.company, version: 1, changeType: 'OPTIMIZED', snapshot: snap } });
    return { plan, routes: out };
  }

  const version = async (plan: string) => (await prisma.routePlan.findUniqueOrThrow({ where: { id: plan }, select: { version: true } })).version;
  const routeOf = async (plan: string, bookingId: string) => (await prisma.routePlanStop.findFirst({ where: { planId: plan, bookingId, stopKind: 'PICKUP' }, select: { assignmentId: true } }))?.assignmentId;

  beforeAll(async () => {
    await sql(`INSERT INTO "Partner" (id, name, slug, "updatedAt") VALUES ('${w.partner}', '${TAG}', '${TAG}', now())`);
    for (const c of [w.company, w.other]) await sql(`INSERT INTO "Company" (id, "partnerId", name, timezone, settings, "updatedAt") VALUES ('${c}', '${w.partner}', '${TAG} ${c.slice(0, 4)}', 'Asia/Kolkata', '{"features":["etms"]}', now())`);
    await sql(`INSERT INTO "Branch" (id, "companyId", name, "updatedAt") VALUES ('${w.branch}', '${w.company}', 'North', now()), ('${w.branch2}', '${w.company}', 'South', now())`);
    for (const [u, c] of [[w.admin, w.company], [w.dispatcher, w.company], [w.outsider, w.company], [w.foreign, w.other]]) await sql(`INSERT INTO "User" (id, "companyId", name, "updatedAt") VALUES ('${u}', '${c}', 'User ${TAG}', now())`);
    await sql(`INSERT INTO "Poi" (id, "companyId", name, category, lat, lng, "updatedAt") VALUES ('${w.site}', '${w.company}', 'HQ', 'OFFICE', 13.05, 80.25, now()), ('${w.site2}', '${w.company}', 'Annex', 'OFFICE', 13.1, 80.3, now())`);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('restore: undo / redo round trip (new EDITED versions, audit restoredFrom); a changed stop set → 409 PLAN_RESTORE_CONFLICT', async () => {
    const p = await makePlan(2);
    const [a, b] = p.routes;
    // v2: move b's passenger onto route a.
    await plans.movePassenger(admin, p.plan, { expectedVersion: 1, bookingId: b.booking, toAssignmentId: a.route });
    expect(await routeOf(p.plan, b.booking)).toBe(a.route);
    // Undo = restore(1) → v3; redo = restore(2) → v4.
    const undo = await plans.restore(admin, p.plan, { version: 1, expectedVersion: 2 });
    expect(undo.plan.version).toBe(3);
    expect(await routeOf(p.plan, b.booking)).toBe(b.route);
    expect(undo.degraded).toBeNull();
    expect(undo.plan.stops.filter((s) => s.assignmentId === b.route).every((s) => s.etaS !== null)).toBe(true);
    const redo = await plans.restore(admin, p.plan, { version: 2, expectedVersion: 3 });
    expect(redo.plan.version).toBe(4);
    expect(await routeOf(p.plan, b.booking)).toBe(a.route);
    const rows = await prisma.routePlanVersion.findMany({ where: { planId: p.plan }, orderBy: { version: 'asc' } });
    expect(rows.map((r) => r.changeType)).toEqual(['OPTIMIZED', 'EDITED', 'EDITED', 'EDITED']);
    const audits = await prisma.auditLog.findMany({ where: { entity: 'RoutePlan', entityId: p.plan } });
    expect(audits.map((x) => (x.changes as { restoredFrom?: number }).restoredFrom).filter((x) => x !== undefined).sort()).toEqual([1, 2]);
    // Stale version → PLAN_STALE; a stop set changed since (a booking added) → conflict naming the new stops.
    expect((await errOf(plans.restore(admin, p.plan, { version: 1, expectedVersion: 3 }))).code).toBe('PLAN_STALE');
    const extra = await booking();
    const added = await plans.addBooking(admin, p.plan, { bookingId: extra.booking, expectedVersion: 4 });
    const conflict = await errOf(plans.restore(admin, p.plan, { version: 1, expectedVersion: added.plan.version }));
    expect(conflict).toMatchObject({ status: 409, code: 'PLAN_RESTORE_CONFLICT' });
    expect((conflict.body.addedStopIds as string[]).length).toBe(2);
    expect(await version(p.plan)).toBe(5);
  });

  it('recalculate re-times (RECALCULATED); a vehicle change returns the re-checked capacity violation', async () => {
    const p = await makePlan(1, { passengers: 3 });
    const r = await plans.recalculate(admin, p.plan, { expectedVersion: 1 });
    expect(r.degraded).toBeNull();
    expect(await prisma.routePlanVersion.findFirst({ where: { planId: p.plan, version: 2 }, select: { changeType: true } })).toEqual({ changeType: 'RECALCULATED' });
    const stops = await prisma.routePlanStop.findMany({ where: { planId: p.plan }, orderBy: { sequence: 'asc' }, select: { etaS: true } });
    expect(stops.map((s) => s.etaS)).toEqual([0, 360]); // from the route start: 0 s leg, then 60 s service + 300 s
    const small = await vehicle(2);
    const changed = await plans.updateAssignment(admin, p.plan, p.routes[0].route, { expectedVersion: 2, objectId: small });
    expect(changed.violations.map((v) => v.kind)).toContain('over_capacity');
  });

  it('add / remove a booking: scope refusals, consent, already on the plan, the 75-booking limit; removal re-closes the route', async () => {
    const p = await makePlan(1);
    let v = 1;
    const refuse = async (b: string, reason: string) => expect(await errOf(plans.addBooking(admin, p.plan, { bookingId: b, expectedVersion: v }))).toMatchObject({ status: 409, code: 'BOOKING_NOT_PLANNABLE', body: { reason } });
    await refuse((await booking({ site: w.site2 })).booking, 'other_site');
    await refuse((await booking({ day: '2026-12-04' })).booking, 'other_date');
    await refuse((await booking({ consent: false })).booking, 'consent_required');
    expect((await errOf(plans.addBooking(admin, p.plan, { bookingId: p.routes[0].booking, expectedVersion: v }))).code).toBe('BOOKING_ALREADY_ON_PLAN');
    // Another company's booking id: 404 (never a hint it exists).
    expect((await errOf(plans.addBooking(foreign, p.plan, { bookingId: p.routes[0].booking, expectedVersion: v }))).status).toBe(404);
    const ok = await booking();
    const added = await plans.addBooking(dispatcher, p.plan, { bookingId: ok.booking, expectedVersion: v });
    v = added.plan.version;
    const stops = added.plan.stops.filter((s) => s.bookingId === ok.booking);
    expect(stops.map((s) => [s.stopKind, s.assignmentId]).sort()).toEqual([['DROP', null], ['PICKUP', null]]);
    // Remove the original passenger: its route closes and is re-timed.
    const removed = await plans.removeBooking(admin, p.plan, p.routes[0].booking, v);
    v = removed.plan.version;
    expect(await prisma.routePlanStop.count({ where: { planId: p.plan, bookingId: p.routes[0].booking } })).toBe(0);
    expect(await prisma.transportBooking.findUniqueOrThrow({ where: { id: p.routes[0].booking }, select: { status: true } })).toEqual({ status: 'PENDING_ASSIGNMENT' });
    // 75-booking limit: fill the plan to 75 bookings (one stop each is enough to count), then one more is refused.
    await sql(`WITH b AS (
        INSERT INTO "TransportBooking" (id, "customerCompanyId", "profileId", source, "serviceDate", direction, "timeZone", "pickupLat", "pickupLng", "dropPoiId", "dropLat", "dropLng", "windowStart", "windowEnd", status, "updatedAt")
        SELECT gen_random_uuid(), '${w.company}', '${ok.profile}', 'ADHOC', '${DAY}', 'IN', 'Asia/Kolkata', 13.0, 80.2, '${w.site}', 13.05, 80.25, '${iso(0)}', '${iso(7200)}', 'CANCELLED', now() FROM generate_series(1, 74) RETURNING id)
      INSERT INTO "RoutePlanStop" (id, "planId", "companyId", ref, lat, lng, "stopKind", "customerCompanyId", "bookingId", "poiId", "updatedAt")
        SELECT gen_random_uuid(), '${p.plan}', '${w.company}', 'x-' || b.id, 13.05, 80.25, 'DROP', '${w.company}', b.id, '${w.site}', now() FROM b`);
    const over = await errOf(plans.addBooking(admin, p.plan, { bookingId: (await booking()).booking, expectedVersion: v }));
    expect(over).toMatchObject({ status: 422, code: 'LIMIT_EXCEEDED' });
    expect(String(over.body.message)).toContain('At most 75 bookings per plan (76 found)');
  });

  it('availability: a busy vehicle or driver blocks publish before anything is written (VEHICLE_BUSY / DRIVER_BUSY); the detail shows it', async () => {
    const p = await makePlan(1, { driver: true });
    const r = p.routes[0];
    const trip = await prisma.plannedTrip.create({ data: { companyId: w.company, objectId: r.vehicle, routeName: 'School run', corridorM: 200, plannedStart: new Date(startMs - 3_600_000), plannedEnd: new Date(startMs + 900_000), status: 'SCHEDULED', origin: 'ETMS' } });
    const busy = await errOf(plans.publish(admin, p.plan, { expectedVersion: 1 }, `${TAG}-busy-v`));
    expect(busy).toMatchObject({ status: 409, code: 'VEHICLE_BUSY', body: { routes: [{ assignmentId: r.route, code: 'VEHICLE_BUSY' }] } });
    expect((await plans.get(admin, p.plan)).publishCheck?.routeErrors?.map((e) => e.code)).toEqual(['VEHICLE_BUSY']);
    // The vehicle is free again; the driver is busy on another vehicle's trip.
    const other = await vehicle();
    await prisma.plannedTrip.update({ where: { id: trip.id }, data: { objectId: other, driverId: r.driver } });
    expect((await errOf(plans.publish(admin, p.plan, { expectedVersion: 1 }, `${TAG}-busy-d`))).code).toBe('DRIVER_BUSY');
    expect(await prisma.transportTrip.count({ where: { routePlanId: p.plan } })).toBe(0);
    expect(await prisma.transportChangeSet.count({ where: { idempotencyKey: { in: [`${TAG}-busy-v`, `${TAG}-busy-d`] } } })).toBe(0);
  });

  it('selected routes: review + hash; partial publish of 1 of 3 (plan stays PLANNED); published route immutable (edit, restore, optimiser load); stale hash; already published; replay; the rest; discard semantics', async () => {
    const p = await makePlan(3);
    const [a, b, c] = p.routes;
    // A selection needs a review hash.
    expect((await errOf(plans.publish(admin, p.plan, { expectedVersion: 1, assignmentIds: [a.route] }, `${TAG}-sel-0`))).code).toBe('PLAN_REVIEW_REQUIRED');
    const review = await plans.review(admin, p.plan, { assignmentIds: a.route });
    expect(review.routes.map((r) => r.assignmentId)).toEqual([a.route]);
    expect(review.routes[0].stops.map((s) => s.stopId)).toEqual([a.pickup, a.drop]);
    expect(review.routes[0]).toMatchObject({ seats: 4, passengers: 1, occupancy: 1 });
    expect(review.errors).toEqual([]);
    expect(review.manualChanges.baselineVersion).toBe(1);
    const keyA = `${TAG}-sel-a`;
    const bodyA = { expectedVersion: 1, assignmentIds: [a.route], reviewHash: review.reviewHash };
    const pubA = await plans.publish(admin, p.plan, bodyA, keyA);
    expect(pubA.value.trips.map((t) => t.assignmentId)).toEqual([a.route]);
    expect(await prisma.routePlan.findUniqueOrThrow({ where: { id: p.plan }, select: { status: true, version: true } })).toEqual({ status: 'PLANNED', version: 2 });
    const detail = await plans.get(admin, p.plan);
    expect(detail.assignments.find((x) => x.id === a.route)).toMatchObject({ published: true, transportTripId: pubA.value.trips[0].transportTripId });
    expect(detail.editable).toBe(true);
    // Idempotent replay of the same request (even though the plan moved on): same trips, nothing new.
    const replay = await plans.publish(admin, p.plan, bodyA, keyA);
    expect(replay.replay).toBe(true);
    expect(replay.value.trips).toEqual(pubA.value.trips);
    expect((await errOf(plans.publish(admin, p.plan, { ...bodyA, assignmentIds: [b.route] }, keyA))).code).toBe('IDEMPOTENCY_KEY_REUSED');
    // Immutable: edits of the published route are refused; restore leaves it as it is; the optimiser treats it as fixed.
    expect((await errOf(plans.movePassenger(admin, p.plan, { expectedVersion: 2, bookingId: a.booking, toAssignmentId: null }))).code).toBe('ROUTE_ALREADY_PUBLISHED');
    expect((await errOf(plans.movePassenger(admin, p.plan, { expectedVersion: 2, bookingId: b.booking, toAssignmentId: a.route }))).code).toBe('ROUTE_ALREADY_PUBLISHED');
    expect((await errOf(plans.updateAssignment(admin, p.plan, a.route, { expectedVersion: 2, locked: false }))).code).toBe('ROUTE_ALREADY_PUBLISHED');
    expect((await errOf(plans.pinBooking(admin, p.plan, a.booking, { expectedVersion: 2, pinned: true }))).code).toBe('ROUTE_ALREADY_PUBLISHED');
    expect((await errOf(plans.removeBooking(admin, p.plan, a.booking, 2))).code).toBe('ROUTE_ALREADY_PUBLISHED');
    expect((await errOf(plans.recalculate(admin, p.plan, { expectedVersion: 2, assignmentIds: [a.route] }))).code).toBe('ROUTE_ALREADY_PUBLISHED');
    await sql(`UPDATE "RoutePlan" SET status = 'OPTIMIZING' WHERE id = '${p.plan}'`);
    const inputs = await new PrismaPlanGateway(prisma as never).load({ id: 'job', companyId: w.company } as never, { planId: p.plan, planVersion: 2 } as never);
    await sql(`UPDATE "RoutePlan" SET status = 'PLANNED' WHERE id = '${p.plan}'`);
    expect(inputs.lockedAssignmentIds).toContain(a.route);
    expect(inputs.vehicles.map((x) => x.assignmentId)).not.toContain(a.route);
    expect(inputs.stops.map((s) => s.id)).not.toEqual(expect.arrayContaining([a.pickup]));
    // Move b's passenger to c (v3), then restore v1: b and c go back; a untouched.
    await plans.movePassenger(admin, p.plan, { expectedVersion: 2, bookingId: b.booking, toAssignmentId: c.route });
    const restored = await plans.restore(admin, p.plan, { version: 1, expectedVersion: 3 });
    expect(await routeOf(p.plan, b.booking)).toBe(b.route);
    expect(await routeOf(p.plan, a.booking)).toBe(a.route);
    // Review hash: an edit of the selected route after review → 409 PLAN_REVIEW_STALE with the fresh hash, which works.
    const rb = await plans.review(admin, p.plan, { assignmentIds: b.route });
    const recalc = await plans.recalculate(admin, p.plan, { expectedVersion: restored.plan.version, assignmentIds: [b.route] });
    const stale = await errOf(plans.publish(admin, p.plan, { expectedVersion: recalc.plan.version, assignmentIds: [b.route], reviewHash: rb.reviewHash }, `${TAG}-sel-b1`));
    expect(stale.code).toBe('PLAN_REVIEW_STALE');
    expect(stale.body.reviewHash).not.toBe(rb.reviewHash);
    const pubB = await plans.publish(admin, p.plan, { expectedVersion: recalc.plan.version, assignmentIds: [b.route], reviewHash: stale.body.reviewHash as string }, `${TAG}-sel-b2`);
    expect(pubB.value.trips.map((t) => t.assignmentId)).toEqual([b.route]);
    // Already published → 409 ROUTE_ALREADY_PUBLISHED (from review and publish alike).
    expect((await errOf(plans.review(admin, p.plan, { assignmentIds: a.route }))).code).toBe('ROUTE_ALREADY_PUBLISHED');
    expect((await errOf(plans.publish(admin, p.plan, { expectedVersion: pubB.value.version, assignmentIds: [a.route], reviewHash: 'r1-x' }, `${TAG}-sel-a2`))).code).toBe('ROUTE_ALREADY_PUBLISHED');
    // The rest (whole-plan publish, no hash: the existing client path) → PUBLISHED.
    const rest = await plans.publish(admin, p.plan, { expectedVersion: pubB.value.version }, `${TAG}-sel-rest`);
    expect(rest.value.trips.map((t) => t.assignmentId)).toEqual([c.route]);
    expect(await prisma.routePlan.findUniqueOrThrow({ where: { id: p.plan }, select: { status: true } })).toEqual({ status: 'PUBLISHED' });
    expect(await prisma.transportTrip.count({ where: { routePlanId: p.plan } })).toBe(3);
    const audits = (await prisma.auditLog.findMany({ where: { entity: 'RoutePlan', entityId: p.plan } })).filter((x) => (x.changes as { published?: boolean }).published);
    expect(audits.map((x) => (x.changes as { partial?: boolean }).partial)).toEqual([true, true, true]);

    // Discard after a partial publish: only the remainder is dropped; the plan closes as PUBLISHED, its trip stands.
    const q = await makePlan(2);
    const rq = await plans.review(admin, q.plan, { assignmentIds: q.routes[0].route });
    await plans.publish(admin, q.plan, { expectedVersion: 1, assignmentIds: [q.routes[0].route], reviewHash: rq.reviewHash }, `${TAG}-disc`);
    const discarded = await plans.discard(admin, q.plan, { expectedVersion: 2 });
    expect(discarded).toMatchObject({ status: 'PUBLISHED', editable: false });
    expect(await prisma.transportTrip.count({ where: { routePlanId: q.plan } })).toBe(1);
    expect(await prisma.transportBooking.findUniqueOrThrow({ where: { id: q.routes[1].booking }, select: { status: true } })).toEqual({ status: 'PENDING_ASSIGNMENT' });
  });

  it('concurrent publishes of overlapping selections: exactly one wins, the other gets a clean 409; one trip per route', async () => {
    const p = await makePlan(2);
    const [a, b] = p.routes;
    const r1 = await plans.review(admin, p.plan, { assignmentIds: a.route });
    const r2 = await plans.review(admin, p.plan, { assignmentIds: `${a.route},${b.route}` });
    const res = await Promise.all([
      errOf(plans.publish(admin, p.plan, { expectedVersion: 1, assignmentIds: [a.route], reviewHash: r1.reviewHash }, `${TAG}-c1`)),
      errOf(plans.publish(admin, p.plan, { expectedVersion: 1, assignmentIds: [a.route, b.route], reviewHash: r2.reviewHash }, `${TAG}-c2`)),
    ]);
    expect(res.filter((x) => x.code === 'OK')).toHaveLength(1);
    const loser = res.find((x) => x.code !== 'OK')!;
    expect(loser.status).toBe(409);
    expect(['ROUTE_ALREADY_PUBLISHED', 'PLAN_STALE']).toContain(loser.code);
    const trips = await prisma.transportTrip.findMany({ where: { routePlanId: p.plan }, select: { routeAssignmentId: true } });
    expect(new Set(trips.map((t) => t.routeAssignmentId)).size).toBe(trips.length);
    expect(await prisma.routePlanVersion.count({ where: { planId: p.plan, changeType: 'PUBLISHED' } })).toBe(1);
  });

  it('consent withdrawn after review: publish still refused (CONSENT_REQUIRED), nothing written', async () => {
    const p = await makePlan(1);
    const r = await plans.review(admin, p.plan, { assignmentIds: p.routes[0].route });
    await sql(`INSERT INTO "EmployeeTransportConsent" (id, "companyId", "profileId", purpose, "noticeVersion", granted, channel, "occurredAt") VALUES (gen_random_uuid(), '${w.company}', '${p.routes[0].profile}', 'TRANSPORT_PROFILE', 'v1', false, 'WEB', now() + interval '1 second')`);
    const e = await errOf(plans.publish(admin, p.plan, { expectedVersion: 1, assignmentIds: [p.routes[0].route], reviewHash: r.reviewHash }, `${TAG}-consent`));
    expect(e).toMatchObject({ status: 409, code: 'PLAN_NOT_PUBLISHABLE' });
    expect((e.body.routes as { code: string }[]).map((x) => x.code)).toContain('CONSENT_REQUIRED');
    expect(await prisma.transportTrip.count({ where: { routePlanId: p.plan } })).toBe(0);
  });

  it('isolation: another company and another branch get 404 on every new route; review hides another branch nothing it may not see', async () => {
    const p = await makePlan(1);
    const r = p.routes[0];
    for (const ctx of [foreign, outsider]) {
      const extra = (await booking()).booking;
      const calls: (() => Promise<unknown>)[] = [
        () => plans.review(ctx, p.plan, {}),
        () => plans.restore(ctx, p.plan, { version: 1, expectedVersion: 1 }),
        () => plans.recalculate(ctx, p.plan, { expectedVersion: 1 }),
        () => plans.addBooking(ctx, p.plan, { bookingId: extra, expectedVersion: 1 }),
        () => plans.removeBooking(ctx, p.plan, r.booking, 1),
        () => plans.pinBooking(ctx, p.plan, r.booking, { pinned: true, expectedVersion: 1 }),
        () => plans.publish(ctx, p.plan, { expectedVersion: 1, assignmentIds: [r.route], reviewHash: 'r1-x' }, `${TAG}-iso-${randomUUID()}`),
      ];
      for (const c of calls) expect((await errOf(c())).status).toBe(404);
    }
    expect(await version(p.plan)).toBe(1);
    // The plan's own branch dispatcher: the review at 4 decimals (consented point), names "First L." only.
    const doc = await plans.review(dispatcher, p.plan, {});
    const pickup = doc.routes[0].stops.find((s) => s.stopKind === 'PICKUP')!;
    expect(pickup.lat).not.toBeNull();
    expect(String(pickup.lat).split('.')[1]?.length ?? 0).toBeLessThanOrEqual(4);
    expect(pickup.profileId).toBe(r.profile);
  });
});

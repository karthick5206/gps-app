/**
 * Regressions for the E4 end-to-end round fixes (T1 / T2 reports, 2026-11-11) on a real, freshly migrated PostgreSQL:
 * - T2-D5: a branch-scoped (ASSIGNED) dispatcher with exactly one branch creates a plan without naming the branch (the
 *   web never sent one); with several branches the branch is still required; capabilities list the caller's own
 *   branches only (ids and names).
 * - T1-D5: the same driver on two routes of one plan is refused at edit time (409 DRIVER_DUPLICATE, like
 *   VEHICLE_DUPLICATE) instead of at publish.
 * - T2-L3: a stale edit touching a pinned stop answers PLAN_STALE (the version is checked before the pin).
 * - T2-L4: the plan detail carries the stored solver weights (`options.weights`) so re-optimise can prefill them.
 *
 * Not part of the normal run (testRegex is *.spec.ts). Against a scratch `veetrax_*_test` database with every migration
 * applied (`prisma migrate deploy`), dropped afterwards:
 *   CI=true ETMS_DB_TEST_URL=postgresql://…@localhost:5432/veetrax_fx_plans_test \
 *     npx jest --testRegex 'e4-e2e-fixes\.db-test\.ts$' --runInBand
 * Synthetic data only (tag fx-…).
 */
jest.mock('@nestjs/mapped-types', () => ({ PartialType: (c: new () => object) => class extends c {} }));

import { HttpException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { PlannedTripsService } from '../planned-trips/planned-trips.service';
import { RoutingCapabilitiesService } from '../routing-jobs/routing-capabilities.controller';
import { dbDescribe } from '../test/scratch-db';
import { DispatchService } from './dispatch/dispatch.service';
import { TripLiveService } from './dispatch/trip-live';
import { RoutePlanCreateService } from './planning/plan-create';
import { RoutePlansService } from './planning/plans.service';

const URL_ = process.env.ETMS_DB_TEST_URL ?? '';
const { d, dbName } = dbDescribe(URL_);
const TAG = `fx-${Date.now().toString(36)}`;
const DAY = '2026-12-03';
const START = '2026-12-03T02:00:00Z';

const errOf = (p: Promise<unknown>) =>
  p.then(
    () => ({ status: 200, code: 'OK', message: '' }),
    (e: unknown) => {
      if (!(e instanceof HttpException)) return { status: 0, code: `unexpected: ${String(e)}`, message: '' };
      const r = e.getResponse() as { code?: string; message?: string };
      return { status: e.getStatus(), code: r.code ?? `HTTP_${e.getStatus()}`, message: String(r.message ?? '') };
    },
  );

d(`E4 E2E fixes on ${dbName}`, () => {
  jest.setTimeout(120_000);
  const prisma = new PrismaClient({ datasourceUrl: URL_ });
  const redis = { client: { get: async () => null, mget: async (...k: string[]) => k.map(() => null), set: async () => 'OK', eval: async () => Promise.reject(new Error('no valkey')), publish: async () => 1, xadd: async () => '1-0', zrangebyscore: async () => [], exists: async () => 0 } };
  const audit = new AuditService(prisma as never);
  const plannedTrips = new PlannedTripsService(prisma as never, audit, { invalidate: async () => undefined } as never);
  const live = new TripLiveService(prisma as never, redis as never, plannedTrips);
  const routing = { enabled: false, route: async () => null, routeVia: async () => null, routeStatus: async () => 'UNAVAILABLE' };
  const dispatch = new DispatchService(prisma as never, audit, routing as never, live, redis as never);
  const provider = { routeVia: async () => ({ ok: false, degraded: 'ENGINE_UNREACHABLE', message: 'stopped' }), health: async () => ({ reachable: false, checkedAt: '', degraded: 'ENGINE_UNREACHABLE' }), capabilities: async () => ({ ok: false, degraded: 'ENGINE_UNREACHABLE', message: 'stopped' }) };
  const plans = new RoutePlansService(prisma as never, audit, dispatch, provider as never);
  const creator = new RoutePlanCreateService(prisma as never, audit, plans);
  const caps = new RoutingCapabilitiesService(provider as never, { health: async () => false } as never, redis as never, prisma as never);

  const id = () => randomUUID();
  const w = {
    partner: id(),
    company: id(),
    other: id(),
    north: id(),
    south: id(),
    east: id(),
    otherBranch: id(),
    site: id(),
    users: { north: id(), multi: id(), admin: id() },
    vehicles: [id(), id(), id()],
    drivers: [id(), id()],
    profiles: [id(), id(), id()],
    bookings: [id(), id(), id()],
  };
  const perms = { etms_planning: ['view', 'create', 'edit', 'delete', 'command'], etms_dispatch: ['view', 'edit', 'command'], objects: ['view'], drivers: ['view'] };
  const ctxOf = (userId: string, dataScope: 'COMPANY' | 'ASSIGNED', branchIds: string[]) =>
    ({ userId, companyId: w.company, homeCompanyId: w.company, isSuperAdmin: false, isCompanyAdmin: false, permissions: perms, dataScope, branchIds, objectIds: [], features: ['etms'], agreements: [], ip: null }) as never;
  const north = ctxOf(w.users.north, 'ASSIGNED', [w.north]);
  const multi = ctxOf(w.users.multi, 'ASSIGNED', [w.north, w.south]);
  const admin = ctxOf(w.users.admin, 'COMPANY', []);
  const sql = (s: string) => prisma.$executeRawUnsafe(s);

  beforeAll(async () => {
    await sql(`INSERT INTO "Partner" (id, name, slug, "updatedAt") VALUES ('${w.partner}', '${TAG}', '${TAG}', now())`);
    for (const [c, n] of [[w.company, 'corp'], [w.other, 'other']]) await sql(`INSERT INTO "Company" (id, "partnerId", name, timezone, settings, "updatedAt") VALUES ('${c}', '${w.partner}', '${TAG} ${n}', 'Asia/Kolkata', '{"features":["etms"]}', now())`);
    for (const [b, n, c] of [[w.north, 'North', w.company], [w.south, 'South', w.company], [w.east, 'East', w.company], [w.otherBranch, 'Elsewhere', w.other]]) await sql(`INSERT INTO "Branch" (id, "companyId", name, "updatedAt") VALUES ('${b}', '${c}', '${n}', now())`);
    for (const u of Object.values(w.users)) await sql(`INSERT INTO "User" (id, "companyId", name, "updatedAt") VALUES ('${u}', '${w.company}', 'User ${TAG}', now())`);
    await sql(`INSERT INTO "Poi" (id, "companyId", name, category, lat, lng, "updatedAt") VALUES ('${w.site}', '${w.company}', 'HQ', 'OFFICE', 13.05, 80.25, now())`);
    for (const [i, v] of w.vehicles.entries()) {
      await sql(`INSERT INTO "TrackedObject" (id, "companyId", "branchId", name, "isActive", "updatedAt") VALUES ('${v}', '${w.company}', '${w.north}', 'Van ${i + 1}', true, now())`);
      await sql(`INSERT INTO "TransportVehicleProfile" ("objectId", "companyId", seats, "updatedAt") VALUES ('${v}', '${w.company}', 4, now())`);
    }
    for (const [i, dr] of w.drivers.entries()) await sql(`INSERT INTO "Driver" (id, "companyId", "branchId", name, "isActive", "updatedAt") VALUES ('${dr}', '${w.company}', '${w.north}', 'Driver ${i + 1}', true, now())`);
    // Passengers 0 and 1 in North, 2 in South; all consented, all booked IN to the site on DAY.
    for (const [i, p] of w.profiles.entries()) {
      const br = i < 2 ? w.north : w.south;
      await sql(`INSERT INTO "EmployeeTransportProfile" (id, "companyId", "branchId", "employeeCode", "displayName", "updatedAt") VALUES ('${p}', '${w.company}', '${br}', 'FX${i}', 'Synthetic ${i}', now())`);
      await sql(`INSERT INTO "EmployeeTransportConsent" (id, "companyId", "profileId", purpose, "noticeVersion", granted, channel) VALUES (gen_random_uuid(), '${w.company}', '${p}', 'TRANSPORT_PROFILE', 'v1', true, 'WEB')`);
      await sql(`INSERT INTO "TransportBooking" (id, "customerCompanyId", "profileId", source, "serviceDate", direction, "timeZone", "pickupLat", "pickupLng", "pickupLabel", "dropPoiId", "dropLat", "dropLng", "dropLabel", "windowStart", "windowEnd", status, "updatedAt")
        VALUES ('${w.bookings[i]}', '${w.company}', '${p}', 'ADHOC', '${DAY}', 'IN', 'Asia/Kolkata', ${13.06 + i * 0.004}, 80.24, 'Home', '${w.site}', 13.05, 80.25, 'HQ', '2026-12-03T03:30:00Z', '2026-12-03T04:00:00Z', 'PENDING_ASSIGNMENT', now())`);
    }
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  const createBody = (extra: Record<string, unknown> = {}) => ({ name: `Plan ${TAG}`, planDate: DAY, planStartAt: START, direction: 'IN' as const, sitePoiId: w.site, objectIds: [w.vehicles[0], w.vehicles[1]], ...extra });

  it('T2-D5 a dispatcher ASSIGNED to exactly one branch creates a plan without naming it: the plan is that branch’s, with only its bookings', async () => {
    const r = await creator.create(north, createBody(), `${TAG}-d5-one`);
    expect(r.replay).toBe(false);
    expect(r.value.branchId).toBe(w.north);
    const planned = new Set(r.value.stops.map((s) => s.bookingId));
    expect([...planned].sort()).toEqual([w.bookings[0], w.bookings[1]].sort());
    // The South passenger is invisible to a North dispatcher: neither planned nor listed.
    expect(r.value.skippedBookings.map((s) => s.bookingId)).not.toContain(w.bookings[2]);
    expect((await prisma.routePlan.findUniqueOrThrow({ where: { id: r.value.id } })).branchId).toBe(w.north);
    // Same key, same body: a replay of that plan.
    const again = await creator.create(north, createBody(), `${TAG}-d5-one`);
    expect(again).toMatchObject({ replay: true, value: { id: r.value.id } });
  });

  it('T2-D5 several branches and none named: still 400 "Choose one of your branches"; a branch outside the caller’s is refused; a named own branch works', async () => {
    expect(await errOf(creator.create(multi, createBody(), `${TAG}-d5-multi-1`))).toMatchObject({ status: 400, message: 'Choose one of your branches for the plan' });
    expect(await errOf(creator.create(north, createBody({ branchId: w.south }), `${TAG}-d5-multi-2`))).toMatchObject({ status: 400 });
    const r = await creator.create(multi, createBody({ branchId: w.south }), `${TAG}-d5-multi-3`);
    expect(r.value.branchId).toBe(w.south);
    // A whole-company role still creates a company-wide plan without a branch.
    const c = await creator.create(admin, createBody(), `${TAG}-d5-admin`);
    expect(c.value.branchId).toBeNull();
  });

  it('T2-D5 GET /routing/capabilities lists the caller’s own branches (ids and names) and nothing else', async () => {
    const n = await caps.get(north);
    expect(n.access.branches).toEqual([{ id: w.north, name: 'North' }]);
    const m = await caps.get(multi);
    expect(m.access.branches).toEqual([
      { id: w.north, name: 'North' },
      { id: w.south, name: 'South' },
    ]);
    // A forged branch id of another company in the context never comes back.
    const forged = await caps.get(ctxOf(w.users.multi, 'ASSIGNED', [w.north, w.otherBranch]));
    expect(forged.access.branches).toEqual([{ id: w.north, name: 'North' }]);
    // Whole-company roles need no branch: none listed.
    expect((await caps.get(admin)).access.branches).toEqual([]);
  });

  /** A PLANNED company-wide plan with two routes (route 0 carries booking 0, route 1 booking 1). */
  async function plannedPlan(tag: string) {
    const plan = id();
    const routes = [id(), id()];
    await sql(`INSERT INTO "RoutePlan" (id, "companyId", "branchId", name, "planDate", "planStartAt", status, direction, "sitePoiId", options, "updatedAt") VALUES ('${plan}', '${w.company}', NULL, '${tag} ${TAG}', '${DAY}', '${START}', 'PLANNED', 'IN', '${w.site}', '{"weights":{"vehicle":7200,"distance":0,"time":1,"routeDuration":60}}', now())`);
    const stops: string[][] = [];
    for (const [k, r] of routes.entries()) {
      await sql(`INSERT INTO "RouteAssignment" (id, "planId", "companyId", "objectId", "vehicleLabel", seq, capacity, "distanceM", "durationS", "startS", "endS", "updatedAt") VALUES ('${r}', '${plan}', '${w.company}', '${w.vehicles[k]}', 'Van ${k + 1}', ${k}, 4, 9000, 2400, 0, 2400, now())`);
      const p = id();
      const dr = id();
      await sql(`INSERT INTO "RoutePlanStop" (id, "planId", "companyId", "assignmentId", ref, lat, lng, demand, "serviceS", sequence, "etaS", "stopKind", "customerCompanyId", "bookingId", "profileId", "updatedAt")
        VALUES ('${p}', '${plan}', '${w.company}', '${r}', 'p${k}', ${13.06 + k * 0.004}, 80.24, 1, 60, 0, 600, 'PICKUP', '${w.company}', '${w.bookings[k]}', '${w.profiles[k]}', now())`);
      await sql(`INSERT INTO "RoutePlanStop" (id, "planId", "companyId", "assignmentId", ref, lat, lng, demand, sequence, "etaS", "stopKind", "customerCompanyId", "bookingId", "poiId", "updatedAt")
        VALUES ('${dr}', '${plan}', '${w.company}', '${r}', 'd${k}', 13.05, 80.25, 1, 1, 2400, 'DROP', '${w.company}', '${w.bookings[k]}', '${w.site}', now())`);
      stops.push([p, dr]);
    }
    return { plan, routes, stops };
  }

  it('T1-D5 the same driver on a second route of the plan → 409 DRIVER_DUPLICATE (nothing written); the same route again, another driver or none is fine', async () => {
    const g = await plannedPlan('d5');
    const first = await plans.updateAssignment(admin, g.plan, g.routes[0], { expectedVersion: 1, driverId: w.drivers[0] });
    expect(first.plan.version).toBe(2);
    expect(await errOf(plans.updateAssignment(admin, g.plan, g.routes[1], { expectedVersion: 2, driverId: w.drivers[0] }))).toMatchObject({ status: 409, code: 'DRIVER_DUPLICATE' });
    const row = await prisma.routeAssignment.findUniqueOrThrow({ where: { id: g.routes[1] } });
    expect(row.driverId).toBeNull();
    expect((await prisma.routePlan.findUniqueOrThrow({ where: { id: g.plan } })).version).toBe(2);
    // Re-setting the same driver on the same route, another driver, and clearing all work.
    expect((await plans.updateAssignment(admin, g.plan, g.routes[0], { expectedVersion: 2, driverId: w.drivers[0] })).plan.version).toBe(3);
    expect((await plans.updateAssignment(admin, g.plan, g.routes[1], { expectedVersion: 3, driverId: w.drivers[1] })).plan.version).toBe(4);
    expect((await plans.updateAssignment(admin, g.plan, g.routes[0], { expectedVersion: 4, driverId: null })).plan.version).toBe(5);
    expect((await plans.updateAssignment(admin, g.plan, g.routes[1], { expectedVersion: 5, driverId: w.drivers[0] })).plan.version).toBe(6);
  });

  it('T2-L3 a stale edit that touches a pinned stop answers PLAN_STALE, not STOP_PINNED', async () => {
    const g = await plannedPlan('l3');
    // Tab A pins route 0's pickup (v1 → v2); tab B still holds v1 and reorders / moves that stop.
    await plans.updateStop(admin, g.plan, g.stops[0][0], { expectedVersion: 1, pinned: true });
    expect(await errOf(plans.resequence(admin, g.plan, { expectedVersion: 1, assignments: [{ assignmentId: g.routes[0], stopIds: [g.stops[0][1], g.stops[0][0]] }] }))).toMatchObject({ status: 409, code: 'PLAN_STALE' });
    expect(await errOf(plans.movePassenger(admin, g.plan, { expectedVersion: 1, bookingId: w.bookings[0], toAssignmentId: g.routes[1] }))).toMatchObject({ status: 409, code: 'PLAN_STALE' });
    // With the current version the pin still protects the stop.
    expect(await errOf(plans.movePassenger(admin, g.plan, { expectedVersion: 2, bookingId: w.bookings[0], toAssignmentId: g.routes[1] }))).toMatchObject({ status: 409, code: 'STOP_PINNED' });
  });

  it('T2-L4 the plan detail carries the stored solver weights (options.weights), so re-optimise can prefill them', async () => {
    const g = await plannedPlan('l4');
    const p = await plans.get(admin, g.plan);
    expect(p.weights).toEqual({ vehicle: 7200, distance: 0, time: 1, routeDuration: 60 });
    // A plan never optimised has none (never invented).
    const fresh = await creator.create(admin, createBody({ name: `Fresh ${TAG}` }), `${TAG}-l4-fresh`);
    expect(fresh.value.weights).toBeNull();
  });
});

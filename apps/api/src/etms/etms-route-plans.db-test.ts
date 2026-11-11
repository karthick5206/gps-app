/**
 * ETMS E4 route plans publish (doc 17 §7 P9) on a real, freshly migrated PostgreSQL scratch database. Proves that
 * publish goes through the E3 publish transaction (advisory locks, FOR UPDATE, constraints, ledger, Idempotency-Key)
 * and leaves ordinary E3 trips, and the P9 gate: manual dispatch works with the optimiser / road engine stopped.
 *
 * Not part of the normal run (testRegex is *.spec.ts). Against a scratch `veetrax_e4f_*_test` database with every
 * migration applied (`prisma migrate deploy`), dropped afterwards:
 *   CI=true ETMS_DB_TEST_URL=postgresql://…@localhost:5432/veetrax_e4f_plans_test \
 *     npx jest --testRegex 'etms-route-plans\.db-test\.ts$' --runInBand
 * Synthetic data only (tag e4f-…). Never veetracer / veetrax_assess (scratch-db guard).
 */
jest.mock('@nestjs/mapped-types', () => ({ PartialType: (c: new () => object) => class extends c {} }));

import { HttpException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { PlannedTripsService } from '../planned-trips/planned-trips.service';
import { dbDescribe } from '../test/scratch-db';
import { DispatchService } from './dispatch/dispatch.service';
import { TripLiveService } from './dispatch/trip-live';
import { TripsService } from './dispatch/trips.service';
import { RoutePlansService } from './planning/plans.service';

const URL_ = process.env.ETMS_DB_TEST_URL ?? '';
const { d, dbName } = dbDescribe(URL_);
const TAG = `e4f-${Date.now().toString(36)}`;
const DAY = '2026-12-01';
const START = '2026-12-01T02:00:00Z'; // 07:30 IST

const codeOf = (p: Promise<unknown>) => p.then(() => 'OK', (e: unknown) => (e instanceof HttpException ? ((e.getResponse() as { code?: string }).code ?? `HTTP_${e.getStatus()}`) : `unexpected: ${String(e)}`));

d(`ETMS E4 route plans publish on ${dbName}`, () => {
  jest.setTimeout(300_000);
  const prisma = new PrismaClient({ datasourceUrl: URL_ });
  const redis = { client: { get: async () => null, mget: async (...k: string[]) => k.map(() => null), set: async () => 'OK', eval: async () => Promise.reject(new Error('no valkey')), publish: async () => 1, xadd: async () => '1-0' } };
  const audit = new AuditService(prisma as never);
  const plannedTrips = new PlannedTripsService(prisma as never, audit, { invalidate: async () => undefined } as never);
  const live = new TripLiveService(prisma as never, redis as never, plannedTrips);
  // Road engine and optimiser stopped: RoutingService off, RoutingProvider unavailable (doc 17 P9 gate).
  const routing = { enabled: false, route: async () => null, routeVia: async () => null, routeStatus: async () => 'UNAVAILABLE' };
  const dispatch = new DispatchService(prisma as never, audit, routing as never, live, redis as never);
  const trips = new TripsService(prisma as never, audit, plannedTrips, dispatch, live);
  const provider = { routeVia: async () => ({ ok: false, degraded: 'ENGINE_UNREACHABLE', message: 'stopped' }) };
  const plans = new RoutePlansService(prisma as never, audit, dispatch, provider as never);

  const id = () => randomUUID();
  const w = { partner: id(), company: id(), branch: id(), site: id(), user: id(), plan: id(), vehicles: [id(), id(), id(), id()], routes: [id(), id(), id()], profiles: [id(), id(), id(), id(), id(), id(), id()], bookings: [] as string[] };
  const ctx = { userId: w.user, companyId: w.company, homeCompanyId: w.company, isSuperAdmin: false, isCompanyAdmin: false, permissions: { etms_planning: ['view', 'edit', 'command'], etms_dispatch: ['view', 'edit', 'command'] }, dataScope: 'COMPANY', branchIds: [], objectIds: [], features: ['etms'], agreements: [], ip: null } as never;
  const sql = (s: string) => prisma.$executeRawUnsafe(s);

  beforeAll(async () => {
    await sql(`INSERT INTO "Partner" (id, name, slug, "updatedAt") VALUES ('${w.partner}', '${TAG}', '${TAG}', now())`);
    await sql(`INSERT INTO "Company" (id, "partnerId", name, timezone, settings, "updatedAt") VALUES ('${w.company}', '${w.partner}', '${TAG} corp', 'Asia/Kolkata', '{"features":["etms"]}', now())`);
    await sql(`INSERT INTO "Branch" (id, "companyId", name, "updatedAt") VALUES ('${w.branch}', '${w.company}', 'North', now())`);
    await sql(`INSERT INTO "User" (id, "companyId", name, "updatedAt") VALUES ('${w.user}', '${w.company}', 'Dispatcher ${TAG}', now())`);
    await sql(`INSERT INTO "Poi" (id, "companyId", name, category, lat, lng, "updatedAt") VALUES ('${w.site}', '${w.company}', 'HQ', 'OFFICE', 13.05, 80.25, now())`);
    for (const [i, v] of w.vehicles.entries()) {
      await sql(`INSERT INTO "TrackedObject" (id, "companyId", "branchId", name, "isActive", "updatedAt") VALUES ('${v}', '${w.company}', '${w.branch}', 'Van ${i + 1}', true, now())`);
      await sql(`INSERT INTO "TransportVehicleProfile" ("objectId", "companyId", seats, "updatedAt") VALUES ('${v}', '${w.company}', 4, now())`);
    }
    for (const [i, p] of w.profiles.entries()) {
      const lat = 13.06 + i * 0.004;
      await sql(`INSERT INTO "EmployeeTransportProfile" (id, "companyId", "branchId", "employeeCode", "displayName", "updatedAt") VALUES ('${p}', '${w.company}', '${w.branch}', 'E${i}', 'Synthetic ${i}', now())`);
      await sql(`INSERT INTO "EmployeeTransportConsent" (id, "companyId", "profileId", purpose, "noticeVersion", granted, channel) VALUES (gen_random_uuid(), '${w.company}', '${p}', 'TRANSPORT_PROFILE', 'v1', true, 'WEB')`);
      const b = id();
      w.bookings.push(b);
      await sql(`INSERT INTO "TransportBooking" (id, "customerCompanyId", "profileId", source, "serviceDate", direction, "timeZone", "pickupLat", "pickupLng", "pickupLabel", "dropPoiId", "dropLat", "dropLng", "dropLabel", "windowStart", "windowEnd", status, "updatedAt")
        VALUES ('${b}', '${w.company}', '${p}', 'ADHOC', '${DAY}', 'IN', 'Asia/Kolkata', ${lat}, 80.24, 'Home', '${w.site}', 13.05, 80.25, 'HQ', '2026-12-01T02:00:00Z', '2026-12-01T03:30:00Z', 'PENDING_ASSIGNMENT', now())`);
    }
    // A PLANNED plan with 3 routes: route k carries bookings 2k and 2k+1 (route 3 only booking 4); booking 5 stays unassigned, 6 off-plan.
    await sql(`INSERT INTO "RoutePlan" (id, "companyId", "branchId", name, "planDate", "planStartAt", status, direction, "sitePoiId", "updatedAt") VALUES ('${w.plan}', '${w.company}', '${w.branch}', 'Login ${TAG}', '${DAY}', '${START}', 'PLANNED', 'IN', '${w.site}', now())`);
    const carried = [[0, 1], [2, 3], [4]];
    for (const [k, r] of w.routes.entries()) {
      await sql(`INSERT INTO "RouteAssignment" (id, "planId", "companyId", "objectId", "vehicleLabel", seq, capacity, "distanceM", "durationS", "startS", "endS", "updatedAt") VALUES ('${r}', '${w.plan}', '${w.company}', '${w.vehicles[k]}', 'Van ${k + 1}', ${k}, 4, 9000, 2400, 0, 2400, now())`);
      let seq = 0;
      for (const i of carried[k]) {
        await sql(`INSERT INTO "RoutePlanStop" (id, "planId", "companyId", "assignmentId", ref, lat, lng, demand, "serviceS", sequence, "etaS", "stopKind", "customerCompanyId", "bookingId", "profileId", "updatedAt")
          VALUES (gen_random_uuid(), '${w.plan}', '${w.company}', '${r}', 'p${i}', ${13.06 + i * 0.004}, 80.24, 1, 60, ${seq}, ${600 + seq * 600}, 'PICKUP', '${w.company}', '${w.bookings[i]}', '${w.profiles[i]}', now())`);
        seq++;
      }
      for (const i of carried[k]) {
        await sql(`INSERT INTO "RoutePlanStop" (id, "planId", "companyId", "assignmentId", ref, lat, lng, demand, sequence, "etaS", "stopKind", "customerCompanyId", "bookingId", "poiId", "updatedAt")
          VALUES (gen_random_uuid(), '${w.plan}', '${w.company}', '${r}', 'd${i}', 13.05, 80.25, 1, ${seq}, 2400, 'DROP', '${w.company}', '${w.bookings[i]}', '${w.site}', now())`);
        seq++;
      }
    }
    await sql(`INSERT INTO "RoutePlanStop" (id, "planId", "companyId", ref, lat, lng, demand, "stopKind", "customerCompanyId", "bookingId", "profileId", "unassignedReason", "updatedAt")
      VALUES (gen_random_uuid(), '${w.plan}', '${w.company}', 'p5', 13.08, 80.24, 1, 'PICKUP', '${w.company}', '${w.bookings[5]}', '${w.profiles[5]}', 'demand_exceeds_vehicle_capacity', now())`);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('a plan with 3 routes publishes 3 ordinary E3 trips (PlannedTrip origin ETMS) with the right passengers; the same key replays', async () => {
    const key = `${TAG}-publish-1`;
    const r = await plans.publish(ctx, w.plan, { expectedVersion: 1 }, key);
    expect(r.replay).toBe(false);
    expect(r.value.trips).toHaveLength(3);
    expect(r.value.version).toBe(2);
    const headers = await prisma.transportTrip.findMany({ where: { routePlanId: w.plan }, include: { plannedTrip: { include: { stops: { orderBy: { seq: 'asc' } } } }, passengers: { include: { booking: true } } } });
    expect(headers).toHaveLength(3);
    const byRoute = new Map(headers.map((h) => [h.routeAssignmentId, h]));
    const expected = [[0, 1], [2, 3], [4]];
    for (const [k, rid] of w.routes.entries()) {
      const h = byRoute.get(rid)!;
      expect(h.plannedTrip).toMatchObject({ origin: 'ETMS', objectId: w.vehicles[k], status: 'SCHEDULED', companyId: w.company });
      expect(h.passengers.map((p) => p.bookingId).sort()).toEqual(expected[k].map((i) => w.bookings[i]).sort());
      expect(h.occupiedSeats).toBe(expected[k].length);
      // Personal pickups owned by their passenger, one merged site stop at the end.
      const stops = h.plannedTrip!.stops;
      expect(stops.map((s) => s.poiId)).toEqual([...expected[k].map(() => null), w.site]);
      expect(stops.slice(0, -1).map((s) => s.profileId)).toEqual(expected[k].map((i) => w.profiles[i]));
      expect(stops[0].plannedArrival.toISOString()).toBe('2026-12-01T02:10:00.000Z');
      expect(h.passengers.every((p) => p.dropSeq === stops.length - 1)).toBe(true);
    }
    const assigned = await prisma.transportBooking.findMany({ where: { id: { in: w.bookings } }, select: { id: true, status: true } });
    expect(assigned.filter((b) => b.status === 'ASSIGNED').map((b) => b.id).sort()).toEqual(w.bookings.slice(0, 5).sort());
    // The plan is a read-only proposal with links; the ledger is E3's.
    expect(await prisma.routePlan.findUnique({ where: { id: w.plan } })).toMatchObject({ status: 'PUBLISHED', version: 2 });
    expect(await prisma.transportChangeSet.findUnique({ where: { id: r.value.changeSetId } })).toMatchObject({ status: 'PUBLISHED', idempotencyKey: key, createdById: w.user });
    expect(await prisma.routePlanVersion.count({ where: { planId: w.plan, changeType: 'PUBLISHED' } })).toBe(1);

    // Same key: replay, nothing new.
    const again = await plans.publish(ctx, w.plan, { expectedVersion: 1 }, key);
    expect(again.replay).toBe(true);
    expect(again.value.trips.map((t) => t.transportTripId).sort()).toEqual(r.value.trips.map((t) => t.transportTripId).sort());
    expect(await prisma.transportTrip.count({ where: { routePlanId: w.plan } })).toBe(3);
    expect(await prisma.plannedTrip.count({ where: { companyId: w.company } })).toBe(3);
    // Another key on a published plan: refused; edits refused (read-only).
    expect(await codeOf(plans.publish(ctx, w.plan, { expectedVersion: 2 }, `${TAG}-publish-2`))).toBe('PLAN_NOT_EDITABLE');
    expect(await codeOf(plans.discard(ctx, w.plan, { expectedVersion: 2 }))).toBe('PLAN_NOT_EDITABLE');
    // The DB backstop: one trip per assignment (unique routeAssignmentId).
    const t = headers[0];
    await expect(prisma.transportTrip.update({ where: { id: headers[1].id }, data: { routeAssignmentId: t.routeAssignmentId } })).rejects.toThrow();
  });

  it('[P9 gate] manual dispatch with the optimiser and road engine stopped: a dispatcher seats an off-plan booking by hand', async () => {
    const b = w.bookings[6];
    const tempId = 'manual';
    const at = Date.parse('2026-12-01T02:20:00Z');
    const res = await dispatch.submit(
      ctx,
      {
        serviceDate: DAY,
        direction: 'IN',
        changes: [
          {
            op: 'CREATE_TRIP',
            tempId,
            objectId: w.vehicles[3],
            plannedStart: new Date(at - 600_000).toISOString(),
            stops: [
              { seq: 0, point: { lat: 13.06 + 6 * 0.004, lng: 80.24 }, plannedArrival: new Date(at).toISOString() },
              { seq: 1, point: { lat: 13.05, lng: 80.25, poiId: w.site }, plannedArrival: new Date(at + 1_800_000).toISOString() },
            ],
          },
          { op: 'ADD_PASSENGER', tripId: tempId, bookingId: b, pickupSeq: 0, dropSeq: 1 },
        ],
      } as never,
      `${TAG}-manual-1`,
    );
    expect(res.value.status).toBe('PUBLISHED');
    const trip = await trips.get(ctx, res.value.trips[0].id);
    expect(trip.passengers).toHaveLength(1);
    expect(trip.path).toBeNull(); // no road path while the engine is stopped (never a straight-line one)
    expect(await prisma.transportBooking.findUnique({ where: { id: b }, select: { status: true } })).toEqual({ status: 'ASSIGNED' });
    // A manual trip is not linked to any plan.
    expect(await prisma.transportTrip.findUnique({ where: { id: res.value.trips[0].id }, select: { routePlanId: true, routeAssignmentId: true } })).toEqual({ routePlanId: null, routeAssignmentId: null });
  });
});

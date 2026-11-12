/**
 * Owner decision 5 (publishing) on a real, freshly migrated PostgreSQL scratch database: the server re-checks the stored
 * plan at publish time. A hard arrival-window violation blocks publishing (nothing written); soft warnings need an
 * acknowledgement of exactly the current warning set; an override of a hard violation needs an authorised caller
 * (whole-company scope + Dispatch: command + Planning: command) and a reason, and is audited and shown on the plan.
 * Idempotency-Key replay and concurrent publishes keep working with the new body fields.
 *
 * Not part of the normal run (testRegex is *.spec.ts). Against a scratch `*_test` database with every migration applied:
 *   CI=true ETMS_DB_TEST_URL=postgresql://…@localhost:5432/veetrax_dp_plans_test \
 *     npx jest --testRegex 'etms-publish-gate\.db-test\.ts$' --runInBand
 * Synthetic data only (tag dp-…). Never veetracer / veetrax_assess (scratch-db guard).
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
import { RoutePlansService } from './planning/plans.service';

const URL_ = process.env.ETMS_DB_TEST_URL ?? '';
const { d, dbName } = dbDescribe(URL_);
const TAG = `dp-${Date.now().toString(36)}`;
const DAY = '2026-12-02';
const START = '2026-12-02T02:00:00Z';

const errOf = (p: Promise<unknown>) =>
  p.then(
    () => ({ code: 'OK', status: 200, body: {} as Record<string, unknown> }),
    (e: unknown) => {
      if (!(e instanceof HttpException)) return { code: `unexpected: ${String(e)}`, status: 0, body: {} as Record<string, unknown> };
      const body = e.getResponse() as Record<string, unknown>;
      return { code: (body.code as string | undefined) ?? `HTTP_${e.getStatus()}`, status: e.getStatus(), body };
    },
  );

d(`ETMS E4 decision 5 publish gate on ${dbName}`, () => {
  jest.setTimeout(300_000);
  const prisma = new PrismaClient({ datasourceUrl: URL_ });
  const redis = { client: { get: async () => null, mget: async (...k: string[]) => k.map(() => null), set: async () => 'OK', eval: async () => Promise.reject(new Error('no valkey')), publish: async () => 1, xadd: async () => '1-0' } };
  const audit = new AuditService(prisma as never);
  const plannedTrips = new PlannedTripsService(prisma as never, audit, { invalidate: async () => undefined } as never);
  const live = new TripLiveService(prisma as never, redis as never, plannedTrips);
  const routing = { enabled: false, route: async () => null, routeVia: async () => null, routeStatus: async () => 'UNAVAILABLE' };
  const dispatch = new DispatchService(prisma as never, audit, routing as never, live, redis as never);
  const provider = { routeVia: async () => ({ ok: false, degraded: 'ENGINE_UNREACHABLE', message: 'stopped' }) };
  const plans = new RoutePlansService(prisma as never, audit, dispatch, provider as never);

  const id = () => randomUUID();
  const w = { partner: id(), company: id(), branch: id(), site: id(), admin: id(), dispatcher: id() };
  const perms = { etms_planning: ['view', 'edit', 'command'], etms_dispatch: ['view', 'edit', 'command'] };
  const base = { homeCompanyId: w.company, companyId: w.company, isSuperAdmin: false, isCompanyAdmin: false, permissions: perms, objectIds: [], features: ['etms'], agreements: [], ip: null };
  /** Whole-company transport admin: may override. */
  const admin = { ...base, userId: w.admin, dataScope: 'COMPANY', branchIds: [] } as never;
  /** Branch dispatcher (ASSIGNED): may publish, may not override. */
  const dispatcher = { ...base, userId: w.dispatcher, dataScope: 'ASSIGNED', branchIds: [w.branch] } as never;
  const sql = (s: string) => prisma.$executeRawUnsafe(s);
  let n = 0;

  /**
   * A PLANNED IN plan with one route (a 4-seat van) carrying `count` bookings: pickups at 600 s, 1200 s, …; every site
   * drop at `dropEta` with the booking window [winStart, winEnd] (seconds after planStartAt).
   */
  async function makePlan(opts: { count: number; dropEta: number | null; winStart: number; winEnd: number }): Promise<{ plan: string; route: string; vehicle: string; bookings: string[]; drops: string[] }> {
    n++;
    const plan = id();
    const route = id();
    const vehicle = id();
    await sql(`INSERT INTO "TrackedObject" (id, "companyId", "branchId", name, "isActive", "updatedAt") VALUES ('${vehicle}', '${w.company}', '${w.branch}', 'Van ${n}', true, now())`);
    await sql(`INSERT INTO "TransportVehicleProfile" ("objectId", "companyId", seats, "updatedAt") VALUES ('${vehicle}', '${w.company}', 4, now())`);
    await sql(`INSERT INTO "RoutePlan" (id, "companyId", "branchId", name, "planDate", "planStartAt", status, direction, "sitePoiId", "updatedAt") VALUES ('${plan}', '${w.company}', '${w.branch}', 'Login ${TAG} ${n}', '${DAY}', '${START}', 'PLANNED', 'IN', '${w.site}', now())`);
    await sql(`INSERT INTO "RouteAssignment" (id, "planId", "companyId", "objectId", "vehicleLabel", seq, capacity, "distanceM", "durationS", "startS", "endS", "updatedAt") VALUES ('${route}', '${plan}', '${w.company}', '${vehicle}', 'Van ${n}', 0, 4, 9000, 2400, 0, 6000, now())`);
    const bookings: string[] = [];
    const drops: string[] = [];
    const startMs = Date.parse(START);
    for (let i = 0; i < opts.count; i++) {
      const p = id();
      const b = id();
      bookings.push(b);
      const lat = 13.06 + n * 0.01 + i * 0.002;
      await sql(`INSERT INTO "EmployeeTransportProfile" (id, "companyId", "branchId", "employeeCode", "displayName", "updatedAt") VALUES ('${p}', '${w.company}', '${w.branch}', 'E${n}-${i}', 'Synthetic ${n}-${i}', now())`);
      await sql(`INSERT INTO "EmployeeTransportConsent" (id, "companyId", "profileId", purpose, "noticeVersion", granted, channel) VALUES (gen_random_uuid(), '${w.company}', '${p}', 'TRANSPORT_PROFILE', 'v1', true, 'WEB')`);
      await sql(`INSERT INTO "TransportBooking" (id, "customerCompanyId", "profileId", source, "serviceDate", direction, "timeZone", "pickupLat", "pickupLng", "pickupLabel", "dropPoiId", "dropLat", "dropLng", "dropLabel", "windowStart", "windowEnd", status, "updatedAt")
        VALUES ('${b}', '${w.company}', '${p}', 'ADHOC', '${DAY}', 'IN', 'Asia/Kolkata', ${lat}, 80.24, 'Home', '${w.site}', 13.05, 80.25, 'HQ', '${new Date(startMs + opts.winStart * 1000).toISOString()}', '${new Date(startMs + opts.winEnd * 1000).toISOString()}', 'PENDING_ASSIGNMENT', now())`);
      await sql(`INSERT INTO "RoutePlanStop" (id, "planId", "companyId", "assignmentId", ref, lat, lng, demand, "serviceS", sequence, "etaS", "stopKind", "customerCompanyId", "bookingId", "profileId", "updatedAt")
        VALUES (gen_random_uuid(), '${plan}', '${w.company}', '${route}', 'p-${b}', ${lat}, 80.24, 1, 60, ${i}, ${600 * (i + 1)}, 'PICKUP', '${w.company}', '${b}', '${p}', now())`);
    }
    for (const [i, b] of bookings.entries()) {
      const sid = id();
      drops.push(sid);
      await sql(`INSERT INTO "RoutePlanStop" (id, "planId", "companyId", "assignmentId", ref, lat, lng, demand, "serviceS", sequence, "etaS", "timeWindows", "stopKind", "customerCompanyId", "bookingId", "poiId", "updatedAt")
        VALUES ('${sid}', '${plan}', '${w.company}', '${route}', 'd-${b}', 13.05, 80.25, 0, 0, ${opts.count + i}, ${opts.dropEta === null ? 'NULL' : opts.dropEta}, '[[${opts.winStart}, ${opts.winEnd}]]', 'DROP', '${w.company}', '${b}', '${w.site}', now())`);
    }
    return { plan, route, vehicle, bookings, drops };
  }

  /** Nothing of a refused publish is written: plan unchanged, no trip, no ledger row, bookings still waiting. */
  async function expectNothingWritten(p: { plan: string; bookings: string[] }) {
    expect(await prisma.routePlan.findUnique({ where: { id: p.plan }, select: { status: true, version: true } })).toEqual({ status: 'PLANNED', version: 1 });
    expect(await prisma.transportTrip.count({ where: { routePlanId: p.plan } })).toBe(0);
    expect(await prisma.transportBooking.count({ where: { id: { in: p.bookings }, status: 'PENDING_ASSIGNMENT' } })).toBe(p.bookings.length);
    expect(await prisma.routePlanVersion.count({ where: { planId: p.plan, changeType: 'PUBLISHED' } })).toBe(0);
  }

  beforeAll(async () => {
    await sql(`INSERT INTO "Partner" (id, name, slug, "updatedAt") VALUES ('${w.partner}', '${TAG}', '${TAG}', now())`);
    await sql(`INSERT INTO "Company" (id, "partnerId", name, timezone, settings, "updatedAt") VALUES ('${w.company}', '${w.partner}', '${TAG} corp', 'Asia/Kolkata', '{"features":["etms"]}', now())`);
    await sql(`INSERT INTO "Branch" (id, "companyId", name, "updatedAt") VALUES ('${w.branch}', '${w.company}', 'North', now())`);
    await sql(`INSERT INTO "User" (id, "companyId", name, "updatedAt") VALUES ('${w.admin}', '${w.company}', 'Admin ${TAG}', now())`);
    await sql(`INSERT INTO "User" (id, "companyId", name, "updatedAt") VALUES ('${w.dispatcher}', '${w.company}', 'Dispatcher ${TAG}', now())`);
    await sql(`INSERT INTO "Poi" (id, "companyId", name, category, lat, lng, "updatedAt") VALUES ('${w.site}', '${w.company}', 'HQ', 'OFFICE', 13.05, 80.25, now())`);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  // E2E case: site arrival 08:56 against a window ending 08:55 (one minute late).
  it('a hard arrival-window violation blocks publish (409 PLAN_HAS_HARD_VIOLATIONS, the violations listed) and nothing is written', async () => {
    const p = await makePlan({ count: 2, dropEta: 5460, winStart: 0, winEnd: 5400 });
    const r = await errOf(plans.publish(admin, p.plan, { expectedVersion: 1 }, `${TAG}-hard-1`));
    expect(r.code).toBe('PLAN_HAS_HARD_VIOLATIONS');
    expect(r.status).toBe(409);
    const v = (r.body.violations as { stopId: string; kind: string; assignmentId: string; overridable: boolean; etaS: number; window: number[] }[]) ?? [];
    expect(v.map((x) => x.stopId).sort()).toEqual([...p.drops].sort());
    expect(v.every((x) => x.kind === 'late' && x.assignmentId === p.route && x.overridable && x.etaS === 5460)).toBe(true);
    // No coordinates or names in the refusal.
    expect(JSON.stringify(r.body)).not.toMatch(/"lat"|"lng"|Synthetic/);
    // Acknowledging warnings does not make a hard violation publishable.
    const acked = await errOf(plans.publish(admin, p.plan, { expectedVersion: 1, acknowledgedWarnings: 'w2-00000000' } as never, `${TAG}-hard-2`));
    expect(acked.code).toBe('PLAN_HAS_HARD_VIOLATIONS');
    await expectNothingWritten(p);
    // The plan detail shows the same classification before publishing.
    const detail = await plans.get(admin, p.plan);
    expect(detail.publishCheck?.hard.map((x) => x.stopId).sort()).toEqual([...p.drops].sort());
    expect(detail.publishCheck?.canOverride).toBe(true);
    expect((await plans.get(dispatcher, p.plan)).publishCheck?.canOverride).toBe(false);
  });

  it('soft warnings need an acknowledgement of exactly the current warning set; a stale one is refused; the acknowledgement is audited', async () => {
    // Arrives at 02:40 for a window opening at 02:50: early_wait (soft).
    const p = await makePlan({ count: 1, dropEta: 2400, winStart: 3000, winEnd: 5400 });
    const none = await errOf(plans.publish(dispatcher, p.plan, { expectedVersion: 1 }, `${TAG}-soft-1`));
    expect(none.code).toBe('PLAN_WARNINGS_NOT_ACKNOWLEDGED');
    expect(none.status).toBe(409);
    const fp = none.body.fingerprint as string;
    expect(fp).toMatch(/^w1-[0-9a-f]{8}$/);
    expect((none.body.warnings as { kind: string }[]).map((x) => x.kind)).toEqual(['early_wait']);
    const stale = await errOf(plans.publish(dispatcher, p.plan, { expectedVersion: 1, acknowledgedWarnings: 'w1-deadbeef' } as never, `${TAG}-soft-2`));
    expect(stale.code).toBe('PLAN_WARNINGS_NOT_ACKNOWLEDGED');
    await expectNothingWritten(p);
    expect((await plans.get(dispatcher, p.plan)).publishCheck?.fingerprint).toBe(fp);

    const ok = await plans.publish(dispatcher, p.plan, { expectedVersion: 1, acknowledgedWarnings: fp } as never, `${TAG}-soft-3`);
    expect(ok.replay).toBe(false);
    expect(ok.value.trips).toHaveLength(1);
    const rows = await prisma.auditLog.findMany({ where: { entity: 'RoutePlan', entityId: p.plan } });
    const published = rows.find((x) => (x.changes as { published?: boolean } | null)?.published);
    expect(published?.userId).toBe(w.dispatcher);
    expect((published?.changes as { acknowledgedWarnings?: unknown }).acknowledgedWarnings).toEqual({ fingerprint: fp, count: 1, kinds: ['early_wait'] });
    expect((await plans.get(dispatcher, p.plan)).publishDecision).toEqual({ acknowledged: { fingerprint: fp, count: 1 }, override: null });
  });

  it('an override by a caller without whole-company scope is refused (403); a trivial reason is refused (400); nothing is written', async () => {
    const p = await makePlan({ count: 1, dropEta: 5460, winStart: 0, winEnd: 5400 });
    const reason = 'Site gate opens late today, security confirmed by phone';
    const denied = await errOf(plans.publish(dispatcher, p.plan, { expectedVersion: 1, override: { reason } } as never, `${TAG}-ov-1`));
    expect(denied).toMatchObject({ code: 'PUBLISH_OVERRIDE_FORBIDDEN', status: 403 });
    // Whole-company scope without Dispatch: command cannot publish at all.
    const noDispatch = { ...(admin as object), permissions: { etms_planning: ['view', 'edit', 'command'], etms_dispatch: ['view'] } } as never;
    expect((await errOf(plans.publish(noDispatch, p.plan, { expectedVersion: 1, override: { reason } } as never, `${TAG}-ov-2`))).status).toBe(403);
    const trivial = await errOf(plans.publish(admin, p.plan, { expectedVersion: 1, override: { reason: '   ok      ' } } as never, `${TAG}-ov-3`));
    expect(trivial).toMatchObject({ code: 'PUBLISH_OVERRIDE_REASON_REQUIRED', status: 400 });
    await expectNothingWritten(p);
    expect(await prisma.auditLog.count({ where: { entity: 'RoutePlan', entityId: p.plan } })).toBe(0);
  });

  it('an authorised override publishes, writes the override audit row (plan, violations, reason, actor) and shows it on the plan; the same key replays, another body is refused', async () => {
    const p = await makePlan({ count: 2, dropEta: 5460, winStart: 0, winEnd: 5400 });
    const reason = 'Site gate opens late today, security confirmed by phone';
    const key = `${TAG}-ov-ok`;
    const body = { expectedVersion: 1, override: { reason } } as never;
    const r = await plans.publish(admin, p.plan, body, key);
    expect(r.replay).toBe(false);
    expect(r.value.trips).toHaveLength(1);
    expect(await prisma.routePlan.findUnique({ where: { id: p.plan }, select: { status: true } })).toEqual({ status: 'PUBLISHED' });

    const rows = await prisma.auditLog.findMany({ where: { entity: 'RoutePlan', entityId: p.plan } });
    const ov = rows.find((x) => (x.changes as { publishOverride?: unknown } | null)?.publishOverride);
    expect(ov).toBeDefined();
    expect(ov!.userId).toBe(w.admin);
    expect(ov!.companyId).toBe(w.company);
    const c = ov!.changes as { publishOverride: { reason: string; violations: { stopId: string; kind: string }[] }; planId: string };
    expect(c.planId).toBe(p.plan);
    expect(c.publishOverride.reason).toBe(reason);
    expect(c.publishOverride.violations.map((x) => x.stopId).sort()).toEqual([...p.drops].sort());
    expect(c.publishOverride.violations.every((x) => x.kind === 'late')).toBe(true);

    const detail = await plans.get(admin, p.plan);
    expect(detail.publishDecision?.override).toMatchObject({ reason, byUserId: w.admin });
    expect(detail.publishDecision?.override?.violations).toHaveLength(2);
    // A branch dispatcher of the same plan sees the override too.
    expect((await plans.get(dispatcher, p.plan)).publishDecision?.override?.reason).toBe(reason);

    // Same key + same body: replay, nothing new. Same key + another body: IDEMPOTENCY_KEY_REUSED.
    const again = await plans.publish(admin, p.plan, body, key);
    expect(again.replay).toBe(true);
    expect(again.value.trips.map((t) => t.transportTripId)).toEqual(r.value.trips.map((t) => t.transportTripId));
    expect((await errOf(plans.publish(admin, p.plan, { expectedVersion: 1, override: { reason: `${reason} (edited)` } } as never, key))).code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect((await errOf(plans.publish(admin, p.plan, { expectedVersion: 1 }, key))).code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await prisma.transportTrip.count({ where: { routePlanId: p.plan } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { entity: 'RoutePlan', entityId: p.plan } })).toBe(rows.length);
  });

  it('concurrent publishes with one key and an override make one set of trips (the other replays or is refused, never a second publish)', async () => {
    const p = await makePlan({ count: 2, dropEta: 5460, winStart: 0, winEnd: 5400 });
    const body = { expectedVersion: 1, override: { reason: 'Shift start moved by 5 minutes, site informed in writing' } } as never;
    const key = `${TAG}-conc`;
    const res = await Promise.all([1, 2, 3].map(() => errOf(plans.publish(admin, p.plan, body, key).then((x) => x))));
    expect(res.filter((x) => x.code === 'OK').length).toBeGreaterThanOrEqual(1);
    for (const x of res) expect(['OK', 'PLAN_STALE', 'IDEMPOTENCY_IN_PROGRESS', 'IDEMPOTENCY_KEY_REUSED']).toContain(x.code);
    expect(await prisma.transportTrip.count({ where: { routePlanId: p.plan } })).toBe(1);
    expect(await prisma.routePlanVersion.count({ where: { planId: p.plan, changeType: 'PUBLISHED' } })).toBe(1);
    const ovRows = (await prisma.auditLog.findMany({ where: { entity: 'RoutePlan', entityId: p.plan } })).filter((x) => (x.changes as { publishOverride?: unknown } | null)?.publishOverride);
    expect(ovRows).toHaveLength(1);
  });

  it('kept: a stop without an engine time (unreachable) is refused as before even with an override (409 PLAN_NOT_PUBLISHABLE, ROUTE_NOT_TIMED)', async () => {
    const p = await makePlan({ count: 1, dropEta: null, winStart: 0, winEnd: 5400 });
    const r = await errOf(plans.publish(admin, p.plan, { expectedVersion: 1, override: { reason: 'Engine down, times confirmed by the driver' } } as never, `${TAG}-unr`));
    expect(r.code).toBe('PLAN_NOT_PUBLISHABLE');
    expect((r.body.routes as { code: string }[]).map((x) => x.code)).toContain('ROUTE_NOT_TIMED');
    await expectNothingWritten(p);
  });
});

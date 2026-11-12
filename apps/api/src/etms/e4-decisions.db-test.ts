/**
 * Owner decisions on the E4 route-optimisation patch (2026-11-11) on a real, freshly migrated PostgreSQL:
 * - Decision 2 (T3-D9): at most 75 bookings per plan, enforced alike by draft creation (POST /transport/route-plans)
 *   and by the optimise reservation (POST /routing/jobs/optimize and the plan alias), counted as bookings, with the
 *   same 422 LIMIT_EXCEEDED message; create refuses (never truncates) and names the way out (split the plan).
 * - Decision 1 (T1-D4): the company max-ride policy (Company.settings.etms.maxRideS) is snapshotted into
 *   RoutePlan.options at optimise time with its source (policy | override | none); a per-plan override needs
 *   etms_settings:edit with whole-company scope and a reason, is audited (plan id, old / new value, reason, actor),
 *   survives re-optimise until changed or cleared, and is shown in the plan detail.
 *
 * Not part of the normal run (testRegex is *.spec.ts). Against a scratch `veetrax_*_test` database with every migration
 * applied (`prisma migrate deploy`), dropped afterwards:
 *   CI=true ETMS_DB_TEST_URL=postgresql://…@localhost:5432/veetrax_dr_plans_test \
 *     npx jest --testRegex 'e4-decisions\.db-test\.ts$' --runInBand
 * Synthetic data only (tag dr-…).
 */
jest.mock('@nestjs/mapped-types', () => ({ PartialType: (c: new () => object) => class extends c {} }));

import { HttpException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { MemoryJobQueue } from '../routing-jobs/job-queue';
import { PrismaJobStore } from '../routing-jobs/prisma-job-store';
import { PrismaPlanGateway } from '../routing-jobs/prisma-plan-gateway';
import { RoutingCapabilitiesService } from '../routing-jobs/routing-capabilities.controller';
import { RoutingJobsService } from '../routing-jobs/routing-jobs.service';
import { dbDescribe } from '../test/scratch-db';
import { RoutePlanCreateService } from './planning/plan-create';
import { RoutePlansService } from './planning/plans.service';
import { TransportSettingsService } from './settings/transport-settings.service';

const URL_ = process.env.ETMS_DB_TEST_URL ?? '';
const { d, dbName } = dbDescribe(URL_);
const TAG = `dr-${Date.now().toString(36)}`;
const DAY = '2026-12-04';
const BULK_DAY = '2026-12-05';
const START = '2026-12-04T02:00:00Z';
const W = { vehicle: 7_200, distance: 0, time: 1, routeDuration: 0 };

const errOf = (p: Promise<unknown>) =>
  p.then(
    () => ({ status: 200, code: 'OK', message: '' }),
    (e: unknown) => {
      if (!(e instanceof HttpException)) return { status: 0, code: `unexpected: ${String(e)}`, message: '' };
      const r = e.getResponse() as { code?: string; message?: string };
      return { status: e.getStatus(), code: r.code ?? `HTTP_${e.getStatus()}`, message: String(r.message ?? '') };
    },
  );

type Opts = { maxRideS?: number; maxRideSource?: string; maxRideOverride?: { maxRideS: number; reason: string; setById: string; setAt: string } };

d(`E4 owner decisions (max ride, plan size) on ${dbName}`, () => {
  jest.setTimeout(180_000);
  const prisma = new PrismaClient({ datasourceUrl: URL_ });
  const audit = new AuditService(prisma as never);
  const provider = { routeVia: async () => ({ ok: false, degraded: 'ENGINE_UNREACHABLE', message: 'stopped' }), health: async () => ({ reachable: false, checkedAt: '', degraded: 'ENGINE_UNREACHABLE' }), capabilities: async () => ({ ok: false, degraded: 'ENGINE_UNREACHABLE', message: 'stopped' }) };
  const redis = { client: { zrangebyscore: async () => [], exists: async () => 0 } };
  const plans = new RoutePlansService(prisma as never, audit, { recordPersonalAccess: async () => undefined } as never, provider as never);
  const creator = new RoutePlanCreateService(prisma as never, audit, plans);
  const settings = new TransportSettingsService(prisma as never, audit);
  const gw = new PrismaPlanGateway(prisma);
  const jobs = new RoutingJobsService(new PrismaJobStore(prisma), new MemoryJobQueue(), gw, { hit: async () => true });
  const caps = new RoutingCapabilitiesService(provider as never, { health: async () => false } as never, redis as never, prisma as never);

  const id = () => randomUUID();
  const w = {
    partner: id(),
    company: id(),
    branch: id(),
    site: id(),
    stop: id(),
    users: { admin: id(), planner: id(), dispatcher: id() },
    vehicles: [id(), id()],
    profiles: [id(), id(), id()],
    bookings: [id(), id(), id()],
  };
  const planning = { etms_planning: ['view', 'create', 'edit', 'delete', 'command'], objects: ['view'], drivers: ['view'] };
  const ctxOf = (userId: string, dataScope: 'COMPANY' | 'ASSIGNED', permissions: Record<string, string[]>) =>
    ({ userId, companyId: w.company, homeCompanyId: w.company, isSuperAdmin: false, isCompanyAdmin: false, permissions, dataScope, branchIds: dataScope === 'COMPANY' ? [] : [w.branch], objectIds: [], features: ['etms'], agreements: [], ip: null }) as never;
  /** Transport admin: whole company, etms_settings:edit (sets the policy, so may override it). */
  const admin = ctxOf(w.users.admin, 'COMPANY', { ...planning, etms_settings: ['view', 'edit'] });
  /** Whole-company planner without the settings grant. */
  const planner = ctxOf(w.users.planner, 'COMPANY', planning);
  /** Branch dispatcher (ASSIGNED). */
  const dispatcher = ctxOf(w.users.dispatcher, 'ASSIGNED', { ...planning, etms_settings: ['view', 'edit'] });
  const sql = (s: string) => prisma.$executeRawUnsafe(s);
  const optionsOf = async (planId: string) => (await prisma.routePlan.findUniqueOrThrow({ where: { id: planId }, select: { options: true } })).options as Opts;
  const overrideAudits = async (planId: string) =>
    (await prisma.auditLog.findMany({ where: { companyId: w.company, entity: 'RoutePlan', entityId: planId }, orderBy: { createdAt: 'asc' } }))
      .filter((a) => (a.changes as Record<string, unknown> | null)?.maxRideOverride !== undefined)
      .map((a) => ({ userId: a.userId, action: a.action, changes: a.changes }));

  beforeAll(async () => {
    await sql(`INSERT INTO "Partner" (id, name, slug, "updatedAt") VALUES ('${w.partner}', '${TAG}', '${TAG}', now())`);
    await sql(`INSERT INTO "Company" (id, "partnerId", name, timezone, settings, "updatedAt") VALUES ('${w.company}', '${w.partner}', '${TAG} corp', 'Asia/Kolkata', '{"features":["etms"]}', now())`);
    await sql(`INSERT INTO "Branch" (id, "companyId", name, "updatedAt") VALUES ('${w.branch}', '${w.company}', 'North', now())`);
    for (const u of Object.values(w.users)) await sql(`INSERT INTO "User" (id, "companyId", name, "updatedAt") VALUES ('${u}', '${w.company}', 'User ${TAG}', now())`);
    await sql(`INSERT INTO "Poi" (id, "companyId", name, category, lat, lng, "updatedAt") VALUES ('${w.site}', '${w.company}', 'HQ', 'OFFICE', 13.05, 80.25, now())`);
    await sql(`INSERT INTO "Poi" (id, "companyId", name, category, lat, lng, "updatedAt") VALUES ('${w.stop}', '${w.company}', 'Shuttle stop', 'OTHER', 13.07, 80.24, now())`);
    for (const [i, v] of w.vehicles.entries()) {
      await sql(`INSERT INTO "TrackedObject" (id, "companyId", "branchId", name, "isActive", "updatedAt") VALUES ('${v}', '${w.company}', '${w.branch}', 'Van ${i + 1}', true, now())`);
      await sql(`INSERT INTO "TransportVehicleProfile" ("objectId", "companyId", seats, "updatedAt") VALUES ('${v}', '${w.company}', 40, now())`);
    }
    // Three consented passengers with personal pickups, booked IN to the site on DAY.
    for (const [i, p] of w.profiles.entries()) {
      await sql(`INSERT INTO "EmployeeTransportProfile" (id, "companyId", "branchId", "employeeCode", "displayName", "updatedAt") VALUES ('${p}', '${w.company}', '${w.branch}', 'DR${i}', 'Synthetic ${i}', now())`);
      await sql(`INSERT INTO "EmployeeTransportConsent" (id, "companyId", "profileId", purpose, "noticeVersion", granted, channel) VALUES (gen_random_uuid(), '${w.company}', '${p}', 'TRANSPORT_PROFILE', 'v1', true, 'WEB')`);
      await sql(`INSERT INTO "TransportBooking" (id, "customerCompanyId", "profileId", source, "serviceDate", direction, "timeZone", "pickupLat", "pickupLng", "pickupLabel", "dropPoiId", "dropLat", "dropLng", "dropLabel", "windowStart", "windowEnd", status, "updatedAt")
        VALUES ('${w.bookings[i]}', '${w.company}', '${p}', 'ADHOC', '${DAY}', 'IN', 'Asia/Kolkata', ${13.06 + i * 0.004}, 80.24, 'Home', '${w.site}', 13.05, 80.25, 'HQ', '2026-12-04T03:30:00Z', '2026-12-04T04:00:00Z', 'PENDING_ASSIGNMENT', now())`);
    }
    // 76 passengers boarding at a company shuttle stop (no personal point, so no consent needed), IN on BULK_DAY.
    await sql(`INSERT INTO "EmployeeTransportProfile" (id, "companyId", "branchId", "employeeCode", "displayName", "updatedAt")
      SELECT gen_random_uuid(), '${w.company}', '${w.branch}', 'BULK' || g, 'Bulk ' || g, now() FROM generate_series(1, 76) g`);
    await sql(`INSERT INTO "TransportBooking" (id, "customerCompanyId", "profileId", source, "serviceDate", direction, "timeZone", "pickupPoiId", "pickupLat", "pickupLng", "pickupLabel", "dropPoiId", "dropLat", "dropLng", "dropLabel", "windowStart", "windowEnd", status, "updatedAt")
      SELECT gen_random_uuid(), '${w.company}', p.id, 'ADHOC', '${BULK_DAY}', 'IN', 'Asia/Kolkata', '${w.stop}', 13.07, 80.24, 'Shuttle stop', '${w.site}', 13.05, 80.25, 'HQ', '2026-12-05T03:30:00Z', '2026-12-05T04:00:00Z', 'PENDING_ASSIGNMENT', now()
      FROM "EmployeeTransportProfile" p WHERE p."companyId" = '${w.company}' AND p."employeeCode" LIKE 'BULK%'`);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  const body = (extra: Record<string, unknown> = {}) => ({ name: `Plan ${TAG}`, planDate: DAY, planStartAt: START, direction: 'IN' as const, sitePoiId: w.site, objectIds: [w.vehicles[0]], ...extra });
  const bulkBody = () => ({ name: `Bulk ${TAG}`, planDate: BULK_DAY, planStartAt: '2026-12-05T02:00:00Z', direction: 'IN' as const, sitePoiId: w.site, objectIds: [...w.vehicles] });
  const version = async (planId: string) => (await prisma.routePlan.findUniqueOrThrow({ where: { id: planId }, select: { version: true } })).version;
  /** Start an optimisation, then cancel the queued job (the plan returns to its status; nothing is solved). */
  const optimiseAndCancel = async (c: never, planId: string, key: string, extra: Record<string, unknown> = {}) => {
    const r = await jobs.enqueueOptimize(c, { planId, expectedVersion: await version(planId), weights: W, ...extra } as never, key);
    await jobs.cancel(c, r.job.jobId);
    return r.job;
  };

  // ───────────────────────────── Decision 2 ─────────────────────────────

  it('D2 create: 76 plannable bookings → 422 LIMIT_EXCEEDED "At most 75 bookings per plan (76 found)…split", nothing created', async () => {
    const before = await prisma.routePlan.count({ where: { companyId: w.company } });
    const e = await errOf(creator.create(admin, bulkBody(), `${TAG}-bulk-76`));
    expect(e).toMatchObject({ status: 422, code: 'LIMIT_EXCEEDED' });
    expect(e.message).toMatch(/^At most 75 bookings per plan \(76 found\); .*split/i);
    expect(await prisma.routePlan.count({ where: { companyId: w.company } })).toBe(before);
  });

  it('D2 create accepts exactly 75; optimise refuses the same plan once it holds 76 bookings (same code and message), and accepts it at 75 again', async () => {
    const one = await prisma.transportBooking.findFirstOrThrow({ where: { customerCompanyId: w.company, serviceDate: new Date(`${BULK_DAY}T00:00:00Z`) }, orderBy: { id: 'asc' } });
    await prisma.transportBooking.update({ where: { id: one.id }, data: { status: 'CANCELLED' } });
    const r = await creator.create(admin, bulkBody(), `${TAG}-bulk-75`);
    expect(r.value.bookingCounts).toMatchObject({ planned: 75 });
    const planId = r.value.id;
    // A plan holding 76 bookings (e.g. created before the limit was lowered): 2 × 76 = 152 stops.
    const proto = await Promise.all((['PICKUP', 'DROP'] as const).map((k) => prisma.routePlanStop.findFirstOrThrow({ where: { planId, stopKind: k } })));
    const extra = proto.map((s) => {
      const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = s as typeof s & { createdAt?: unknown; updatedAt?: unknown };
      return { ...rest, id: randomUUID(), ref: `${s.stopKind === 'PICKUP' ? 'p' : 'd'}-${one.id}`, bookingId: one.id, timeWindows: s.timeWindows ?? undefined };
    });
    await prisma.routePlanStop.createMany({ data: extra as never });
    const e = await errOf(jobs.enqueueOptimize(admin, { planId, expectedVersion: await version(planId), weights: W }, `${TAG}-opt-76`));
    expect(e).toMatchObject({ status: 422, code: 'LIMIT_EXCEEDED' });
    expect(e.message).toMatch(/^At most 75 bookings per plan \(76 found\)/);
    await prisma.routePlanStop.deleteMany({ where: { planId, bookingId: one.id } });
    const ok = await jobs.enqueueOptimize(admin, { planId, expectedVersion: await version(planId), weights: W }, `${TAG}-opt-75`);
    expect(ok.job.state).toBe('queued');
    await jobs.cancel(admin, ok.job.jobId);
  });

  it('D2 GET /routing/capabilities exposes limits.planBookings = 75', async () => {
    const c = await caps.get(admin);
    expect((c.limits as unknown as Record<string, number>).planBookings).toBe(75);
  });

  // ───────────────────────────── Decision 1 ─────────────────────────────

  it('D1 no policy, no override: optimise snapshots "no limit" (source none); the worker reads no max ride', async () => {
    const p = await creator.create(admin, body(), `${TAG}-none`);
    await optimiseAndCancel(admin, p.value.id, `${TAG}-none-opt`);
    const o = await optionsOf(p.value.id);
    expect(o.maxRideS ?? null).toBeNull();
    expect(o.maxRideSource).toBe('none');
  });

  it('D1 company policy is snapshotted at optimise time with source policy, read by the worker, and shown in the plan detail', async () => {
    await settings.update(admin, { maxRideS: 3_600 } as never);
    const p = await creator.create(planner, body(), `${TAG}-policy`);
    // Snapshot at optimise, not at create.
    expect((await optionsOf(p.value.id)).maxRideS).toBeUndefined();
    await optimiseAndCancel(planner, p.value.id, `${TAG}-policy-opt`);
    expect(await optionsOf(p.value.id)).toMatchObject({ maxRideS: 3_600, maxRideSource: 'policy' });
    // The worker input carries it (status forced back to OPTIMIZING the way a running job would see it).
    await prisma.routePlan.update({ where: { id: p.value.id }, data: { status: 'OPTIMIZING' } });
    const inputs = await gw.load({ companyId: w.company } as never, { kind: 'optimize', planId: p.value.id, planVersion: await version(p.value.id), profile: 'car', timeLimitS: 10 } as never);
    expect(inputs.maxRideS).toBe(3_600);
    await prisma.routePlan.update({ where: { id: p.value.id }, data: { status: 'DRAFT' } });
    const detail = (await plans.get(planner, p.value.id)) as unknown as { maxRide?: unknown };
    expect(detail.maxRide).toEqual({ appliedS: 3_600, appliedSource: 'policy', policyS: 3_600, override: null });
  });

  it('D1 override: refused (403 FORBIDDEN_GRANT) for a planner without etms_settings:edit and for a branch dispatcher; nothing changes', async () => {
    const p = await creator.create(admin, body(), `${TAG}-refuse`);
    for (const [c, k] of [
      [planner, 'p'],
      [dispatcher, 'd'],
    ] as const) {
      expect(await errOf(jobs.enqueueOptimize(c, { planId: p.value.id, expectedVersion: await version(p.value.id), weights: W, maxRideOverride: { maxRideS: 5_400, reason: 'Long detour' } } as never, `${TAG}-refuse-${k}`))).toMatchObject({ status: 403, code: 'FORBIDDEN_GRANT' });
      expect(await errOf(creator.create(c, body({ maxRideOverride: { maxRideS: 5_400, reason: 'Long detour' } }) as never, `${TAG}-refuse-create-${k}`))).toMatchObject({ status: 403, code: 'FORBIDDEN_GRANT' });
    }
    expect((await optionsOf(p.value.id)).maxRideOverride).toBeUndefined();
    expect(await overrideAudits(p.value.id)).toEqual([]);
  });

  it('D1 override by an authorised admin on optimise: snapshot source override, audited (plan, old / new, reason, actor), kept by re-optimise, policy changes do not touch it, clearing returns to policy (audited)', async () => {
    const p = await creator.create(planner, body(), `${TAG}-ovr`);
    const planId = p.value.id;
    await optimiseAndCancel(admin, planId, `${TAG}-ovr-1`, { maxRideOverride: { maxRideS: 5_400, reason: ' Flood diversion on the ring road ' } });
    const o1 = await optionsOf(planId);
    expect(o1).toMatchObject({ maxRideS: 5_400, maxRideSource: 'override', maxRideOverride: { maxRideS: 5_400, reason: 'Flood diversion on the ring road', setById: w.users.admin } });
    expect(await overrideAudits(planId)).toEqual([{ userId: w.users.admin, action: 'UPDATE', changes: expect.objectContaining({ maxRideOverride: { from: null, to: 5_400 }, reason: 'Flood diversion on the ring road', policyS: 3_600 }) }]);

    // Re-optimise (by anyone with planning rights) without naming the override keeps it, even after a policy change.
    await settings.update(admin, { maxRideS: 2_700 } as never);
    await optimiseAndCancel(planner, planId, `${TAG}-ovr-2`);
    expect(await optionsOf(planId)).toMatchObject({ maxRideS: 5_400, maxRideSource: 'override', maxRideOverride: { maxRideS: 5_400 } });
    expect(await overrideAudits(planId)).toHaveLength(1);

    // The same value again is no change: no second audit entry.
    await optimiseAndCancel(admin, planId, `${TAG}-ovr-3`, { maxRideOverride: { maxRideS: 5_400, reason: 'Flood diversion on the ring road' } });
    expect(await overrideAudits(planId)).toHaveLength(1);

    const detail = (await plans.get(planner, planId)) as unknown as { maxRide?: { override: unknown; appliedSource: string; policyS: number | null } };
    expect(detail.maxRide).toMatchObject({ appliedS: 5_400, appliedSource: 'override', policyS: 2_700, override: { maxRideS: 5_400, reason: 'Flood diversion on the ring road', setById: w.users.admin } });

    // Clearing (null) returns to the policy at the next snapshot; audited.
    await optimiseAndCancel(admin, planId, `${TAG}-ovr-4`, { maxRideOverride: null });
    const o4 = await optionsOf(planId);
    expect(o4).toMatchObject({ maxRideS: 2_700, maxRideSource: 'policy' });
    expect(o4.maxRideOverride).toBeUndefined();
    const audits = await overrideAudits(planId);
    expect(audits).toHaveLength(2);
    expect(audits[1]).toMatchObject({ userId: w.users.admin, changes: expect.objectContaining({ maxRideOverride: { from: 5_400, to: null } }) });
  });

  it('D1 override on create (authorised, with reason): stored on the plan and audited; the first optimisation applies it', async () => {
    const p = await creator.create(admin, body({ maxRideOverride: { maxRideS: 4_500, reason: 'Night shift, longer loop' } }) as never, `${TAG}-create-ovr`);
    expect(await optionsOf(p.value.id)).toMatchObject({ maxRideOverride: { maxRideS: 4_500, reason: 'Night shift, longer loop', setById: w.users.admin } });
    expect(await overrideAudits(p.value.id)).toEqual([{ userId: w.users.admin, action: 'UPDATE', changes: expect.objectContaining({ maxRideOverride: { from: null, to: 4_500 }, reason: 'Night shift, longer loop' }) }]);
    await optimiseAndCancel(planner, p.value.id, `${TAG}-create-ovr-opt`);
    expect(await optionsOf(p.value.id)).toMatchObject({ maxRideS: 4_500, maxRideSource: 'override' });
  });

  it('D1 capabilities tell the planner whether it may override and the company policy', async () => {
    const a = await caps.get(admin);
    expect(a.access).toMatchObject({ canOverrideMaxRide: true, maxRidePolicyS: 2_700 });
    expect((await caps.get(planner)).access).toMatchObject({ canOverrideMaxRide: false, maxRidePolicyS: 2_700 });
    expect((await caps.get(dispatcher)).access).toMatchObject({ canOverrideMaxRide: false });
  });
});

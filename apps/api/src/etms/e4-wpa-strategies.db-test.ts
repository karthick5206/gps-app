/**
 * E4 WP-A (strategies, preferences, alternatives, compare metrics) on a real, freshly migrated PostgreSQL scratch
 * database: alternative plans create sibling DRAFT plans + optimise jobs, replay idempotently, stay inside the company /
 * branch, honour the 75-booking limit, never clone published routes; compare returns the WP-A metrics; preserveLocks=false
 * is refused without etms_planning:edit and audited when allowed; a preference max ride above the policy is refused.
 *
 * Not part of the normal run (testRegex is *.spec.ts). Against a scratch `*_test` database with every migration applied:
 *   ETMS_DB_TEST_URL=postgresql://…@localhost:5432/veetrax_e4wpa_test \
 *     npx jest --testRegex 'e4-wpa-strategies\.db-test\.ts$' --runInBand
 * Synthetic data only (companies "etms-e4e-db-test …", removed again). Never veetracer / veetrax_assess (scratch-db guard).
 */
import { HttpException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { dbDescribe } from '../test/scratch-db';
import { MemoryJobQueue } from '../routing-jobs/job-queue';
import { PrismaJobStore } from '../routing-jobs/prisma-job-store';
import { PrismaPlanGateway } from '../routing-jobs/prisma-plan-gateway';
import { RoutingJobsService } from '../routing-jobs/routing-jobs.service';
import { STRATEGY_WEIGHTS } from '../routing-jobs/strategies';
import { cleanupSeeded, ctxFor, seedPartner, seedPlan } from '../routing-jobs/testing/db-seed';
import { RoutePlanAlternativesService } from './planning/plan-alternatives';
import { RoutePlansService } from './planning/plans.service';

const URL_ = process.env.ETMS_DB_TEST_URL ?? '';
const { d, dbName } = dbDescribe(URL_);

const errOf = (p: Promise<unknown>) =>
  p.then(
    () => ({ status: 200, code: 'OK' }),
    (e: unknown) => (e instanceof HttpException ? { status: e.getStatus(), code: (e.getResponse() as { code?: string }).code ?? '' } : { status: 0, code: String(e) }),
  );

d(`ETMS E4 WP-A strategies and alternatives on ${dbName || '(no scratch DB)'}`, () => {
  jest.setTimeout(120_000);
  const prisma = new PrismaClient({ datasources: { db: { url: URL_ } } });
  const audit = new AuditService(prisma as never);
  const plans = new RoutePlansService(prisma as never, audit, {} as never, null);
  const gw = new PrismaPlanGateway(prisma);
  const jobs = new RoutingJobsService(new PrismaJobStore(prisma), new MemoryJobQueue(), gw, { hit: async () => true });
  const alt = new RoutePlanAlternativesService(prisma as never, audit, plans, jobs);
  const companies: string[] = [];
  let partnerId: string;
  const sql = (s: string) => prisma.$executeRawUnsafe(s);
  const editor = (company: string) => ({ ...ctxFor(company), permissions: { etms_planning: ['view', 'create', 'edit'] } }) as never;

  beforeAll(async () => {
    partnerId = await seedPartner(prisma);
  });
  afterAll(async () => {
    for (const c of companies) {
      await sql(`DELETE FROM "TransportTrip" WHERE "providerCompanyId" = '${c}'`);
      // Branches are removed after the plans and profiles (cleanupSeeded), then the company.
    }
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('veetrax.evidence_write', 'purge', true)`);
      for (const c of companies) {
        for (const t of ['RoutingJob', 'RoutePlan', 'TransportBooking', 'EmployeeTransportConsent', 'EmployeeTransportProfile']) await tx.$executeRawUnsafe(`DELETE FROM "${t}" WHERE "${t === 'TransportBooking' ? 'customerCompanyId' : 'companyId'}" = '${c}'`);
        await tx.$executeRawUnsafe(`DELETE FROM "Branch" WHERE "companyId" = '${c}'`);
      }
    });
    expect(await cleanupSeeded(prisma, companies, partnerId)).toBe(0);
    await prisma.$disconnect();
  });

  it('alternatives: one sibling DRAFT plan per strategy (stops unassigned) and one job each within the concurrency limit; replay is idempotent', async () => {
    const g = await seedPlan(prisma, partnerId, companies, 'alt');
    const ctx = editor(g.company);
    const body = { strategies: ['BALANCED', 'FEWER_VEHICLES', 'COMFORT'] as const, expectedVersion: 1, timeLimitS: 5 };
    const r = await alt.create(ctx, g.plan, { ...body, strategies: [...body.strategies] }, 'alt-key-0001');
    expect(r.replay).toBe(false);
    expect(r.value.alternatives.map((a) => a.strategy)).toEqual(['BALANCED', 'FEWER_VEHICLES', 'COMFORT']);
    // Per-company concurrency 2: two jobs queued, the third waits (QUOTA_EXCEEDED), its plan stays DRAFT.
    expect(r.value.alternatives.map((a) => !!a.jobId)).toEqual([true, true, false]);
    expect(r.value.alternatives[2].error?.code).toBe('QUOTA_EXCEEDED');
    const ids = r.value.alternatives.map((a) => a.planId);
    const sib = await prisma.routePlan.findMany({ where: { id: { in: ids } }, include: { stops: true, assignments: true, versions: true } });
    for (const p of sib) {
      const o = p.options as Record<string, unknown>;
      expect(o.alternativeOf).toBe(g.plan);
      expect(p.stops).toHaveLength(6);
      expect(p.stops.every((s) => s.assignmentId === null && s.etaS === null)).toBe(true);
      expect(p.assignments).toHaveLength(2);
      expect(p.versions.map((v) => v.changeType)).toEqual(['CREATED']);
      expect([p.direction, p.shiftId, p.sitePoiId]).toEqual(['IN', g.shift, g.office]);
    }
    const balanced = sib.find((p) => p.id === ids[0])!;
    expect(balanced.status).toBe('OPTIMIZING');
    expect((balanced.options as { weights?: unknown }).weights).toEqual(STRATEGY_WEIGHTS.BALANCED);
    const job = await prisma.routingJob.findUnique({ where: { id: r.value.alternatives[0].jobId! } });
    expect((job!.input as { weights: unknown; strategy: string }).strategy).toBe('BALANCED');
    expect(sib.find((p) => p.id === ids[2])!.status).toBe('DRAFT');
    // The source plan is untouched.
    expect(await prisma.routePlan.findUnique({ where: { id: g.plan }, select: { status: true, version: true } })).toEqual({ status: 'DRAFT', version: 1 });

    // Replay: same siblings, no new plan or job; after a job is cancelled, the waiting one starts.
    await jobs.cancel(ctx, r.value.alternatives[0].jobId!);
    const again = await alt.create(ctx, g.plan, { ...body, strategies: [...body.strategies] }, 'alt-key-0001');
    expect(again.replay).toBe(true);
    expect(again.value.alternatives.map((a) => a.planId)).toEqual(ids);
    expect(again.value.alternatives[1].jobId).toBe(r.value.alternatives[1].jobId);
    expect(again.value.alternatives[2].jobId).toBeTruthy();
    expect(await prisma.routePlan.count({ where: { companyId: g.company } })).toBe(4);
    // Same key, other body → 422.
    expect(await errOf(alt.create(ctx, g.plan, { strategies: ['FASTEST', 'COMFORT'], expectedVersion: 1 }, 'alt-key-0001'))).toEqual({ status: 422, code: 'IDEMPOTENCY_KEY_REUSED' });

    // GET alternatives: from the source and from a sibling alike.
    const list = await alt.list(ctx, g.plan);
    expect(list.alternatives.map((a) => a.planId).sort()).toEqual([...ids].sort());
    expect((await alt.list(ctx, ids[1])).sourcePlanId).toBe(g.plan);

    // Compare: WP-A metrics next to the old ones.
    const cmp = await plans.compare(ctx, ids.slice(0, 2).join(','));
    expect(cmp.plans[0]).toMatchObject({ planId: ids[0], strategy: 'BALANCED', alternativeOf: g.plan, vehiclesUsed: 0, bookingsAssigned: 0, excludedBookings: 3, excluded: [{ reason: 'not_optimised', bookings: 3 }], deadlineCompliance: { inside: 0, total: 0, ratio: null } });
    expect(cmp.plans[0]).toHaveProperty('seatUtilisation');
  });

  it('isolation: another company and another branch get 404; stale version 409; nothing is created', async () => {
    const g = await seedPlan(prisma, partnerId, companies, 'iso');
    const other = await seedPlan(prisma, partnerId, companies, 'iso-other');
    const b = { strategies: ['BALANCED', 'FASTEST'] as ('BALANCED' | 'FASTEST')[], expectedVersion: 1 };
    expect(await errOf(alt.create(editor(other.company), g.plan, b, 'iso-key-0001'))).toMatchObject({ status: 404 });
    expect(await errOf(alt.list(editor(other.company), g.plan))).toMatchObject({ status: 404 });
    const branchUser = { ...ctxFor(g.company), dataScope: 'ASSIGNED', branchIds: [randomUUID()], permissions: { etms_planning: ['view', 'create'] } } as never;
    expect(await errOf(alt.create(branchUser, g.plan, b, 'iso-key-0002'))).toMatchObject({ status: 404 });
    expect(await errOf(alt.create(editor(g.company), g.plan, { ...b, expectedVersion: 2 }, 'iso-key-0003'))).toEqual({ status: 409, code: 'PLAN_STALE' });
    expect(await prisma.routePlan.count({ where: { companyId: g.company } })).toBe(1);
  });

  it('75-booking limit (422 LIMIT_EXCEEDED, nothing created); published routes and their passengers are not cloned', async () => {
    const big = await seedPlan(prisma, partnerId, companies, 'big');
    await sql(`INSERT INTO "EmployeeTransportProfile" (id, "companyId", "employeeCode", "displayName", "updatedAt") SELECT gen_random_uuid(), '${big.company}', 'L' || g, 'Synthetic L' || g, now() FROM generate_series(1, 73) g`);
    await sql(`INSERT INTO "EmployeeTransportConsent" (id, "companyId", "profileId", purpose, "noticeVersion", granted, channel) SELECT gen_random_uuid(), '${big.company}', p.id, 'TRANSPORT_PROFILE', 'v1', true, 'WEB' FROM "EmployeeTransportProfile" p WHERE p."companyId" = '${big.company}' AND p."employeeCode" LIKE 'L%'`);
    await sql(`INSERT INTO "TransportBooking" (id, "customerCompanyId", "profileId", source, "serviceDate", direction, "timeZone", "pickupLat", "pickupLng", "dropPoiId", "dropLat", "dropLng", "windowStart", "windowEnd", status, "updatedAt")
      SELECT gen_random_uuid(), '${big.company}', p.id, 'ADHOC', '2026-12-01', 'IN', 'Asia/Kolkata', 13.05, 80.2, '${big.office}', 13.0827, 80.2707, '2026-12-01T02:00:00Z', '2026-12-01T03:00:00Z', 'PENDING_ASSIGNMENT', now() FROM "EmployeeTransportProfile" p WHERE p."companyId" = '${big.company}' AND p."employeeCode" LIKE 'L%'`);
    await sql(`INSERT INTO "RoutePlanStop" (id, "planId", "companyId", ref, lat, lng, demand, "serviceS", "stopKind", "customerCompanyId", "bookingId", "updatedAt")
      SELECT gen_random_uuid(), '${big.plan}', '${big.company}', 'x-' || b.id, 13.05, 80.2, 1, 60, 'PICKUP', '${big.company}', b.id, now() FROM "TransportBooking" b WHERE b."customerCompanyId" = '${big.company}' AND b.status = 'PENDING_ASSIGNMENT'`);
    expect(await errOf(alt.create(editor(big.company), big.plan, { strategies: ['BALANCED', 'FASTEST'], expectedVersion: 1 }, 'big-key-0001'))).toEqual({ status: 422, code: 'LIMIT_EXCEEDED' });
    expect(await prisma.routePlan.count({ where: { companyId: big.company } })).toBe(1);

    const g = await seedPlan(prisma, partnerId, companies, 'pub');
    await sql(`UPDATE "RoutePlanStop" SET "assignmentId" = '${g.vans[0]}', sequence = 1 WHERE id IN ('${g.pickups[0]}', '${g.drops[0]}')`);
    await sql(`INSERT INTO "TransportTrip" (id, "providerCompanyId", "customerCompanyId", "serviceDate", direction, "seatCapacity", "routePlanId", "routeAssignmentId", "updatedAt") VALUES (gen_random_uuid(), '${g.company}', '${g.company}', '2026-12-01', 'IN', 4, '${g.plan}', '${g.vans[0]}', now())`);
    const r = await alt.create(editor(g.company), g.plan, { strategies: ['BALANCED', 'COMFORT'], expectedVersion: 1 }, 'pub-key-0001');
    expect(r.value.skippedBookings).toEqual([{ bookingId: g.bookings[0], reason: 'published' }]);
    const sib = await prisma.routePlan.findUnique({ where: { id: r.value.alternatives[0].planId }, include: { stops: true, assignments: true } });
    expect(sib!.assignments).toHaveLength(1);
    expect(sib!.stops.map((s) => s.bookingId).sort()).toEqual([g.bookings[1], g.bookings[1], g.bookings[2], g.bookings[2]].sort());
  });

  it('review fixes: preference max ride above the policy refused before any sibling exists; the override is copied only with the right (audited)', async () => {
    const g = await seedPlan(prisma, partnerId, companies, 'ride');
    await sql(`UPDATE "Company" SET settings = '{"features":["etms"],"etms":{"maxRideS":2700}}' WHERE id = '${g.company}'`);
    await sql(`UPDATE "RoutePlan" SET options = '{"maxRideOverride":{"maxRideS":5400,"reason":"Flood diversion on the ring road","setById":null,"setAt":"2026-11-15T00:00:00Z"}}' WHERE id = '${g.plan}'`);
    const body = { strategies: ['BALANCED', 'FASTEST'] as ('BALANCED' | 'FASTEST')[], expectedVersion: 1, preferences: { maxRideS: 3600 } };
    // Planner without the override right: the siblings would run on the policy (2700) → 400, nothing written.
    expect(await errOf(alt.create(editor(g.company), g.plan, body, 'ride-key-0001'))).toEqual({ status: 400, code: 'MAX_RIDE_ABOVE_POLICY' });
    expect(await prisma.routePlan.count({ where: { companyId: g.company } })).toBe(1);
    expect(await prisma.routingJob.count({ where: { companyId: g.company } })).toBe(0);
    // Same request without the preference: siblings without the override.
    const plain = await alt.create(editor(g.company), g.plan, { ...body, preferences: undefined }, 'ride-key-0002');
    const p1 = await prisma.routePlan.findUnique({ where: { id: plain.value.alternatives[0].planId }, select: { options: true } });
    expect(p1!.options).not.toHaveProperty('maxRideOverride');
    // Transport admin (etms_settings:edit, whole company): override copied, 3600 within it, one audit entry per clone.
    await prisma.routingJob.deleteMany({ where: { companyId: g.company } });
    const admin = { ...ctxFor(g.company), permissions: { etms_planning: ['view', 'create', 'edit'], etms_settings: ['view', 'edit'] } } as never;
    const r = await alt.create(admin, g.plan, body, 'ride-key-0003');
    for (const a of r.value.alternatives) {
      const o = (await prisma.routePlan.findUnique({ where: { id: a.planId }, select: { options: true } }))!.options as Record<string, unknown>;
      expect(o.maxRideOverride).toMatchObject({ maxRideS: 5400 });
      const logs = await prisma.auditLog.findMany({ where: { entityId: a.planId } });
      expect(logs.some((l) => JSON.stringify(l).includes('copiedFrom'))).toBe(true);
    }
  });

  it('review fixes: a branch dispatcher clones only bookings of their branches (others neither cloned nor listed); a legacy personal stop without consent is not cloned', async () => {
    const g = await seedPlan(prisma, partnerId, companies, 'branch');
    const [brA, brB] = [randomUUID(), randomUUID()];
    await sql(`INSERT INTO "Branch" (id, "companyId", name, "updatedAt") VALUES ('${brA}', '${g.company}', 'A', now()), ('${brB}', '${g.company}', 'B', now())`);
    await sql(`UPDATE "EmployeeTransportProfile" SET "branchId" = '${brB}' WHERE id = '${g.profiles[0]}'`);
    await sql(`UPDATE "EmployeeTransportProfile" SET "branchId" = '${brA}' WHERE id IN ('${g.profiles[1]}', '${g.profiles[2]}')`);
    await sql(`UPDATE "RoutePlan" SET "branchId" = '${brA}' WHERE id = '${g.plan}'`);
    // Legacy personal stop: no profileId, no poiId (owner = the booking's passenger), whose consent is withdrawn.
    await sql(`UPDATE "RoutePlanStop" SET "profileId" = NULL WHERE id = '${g.pickups[2]}'`);
    await sql(`INSERT INTO "EmployeeTransportConsent" (id, "companyId", "profileId", purpose, "noticeVersion", granted, channel, "occurredAt") VALUES (gen_random_uuid(), '${g.company}', '${g.profiles[2]}', 'TRANSPORT_PROFILE', 'v1', false, 'WEB', now() + interval '1 minute')`);
    const dispatcher = { ...ctxFor(g.company), dataScope: 'ASSIGNED', branchIds: [brA], permissions: { etms_planning: ['view', 'create'] } } as never;
    const r = await alt.create(dispatcher, g.plan, { strategies: ['BALANCED', 'COMFORT'], expectedVersion: 1 }, 'branch-key-0001');
    expect(r.value.skippedBookings).toEqual([{ bookingId: g.bookings[2], reason: 'consent_required' }]);
    for (const a of r.value.alternatives) {
      const stops = await prisma.routePlanStop.findMany({ where: { planId: a.planId }, select: { bookingId: true } });
      expect(stops.map((s) => s.bookingId)).toEqual([g.bookings[1], g.bookings[1]]);
    }
  });

  it('preserveLocks=false: 403 without etms_planning:edit (nothing written); allowed and audited for an editor; preference max ride above the policy → 400', async () => {
    const g = await seedPlan(prisma, partnerId, companies, 'locks');
    await sql(`UPDATE "RoutePlan" SET options = '{"lockedAssignmentIds":["${g.vans[0]}"]}' WHERE id = '${g.plan}'`);
    const viewer = { ...ctxFor(g.company), permissions: { etms_planning: ['view', 'create'] } } as never;
    const req = { planId: g.plan, expectedVersion: 1, strategy: 'BALANCED' as const, preferences: { preserveLocks: false } };
    expect(await errOf(jobs.enqueueOptimize(viewer, req, 'lock-key-0001'))).toEqual({ status: 403, code: 'FORBIDDEN_GRANT' });
    expect(await errOf(alt.create(viewer, g.plan, { strategies: ['BALANCED', 'FASTEST'], expectedVersion: 1, preferences: { preserveLocks: false } }, 'lock-key-0002'))).toEqual({ status: 403, code: 'FORBIDDEN_GRANT' });
    expect(await prisma.routingJob.count({ where: { companyId: g.company } })).toBe(0);

    await sql(`UPDATE "Company" SET settings = '{"features":["etms"],"etms":{"maxRideS":2700}}' WHERE id = '${g.company}'`);
    const ed = editor(g.company);
    expect(await errOf(jobs.enqueueOptimize(ed, { ...req, preferences: { maxRideS: 3600 } }, 'lock-key-0003'))).toEqual({ status: 400, code: 'MAX_RIDE_ABOVE_POLICY' });
    expect(await prisma.routePlan.findUnique({ where: { id: g.plan }, select: { status: true } })).toEqual({ status: 'DRAFT' });

    await jobs.enqueueOptimize(ed, { ...req, preferences: { preserveLocks: false, maxRideS: 1800 } }, 'lock-key-0004');
    const plan = await prisma.routePlan.findUnique({ where: { id: g.plan }, select: { status: true, options: true } });
    expect(plan!.status).toBe('OPTIMIZING');
    expect(plan!.options).toMatchObject({ strategy: 'BALANCED', weightsSource: 'strategy', preferences: { preserveLocks: false, maxRideS: 1800 }, maxRideS: 2700, maxRideSource: 'policy' });
    const logs = await prisma.auditLog.findMany({ where: { companyId: g.company, entity: 'RoutePlan', entityId: g.plan } });
    expect(logs.some((l) => JSON.stringify(l.changes ?? l).includes('"preserveLocks":false'))).toBe(true);
    // The worker's inputs: the locked route is re-solved, the run's max ride is the tighter preference.
    const job = (await prisma.routingJob.findFirst({ where: { planId: g.plan } }))!;
    const inputs = await gw.load(job as never, { kind: 'optimize', planId: g.plan, planVersion: 1, profile: 'car', timeLimitS: 5 });
    expect(inputs.lockedAssignmentIds).toEqual([]);
    expect(inputs.vehicles.map((v) => v.assignmentId).sort()).toEqual([...g.vans].sort());
    expect(inputs.maxRideS).toBe(1800);
  });
});

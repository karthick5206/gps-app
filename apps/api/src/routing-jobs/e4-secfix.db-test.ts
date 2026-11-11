/**
 * E4 security review fixes + QA backend items on a real PostgreSQL with every migration applied (M1, L1, L2, L6, L7 via
 * routing-jobs.db-test, L8; QA B3, B4). Not part of the normal run (testRegex is *.spec.ts):
 *   CI=true ETMS_DB_TEST_URL=postgresql://…@localhost:5432/veetrax_e4sf_x_test \
 *     npx jest --testRegex 'e4-secfix\.db-test\.ts$' --runInBand
 * Allowed databases: *_test only in CI (scratch-db guard); never veetracer. Synthetic data on scratch companies
 * ("etms-e4e-db-test …"), committed (several connections race) and removed again in afterAll.
 */
import { HttpException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { eraseRoutingPlanPoints, withdrawRoutingPlanPoints } from '../etms/dispatch/routing-plan-privacy';
import { RoutePlanCreateService } from '../etms/planning/plan-create';
import { RoutePlansService } from '../etms/planning/plans.service';
import { purgeStuckRoutePlans } from '../retention/stuck-route-plans';
import { dbDescribe } from '../test/scratch-db';
import { MemoryJobQueue } from './job-queue';
import { RoutingJobWorker } from './job-worker';
import { optimizeRunner, parseOptimizeInput } from './optimize-runner';
import type { PlanWrite } from './optimize-problem';
import { PrismaJobStore } from './prisma-job-store';
import { PrismaPlanGateway } from './prisma-plan-gateway';
import { RoutingJobsService } from './routing-jobs.service';
import { cleanupSeeded, ctxFor, seedPartner, seedPlan } from './testing/db-seed';
import { FakeMatrix, FakeSolver, until } from './testing/fakes';
import { InMemoryUsageHook } from './usage-hook';

const URL_ = process.env.ETMS_DB_TEST_URL ?? '';
const { d, dbName } = dbDescribe(URL_);
const W = { vehicle: 7_200, distance: 0, time: 1, routeDuration: 0 };

/** Interactive-transaction options: a new connection through the WSL / CI network can take more than Prisma's 2 s maxWait. */
const TX = { timeout: 60_000, maxWait: 30_000 };
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};
const codeOf = (p: Promise<unknown>) => p.then(() => 'OK', (e: unknown) => (e instanceof HttpException ? ((e.getResponse() as { code?: string }).code ?? `HTTP_${e.getStatus()}`) : `error: ${(e as Error).message}`));
/**
 * SQLSTATE of a refused write, whatever Prisma wraps it in: raw (P2010) errors carry it as meta.code or "Code: `…`";
 * model errors map unique / foreign-key violations to P2002 / P2003 (a trigger raising 23503 surfaces as P2003).
 */
const sqlState = (p: Promise<unknown>): Promise<string> =>
  p.then(
    () => 'OK',
    (e: { code?: string; meta?: { code?: string }; message?: string }) =>
      e.meta?.code ?? /Code: `(\w+)`/.exec(e.message ?? '')?.[1] ?? ({ P2002: '23505', P2003: '23503' } as Record<string, string>)[e.code ?? ''] ?? `unexpected ${e.code ?? e.message}`,
  );

d(`E4 security fixes + QA backend items on ${dbName || '(no scratch DB)'}`, () => {
  jest.setTimeout(180_000);
  let prisma: PrismaClient;
  let watcher: PrismaClient;
  let store: PrismaJobStore;
  let gw: PrismaPlanGateway;
  const companies: string[] = [];
  const extra: (() => Promise<unknown>)[] = [];
  let partnerId: string;
  const seed = (name: string) => seedPlan(prisma, partnerId, companies, name);
  const jobs = () => new RoutingJobsService(store, new MemoryJobQueue(), gw, { hit: async () => true });
  const plansSvc = () => new RoutePlansService(prisma as never, new AuditService(prisma as never), { recordPersonalAccess: async () => undefined } as never, null);

  /** Backends of this database waiting on a lock (another connection). */
  const lockWaiters = async () => Number((await watcher.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`)[0].n);

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: URL_ } } });
    watcher = new PrismaClient({ datasources: { db: { url: URL_ } } });
    store = new PrismaJobStore(prisma);
    gw = new PrismaPlanGateway(prisma);
    partnerId = await seedPartner(prisma);
  });

  afterAll(async () => {
    if (!prisma) return;
    for (const f of extra.reverse()) await f().catch(() => undefined);
    expect(await cleanupSeeded(prisma, companies, partnerId)).toBe(0);
    await prisma.$disconnect();
    await watcher.$disconnect();
  });

  // ───────────────────────────── M1 ─────────────────────────────

  it('M1: consent withdrawal concurrent with a plan edit (plan locked first by the edit): no 40P01, the withdrawal succeeds', async () => {
    const g = await seed('m1-edit');
    const planLocked = deferred();
    const go = deferred();
    // The edit's order: version compare-and-set on the plan, then the stop rows (plans.service edit()).
    const edit = prisma.$transaction(
      async (tx) => {
        const n = await tx.routePlan.updateMany({ where: { id: g.plan, version: 1 }, data: { version: { increment: 1 } } });
        expect(n.count).toBe(1);
        planLocked.resolve();
        await go.promise;
        await tx.routePlanStop.update({ where: { id: g.pickups[0] }, data: { assignmentId: g.vans[0], sequence: 0 } });
      },
      TX,
    );
    await planLocked.promise;
    const withdraw = prisma.$transaction((tx) => withdrawRoutingPlanPoints(tx, g.company, g.profiles[0]), TX);
    try {
      await until(async () => (await lockWaiters()) > 0, 30_000); // the withdrawal waits for the plan lock
    } finally {
      go.resolve(); // before the fix the edit's stop update deadlocked here (the withdrawal already held the stop)
    }
    await expect(edit).resolves.toBeUndefined();
    await expect(withdraw).resolves.toEqual({ removed: 1, anonymised: 0, planIds: [g.plan] });
    expect(await prisma.routePlanStop.findUnique({ where: { id: g.pickups[0] } })).toBeNull();
    expect((await prisma.routePlan.findUniqueOrThrow({ where: { id: g.plan } })).version).toBe(3);
  });

  it('M1: consent withdrawal concurrent with an optimise job result write: no 40P01, both succeed in order', async () => {
    const g = await seed('m1-job');
    const job = (await jobs().enqueueOptimize(ctxFor(g.company), { planId: g.plan, expectedVersion: 1, timeLimitS: 5, weights: W }, `m1-${randomUUID()}`)).job;
    const row = (await store.get(job.jobId))!;
    const inputs = await gw.load(row, parseOptimizeInput(row));
    const w: PlanWrite = { assignments: [{ assignmentId: g.vans[0], visits: [{ stopId: g.pickups[0], sequence: 0, etaS: 0 }, { stopId: g.drops[0], sequence: 1, etaS: 600 }], startS: 0, endS: 600, durationS: 600, distanceM: 4000 }], unassigned: [] };
    const planLocked = deferred();
    const go = deferred();
    // The real gateway write, paused after its plan compare-and-set (before its first stop update).
    const write = prisma.$transaction(
      async (tx) => {
        const gated = new Proxy(tx, {
          get(t, k) {
            const v = (t as unknown as Record<string | symbol, unknown>)[k];
            if (k !== 'routePlanStop') return v;
            return new Proxy(v as object, {
              get(s, m) {
                const f = (s as Record<string | symbol, unknown>)[m];
                return typeof f === 'function'
                  ? async (...a: unknown[]) => {
                      planLocked.resolve();
                      await go.promise;
                      return (f as (...x: unknown[]) => unknown).apply(s, a);
                    }
                  : f;
              },
            });
          },
        });
        await gw.write(gated, row, inputs, w, null, [], 'gh-test');
      },
      TX,
    );
    await planLocked.promise;
    const withdraw = prisma.$transaction((tx) => withdrawRoutingPlanPoints(tx, g.company, g.profiles[0]), TX);
    try {
      await until(async () => (await lockWaiters()) > 0, 30_000);
    } finally {
      go.resolve();
    }
    await expect(write).resolves.toBeUndefined();
    await expect(withdraw).resolves.toEqual({ removed: 1, anonymised: 0, planIds: [g.plan] });
    const plan = await prisma.routePlan.findUniqueOrThrow({ where: { id: g.plan }, include: { stops: true } });
    expect(plan).toMatchObject({ status: 'PLANNED', version: 3 });
    expect(plan.stops.some((s) => s.id === g.pickups[0])).toBe(false);
  });

  // ───────────────────────────── L2 ─────────────────────────────

  it('L2: an erasure after the job loaded the plan bumps the version: the result write is PLAN_STALE and the erased stop stays coarse', async () => {
    const g = await seed('l2');
    await prisma.routePlanStop.update({ where: { id: g.pickups[0] }, data: { snapDistanceM: 5, snappedLat: 13.0101, snappedLng: 80.2101 } });
    const job = (await jobs().enqueueOptimize(ctxFor(g.company), { planId: g.plan, expectedVersion: 1, timeLimitS: 5, weights: W }, `l2-${randomUUID()}`)).job;
    const row = (await store.get(job.jobId))!;
    const inputs = await gw.load(row, parseOptimizeInput(row)); // the precise point was read
    expect(await prisma.$transaction((tx) => eraseRoutingPlanPoints(tx, g.company, g.profiles[0], [g.bookings[0]]), TX)).toBe(1);
    expect(await prisma.routePlan.findUniqueOrThrow({ where: { id: g.plan } })).toMatchObject({ status: 'OPTIMIZING', version: 2 });
    const matrix = { snapped: [{ snapDistanceM: 12, lat: 13.0102, lng: 80.2102 }] } as never;
    await expect(prisma.$transaction((tx) => gw.write(tx, row, inputs, { assignments: [], unassigned: [] }, matrix, [{ stopId: g.pickups[0], index: 0 }], 'gh-test'), TX)).rejects.toMatchObject({ code: 'PLAN_STALE' });
    expect(await prisma.routePlanStop.findUniqueOrThrow({ where: { id: g.pickups[0] } })).toMatchObject({ lat: 13.01, lng: 80.21, snapDistanceM: null, snappedLat: null, snappedLng: null, name: null });
  });

  // ───────────────────────────── L1 ─────────────────────────────

  it('L1: plan create — another user with the same key gets 422; two concurrent creates with one key give one plan', async () => {
    const g = await seed('l1');
    const van = randomUUID();
    await prisma.$executeRawUnsafe(`INSERT INTO "TrackedObject" (id, "companyId", name, "updatedAt") VALUES ('${van}', '${g.company}', 'Van L1', now())`);
    const audit = new AuditService(prisma as never);
    const creator = new RoutePlanCreateService(prisma as never, audit, plansSvc());
    const owner = ctxFor(g.company);
    const dto = { name: 'L1', planDate: '2026-12-02', direction: 'IN' as const, sitePoiId: g.office, objectIds: [van] };
    const key = `l1-${randomUUID()}`;
    const [a, b] = await Promise.all([creator.create(owner, dto, key), creator.create(owner, dto, key)]);
    expect(a.value.id).toBe(b.value.id);
    expect([a.replay, b.replay].sort()).toEqual([false, true]);
    // QA re-check: an empty plan says why (no booking on 2 Dec at all; none for a chosen shift).
    const fresh = a.replay ? b : a;
    expect(fresh.value).toMatchObject({ emptyReason: 'NO_BOOKINGS', bookingCounts: { found: 0, planned: 0, skipped: 0 } });
    expect((a.replay ? a : b).value.emptyReason).toBe('NO_BOOKINGS');
    const withShift = await creator.create(owner, { ...dto, shiftId: g.shift }, `l1-${randomUUID()}`);
    expect(withShift.value).toMatchObject({ emptyReason: 'NO_BOOKINGS_FOR_SHIFT', bookingCounts: { found: 0, planned: 0 } });
    expect(await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM "RoutePlan" WHERE "companyId" = ${g.company}::uuid AND options->>'createKey' = ${key}`).toEqual([{ n: 1n }]);
    // Same key and body from another user of the company: 422, without the plan.
    const other = await creator.create(ctxFor(g.company), dto, key).catch((e: HttpException) => e);
    expect(other).toBeInstanceOf(HttpException);
    expect((other as HttpException).getStatus()).toBe(422);
    expect(JSON.stringify((other as HttpException).getResponse())).not.toContain(a.value.id);
    // The database refuses a second plan with the key whatever the code does (unique index).
    expect(await sqlState(prisma.$executeRawUnsafe(`INSERT INTO "RoutePlan" (id, "companyId", name, "planDate", options, "updatedAt") VALUES (gen_random_uuid(), '${g.company}', 'dup', '2026-12-02', '{"createKey":"${key}"}', now())`))).toBe('23505');
    // Informational: an inactive vehicle is refused; a depot that is not a company place is refused.
    await prisma.trackedObject.update({ where: { id: van }, data: { isActive: false } });
    expect(await codeOf(creator.create(owner, dto, `l1-${randomUUID()}`))).toBe('NOT_FOUND');
    await prisma.trackedObject.update({ where: { id: van }, data: { isActive: true } });
    expect(await codeOf(creator.create(owner, { ...dto, depot: { lat: 13.2, lng: 80.4 } }, `l1-${randomUUID()}`))).toMatch(/VALIDATION|HTTP_400|INVALID/);
  });

  // ───────────────────────────── L6 ─────────────────────────────

  it('L6: retention purges stuck OPTIMIZING plans past the cutoff — job terminal or missing, or routing off — and cancels their jobs', async () => {
    const g = await seed('l6');
    const old = new Date('2020-01-01');
    // plan A: OPTIMIZING, old, QUEUED job (routing off rollback); plan B: OPTIMIZING, old, FAILED job; plan C: OPTIMIZING, old, no job;
    // plan D: OPTIMIZING, old, QUEUED job with routing on (kept); plan E: OPTIMIZING, future date (kept).
    const ids = { A: g.plan, B: randomUUID(), C: randomUUID(), D: randomUUID(), E: randomUUID() };
    await prisma.routePlan.update({ where: { id: g.plan }, data: { status: 'OPTIMIZING', planDate: old } });
    for (const [k, id] of Object.entries(ids)) {
      if (k === 'A') continue;
      await prisma.routePlan.create({ data: { id, companyId: g.company, name: k, planDate: k === 'E' ? new Date('2099-01-01') : old, status: 'OPTIMIZING' } });
    }
    const jobA = await prisma.routingJob.create({ data: { companyId: g.company, planId: ids.A, kind: 'optimize', status: 'QUEUED' } });
    await prisma.routingJob.create({ data: { companyId: g.company, planId: ids.B, kind: 'optimize', status: 'FAILED', finishedAt: new Date() } });
    const jobD = await prisma.routingJob.create({ data: { companyId: g.company, planId: ids.D, kind: 'optimize', status: 'QUEUED' } });
    const cutoff = new Date('2026-01-01');
    // routing on: B and C go (terminal / missing job); A and D keep their QUEUED job; E is recent.
    expect(await purgeStuckRoutePlans(prisma, g.company, cutoff, true, 50)).toBe(2);
    const left = async () => (await prisma.routePlan.findMany({ where: { companyId: g.company }, select: { id: true } })).map((p) => p.id).sort();
    expect(await left()).toEqual([ids.A, ids.D, ids.E].sort());
    // routing off: A and D go too, their jobs CANCELLED (and unlinked by the FK); E stays.
    expect(await purgeStuckRoutePlans(prisma, g.company, cutoff, false, 50)).toBe(2);
    expect(await left()).toEqual([ids.E]);
    for (const j of [jobA, jobD]) expect(await prisma.routingJob.findUniqueOrThrow({ where: { id: j.id } })).toMatchObject({ status: 'CANCELLED', planId: null, finishedAt: expect.any(Date) });
    // the stops of A went with it (cascade): no personal point outlives retention
    expect(await prisma.routePlanStop.count({ where: { planId: ids.A } })).toBe(0);
  });

  it('R4: retention vs. a late job result write (job row, then plan row): no deadlock; the written plan is kept', async () => {
    const g = await seed('r4');
    await prisma.routePlan.update({ where: { id: g.plan }, data: { status: 'OPTIMIZING', planDate: new Date('2020-01-01') } });
    const job = await prisma.routingJob.create({ data: { companyId: g.company, planId: g.plan, kind: 'optimize', status: 'RUNNING', lockedBy: 'w:late', lockedUntil: new Date(Date.now() + 60_000) } });
    const jobLocked = deferred();
    const go = deferred();
    // The worker's succeed(): the job row first, then the plan (PrismaJobStore.succeed → PrismaPlanGateway.write).
    const worker = prisma.$transaction(
      async (tx) => {
        await tx.routingJob.updateMany({ where: { id: job.id, status: 'RUNNING', lockedBy: 'w:late' }, data: { status: 'SUCCEEDED', phase: 'done', progress: 100, finishedAt: new Date(), lockedUntil: null } });
        jobLocked.resolve();
        await go.promise;
        await tx.routePlan.updateMany({ where: { id: g.plan, status: 'OPTIMIZING' }, data: { status: 'PLANNED', version: { increment: 1 } } });
      },
      TX,
    );
    await jobLocked.promise;
    const purge = purgeStuckRoutePlans(prisma, g.company, new Date('2026-01-01'), false, 10); // routing off: would cancel the job
    try {
      await until(async () => (await lockWaiters()) > 0, 30_000); // retention waits on the job row, holding no plan lock
    } finally {
      go.resolve();
    }
    await expect(worker).resolves.toBeUndefined();
    await expect(purge).resolves.toBe(0); // the plan is PLANNED now: not stuck any more
    expect(await prisma.routePlan.findUniqueOrThrow({ where: { id: g.plan } })).toMatchObject({ status: 'PLANNED' });
    expect(await prisma.routingJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ status: 'SUCCEEDED', planId: g.plan });
  });

  // ───────────────────────────── L8 ─────────────────────────────

  it('L8: triggers refuse cross-plan / cross-company links; clearing a link and purges still work', async () => {
    const g = await seed('l8');
    const h = await seed('l8-other');
    // RoutePlanStop on another plan's assignment
    expect(await sqlState(prisma.routePlanStop.update({ where: { id: g.pickups[0] }, data: { assignmentId: h.vans[0] } }))).toBe('23503');
    await expect(prisma.routePlanStop.update({ where: { id: g.pickups[0] }, data: { assignmentId: g.vans[1] } })).resolves.toBeDefined();
    await expect(prisma.routePlanStop.update({ where: { id: g.pickups[0] }, data: { assignmentId: null } })).resolves.toBeDefined();
    // RoutingJob on another company's plan
    expect(await sqlState(prisma.routingJob.create({ data: { companyId: g.company, planId: h.plan, kind: 'optimize' } }))).toBe('23503');
    const ok = await prisma.routingJob.create({ data: { companyId: g.company, planId: g.plan, kind: 'optimize', status: 'FAILED', finishedAt: new Date() } });
    expect(await sqlState(prisma.routingJob.update({ where: { id: ok.id }, data: { planId: h.plan } }))).toBe('23503');
    // TransportTrip links: plan of the trip's operator only; the assignment of that plan only
    const pt = randomUUID();
    const trip = randomUUID();
    const van = randomUUID();
    await prisma.$executeRawUnsafe(`INSERT INTO "TrackedObject" (id, "companyId", name, "updatedAt") VALUES ('${van}', '${g.company}', 'Van L8', now())`);
    await prisma.$executeRawUnsafe(`INSERT INTO "PlannedTrip" (id, "companyId", origin, "objectId", "routeName", "corridorM", "plannedStart", "plannedEnd", "updatedAt") VALUES ('${pt}', '${g.company}', 'ETMS', '${van}', 'L8', 200, '2026-12-01T02:30:00Z', '2026-12-01T03:30:00Z', now())`);
    extra.push(() => prisma.$executeRawUnsafe(`DELETE FROM "PlannedTrip" WHERE id = '${pt}'`));
    await prisma.$executeRawUnsafe(`INSERT INTO "TransportTrip" (id, "plannedTripId", "providerCompanyId", "customerCompanyId", "serviceDate", direction, "seatCapacity", "updatedAt") VALUES ('${trip}', '${pt}', '${g.company}', '${g.company}', '2026-12-01', 'IN', 4, now())`);
    extra.push(() => prisma.$executeRawUnsafe(`DELETE FROM "TransportTrip" WHERE id = '${trip}'`));
    expect(await sqlState(prisma.$executeRawUnsafe(`UPDATE "TransportTrip" SET "routePlanId" = '${h.plan}' WHERE id = '${trip}'`))).toBe('23503');
    expect(await sqlState(prisma.$executeRawUnsafe(`UPDATE "TransportTrip" SET "routePlanId" = '${g.plan}', "routeAssignmentId" = '${h.vans[0]}' WHERE id = '${trip}'`))).toBe('23503');
    expect(await prisma.$executeRawUnsafe(`UPDATE "TransportTrip" SET "routePlanId" = '${g.plan}', "routeAssignmentId" = '${g.vans[0]}' WHERE id = '${trip}'`)).toBe(1);
    // A plan purge nulls both links (FK SET NULL fires the trigger with null values: never refused).
    await prisma.routePlan.delete({ where: { id: g.plan } });
    expect(await prisma.$queryRawUnsafe(`SELECT "routePlanId", "routeAssignmentId" FROM "TransportTrip" WHERE id = '${trip}'`)).toEqual([{ routePlanId: null, routeAssignmentId: null }]);
    expect(await prisma.routingJob.findUniqueOrThrow({ where: { id: ok.id } })).toMatchObject({ planId: null });
  });

  // ───────────────────────────── QA B3 / B4 ─────────────────────────────

  it('QA B3: a successful optimisation makes the plan PLANNED; edits keep it PLANNED; a cancelled re-optimisation gives PLANNED back', async () => {
    const g = await seed('b3');
    const c = ctxFor(g.company);
    const job = (await jobs().enqueueOptimize(c, { planId: g.plan, expectedVersion: 1, timeLimitS: 5, weights: W }, `b3-${randomUUID()}`)).job;
    const worker = new RoutingJobWorker(store, new MemoryJobQueue(), new Map([['optimize', optimizeRunner({ plans: gw, matrix: new FakeMatrix(), solver: new FakeSolver(), usage: new InMemoryUsageHook() })]]), { leaseMs: 5_000, heartbeatMs: 1_000, sweepMs: 60_000, republishAfterMs: 60_000, sweepLock: async () => true }, (j) => gw.release(j), Date.now, 'db-b3');
    expect(await worker.process(job.jobId)).toBe('succeeded');
    expect(await prisma.routePlan.findUniqueOrThrow({ where: { id: g.plan } })).toMatchObject({ status: 'PLANNED', version: 2 });
    expect((await prisma.routePlanVersion.findFirstOrThrow({ where: { planId: g.plan, version: 2 } })).snapshot).toMatchObject({ status: 'PLANNED' });
    const r = await plansSvc().updateStop(c, g.plan, g.pickups[1], { expectedVersion: 2, pinned: true });
    expect(r.plan).toMatchObject({ status: 'PLANNED', version: 3, editable: true });
    const again = (await jobs().enqueueOptimize(c, { planId: g.plan, expectedVersion: 3, timeLimitS: 5, weights: W }, `b3-${randomUUID()}`)).job;
    expect((await prisma.routePlan.findUniqueOrThrow({ where: { id: g.plan } })).status).toBe('OPTIMIZING');
    await jobs().cancel(c, again.jobId);
    expect(await prisma.routePlan.findUniqueOrThrow({ where: { id: g.plan } })).toMatchObject({ status: 'PLANNED', version: 3 });
  });

  it('QA B4: the same vehicle on two routes is refused (409 VEHICLE_DUPLICATE); a seatless vehicle is reported (VEHICLE_NO_SEATS)', async () => {
    const g = await seed('b4');
    const c = ctxFor(g.company);
    const [seated, seatless] = [randomUUID(), randomUUID()];
    for (const [id, name] of [[seated, 'Van S'], [seatless, 'Van N']]) await prisma.$executeRawUnsafe(`INSERT INTO "TrackedObject" (id, "companyId", name, "updatedAt") VALUES ('${id}', '${g.company}', '${name}', now())`);
    await prisma.transportVehicleProfile.create({ data: { objectId: seated, companyId: g.company, seats: 6 } });
    extra.push(() => prisma.transportVehicleProfile.deleteMany({ where: { objectId: seated } }));
    const svc = plansSvc();
    const r1 = await svc.updateAssignment(c, g.plan, g.vans[0], { expectedVersion: 1, objectId: seated });
    expect(r1.routeViolations).toEqual([]);
    expect(await codeOf(svc.updateAssignment(c, g.plan, g.vans[1], { expectedVersion: 2, objectId: seated }))).toBe('VEHICLE_DUPLICATE');
    expect((await prisma.routeAssignment.findUniqueOrThrow({ where: { id: g.vans[1] } })).objectId).toBeNull();
    const r2 = await svc.updateAssignment(c, g.plan, g.vans[1], { expectedVersion: 2, objectId: seatless });
    expect(r2.routeViolations).toEqual([{ assignmentId: g.vans[1], code: 'VEHICLE_NO_SEATS', message: expect.any(String) }]);
  });
});


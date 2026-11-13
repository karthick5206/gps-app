/**
 * ETMS E4 WP 4.2 optimisation jobs on a real PostgreSQL with all migrations applied (RoutingJob / RoutePlan* from
 * routing_engine_v2 + etms_planning_links): the Prisma job store's compare-and-set semantics, plan reservation, the
 * worker writing a DRAFT plan version in one transaction, consent re-checked at run time, lease takeover (R4) and a
 * stale plan. Not part of the normal run (testRegex is *.spec.ts):
 *   ETMS_DB_TEST_URL=postgresql://user:pass@localhost:5432/veetrax_e4e_worker_test \
 *     npx jest --testRegex 'routing-jobs\.db-test\.ts$' --runInBand
 * Allowed databases: *_test (veetrax_assess outside CI); never veetracer. The engine and the optimiser are fakes
 * (synthetic matrix, greedy solver). Rows are committed (the store opens its own transactions) on scratch companies
 * named "etms-e4e-db-test …", which afterAll deletes again (purge mode for the consent evidence).
 */
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { dbDescribe } from '../test/scratch-db';
import { MemoryJobQueue } from './job-queue';
import { DuplicateIdempotencyKey } from './job-store';
import { RoutingJobWorker, WorkerOptions } from './job-worker';
import { optimizeRunner } from './optimize-runner';
import { PrismaJobStore } from './prisma-job-store';
import { PrismaPlanGateway } from './prisma-plan-gateway';
import { RoutingJobsService } from './routing-jobs.service';
import { cleanupSeeded, ctxFor, seedPartner, seedPlan } from './testing/db-seed';
import { AuditService } from '../audit/audit.service';
import { RoutePlanCreateService } from '../etms/planning/plan-create';
import { RoutePlansService } from '../etms/planning/plans.service';
import { FakeMatrix, FakeSolver, until } from './testing/fakes';
import { InMemoryUsageHook } from './usage-hook';

const URL_ = process.env.ETMS_DB_TEST_URL ?? '';
const { d, dbName } = dbDescribe(URL_);
const W = { vehicle: 7_200, distance: 0, time: 1, routeDuration: 0 };
const ctxForResult = ctxFor('x');
/** Waits on database state: generous, because the scratch database may be shared with other suites under load. */
const DB_WAIT_MS = 20_000;

d(`ETMS E4 optimisation jobs on ${dbName || '(no scratch DB)'}`, () => {
  jest.setTimeout(120_000);
  let prisma: PrismaClient;
  let store: PrismaJobStore;
  let gw: PrismaPlanGateway;
  const companies: string[] = [];
  let partnerId: string;

  const seed = (name: string) => seedPlan(prisma, partnerId, companies, name);

  const opts = (over: Partial<WorkerOptions> = {}): WorkerOptions => ({ leaseMs: 400, heartbeatMs: 80, sweepMs: 60_000, republishAfterMs: 60_000, sweepLock: async () => true, ...over });

  function makeWorker(id: string, matrix = new FakeMatrix(), solver = new FakeSolver(), over: Partial<WorkerOptions> = {}, jobStore: PrismaJobStore = store) {
    const queue = new MemoryJobQueue();
    const w = new RoutingJobWorker(jobStore, queue, new Map([['optimize', optimizeRunner({ plans: gw, matrix, solver, usage: new InMemoryUsageHook() })]]), opts(over), (job) => gw.release(job), Date.now, id);
    return { w, matrix, solver, queue };
  }

  async function enqueue(g: { company: string; plan: string }, key = `k-${randomUUID()}`) {
    const svc = new RoutingJobsService(store, new MemoryJobQueue(), gw, { hit: async () => true });
    return (await svc.enqueueOptimize(ctxFor(g.company), { planId: g.plan, expectedVersion: 1, timeLimitS: 5, weights: W }, key)).job;
  }

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: URL_ } } });
    store = new PrismaJobStore(prisma);
    gw = new PrismaPlanGateway(prisma);
    partnerId = await seedPartner(prisma);
  });

  afterAll(async () => {
    if (prisma) {
      expect(await cleanupSeeded(prisma, companies, partnerId)).toBe(0);
      await prisma.$disconnect();
    }
  });

  it('store: per-company idempotency key is unique (DuplicateIdempotencyKey), claims are exclusive among 5 racers', async () => {
    const g = await seed('store');
    const base = { companyId: g.company, userId: null, planId: g.plan, kind: 'optimize' as const, input: { kind: 'optimize' }, requestHash: 'h', timeoutS: 60, maxAttempts: 3 };
    const j = await store.create({ ...base, idempotencyKey: 'same-key-1' });
    await expect(store.create({ ...base, idempotencyKey: 'same-key-1' })).rejects.toBeInstanceOf(DuplicateIdempotencyKey);
    const claims = await Promise.all(['a', 'b', 'c', 'd', 'e'].map((w) => store.claim(j.id, w, new Date(), 60_000)));
    expect(claims.filter(Boolean)).toHaveLength(1);
    const winner = claims.find(Boolean)!;
    expect(winner).toMatchObject({ status: 'RUNNING', phase: 'matrix', attempts: 1 });
    expect(await store.renewLease(j.id, 'not-me', new Date(Date.now() + 1000))).toBe(false);
    expect(await store.progress(j.id, winner.lockedBy!, { phase: 'solve', progress: 50 })).toBe(true);
    expect(await store.requestCancel(randomUUID(), j.id, new Date())).toBeNull(); // other company
    expect((await store.requestCancel(g.company, j.id, new Date()))!.outcome).toBe('requested');
    expect(await store.settle(j.id, winner.lockedBy!, { to: 'CANCELLED' }, new Date())).toBe(true);
    const row = (await store.get(j.id))!;
    expect(row).toMatchObject({ status: 'CANCELLED' });
    expect(row.finishedAt).not.toBeNull();
    expect(await store.settle(j.id, winner.lockedBy!, { to: 'FAILED', error: { code: 'TIMEOUT', message: 'x' } }, new Date())).toBe(false);
  });

  it('enqueue reserves the plan (OPTIMIZING); replay returns the same job; a stale version is 409 and leaves nothing', async () => {
    const g = await seed('enqueue');
    const svc = new RoutingJobsService(store, new MemoryJobQueue(), gw, { hit: async () => true });
    const c = ctxFor(g.company);
    const a = await svc.enqueueOptimize(c, { planId: g.plan, expectedVersion: 1, weights: W }, 'enqueue-key-1');
    const b = await svc.enqueueOptimize(c, { planId: g.plan, expectedVersion: 1, weights: W }, 'enqueue-key-1');
    expect(b).toMatchObject({ replay: true, job: { jobId: a.job.jobId } });
    expect((await prisma.routePlan.findUniqueOrThrow({ where: { id: g.plan } })).status).toBe('OPTIMIZING');
    const row = await prisma.routingJob.findUniqueOrThrow({ where: { id: a.job.jobId } });
    expect(JSON.stringify(row.input)).not.toMatch(/lat|lng|13\.0|80\.2/);
    await expect(svc.enqueueOptimize(c, { planId: g.plan, expectedVersion: 1, weights: W }, 'enqueue-key-2')).rejects.toMatchObject({ status: 409 });
    const g2 = await seed('stale');
    await expect(svc.enqueueOptimize(ctxFor(g2.company), { planId: g2.plan, expectedVersion: 7, weights: W }, 'enqueue-key-3')).rejects.toMatchObject({ status: 409 });
    expect(await prisma.routingJob.count({ where: { companyId: g2.company } })).toBe(0);
    expect((await prisma.routePlan.findUniqueOrThrow({ where: { id: g2.plan } })).status).toBe('DRAFT');
    // cancel while queued releases the plan
    await svc.cancel(c, a.job.jobId);
    expect((await prisma.routePlan.findUniqueOrThrow({ where: { id: g.plan } })).status).toBe('DRAFT');
  });

  it('worker: DRAFT plan version 2 in one transaction — stops sequenced, version snapshot without coordinates', async () => {
    const g = await seed('run');
    const job = await enqueue(g);
    const { w } = makeWorker('db-w1');
    expect(await w.process(job.jobId)).toBe('succeeded');
    const plan = await prisma.routePlan.findUniqueOrThrow({ where: { id: g.plan }, include: { stops: true, assignments: true, versions: true } });
    expect(plan).toMatchObject({ status: 'PLANNED', version: 2, graphVersion: 'gh-test/2026-11-10' });
    const onVan1 = plan.stops.filter((s) => s.assignmentId === g.vans[0]).sort((a, b) => a.sequence! - b.sequence!);
    expect(onVan1.map((s) => s.stopKind)).toEqual(['PICKUP', 'PICKUP', 'PICKUP', 'DROP', 'DROP', 'DROP']);
    expect(plan.assignments.find((a) => a.id === g.vans[0])!.etaModel).toMatchObject({ calibrated: false, liveTraffic: false });
    expect(plan.versions).toHaveLength(1);
    expect(plan.versions[0]).toMatchObject({ version: 2, changeType: 'OPTIMIZED' });
    expect(JSON.stringify(plan.versions[0].snapshot)).not.toMatch(/"lat"|"lng"|Passenger|HQ|13\.0|80\.2/);
    const row = await prisma.routingJob.findUniqueOrThrow({ where: { id: job.jobId } });
    expect(row).toMatchObject({ status: 'SUCCEEDED', phase: 'done', progress: 100 });
    expect(JSON.stringify(row.result)).not.toMatch(/"lat"|"lng"|13\.0|80\.2/);
  });

  it('consent withdrawn after enqueue: the stop is left out (consent_withdrawn) and its point never reaches the engine', async () => {
    const g = await seed('consent');
    const job = await enqueue(g);
    await prisma.$executeRawUnsafe(`INSERT INTO "EmployeeTransportConsent" (id, "companyId", "profileId", purpose, "noticeVersion", granted, channel, "occurredAt") VALUES (gen_random_uuid(), '${g.company}', '${g.profiles[0]}', 'TRANSPORT_PROFILE', 'v1', false, 'WEB', now() + interval '1 second')`);
    const { w, matrix } = makeWorker('db-w2');
    expect(await w.process(job.jobId)).toBe('succeeded');
    expect(matrix.lastPoints).not.toContainEqual({ lat: 13.01, lng: 80.21 });
    const stops = await prisma.routePlanStop.findMany({ where: { planId: g.plan } });
    expect(stops.find((s) => s.id === g.pickups[0])).toMatchObject({ assignmentId: null, unassignedReason: 'consent_withdrawn' });
    expect(stops.find((s) => s.id === g.drops[0])).toMatchObject({ assignmentId: null, unassignedReason: 'consent_withdrawn' });
  });

  it('R4: worker killed mid-job → lease expires → another worker re-runs it; exactly one plan version is written', async () => {
    const g = await seed('kill');
    const job = await enqueue(g);
    const m1 = new FakeMatrix();
    m1.mode = 'hang';
    const { w: w1 } = makeWorker('db-dying', m1);
    const run = w1.process(job.jobId);
    await until(async () => (await prisma.routingJob.findUniqueOrThrow({ where: { id: job.jobId } })).status === 'RUNNING', DB_WAIT_MS);
    w1.kill();
    await run;
    // Wait for the lease to have really expired (a heartbeat in flight at kill() may have pushed it out), instead of a
    // fixed sleep that a loaded machine can outrun.
    await until(async () => (await prisma.routingJob.findUniqueOrThrow({ where: { id: job.jobId } })).lockedUntil! < new Date(), DB_WAIT_MS);
    // The sweeper is global by design (any worker recovers any company's job). Scope this rescuer to the test's own
    // company, so expired leases of other suites (or of a parallel run of this file) on the same scratch database are
    // neither counted here nor re-queued under them. Before this, a parallel run saw requeued 0 / 2 / 3 (E4 gates).
    const scoped: PrismaJobStore = Object.create(store);
    scoped.expired = async (now, limit) => (await store.expired(now, limit)).filter((j) => j.companyId === g.company);
    const { w: w2 } = makeWorker('db-rescuer', new FakeMatrix(), new FakeSolver(), {}, scoped);
    expect(await w2.sweep()).toMatchObject({ requeued: 1 });
    expect(await w2.process(job.jobId)).toBe('succeeded');
    const row = await prisma.routingJob.findUniqueOrThrow({ where: { id: job.jobId } });
    expect(row).toMatchObject({ status: 'SUCCEEDED', attempts: 2, lockedBy: expect.stringMatching(/^db-rescuer:[0-9a-f-]{36}$/) });
    expect(await prisma.routePlanVersion.count({ where: { planId: g.plan } })).toBe(1);
  });

  it('the plan changed during the run → PLAN_STALE, nothing written, plan untouched by the job', async () => {
    const g = await seed('stale-run');
    const job = await enqueue(g);
    const solver = new FakeSolver();
    const orig = solver.solve.bind(solver);
    solver.solve = async (p, s) => {
      await prisma.routePlan.update({ where: { id: g.plan }, data: { version: { increment: 1 } } }); // e.g. a consent withdrawal
      return orig(p, s);
    };
    const { w } = makeWorker('db-w3', new FakeMatrix(), solver);
    expect(await w.process(job.jobId)).toBe('failed');
    const row = await prisma.routingJob.findUniqueOrThrow({ where: { id: job.jobId } });
    expect(row).toMatchObject({ status: 'FAILED', error: { code: 'PLAN_STALE' } });
    expect(await prisma.routePlanStop.count({ where: { planId: g.plan, assignmentId: { not: null } } })).toBe(0);
    expect(await prisma.routePlanVersion.count({ where: { planId: g.plan } })).toBe(0);
  });

  it('E4 gates security L3: a plan stop pointing at another company\'s booking is left out; its window never reaches the solver', async () => {
    const g = await seed('l3-own');
    const other = await seed('l3-other');
    // A writer bug (simulated): plan A's first pickup now names company B's booking. Nothing in the schema refuses it.
    const linked = await prisma.routePlanStop
      .update({ where: { id: g.pickups[0] }, data: { bookingId: other.bookings[0] } })
      .then(() => true)
      .catch(() => false);
    if (!linked) return; // a same-company constraint on the link exists: the database already refuses it
    const job = await enqueue(g);
    const { w, solver } = makeWorker('db-l3');
    expect(await w.process(job.jobId)).toBe('succeeded');
    expect(solver.lastProblem!.stops.map((s) => s.id)).not.toContain(g.pickups[0]);
    const stop = await prisma.routePlanStop.findUniqueOrThrow({ where: { id: g.pickups[0] } });
    expect(stop).toMatchObject({ assignmentId: null, unassignedReason: 'booking_not_active' });
  });

  it('a locked route keeps its stops; a pinned stop is sent to the solver with its vehicle', async () => {
    const g = await seed('locks');
    await prisma.routePlanStop.updateMany({ where: { id: { in: [g.pickups[2], g.drops[2]] } }, data: { assignmentId: g.vans[1], sequence: 1 } });
    await prisma.routePlanStop.update({ where: { id: g.pickups[1] }, data: { assignmentId: g.vans[0], sequence: 1 } });
    await prisma.routePlan.update({ where: { id: g.plan }, data: { options: { lockedAssignmentIds: [g.vans[1]], pinnedStopIds: [g.pickups[1]] } } });
    const job = await enqueue(g);
    const { w, solver } = makeWorker('db-w4');
    expect(await w.process(job.jobId)).toBe('succeeded');
    expect(solver.lastProblem!.vehicles.map((v) => v.id)).toEqual([g.vans[0]]);
    expect(solver.lastProblem!.stops.find((s) => s.id === g.pickups[1])).toMatchObject({ pinnedVehicleId: g.vans[0] });
    expect(solver.lastProblem!.stops.map((s) => s.id)).not.toContain(g.pickups[2]);
    const locked = await prisma.routePlanStop.findMany({ where: { id: { in: [g.pickups[2], g.drops[2]] } } });
    expect(locked.every((s) => s.assignmentId === g.vans[1] && s.sequence === 1)).toBe(true);
  });

  it('POST transport/route-plans: DRAFT plan from the open bookings — consented booking points only, site windows, one route per vehicle', async () => {
    const g = await seed('create');
    await prisma.routePlan.delete({ where: { id: g.plan } });
    await prisma.transportBooking.updateMany({ where: { id: { in: g.bookings } }, data: { status: 'PENDING_ASSIGNMENT' } });
    // the passenger's profile home is somewhere else: the plan must use the booking's pickup, never the profile home
    await prisma.employeeTransportProfile.update({ where: { id: g.profiles[1] }, data: { homeLat: 12.5, homeLng: 79.5 } });
    // passenger 2 withdrew routing consent: skipped, no point copied
    await prisma.$executeRawUnsafe(`INSERT INTO "EmployeeTransportConsent" (id, "companyId", "profileId", purpose, "noticeVersion", granted, channel, "occurredAt") VALUES (gen_random_uuid(), '${g.company}', '${g.profiles[2]}', 'TRANSPORT_PROFILE', 'v1', false, 'WEB', now() + interval '1 second')`);
    const van = randomUUID();
    await prisma.$executeRawUnsafe(`INSERT INTO "TrackedObject" (id, "companyId", name, "updatedAt") VALUES ('${van}', '${g.company}', 'Van X', now())`);
    await prisma.transportVehicleProfile.create({ data: { objectId: van, companyId: g.company, seats: 6 } });
    const audit = new AuditService(prisma as never);
    const accessLog: { ids: string[]; extra: Record<string, unknown> }[] = [];
    const plans = new RoutePlansService(prisma as never, audit, { recordPersonalAccess: async (_c: unknown, _v: unknown, ids: string[], _p: unknown, extra: Record<string, unknown>) => void accessLog.push({ ids, extra }) } as never, null);
    const creator = new RoutePlanCreateService(prisma as never, audit, plans);
    const c = { ...ctxFor(g.company), permissions: { etms_dispatch: ['view'] } } as typeof ctxForResult;
    const dto = { name: 'Login 1 Dec', planDate: '2026-12-01', direction: 'IN' as const, sitePoiId: g.office, objectIds: [van], depot: { lat: 13.0828, lng: 80.2708 } }; // ~15 m from HQ: stored as HQ's own point
    const r = await creator.create(c, dto, 'create-key-0001');
    expect(r.replay).toBe(false);
    expect(r.value.skippedBookings).toEqual([{ bookingId: g.bookings[2], reason: 'consent_required' }]);
    expect(r.value).toMatchObject({ emptyReason: null, bookingCounts: { found: 3, planned: 2, skipped: 1 } });
    const plan = await prisma.routePlan.findUniqueOrThrow({ where: { id: r.value.id }, include: { stops: true, assignments: true, versions: true } });
    expect(plan).toMatchObject({ status: 'DRAFT', version: 1, direction: 'IN', sitePoiId: g.office, depot: { lat: 13.0827, lng: 80.2707 } });
    expect(plan.assignments).toEqual([expect.objectContaining({ objectId: van, capacity: 6 })]);
    expect(plan.stops).toHaveLength(4);
    const pick = plan.stops.find((s) => s.bookingId === g.bookings[1] && s.stopKind === 'PICKUP')!;
    expect(pick).toMatchObject({ lat: 13.02, lng: 80.22, profileId: g.profiles[1], poiId: null, customerCompanyId: g.company, demand: 1, name: 'Passenger pickup' });
    const drop = plan.stops.find((s) => s.bookingId === g.bookings[1] && s.stopKind === 'DROP')!;
    expect(drop).toMatchObject({ poiId: g.office, profileId: null, timeWindows: [[7_200, 10_800]] });
    expect(plan.stops.some((s) => s.lat === 12.5)).toBe(false);
    // "First L." on the plan detail for a caller who may see names, and the read is ACCESS-audited with the names.
    expect(r.value.stops.find((s) => s.bookingId === g.bookings[1] && s.stopKind === 'PICKUP')!.passengerName).toBe('Synthetic 1.');
    expect(accessLog.at(-1)).toMatchObject({ extra: { passengerNames: 2 } });
    expect(accessLog.at(-1)!.ids).toEqual(expect.arrayContaining([g.profiles[0], g.profiles[1]]));
    const noNames = await plans.get(ctxFor(g.company), r.value.id);
    expect(noNames.stops.every((s) => !s.passengerName)).toBe(true);
    expect(plan.versions).toEqual([expect.objectContaining({ version: 1, changeType: 'CREATED' })]);
    expect(JSON.stringify(plan.versions[0].snapshot)).not.toMatch(/"lat"|13.0/);
    // replay and key reuse
    expect((await creator.create(c, dto, 'create-key-0001')).replay).toBe(true);
    await expect(creator.create(c, { ...dto, name: 'Other' }, 'create-key-0001')).rejects.toMatchObject({ status: 422 });
    // another company's site: 404
    await expect(creator.create(ctxFor(randomUUID()), dto, 'create-key-0002')).rejects.toMatchObject({ status: 404 });
    // the new plan optimises end to end (weights stored on the plan)
    const svc = new RoutingJobsService(store, new MemoryJobQueue(), gw, { hit: async () => true });
    const job = (await svc.enqueueOptimize(c, { planId: plan.id, expectedVersion: 1, timeLimitS: 5, weights: W }, 'create-opt-0001')).job;
    expect(((await prisma.routePlan.findUniqueOrThrow({ where: { id: plan.id } })).options as { weights?: unknown }).weights).toEqual(W);
    const { w, solver } = makeWorker('db-w5');
    expect(await w.process(job.jobId)).toBe('succeeded');
    expect(solver.lastProblem!.options.weights).toEqual(W);

    // Security delta D1: a dispatcher limited to branch Y never learns of branch X bookings: not listed as
    // out_of_scope, not counted in bookingCounts, and the plan is reported as having found nothing.
    await prisma.transportBooking.updateMany({ where: { id: { in: g.bookings } }, data: { status: 'PENDING_ASSIGNMENT' } });
    const bx = await prisma.branch.create({ data: { companyId: g.company, name: 'Branch X' } });
    const by = await prisma.branch.create({ data: { companyId: g.company, name: 'Branch Y' } });
    try {
      await prisma.employeeTransportProfile.updateMany({ where: { id: { in: g.profiles } }, data: { branchId: bx.id } });
      await prisma.trackedObject.update({ where: { id: van }, data: { branchId: by.id } });
      const branchY = { ...c, dataScope: 'ASSIGNED', branchIds: [by.id] } as typeof ctxForResult;
      const ry = await creator.create(branchY, { ...dto, name: 'Branch Y login', branchId: by.id }, 'create-key-d1-0001');
      expect(ry.value.skippedBookings).toEqual([]);
      expect(ry.value).toMatchObject({ emptyReason: 'NO_BOOKINGS', bookingCounts: { found: 0, planned: 0, skipped: 0 } });
      for (const id of g.bookings) expect(JSON.stringify(ry.value)).not.toContain(id);
    } finally {
      await prisma.routePlan.deleteMany({ where: { companyId: g.company, name: 'Branch Y login' } });
      await prisma.trackedObject.update({ where: { id: van }, data: { branchId: null } });
      await prisma.employeeTransportProfile.updateMany({ where: { id: { in: g.profiles } }, data: { branchId: null } });
      await prisma.branch.deleteMany({ where: { id: { in: [bx.id, by.id] } } });
    }
  });

  it('retention trims finished jobs past ROUTING_JOB_RETENTION_DAYS', async () => {
    const g = await seed('retention');
    const old = await prisma.routingJob.create({ data: { companyId: g.company, kind: 'optimize', status: 'FAILED', finishedAt: new Date(Date.now() - 40 * 86_400_000) } });
    const recent = await prisma.routingJob.create({ data: { companyId: g.company, kind: 'optimize', status: 'FAILED', finishedAt: new Date(Date.now() - 29 * 86_400_000) } });
    // The retention SQL is global (retention.service.ts). A parallel run on the same scratch database may delete `old`
    // first, so the row count of this DELETE is not asserted; the outcome for this company's rows is (E4 gates).
    await prisma.$executeRaw`DELETE FROM "RoutingJob" WHERE id IN (SELECT id FROM "RoutingJob" WHERE "finishedAt" < ${new Date(Date.now() - 30 * 86_400_000)} LIMIT 5000)`;
    expect(await prisma.routingJob.findUnique({ where: { id: old.id } })).toBeNull();
    expect(await prisma.routingJob.findUnique({ where: { id: recent.id } })).not.toBeNull();
  });
});

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
import { FakeMatrix, FakeSolver, sleep, until } from './testing/fakes';
import { InMemoryUsageHook } from './usage-hook';

const URL_ = process.env.ETMS_DB_TEST_URL ?? '';
const { d, dbName } = dbDescribe(URL_);

d(`ETMS E4 optimisation jobs on ${dbName || '(no scratch DB)'}`, () => {
  jest.setTimeout(120_000);
  let prisma: PrismaClient;
  let store: PrismaJobStore;
  let gw: PrismaPlanGateway;
  const companies: string[] = [];
  let partnerId: string;

  const seed = (name: string) => seedPlan(prisma, partnerId, companies, name);

  const opts = (over: Partial<WorkerOptions> = {}): WorkerOptions => ({ leaseMs: 400, heartbeatMs: 80, sweepMs: 60_000, republishAfterMs: 60_000, sweepLock: async () => true, ...over });

  function makeWorker(id: string, matrix = new FakeMatrix(), solver = new FakeSolver(), over: Partial<WorkerOptions> = {}) {
    const queue = new MemoryJobQueue();
    const w = new RoutingJobWorker(store, queue, new Map([['optimize', optimizeRunner({ plans: gw, matrix, solver, usage: new InMemoryUsageHook() })]]), opts(over), (job) => gw.release(job), Date.now, id);
    return { w, matrix, solver, queue };
  }

  async function enqueue(g: { company: string; plan: string }, key = `k-${randomUUID()}`) {
    const svc = new RoutingJobsService(store, new MemoryJobQueue(), gw, { hit: async () => true });
    return (await svc.enqueueOptimize(ctxFor(g.company), { planId: g.plan, expectedVersion: 1, timeLimitS: 5 }, key)).job;
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
    const a = await svc.enqueueOptimize(c, { planId: g.plan, expectedVersion: 1 }, 'enqueue-key-1');
    const b = await svc.enqueueOptimize(c, { planId: g.plan, expectedVersion: 1 }, 'enqueue-key-1');
    expect(b).toMatchObject({ replay: true, job: { jobId: a.job.jobId } });
    expect((await prisma.routePlan.findUniqueOrThrow({ where: { id: g.plan } })).status).toBe('OPTIMIZING');
    const row = await prisma.routingJob.findUniqueOrThrow({ where: { id: a.job.jobId } });
    expect(JSON.stringify(row.input)).not.toMatch(/lat|lng|13\.0|80\.2/);
    await expect(svc.enqueueOptimize(c, { planId: g.plan, expectedVersion: 1 }, 'enqueue-key-2')).rejects.toMatchObject({ status: 409 });
    const g2 = await seed('stale');
    await expect(svc.enqueueOptimize(ctxFor(g2.company), { planId: g2.plan, expectedVersion: 7 }, 'enqueue-key-3')).rejects.toMatchObject({ status: 409 });
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
    expect(plan).toMatchObject({ status: 'DRAFT', version: 2, graphVersion: 'gh-test/2026-11-10' });
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
    await until(async () => (await prisma.routingJob.findUniqueOrThrow({ where: { id: job.jobId } })).status === 'RUNNING');
    w1.kill();
    await run;
    await sleep(500);
    const { w: w2 } = makeWorker('db-rescuer');
    expect(await w2.sweep()).toMatchObject({ requeued: 1 });
    expect(await w2.process(job.jobId)).toBe('succeeded');
    const row = await prisma.routingJob.findUniqueOrThrow({ where: { id: job.jobId } });
    expect(row).toMatchObject({ status: 'SUCCEEDED', attempts: 2, lockedBy: 'db-rescuer' });
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

  it('retention trims finished jobs past ROUTING_JOB_RETENTION_DAYS', async () => {
    const g = await seed('retention');
    const old = await prisma.routingJob.create({ data: { companyId: g.company, kind: 'optimize', status: 'FAILED', finishedAt: new Date(Date.now() - 40 * 86_400_000) } });
    const n = await prisma.$executeRaw`DELETE FROM "RoutingJob" WHERE id IN (SELECT id FROM "RoutingJob" WHERE "finishedAt" < ${new Date(Date.now() - 30 * 86_400_000)} LIMIT 5000)`;
    expect(n).toBeGreaterThanOrEqual(1);
    expect(await prisma.routingJob.findUnique({ where: { id: old.id } })).toBeNull();
  });
});

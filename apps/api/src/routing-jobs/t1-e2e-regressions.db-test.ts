/**
 * Regression for T1 E2E defect T1-D1 (E4 backend end-to-end, 2026-11-11) on a real PostgreSQL with all migrations:
 * the loader copied the booking window (the SITE window: IN arrival / OUT departure) onto the passenger's own pickup,
 * so every pickup had to happen inside the 35-minute arrival window (a real 18-passenger plan used 5 vans where 2
 * suffice). Not part of the normal run (testRegex is *.spec.ts):
 *   CI=true ETMS_DB_TEST_URL=postgresql://user:pass@localhost:5432/veetrax_x_test \
 *     npx jest --testRegex 't1-e2e-regressions\.db-test\.ts$' --runInBand
 * Synthetic data only (db-seed: made-up Chennai points, "Synthetic n" names); afterAll deletes it again.
 */
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { dbDescribe } from '../test/scratch-db';
import { MemoryJobQueue } from './job-queue';
import { RoutingJobWorker } from './job-worker';
import { optimizeRunner } from './optimize-runner';
import { PrismaJobStore } from './prisma-job-store';
import { PrismaPlanGateway } from './prisma-plan-gateway';
import { RoutingJobsService } from './routing-jobs.service';
import { cleanupSeeded, ctxFor, seedPartner, seedPlan } from './testing/db-seed';
import { FakeMatrix, FakeSolver } from './testing/fakes';
import { InMemoryUsageHook } from './usage-hook';

const URL_ = process.env.ETMS_DB_TEST_URL ?? '';
const { d, dbName } = dbDescribe(URL_);
const W = { vehicle: 7_200, distance: 0, time: 1, routeDuration: 0 };

d(`T1 E2E regressions on ${dbName || '(no scratch DB)'}`, () => {
  jest.setTimeout(60_000);
  let prisma: PrismaClient;
  let store: PrismaJobStore;
  let gw: PrismaPlanGateway;
  const companies: string[] = [];
  let partnerId: string;

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

  async function run(g: { company: string; plan: string }) {
    const svc = new RoutingJobsService(store, new MemoryJobQueue(), gw, { hit: async () => true });
    const job = (await svc.enqueueOptimize(ctxFor(g.company), { planId: g.plan, expectedVersion: 1, timeLimitS: 5, weights: W }, `k-${randomUUID()}`)).job;
    const solver = new FakeSolver();
    const w = new RoutingJobWorker(store, new MemoryJobQueue(), new Map([['optimize', optimizeRunner({ plans: gw, matrix: new FakeMatrix(), solver, usage: new InMemoryUsageHook() })]]), { leaseMs: 5_000, heartbeatMs: 500, sweepMs: 60_000, republishAfterMs: 60_000, sweepLock: async () => true }, (j) => gw.release(j), Date.now, `t1-${randomUUID().slice(0, 6)}`);
    expect(await w.process(job.jobId)).toBe('succeeded');
    return solver.lastProblem!;
  }

  it('T1-D1 IN trip: the booking window is the site window only; passenger pickups carry no time window', async () => {
    const g = await seedPlan(prisma, partnerId, companies, 't1-d1-in');
    const p = await run(g);
    expect(p.trip).toMatchObject({ direction: 'IN', siteWindow: [3_000, 3_600] });
    expect(p.stops.map((s) => s.id).sort()).toEqual([...g.pickups].sort());
    for (const s of p.stops) expect(s.timeWindows).toBeUndefined();
  });

  it("T1-D6 optimise with another company's plan id or an unknown id → 404 Plan not found (was a 409 \"In use\" from the FK / company check); no job row", async () => {
    const mine = await seedPlan(prisma, partnerId, companies, 't1-d6-mine');
    const theirs = await seedPlan(prisma, partnerId, companies, 't1-d6-theirs');
    const svc = new RoutingJobsService(store, new MemoryJobQueue(), gw, { hit: async () => true });
    for (const planId of [theirs.plan, randomUUID()]) {
      await expect(svc.enqueueOptimize(ctxFor(mine.company), { planId, expectedVersion: 1, timeLimitS: 5, weights: W }, `k-${randomUUID()}`)).rejects.toMatchObject({ status: 404, response: { code: 'JOB_NOT_FOUND', message: 'Plan not found' } });
    }
    expect(await prisma.routingJob.count({ where: { companyId: mine.company } })).toBe(0);
    expect((await prisma.routePlan.findUniqueOrThrow({ where: { id: theirs.plan } })).status).toBe('DRAFT');
  });

  it('T1-D1 generic plan (no direction): the booking window still applies to the stop', async () => {
    const g = await seedPlan(prisma, partnerId, companies, 't1-d1-generic');
    await prisma.routePlan.update({ where: { id: g.plan }, data: { direction: null } });
    await prisma.routePlanStop.deleteMany({ where: { id: { in: g.drops } } });
    const p = await run(g);
    expect(p.trip).toBeUndefined();
    for (const s of p.stops) expect(s.timeWindows).toEqual([[0, 3_600]]);
  });
});

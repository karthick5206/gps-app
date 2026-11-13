/**
 * v1.16 automatic route planning switches on a real PostgreSQL with every migration applied (RoutingSettings,
 * Company.settings.etms.autoRouting): platform switch default OFF, readiness refusal, audit, per-company gating, the env
 * kill switch, the worker ending a queued job ROUTING_OFF (plan back to DRAFT), retention's per-company decision.
 *   CI=true ETMS_DB_TEST_URL=postgresql://…/veetrax_x_test npx jest --testRegex 'routing-switch\.db-test\.ts$' --runInBand
 * Synthetic scratch companies ("etms-e4e-db-test …"), removed again; the RoutingSettings row is restored afterwards.
 */
import { randomUUID } from 'crypto';
import { ConflictException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import type { AuthContext } from '../access/auth-context';
import { AuditService } from '../audit/audit.service';
import { RetentionService } from '../retention/retention.service';
import { prismaPlatformSwitchReader, routingOffReasonFor, RoutingSwitchCache, setPlatformRoutingSnapshot } from '../routing-switch/routing-switch';
import { RoutingSwitchService } from '../routing-switch/routing-switch.service';
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

d(`v1.16 routing switches on ${dbName || '(no scratch DB)'}`, () => {
  jest.setTimeout(120_000);
  let prisma: PrismaClient;
  let partnerId: string;
  const companies: string[] = [];
  let saved: { enabled: boolean; updatedById: string | null } | null = null;
  const env = { ...process.env };
  let ready = true;
  const service = () =>
    new RoutingSwitchService(
      prisma as never,
      new AuditService(prisma as never),
      { client: { zrangebyscore: async () => (ready ? ['vt:health:proc:routing-worker:db-1'] : []), exists: async () => 1 } } as never,
      { configured: true, config: { baseUrl: 'http://127.0.0.1:8090', token: 't'.repeat(24), problem: null }, healthInfo: async () => ({ ok: true, ortools: '9.15', python: '3.14.0' }) } as never,
      { health: async () => ({ reachable: true, checkedAt: '' }) } as never,
    );
  const setCompany = (id: string, on: boolean) => prisma.$executeRaw`UPDATE "Company" SET settings = jsonb_set(settings, '{etms}', ${JSON.stringify(on ? { autoRouting: true } : {})}::jsonb, true) WHERE id = ${id}::uuid`;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: URL_ } } });
    partnerId = await seedPartner(prisma);
    saved = await prisma.routingSettings.findUnique({ where: { id: 'default' }, select: { enabled: true, updatedById: true } });
    await prisma.routingSettings.deleteMany({ where: { id: 'default' } });
  });

  afterAll(async () => {
    if (!prisma) return;
    process.env = { ...env };
    setPlatformRoutingSnapshot(false);
    await prisma.routingSettings.deleteMany({ where: { id: 'default' } });
    if (saved) await prisma.routingSettings.create({ data: { id: 'default', ...saved } });
    expect(await cleanupSeeded(prisma, companies, partnerId)).toBe(0);
    await prisma.$disconnect();
  });

  it('platform switch: default OFF (no row); ON refused while not ready (409, nothing stored or audited); ON when ready stored + audited; OFF audited', async () => {
    delete process.env.ETMS_ROUTING;
    const g = await seedPlan(prisma, partnerId, companies, 'switch-platform');
    const sa = { ...ctxFor(g.company), isSuperAdmin: true } as AuthContext;
    const reader = prismaPlatformSwitchReader(prisma);
    expect(await reader()).toBe(false);
    ready = false;
    await expect(service().set(sa, true)).rejects.toBeInstanceOf(ConflictException);
    expect(await prisma.routingSettings.count()).toBe(0);
    ready = true;
    const svc = service();
    expect(await svc.set(sa, true)).toMatchObject({ enabled: true, active: true, readiness: { ready: true } });
    expect(await reader()).toBe(true);
    await svc.set(sa, false);
    expect(await reader()).toBe(false);
    const audits = await prisma.auditLog.findMany({ where: { companyId: g.company, entity: 'RoutingSettings' }, orderBy: { createdAt: 'asc' } });
    expect(audits.map((a) => a.changes)).toEqual([{ enabled: { from: false, to: true } }, { enabled: { from: true, to: false } }]);
  });

  it('per company: active only with env not off + platform on + the company on; the count query reads the JSON switch', async () => {
    delete process.env.ETMS_ROUTING;
    const a = await seedPlan(prisma, partnerId, companies, 'switch-a');
    const b = await seedPlan(prisma, partnerId, companies, 'switch-b');
    await setCompany(a.company, true);
    const sa = { ...ctxFor(a.company), isSuperAdmin: true } as AuthContext;
    const svc = service();
    await svc.set(sa, true);
    const cache = new RoutingSwitchCache(prismaPlatformSwitchReader(prisma), 0, Date.now, false);
    expect(await routingOffReasonFor(prisma, cache, a.company)).toBeNull();
    expect(await routingOffReasonFor(prisma, cache, b.company)).toBe('COMPANY_OFF');
    expect((await svc.get(sa)).companiesOn).toBeGreaterThanOrEqual(1);
    process.env.ETMS_ROUTING = 'off';
    expect(await routingOffReasonFor(prisma, cache, a.company)).toBe('ENV_OFF');
    delete process.env.ETMS_ROUTING;
    await svc.set(sa, false);
    expect(await routingOffReasonFor(prisma, cache, a.company)).toBe('PLATFORM_OFF');
    // Retention (stuck OPTIMIZING plans): the same per-company decision, read from the database.
    const retention = new RetentionService(prisma as never, {} as never);
    expect(await retention.routingOn(a.company)).toBe(false);
    await svc.set(sa, true);
    expect(await retention.routingOn(a.company)).toBe(true);
    expect(await retention.routingOn(b.company)).toBe(false);
    await svc.set(sa, false);
  });

  it('switched off while a job is queued: the worker ends it FAILED ROUTING_OFF without engine work and the plan returns to DRAFT', async () => {
    delete process.env.ETMS_ROUTING;
    const g = await seedPlan(prisma, partnerId, companies, 'switch-worker');
    await setCompany(g.company, true);
    const store = new PrismaJobStore(prisma);
    const gw = new PrismaPlanGateway(prisma);
    const job = (await new RoutingJobsService(store, new MemoryJobQueue(), gw, { hit: async () => true }).enqueueOptimize(ctxFor(g.company), { planId: g.plan, expectedVersion: 1, timeLimitS: 5, weights: W }, `sw-${randomUUID()}`)).job;
    expect((await prisma.routePlan.findUniqueOrThrow({ where: { id: g.plan } })).status).toBe('OPTIMIZING');
    const cache = new RoutingSwitchCache(prismaPlatformSwitchReader(prisma), 0, Date.now, false); // platform OFF (no ON row)
    const matrix = new FakeMatrix();
    const solver = new FakeSolver();
    const worker = new RoutingJobWorker(
      store,
      new MemoryJobQueue(),
      new Map([['optimize', optimizeRunner({ plans: gw, matrix, solver, usage: new InMemoryUsageHook() })]]),
      { leaseMs: 5_000, heartbeatMs: 1_000, sweepMs: 60_000, republishAfterMs: 60_000, sweepLock: async () => true, gate: (j) => routingOffReasonFor(prisma, cache, j.companyId) },
      (j) => gw.release(j),
      Date.now,
      'db-switch',
    );
    expect(await worker.process(job.jobId)).toBe('failed');
    const row = await prisma.routingJob.findUniqueOrThrow({ where: { id: job.jobId } });
    expect(row).toMatchObject({ status: 'FAILED', error: expect.objectContaining({ code: 'ROUTING_OFF' }) });
    expect([matrix.calls, solver.calls]).toEqual([0, 0]);
    expect((await prisma.routePlan.findUniqueOrThrow({ where: { id: g.plan } })).status).toBe('DRAFT');
    await worker.stop(100);
  });
});

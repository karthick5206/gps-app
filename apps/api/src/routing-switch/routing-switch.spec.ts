import { ConflictException, ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { pythonVersionOk, ROUTING_READINESS_KEYS, type RoutingReadinessDto } from '@veetracer/shared';
import type { AuthContext } from '../access/auth-context';
import { PermissionGuard } from '../access/permission.guard';
import { resolvePermissions } from '../access/access-rules';
import { MemoryJobQueue } from '../routing-jobs/job-queue';
import { MemoryJobStore } from '../routing-jobs/job-store';
import { RoutingJobWorker, type JobRunner } from '../routing-jobs/job-worker';
import { optimizeRunner } from '../routing-jobs/optimize-runner';
import { FakeMatrix, FakePlans, FakeSolver, optimizeInput, until } from '../routing-jobs/testing/fakes';
import { InMemoryUsageHook } from '../routing-jobs/usage-hook';
import { OptimizerClient } from '../routing/optimizer/optimizer.client';
import { evaluateRoutingReadiness, type ReadinessPorts } from './routing-readiness';
import { setPlatformRoutingSnapshot, platformRoutingSnapshot } from './routing-switch';
import { RoutingSwitchController } from './routing-switch.controller';
import { RoutingSwitchService } from './routing-switch.service';

const NOW = new Date('2026-11-13T09:00:00Z');
const healthy = (): ReadinessPorts => ({
  envMode: 'auto',
  optimizer: { configured: true, config: { baseUrl: 'http://127.0.0.1:8090', token: 't'.repeat(24), problem: null }, healthInfo: jest.fn(async () => ({ ok: true, ortools: '9.15.6755', python: '3.14.0' })) },
  workers: jest.fn(async () => 1),
  engine: jest.fn(async () => ({ reachable: true, checkedAt: NOW.toISOString(), latencyMs: 4 })),
});
const failing = (r: RoutingReadinessDto) => r.checks.filter((c) => !c.ok).map((c) => c.key);

describe('routing readiness (v1.16 "if I enable it, it should work")', () => {
  it('all healthy → ready, every key checked in order, versions reported', async () => {
    const r = await evaluateRoutingReadiness(healthy(), NOW);
    expect(r.ready).toBe(true);
    expect(r.checks.map((c) => c.key)).toEqual([...ROUTING_READINESS_KEYS]);
    expect(r.checks.find((c) => c.key === 'optimizerVersion')!.detail).toBe('Python 3.14.0, OR-Tools 9.15.6755');
  });

  it('env kill switch → not ready, nothing probed', async () => {
    const p = { ...healthy(), envMode: 'off' as const };
    const r = await evaluateRoutingReadiness(p, NOW);
    expect(r.ready).toBe(false);
    expect(r.checks[0]).toMatchObject({ key: 'env', ok: false });
    expect(r.checks[0].detail).toMatch(/ETMS_ROUTING=off/);
    expect(p.optimizer.healthInfo).not.toHaveBeenCalled();
    expect(p.engine).not.toHaveBeenCalled();
    expect(p.workers).not.toHaveBeenCalled();
  });

  it('says exactly what is missing: optimiser not configured, no worker, engine down', async () => {
    const p: ReadinessPorts = { ...healthy(), optimizer: { configured: false, config: { baseUrl: '', token: '', problem: 'OPTIMIZER_URL is not set' }, healthInfo: jest.fn() }, workers: async () => 0, engine: async () => ({ reachable: false, checkedAt: '', degraded: 'ENGINE_UNREACHABLE' }) };
    const r = await evaluateRoutingReadiness(p, NOW);
    expect(failing(r)).toEqual(['optimizerConfig', 'optimizer', 'optimizerVersion', 'worker', 'engine']);
    expect(r.checks.find((c) => c.key === 'optimizerConfig')!.detail).toMatch(/OPTIMIZER_URL is not set/);
    expect(r.checks.find((c) => c.key === 'worker')!.detail).toMatch(/veetrax-routing-worker/);
    expect(p.optimizer.healthInfo).not.toHaveBeenCalled();
  });

  it('old optimiser (no Python reported) or Python below 3.14 → version check fails', async () => {
    const p = healthy();
    (p.optimizer.healthInfo as jest.Mock).mockResolvedValueOnce({ ok: true, ortools: '9.15', python: null });
    expect(failing(await evaluateRoutingReadiness(p, NOW))).toEqual(['optimizerVersion']);
    (p.optimizer.healthInfo as jest.Mock).mockResolvedValueOnce({ ok: true, ortools: '9.15', python: '3.12.3' });
    const r = await evaluateRoutingReadiness(p, NOW);
    expect(failing(r)).toEqual(['optimizerVersion']);
    expect(r.checks.find((c) => c.key === 'optimizerVersion')!.detail).toMatch(/3\.12\.3 is older than 3\.14/);
    expect([pythonVersionOk('3.14.0'), pythonVersionOk('3.15'), pythonVersionOk('4.0'), pythonVersionOk('3.13.9'), pythonVersionOk('')]).toEqual([true, true, true, false, false]);
  });

  it('details never carry a host, port or token', async () => {
    const p: ReadinessPorts = { ...healthy(), optimizer: { ...healthy().optimizer, healthInfo: async () => ({ ok: false, ortools: null, python: null }) }, engine: async () => ({ reachable: false, checkedAt: '', degraded: 'ENGINE_TIMEOUT', message: 'http://127.0.0.1:8989 timed out' }) };
    expect(JSON.stringify(await evaluateRoutingReadiness(p, NOW))).not.toMatch(/127\.0\.0\.1|8989|tttt/);
  });

  it('OptimizerClient.healthInfo reads the versions (and drops anything that is not a version string)', async () => {
    const fetchImpl = jest.fn(async () => new Response(JSON.stringify({ ok: true, ortools: '9.15.6755', python: '3.14.0<script>' }), { status: 200 }));
    const c = new OptimizerClient({ baseUrl: 'http://127.0.0.1:8090', token: 't'.repeat(24), problem: null }, fetchImpl as never);
    expect(await c.healthInfo()).toEqual({ ok: true, ortools: '9.15.6755', python: null });
    fetchImpl.mockResolvedValueOnce(new Response('{}', { status: 401 }));
    expect(await c.healthInfo()).toEqual({ ok: false, ortools: null, python: null });
    expect(await new OptimizerClient({ baseUrl: '', token: '', problem: 'x' }, fetchImpl as never).healthInfo()).toEqual({ ok: false, ortools: null, python: null });
  });
});

describe('RoutingSwitchService (platform switch, Super Admin)', () => {
  const sa = { userId: 'sa-1', companyId: 'platform', homeCompanyId: 'platform', isSuperAdmin: true } as AuthContext;
  const admin = { userId: 'u-1', companyId: 'c1', homeCompanyId: 'c1', isSuperAdmin: false } as AuthContext;
  function world(ready: boolean) {
    let row: { id: string; enabled: boolean; updatedById: string | null; updatedAt: Date } | null = null;
    const audits: unknown[] = [];
    const prisma = {
      routingSettings: {
        findUnique: jest.fn(async () => row),
        upsert: jest.fn(async ({ create, update }: { create: { enabled: boolean; updatedById: string }; update: { enabled: boolean; updatedById: string } }) => {
          row = row ? { ...row, ...update, updatedAt: NOW } : { id: 'default', ...create, updatedAt: NOW };
          return row;
        }),
      },
      $queryRaw: jest.fn(async () => [{ n: 2n }]),
      routingJob: { count: jest.fn(async () => 1) },
      user: { findUnique: jest.fn(async () => ({ name: 'Synthetic Admin' })) },
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
    };
    const audit = { record: jest.fn(async (_ctx: unknown, e: unknown) => void audits.push(e)) };
    const redis = { client: { zrangebyscore: jest.fn(async () => (ready ? ['vt:health:proc:routing-worker:h-1'] : [])), exists: jest.fn(async () => 1) } };
    const optimizer = { configured: true, config: { baseUrl: 'http://127.0.0.1:8090', token: 't'.repeat(24), problem: null }, healthInfo: jest.fn(async () => ({ ok: true, ortools: '9.15', python: '3.14.0' })) };
    const engine = { health: jest.fn(async () => ({ reachable: true, checkedAt: '' })) };
    const svc = new RoutingSwitchService(prisma as never, audit as never, redis as never, optimizer as never, engine as never);
    return { svc, prisma, audits, getRow: () => row };
  }
  const env = { ...process.env };
  beforeEach(() => {
    delete process.env.ETMS_ROUTING;
    setPlatformRoutingSnapshot(false);
  });
  afterEach(() => {
    process.env = { ...env };
    setPlatformRoutingSnapshot(false);
  });

  it('default: OFF with no row; counts and readiness reported', async () => {
    const { svc } = world(true);
    expect(await svc.get(sa)).toMatchObject({ enabled: false, envMode: 'auto', active: false, updatedAt: null, updatedBy: null, companiesOn: 2, openJobs: 1, readiness: { ready: true } });
  });

  it('ON is refused with 409 ROUTING_NOT_READY and the readiness when a check fails; nothing written or audited', async () => {
    const { svc, prisma, audits } = world(false);
    const err = await svc.set(sa, true).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    const body = (err as ConflictException).getResponse() as { code: string; readiness: RoutingReadinessDto };
    expect(body.code).toBe('ROUTING_NOT_READY');
    expect(failing(body.readiness)).toEqual(['worker']);
    expect(prisma.routingSettings.upsert).not.toHaveBeenCalled();
    expect(audits).toEqual([]);
    expect(platformRoutingSnapshot()).toBe(false);
  });

  it('ON when ready: stored, audited (before / after), snapshot on at once; OFF always works and is audited; a no-op is not', async () => {
    const { svc, audits, getRow } = world(true);
    expect(await svc.set(sa, true)).toMatchObject({ enabled: true, active: true, updatedBy: 'Synthetic Admin' });
    expect(getRow()).toMatchObject({ enabled: true, updatedById: 'sa-1' });
    expect(platformRoutingSnapshot()).toBe(true);
    await svc.set(sa, true);
    expect(audits).toEqual([{ action: 'UPDATE', entity: 'RoutingSettings', entityId: 'default', before: { enabled: false }, after: { enabled: true } }]);
    await svc.set(sa, false);
    expect(platformRoutingSnapshot()).toBe(false);
    expect(audits).toHaveLength(2);
    expect(audits[1]).toMatchObject({ before: { enabled: true }, after: { enabled: false } });
  });

  it('env kill switch: ON refused, the stored switch says nothing about activity (active false)', async () => {
    const { svc } = world(true);
    await svc.set(sa, true);
    process.env.ETMS_ROUTING = 'off';
    expect(await svc.get(sa, true)).toMatchObject({ enabled: true, envMode: 'off', active: false, readiness: { ready: false } });
    await svc.set(sa, false);
    await expect(svc.set(sa, true)).rejects.toBeInstanceOf(ConflictException);
  });

  it('only the Super Admin (service check besides the menu)', async () => {
    const { svc } = world(true);
    await expect(svc.get(admin)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.set(admin, false)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('isolation: GET / PUT /admin/routing need sa_platform_settings (a Super Admin-only menu): 403 for every company role', () => {
    const guard = new PermissionGuard(new Reflector());
    const run = (handler: 'get' | 'set', ctx: AuthContext) => {
      const exec = { getType: () => 'http', getHandler: () => RoutingSwitchController.prototype[handler], getClass: () => RoutingSwitchController, switchToHttp: () => ({ getRequest: () => ({ auth: ctx, headers: {} }) }) } as unknown as ExecutionContext;
      try {
        return guard.canActivate(exec) ? 200 : 403;
      } catch (e) {
        return (e as { getStatus?: () => number }).getStatus?.() ?? 500;
      }
    };
    const superAdmin = { ...sa, ...resolvePermissions([], true), branchIds: [], objectIds: [], ip: null } as AuthContext;
    const companyAdmin = { ...admin, isCompanyAdmin: true, permissions: { etms_settings: ['view', 'edit'], users: ['view', 'edit'] }, dataScope: 'COMPANY', branchIds: [], objectIds: [], ip: null } as unknown as AuthContext;
    expect([run('get', superAdmin), run('set', superAdmin)]).toEqual([200, 200]);
    expect([run('get', companyAdmin), run('set', companyAdmin)]).toEqual([403, 403]);
  });
});

describe('routing worker gate (v1.16: idle when off, queued jobs end cleanly)', () => {
  it('switched off before the job starts → FAILED ROUTING_OFF, no matrix / solver call, plan back to DRAFT; on → runs', async () => {
    const store = new MemoryJobStore();
    const queue = new MemoryJobQueue();
    const plans = new FakePlans();
    const matrix = new FakeMatrix();
    const solver = new FakeSolver();
    let off: string | null = 'PLATFORM_OFF';
    const gate = jest.fn(async () => off);
    const runners = new Map<string, JobRunner>([['optimize', optimizeRunner({ plans, matrix, solver, usage: new InMemoryUsageHook() })]]);
    const worker = new RoutingJobWorker(store, queue, runners, { leaseMs: 300, heartbeatMs: 60, sweepMs: 10_000, republishAfterMs: 10_000, sweepLock: async () => true, gate }, () => plans.release(), Date.now, 'w-gate');
    const job = await store.create({ companyId: 'company-1', userId: 'user-1', planId: 'plan-1', kind: 'optimize', input: optimizeInput(), idempotencyKey: null, requestHash: null, timeoutS: 30, maxAttempts: 3 });
    expect(await worker.process(job.id)).toBe('failed');
    const done = await store.get(job.id);
    expect(done).toMatchObject({ status: 'FAILED', error: { code: 'ROUTING_OFF' } });
    expect(done!.error!.message).toMatch(/switched off \(PLATFORM_OFF\)/);
    expect(gate).toHaveBeenCalledWith(expect.objectContaining({ companyId: 'company-1' }));
    expect([matrix.calls, solver.calls, plans.loads]).toEqual([0, 0, 0]);
    expect(plans.plan.status).toBe('DRAFT');

    off = null;
    plans.plan.status = 'OPTIMIZING';
    const job2 = await store.create({ companyId: 'company-1', userId: 'user-1', planId: 'plan-1', kind: 'optimize', input: optimizeInput(), idempotencyKey: null, requestHash: null, timeoutS: 30, maxAttempts: 3 });
    await until(async () => (await worker.process(job2.id)) === 'succeeded');
    expect(matrix.calls).toBe(1);
    await worker.stop(100);
    await queue.close();
  });
});

describe('company switch (Transport → Settings, etms.autoRouting)', () => {
  it('default off; on / off stored in Company.settings.etms (unmanaged keys kept), audited, whole-company scope only', async () => {
    const { TransportSettingsService } = await import('../etms/settings/transport-settings.service');
    const company = { settings: { etms: { directoryListed: false, bookingCutoffMin: 90 } } as Record<string, unknown> };
    const write = async (_s: TemplateStringsArray, key: string, json: string) => (company.settings[key] = JSON.parse(json));
    const audits: unknown[] = [];
    const settings = new TransportSettingsService(
      { company: { findUniqueOrThrow: async () => company }, $executeRaw: write, $transaction: async (fn: (tx: unknown) => unknown) => fn({ $executeRaw: write }) } as never,
      { record: async (_c: unknown, e: unknown) => void audits.push(e) } as never,
    );
    const admin = { userId: 'a', companyId: 'custA', dataScope: 'COMPANY' } as AuthContext;
    expect(await settings.get(admin)).not.toHaveProperty('autoRouting');
    expect(await settings.update(admin, { autoRouting: true })).toEqual({ directoryListed: false, autoRouting: true });
    expect(company.settings.etms).toEqual({ directoryListed: false, bookingCutoffMin: 90, autoRouting: true });
    expect(audits[0]).toMatchObject({ entity: 'etms_settings', before: { directoryListed: false }, after: { autoRouting: true } });
    expect(await settings.update(admin, { autoRouting: false })).toEqual({ directoryListed: false });
    expect(company.settings.etms).toEqual({ directoryListed: false, bookingCutoffMin: 90 });
    await expect(settings.update({ ...admin, dataScope: 'ASSIGNED' } as AuthContext, { autoRouting: true })).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('GET /api/health/routing (release health gate)', () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });
  const res = () => ({ status: jest.fn() });
  const readiness = (ready: boolean): RoutingReadinessDto => ({ ready, checkedAt: '', checks: [{ key: 'env', ok: true, detail: null }, { key: 'worker', ok: ready, detail: ready ? null : 'No routing worker heartbeat: start veetrax-routing-worker' }] });

  it('off (env kill switch) / idle (platform off, nothing probed) / on (ready 200, not ready 503 with keys only)', async () => {
    const { HealthController } = await import('../health.controller');
    const sw = { platformOn: jest.fn(async () => false), readinessNow: jest.fn(async () => readiness(true)) };
    const c = new HealthController({} as never, sw as never);
    process.env.ETMS_ROUTING = 'off';
    expect(await c.routing(res() as never)).toEqual({ ok: true, status: 'DISABLED', switch: 'off', failing: [] });
    delete process.env.ETMS_ROUTING;
    expect(await c.routing(res() as never)).toEqual({ ok: true, status: 'IDLE', switch: 'idle', failing: [] });
    expect(sw.readinessNow).not.toHaveBeenCalled();
    sw.platformOn.mockResolvedValue(true);
    const r1 = res();
    expect(await c.routing(r1 as never)).toEqual({ ok: true, status: 'OK', switch: 'on', failing: [] });
    expect(r1.status).not.toHaveBeenCalled();
    sw.readinessNow.mockResolvedValue(readiness(false));
    const r2 = res();
    const body = await c.routing(r2 as never);
    expect(body).toEqual({ ok: false, status: 'CRITICAL', switch: 'on', failing: ['worker'] });
    expect(r2.status).toHaveBeenCalledWith(503);
    expect(JSON.stringify(body)).not.toMatch(/veetrax-routing-worker/);
  });
});

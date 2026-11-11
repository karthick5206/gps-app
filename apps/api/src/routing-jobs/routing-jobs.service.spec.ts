import { HttpException } from '@nestjs/common';
import type { AuthContext } from '../access/auth-context';
import { MemoryJobQueue } from './job-queue';
import { JobRecord, MemoryJobStore, StoreTx } from './job-store';
import { RoutingHttpError } from './routing-flags';
import { PlanJobLink, RateLimiter, RoutingJobsService, toJobDto } from './routing-jobs.service';

const ctx = (over: Partial<AuthContext> = {}): AuthContext =>
  ({ userId: 'user-1', homeCompanyId: 'company-1', companyId: 'company-1', isSuperAdmin: false, permissions: {}, dataScope: 'COMPANY', branchIds: [], objectIds: [], features: ['etms'], ...over }) as AuthContext;

/** Plans of company-1 only, version 3, DRAFT; branch b1 for plan-b. */
class FakeLink implements PlanJobLink {
  status = new Map<string, string>([
    ['plan-1', 'DRAFT'],
    ['plan-2', 'DRAFT'],
    ['plan-3', 'DRAFT'],
    ['plan-b', 'DRAFT'],
  ]);
  released: string[] = [];
  async reserve(_tx: StoreTx, c: AuthContext, planId: string, expectedVersion: number) {
    if (c.companyId !== 'company-1' || !this.status.has(planId) || !(await this.visible(c, planId))) throw new RoutingHttpError('JOB_NOT_FOUND', 'Plan not found');
    if (expectedVersion !== 3) throw new RoutingHttpError('PLAN_STALE', 'stale', { currentVersion: 3 });
    if (this.status.get(planId) === 'OPTIMIZING') throw new RoutingHttpError('PLAN_NOT_EDITABLE', 'An optimisation is already running for this plan');
    this.status.set(planId, 'OPTIMIZING');
    return { profile: 'car' as const };
  }
  async release(job: Pick<JobRecord, 'planId'>) {
    this.released.push(job.planId!);
    if (this.status.get(job.planId!) === 'OPTIMIZING') this.status.set(job.planId!, 'DRAFT');
  }
  async visible(c: AuthContext, planId: string) {
    return c.dataScope === 'COMPANY' || planId !== 'plan-b' || c.branchIds.includes('b1');
  }
}

const allow: RateLimiter = { hit: async () => true };
const KEY = 'idem-key-0001';

async function codeOf(p: Promise<unknown>): Promise<{ status: number; code: string }> {
  try {
    await p;
  } catch (e) {
    const r = (e as HttpException).getResponse() as { code: string };
    return { status: (e as HttpException).getStatus(), code: r.code };
  }
  throw new Error('expected an error');
}

describe('RoutingJobsService (API side)', () => {
  let store: MemoryJobStore;
  let queue: MemoryJobQueue;
  let link: FakeLink;
  let svc: RoutingJobsService;
  beforeEach(() => {
    store = new MemoryJobStore();
    queue = new MemoryJobQueue();
    link = new FakeLink();
    svc = new RoutingJobsService(store, queue, link, allow);
  });

  it('creates a QUEUED job (input without coordinates), reserves the plan and publishes it', async () => {
    const r = await svc.enqueueOptimize(ctx(), { planId: 'plan-1', expectedVersion: 3, timeLimitS: 15 }, KEY);
    expect(r.replay).toBe(false);
    expect(r.job).toMatchObject({ kind: 'optimize', state: 'queued', phase: null, progress: 0, attempts: 0, maxAttempts: 3, planId: 'plan-1' });
    const row = (await store.get(r.job.jobId))!;
    expect(row.input).toEqual({ kind: 'optimize', planId: 'plan-1', planVersion: 3, profile: 'car', timeLimitS: 15 });
    expect(row.timeoutS).toBe(255);
    expect(link.status.get('plan-1')).toBe('OPTIMIZING');
    expect(queue.published).toEqual([r.job.jobId]);
  });

  it('Idempotency-Key: same body → the same job (replay); another body → 422 IDEMPOTENCY_KEY_REUSED; missing → 400', async () => {
    const a = await svc.enqueueOptimize(ctx(), { planId: 'plan-1', expectedVersion: 3 }, KEY);
    const b = await svc.enqueueOptimize(ctx(), { planId: 'plan-1', expectedVersion: 3 }, KEY);
    expect(b).toMatchObject({ replay: true, job: { jobId: a.job.jobId } });
    expect(store.rows.size).toBe(1);
    expect(await codeOf(svc.enqueueOptimize(ctx(), { planId: 'plan-1', expectedVersion: 3, timeLimitS: 30 }, KEY))).toEqual({ status: 422, code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(await codeOf(svc.enqueueOptimize(ctx(), { planId: 'plan-2', expectedVersion: 3 }, undefined))).toMatchObject({ status: 400 });
  });

  it('the same key in another company is a different job (keys are per company)', async () => {
    await svc.enqueueOptimize(ctx(), { planId: 'plan-1', expectedVersion: 3 }, KEY);
    expect(await codeOf(svc.enqueueOptimize(ctx({ companyId: 'company-2' }), { planId: 'plan-1', expectedVersion: 3 }, KEY))).toEqual({ status: 404, code: 'JOB_NOT_FOUND' });
  });

  it('stale plan version → 409 PLAN_STALE; a plan already optimising → 409; nothing is left behind', async () => {
    expect(await codeOf(svc.enqueueOptimize(ctx(), { planId: 'plan-1', expectedVersion: 2 }, KEY))).toEqual({ status: 409, code: 'PLAN_STALE' });
    expect(store.rows.size).toBe(0);
    link.status.set('plan-1', 'OPTIMIZING');
    expect(await codeOf(svc.enqueueOptimize(ctx(), { planId: 'plan-1', expectedVersion: 3 }, 'idem-key-0002'))).toEqual({ status: 409, code: 'PLAN_NOT_EDITABLE' });
  });

  it('per-company concurrency: the third active optimisation is 429 QUOTA_EXCEEDED', async () => {
    await svc.enqueueOptimize(ctx(), { planId: 'plan-1', expectedVersion: 3 }, 'idem-key-a001');
    await svc.enqueueOptimize(ctx(), { planId: 'plan-2', expectedVersion: 3 }, 'idem-key-a002');
    expect(await codeOf(svc.enqueueOptimize(ctx(), { planId: 'plan-3', expectedVersion: 3 }, 'idem-key-a003'))).toEqual({ status: 429, code: 'QUOTA_EXCEEDED' });
    // another company is not affected
    const other = new RoutingJobsService(store, queue, { ...link, reserve: async () => ({ profile: 'car' as const }), release: async () => undefined, visible: async () => true }, allow);
    await expect(other.enqueueOptimize(ctx({ companyId: 'company-2' }), { planId: 'plan-x', expectedVersion: 1 }, 'idem-key-a004')).resolves.toBeDefined();
  });

  it('per-user rate limit → 429 QUOTA_EXCEEDED', async () => {
    const limited = new RoutingJobsService(store, queue, link, { hit: async () => false });
    expect(await codeOf(limited.enqueueOptimize(ctx(), { planId: 'plan-1', expectedVersion: 3 }, KEY))).toEqual({ status: 429, code: 'QUOTA_EXCEEDED' });
  });

  it('a lost publish (Valkey down) still creates the job (the sweeper re-publishes it)', async () => {
    queue.publish = async () => {
      throw new Error('Valkey down');
    };
    const r = await svc.enqueueOptimize(ctx(), { planId: 'plan-1', expectedVersion: 3 }, KEY);
    expect((await store.get(r.job.jobId))!.status).toBe('QUEUED');
  });

  it('reads are company-scoped: another company gets 404; branch users do not see other branches', async () => {
    const { job } = await svc.enqueueOptimize(ctx(), { planId: 'plan-b', expectedVersion: 3 }, KEY);
    expect((await svc.get(ctx(), job.jobId)).jobId).toBe(job.jobId);
    expect(await codeOf(svc.get(ctx({ companyId: 'company-2' }), job.jobId))).toEqual({ status: 404, code: 'JOB_NOT_FOUND' });
    expect(await codeOf(svc.get(ctx({ dataScope: 'ASSIGNED', branchIds: ['b2'] }), job.jobId))).toEqual({ status: 404, code: 'JOB_NOT_FOUND' });
    expect(await svc.list(ctx({ dataScope: 'ASSIGNED', branchIds: ['b2'] }), {})).toEqual([]);
    expect(await svc.list(ctx(), { state: 'queued' })).toHaveLength(1);
    expect(await svc.list(ctx(), { state: 'failed' })).toHaveLength(0);
    expect(await svc.list(ctx({ companyId: 'company-2' }), {})).toHaveLength(0);
  });

  it('cancel: QUEUED → cancelled at once (plan released); RUNNING → cancel requested; finished → 409', async () => {
    const a = await svc.enqueueOptimize(ctx(), { planId: 'plan-1', expectedVersion: 3 }, 'idem-key-c001');
    expect(await svc.cancel(ctx(), a.job.jobId)).toMatchObject({ state: 'cancelled', cancelRequested: true });
    expect(link.status.get('plan-1')).toBe('DRAFT');
    expect(await codeOf(svc.cancel(ctx(), a.job.jobId))).toMatchObject({ status: 409 });

    const b = await svc.enqueueOptimize(ctx(), { planId: 'plan-2', expectedVersion: 3 }, 'idem-key-c002');
    await store.claim(b.job.jobId, 'w1', new Date(), 60_000);
    expect(await svc.cancel(ctx(), b.job.jobId)).toMatchObject({ state: 'running', phase: 'matrix', cancelRequested: true });
    expect(link.status.get('plan-2')).toBe('OPTIMIZING'); // the worker releases it when it stops
    expect(await codeOf(svc.cancel(ctx({ companyId: 'company-2' }), b.job.jobId))).toEqual({ status: 404, code: 'JOB_NOT_FOUND' });
  });

  it('the DTO shows a pending retry reason while QUEUED, the result only when succeeded', () => {
    const base = { id: 'j', companyId: 'c', planId: 'p', userId: null, kind: 'optimize', input: null, progress: 0, attempts: 1, maxAttempts: 3, timeoutS: 60, cancelRequested: false, idempotencyKey: null, requestHash: null, lockedBy: null, lockedUntil: null, notBefore: null, graphVersion: null, createdAt: new Date(0), startedAt: null, finishedAt: null } as const;
    const queued = toJobDto({ ...base, status: 'QUEUED', phase: null, result: null, error: { code: 'ENGINE_UNREACHABLE', message: 'down', retry: 10 } });
    expect(queued).toMatchObject({ state: 'queued', error: { code: 'ENGINE_UNREACHABLE', retry: 10 } });
    expect(queued.result).toBeUndefined();
    const done = toJobDto({ ...base, status: 'SUCCEEDED', phase: 'done', result: { status: 'FEASIBLE' }, error: null });
    expect(done).toMatchObject({ state: 'succeeded', phase: 'done', result: { status: 'FEASIBLE' } });
    expect(done.attribution).toMatch(/OpenStreetMap/);
  });
});

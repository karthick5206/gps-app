import { HttpException } from '@nestjs/common';
import * as shared from '@veetracer/shared';
import { ROUTING_LIMITS } from '@veetracer/shared';
import type { AuthContext } from '../access/auth-context';
import { MemoryJobQueue } from './job-queue';
import { JobRecord, MemoryJobStore, StoreTx } from './job-store';
import { RoutingJobWorker } from './job-worker';
import type { PlanInputs } from './optimize-problem';
import { optimizeRunner } from './optimize-runner';
import { PlanJobLink, RoutingJobsService } from './routing-jobs.service';
import { FakeMatrix, FakePlans, FakeSolver, optimizeInput, syntheticPlan } from './testing/fakes';
import { InMemoryUsageHook } from './usage-hook';
import { meaningfulReason } from '../etms/planning/plans.service';

/**
 * Owner decisions on the E4 route-optimisation patch (2026-11-11), API unit level. Synthetic data only.
 *  - Decision 2 (T3-D9): one maximum of 75 bookings per plan for draft creation and optimisation alike, counted as
 *    bookings (passengers), with the same 422 LIMIT_EXCEEDED message everywhere; the solver stop cap stays consistent.
 *  - Decision 1 (T1-D4): a company max-ride policy with an authorised, audited per-plan override. Here: the optimise
 *    request carries the override only for an authorised caller (etms_settings:edit with whole-company scope, the same
 *    authority that sets the company policy), always with a reason, and it is part of the idempotent request.
 */

type Override = { maxRideS: number; reason: string } | null | undefined;

const W = { vehicle: 7_200, distance: 0, time: 1, routeDuration: 0 };
const PLANNER = { etms_planning: ['view', 'create', 'edit', 'command'] } as AuthContext['permissions'];
const ctx = (over: Partial<AuthContext> = {}): AuthContext =>
  ({ userId: 'user-1', homeCompanyId: 'company-1', companyId: 'company-1', isSuperAdmin: false, permissions: PLANNER, dataScope: 'COMPANY', branchIds: [], objectIds: [], features: ['etms'], ip: null, ...over }) as AuthContext;
/** Transport admin: may set the company policy, so may override it for one plan. */
const admin = ctx({ permissions: { ...PLANNER, etms_settings: ['view', 'edit'] } as AuthContext['permissions'] });
/** Branch dispatcher holding the settings grant: still not whole-company, so no override. */
const branchWithSettings = ctx({ dataScope: 'ASSIGNED', branchIds: ['b1'], permissions: { ...PLANNER, etms_settings: ['view', 'edit'] } as AuthContext['permissions'] });
/** Whole-company planner without etms_settings:edit. */
const planner = ctx();

class RecordingLink implements PlanJobLink {
  calls: { planId: string; extra: unknown }[] = [];
  async reserve(_tx: StoreTx, _c: AuthContext, planId: string, _v: number, _w?: unknown, extra?: unknown) {
    this.calls.push({ planId, extra });
    return { profile: 'car' as const };
  }
  async release(_job: Pick<JobRecord, 'planId'>) {}
  async visible() {
    return true;
  }
}

async function errorOf(p: Promise<unknown>): Promise<{ status: number; code: string; message: string }> {
  try {
    await p;
  } catch (e) {
    if (!(e instanceof HttpException)) throw e;
    const r = e.getResponse() as { code: string; message: string };
    return { status: e.getStatus(), code: r.code, message: String(r.message) };
  }
  throw new Error('expected an error');
}

/** A synthetic trip-mode plan with `n` bookings (pickup + site drop each). */
function planWithBookings(n: number): PlanInputs {
  const base = syntheticPlan();
  const stops = Array.from({ length: n }, (_, i) => [
    { ...base.stops[0], id: `pick-${i}`, ref: `P${i}`, bookingId: `booking-${i}`, lat: 13 + i / 1000 },
    { ...base.stops[3], id: `drop-${i}`, ref: `D${i}`, bookingId: `booking-${i}` },
  ]).flat();
  return { ...base, stops, vehicles: base.vehicles.map((v) => ({ ...v, capacity: 80 })) };
}

async function runWorker(plans: FakePlans) {
  const store = new MemoryJobStore();
  const queue = new MemoryJobQueue();
  const w = new RoutingJobWorker(store, queue, new Map([['optimize', optimizeRunner({ plans, matrix: new FakeMatrix(), solver: new FakeSolver(), usage: new InMemoryUsageHook() })]]), { leaseMs: 5_000, heartbeatMs: 500, sweepMs: 60_000, republishAfterMs: 60_000, sweepLock: async () => true }, () => plans.release(), Date.now, 'dec-w');
  const j = await store.create({ companyId: 'company-1', userId: 'user-1', planId: 'plan-1', kind: 'optimize', input: optimizeInput(), idempotencyKey: null, requestHash: null, timeoutS: 30, maxAttempts: 1 });
  try {
    const outcome = await w.process(j.id);
    return { outcome, job: await store.getScoped('company-1', j.id) };
  } finally {
    await w.stop(200);
    await queue.close();
  }
}

describe('Decision 2: at most 75 bookings per plan (create and optimise)', () => {
  it('one shared limit of 75 bookings, consistent with the solver stop cap (75 bookings → 150 stops + depot / site)', () => {
    const limits = ROUTING_LIMITS as unknown as Record<string, number>;
    expect(limits.planBookings).toBe(75);
    expect(limits.planBookings * 2).toBeLessThanOrEqual(ROUTING_LIMITS.optimizeStops);
    expect(limits.planBookings * 2).toBeLessThanOrEqual(ROUTING_LIMITS.planStops);
    expect(limits.planBookings * 2 + 2).toBeLessThanOrEqual(ROUTING_LIMITS.optimizeLocations);
    const msg = (shared as unknown as { planBookingsLimitMessage?: (n: number) => string }).planBookingsLimitMessage;
    expect(typeof msg).toBe('function');
    expect(msg!(76)).toMatch(/^At most 75 bookings per plan \(76 found\)/);
  });

  it('the worker refuses a 76-booking plan with the bookings message (it said "150 stops" before)', async () => {
    const plans = new FakePlans();
    plans.plan = { ...planWithBookings(76), status: 'OPTIMIZING' };
    const { outcome, job } = await runWorker(plans);
    expect(outcome).toBe('failed');
    expect(job?.error).toMatchObject({ code: 'LIMIT_EXCEEDED' });
    expect(job?.error?.message).toMatch(/^At most 75 bookings per plan \(76 found\)/);
  });

  it('the worker still runs a 75-booking plan', async () => {
    const plans = new FakePlans();
    plans.plan = { ...planWithBookings(75), status: 'OPTIMIZING' };
    const { outcome, job } = await runWorker(plans);
    expect([outcome, job?.error ?? null]).toEqual(['succeeded', null]);
  });
});

describe('Decision 1: per-plan max-ride override on optimise (authorised, with a reason)', () => {
  let store: MemoryJobStore;
  let link: RecordingLink;
  let svc: RoutingJobsService;
  beforeEach(() => {
    store = new MemoryJobStore();
    link = new RecordingLink();
    svc = new RoutingJobsService(store, new MemoryJobQueue(), link, { hit: async () => true });
  });
  const optimise = (c: AuthContext, maxRideOverride: Override, key: string) => svc.enqueueOptimize(c, { planId: 'plan-1', expectedVersion: 3, weights: W, ...(maxRideOverride !== undefined ? { maxRideOverride } : {}) } as never, key);

  it('an authorised caller (etms_settings:edit, whole company) passes the override and its reason to the plan reservation', async () => {
    await optimise(admin, { maxRideS: 5_400, reason: '  Flood diversion on the ring road  ' }, 'dec-key-0001');
    expect(link.calls).toEqual([{ planId: 'plan-1', extra: { maxRideOverride: { maxRideS: 5_400, reason: 'Flood diversion on the ring road' } } }]);
  });

  it('clearing the override (null) is also an override action: authorised callers only', async () => {
    await optimise(admin, null, 'dec-key-0002');
    expect(link.calls[0].extra).toEqual({ maxRideOverride: null });
    expect(await errorOf(optimise(planner, null, 'dec-key-0003'))).toMatchObject({ status: 403, code: 'FORBIDDEN_GRANT' });
  });

  it('without the override the plan keeps what it has (nothing passed)', async () => {
    await optimise(planner, undefined, 'dec-key-0004');
    expect(link.calls[0].extra ?? {}).toEqual({});
  });

  it('403 FORBIDDEN_GRANT for a whole-company planner without etms_settings:edit and for a branch-scoped user with it; no job is created', async () => {
    for (const [c, key] of [
      [planner, 'dec-key-0005'],
      [branchWithSettings, 'dec-key-0006'],
    ] as const) {
      expect(await errorOf(optimise(c, { maxRideS: 5_400, reason: 'Long route' }, key))).toMatchObject({ status: 403, code: 'FORBIDDEN_GRANT' });
    }
    expect(link.calls).toEqual([]);
    expect(await store.list('company-1', { limit: 10 })).toEqual([]);
  });

  it('a reason is mandatory and the value must be within the policy bounds (400 VALIDATION_FAILED)', async () => {
    expect(await errorOf(optimise(admin, { maxRideS: 5_400, reason: '   ' }, 'dec-key-0007'))).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
    expect(await errorOf(optimise(admin, { maxRideS: 60, reason: 'Too short' }, 'dec-key-0008'))).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
    expect(await errorOf(optimise(admin, { maxRideS: 99_999, reason: 'Too long' }, 'dec-key-0009'))).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
    expect(link.calls).toEqual([]);
  });

  it('E4 decisions D-L4: the reason follows the publish override rule (15+ characters, two words; Hindi / Tamil letters count)', async () => {
    for (const [k, reason] of [['a', 'abc'], ['b', 'aaaaaaaaaaaaaaaaaaaa'], ['c', '1234567890 1234567890'], ['d', 'Short one']] as const) {
      expect(await errorOf(optimise(admin, { maxRideS: 5_400, reason }, `dec-key-l4-${k}`))).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
    }
    expect(link.calls).toEqual([]);
    await optimise(admin, { maxRideS: 5_400, reason: 'शिफ्ट देर से शुरू होगी आज' }, 'dec-key-l4-hi');
    await optimise(admin, { maxRideS: 5_400, reason: 'மழை காரணமாக மாற்றுப் பாதை' }, 'dec-key-l4-ta');
    expect(link.calls).toHaveLength(2);
    // One validator for both overrides.
    for (const r of ['abc', 'Short one', 'Flood diversion', 'शिफ्ट देर से शुरू होगी आज', '1234567890 1234567890']) expect(shared.meaningfulOverrideReason(r)).toBe(meaningfulReason(r));
  });

  it('the override is part of the idempotent request: the same key with another override is IDEMPOTENCY_KEY_REUSED', async () => {
    await optimise(admin, { maxRideS: 5_400, reason: 'Flood diversion' }, 'dec-key-0010');
    expect(await errorOf(optimise(admin, { maxRideS: 7_200, reason: 'Flood diversion' }, 'dec-key-0010'))).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(await errorOf(optimise(admin, undefined, 'dec-key-0010'))).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    // the very same request replays
    await expect(optimise(admin, { maxRideS: 5_400, reason: 'Flood diversion' }, 'dec-key-0010')).resolves.toMatchObject({ replay: true });
  });
});

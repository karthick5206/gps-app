import { MemoryJobQueue } from './job-queue';
import { decideFailure, busyBackoffMs } from './job-state';
import { MemoryJobStore } from './job-store';
import { JobError, RoutingJobWorker } from './job-worker';
import { matrixDeadline, optimizeRunner, SOLVE_SLACK_S } from './optimize-runner';
import { FakeMatrix, FakePlans, FakeSolver, optimizeInput } from './testing/fakes';
import { InMemoryUsageHook } from './usage-hook';

/**
 * T3 E2E (load test, 2026-11-11) defect T3-D2: an optimiser 429 ("busy": every solver slot taken) used one of the
 * job's 3 attempts and was retried after 5 s / 10 s. With more worker slots than optimiser slots, jobs FAILED after
 * about 16 s without ever being solved (8 of 12 at 3 workers / concurrency 1). Busy is not a failure of the job: it
 * must not use an attempt, it waits longer (jittered), and it gives up with a clear reason only once the job's own
 * time budget (createdAt + timeoutS) is spent. Synthetic plan only.
 */
describe('T3-D2 optimiser busy (429) does not use up the job', () => {
  let store: MemoryJobStore;
  let queue: MemoryJobQueue;
  let plans: FakePlans;
  let solver: FakeSolver;
  const workers: RoutingJobWorker[] = [];

  beforeEach(() => {
    store = new MemoryJobStore();
    queue = new MemoryJobQueue();
    plans = new FakePlans();
    solver = new FakeSolver();
  });
  afterEach(async () => {
    for (const w of workers.splice(0)) await w.stop(200);
    await queue.close();
  });

  const worker = () => {
    const runners = new Map([['optimize', optimizeRunner({ plans, matrix: new FakeMatrix(), solver, usage: new InMemoryUsageHook() })]]);
    const w = new RoutingJobWorker(store, queue, runners, { leaseMs: 300, heartbeatMs: 60, sweepMs: 60_000, republishAfterMs: 60_000, sweepLock: async () => true }, () => plans.release(), Date.now, 'w-busy');
    workers.push(w);
    return w;
  };
  const due = (id: string) => {
    store.rows.get(id)!.notBefore = new Date(0);
  };

  it('five busy answers in a row, then a free slot: the job succeeds on its first real attempt (attempts stays 1)', async () => {
    const j = await store.create({ companyId: 'company-1', userId: 'user-1', planId: 'plan-1', kind: 'optimize', input: optimizeInput(), idempotencyKey: null, requestHash: null, timeoutS: 250, maxAttempts: 3 });
    const w = worker();
    solver.mode = 'busy';
    const waits: number[] = [];
    for (let i = 0; i < 5; i++) {
      expect(await w.process(j.id)).toBe('retry');
      const row = (await store.get(j.id))!;
      expect(row).toMatchObject({ status: 'QUEUED', attempts: 0, error: { code: 'OPTIMIZER_BUSY', busy: i + 1 } });
      waits.push(row.notBefore!.getTime() - Date.now());
      due(j.id);
    }
    // Longer than the 5 s / 10 s transient back-off, growing, never above the cap.
    expect(Math.min(...waits)).toBeGreaterThanOrEqual(4_000);
    expect(Math.max(...waits)).toBeLessThanOrEqual(90_000);
    solver.mode = 'ok';
    expect(await w.process(j.id)).toBe('succeeded');
    expect((await store.get(j.id))!).toMatchObject({ status: 'SUCCEEDED', attempts: 1 });
    expect(plans.writes).toHaveLength(1);
  });

  it('busy past the job budget (createdAt + timeoutS) → FAILED OPTIMIZER_BUSY with a clear reason; nothing written', async () => {
    const j = await store.create({ companyId: 'company-1', userId: 'user-1', planId: 'plan-1', kind: 'optimize', input: optimizeInput(), idempotencyKey: null, requestHash: null, timeoutS: 250, maxAttempts: 3 });
    const w = worker();
    solver.mode = 'busy';
    expect(await w.process(j.id)).toBe('retry');
    due(j.id);
    // The job was created 249 s ago: the next busy wait would run past its 250 s budget.
    store.rows.get(j.id)!.createdAt = new Date(Date.now() - 249_000);
    expect(await w.process(j.id)).toBe('failed');
    const row = (await store.get(j.id))!;
    expect(row).toMatchObject({ status: 'FAILED', error: { code: 'OPTIMIZER_BUSY' } });
    expect(row.error!.message).toMatch(/stayed busy for 249 s/);
    expect(plans.writes).toHaveLength(0);
    expect(plans.plan.status).toBe('DRAFT');
  });

  it('a real failure after busy answers still has all its attempts (busy count resets)', async () => {
    const j = await store.create({ companyId: 'company-1', userId: 'user-1', planId: 'plan-1', kind: 'optimize', input: optimizeInput(), idempotencyKey: null, requestHash: null, timeoutS: 250, maxAttempts: 2 });
    const w = worker();
    solver.mode = 'busy';
    expect(await w.process(j.id)).toBe('retry');
    due(j.id);
    solver.mode = 'down';
    expect(await w.process(j.id)).toBe('retry');
    expect((await store.get(j.id))!).toMatchObject({ attempts: 1, error: { code: 'OPTIMIZER_UNAVAILABLE', retry: 5 } });
    expect((await store.get(j.id))!.error).not.toHaveProperty('busy');
  });

  it('decideFailure: busy waits are jittered and grow (10 s → 20 s → 40 s → 60 s cap, ±25 %); other transient codes keep 5 s / 10 s', () => {
    expect(busyBackoffMs(1, () => 0)).toBe(7_500);
    expect(busyBackoffMs(1, () => 1)).toBe(12_500);
    expect(busyBackoffMs(2, () => 0.5)).toBe(20_000);
    expect(busyBackoffMs(9, () => 0.5)).toBe(60_000);
    const now = 1_000_000;
    const busy = decideFailure({ code: 'OPTIMIZER_BUSY', message: 'Optimizer busy; retried shortly' }, { attempts: 3, maxAttempts: 3, cancelRequested: false, busy: 0, createdAtMs: now - 1_000, timeoutS: 250 }, now, () => 0.5);
    expect(busy).toMatchObject({ to: 'QUEUED', refundAttempt: true, notBeforeMs: now + 10_000, error: { code: 'OPTIMIZER_BUSY', busy: 1, retry: 10 } });
    const down = decideFailure({ code: 'OPTIMIZER_UNAVAILABLE', message: 'down' }, { attempts: 1, maxAttempts: 3, cancelRequested: false }, now);
    expect(down).toMatchObject({ to: 'QUEUED', notBeforeMs: now + 5_000 });
    expect(down).not.toHaveProperty('refundAttempt');
    // A cancel always wins.
    expect(decideFailure({ code: 'OPTIMIZER_BUSY', message: 'b' }, { attempts: 1, maxAttempts: 3, cancelRequested: true }, now)).toEqual({ to: 'CANCELLED' });
  });

  it('MATRIX_BUSY (the matrix builder queue is full) is handled the same way', () => {
    const now = 5_000_000;
    expect(decideFailure({ code: 'MATRIX_BUSY', message: 'queue full' }, { attempts: 3, maxAttempts: 3, cancelRequested: false, busy: 2, createdAtMs: now - 10_000, timeoutS: 250 }, now, () => 0.5)).toMatchObject({ to: 'QUEUED', refundAttempt: true, error: { busy: 3 } });
    expect(JobError).toBeDefined();
  });
});

describe('E4 review L3: the matrix build gets the job deadline minus the solve share', () => {
  it('matrixDeadline: claim + timeoutS − timeLimitS − slack; none without a timeout', () => {
    const startedAt = new Date(1_000_000);
    // Default job of a 30 s solve: timeoutS 270 → the matrix (queue included) must end 210 s after the claim.
    expect(matrixDeadline({ startedAt, timeoutS: 270 }, 30)).toBe(1_000_000 + (270 - 30 - SOLVE_SLACK_S) * 1000);
    expect(matrixDeadline({ startedAt: null, timeoutS: 270 }, 30, 5_000)).toBe(5_000 + 210_000);
    expect(matrixDeadline({ startedAt, timeoutS: 0 }, 30)).toBeUndefined();
  });

  it('the runner passes the deadline to the matrix port', async () => {
    const store = new MemoryJobStore();
    const queue = new MemoryJobQueue();
    const plans = new FakePlans();
    const matrix = new FakeMatrix();
    const seen: (number | undefined)[] = [];
    const build = matrix.build.bind(matrix);
    matrix.build = (p, prof, o) => (seen.push((o as { deadlineAt?: number } | undefined)?.deadlineAt), build(p, prof, o));
    const w = new RoutingJobWorker(store, queue, new Map([['optimize', optimizeRunner({ plans, matrix, solver: new FakeSolver(), usage: new InMemoryUsageHook() })]]), { leaseMs: 5_000, heartbeatMs: 500, sweepMs: 60_000, republishAfterMs: 60_000, sweepLock: async () => true }, () => plans.release(), Date.now, 'w-l3');
    const j = await store.create({ companyId: 'company-1', userId: 'user-1', planId: 'plan-1', kind: 'optimize', input: optimizeInput(), idempotencyKey: null, requestHash: null, timeoutS: 245, maxAttempts: 3 });
    const before = Date.now();
    expect(await w.process(j.id)).toBe('succeeded');
    const claimedAt = (await store.get(j.id))!.startedAt!.getTime();
    expect(claimedAt).toBeGreaterThanOrEqual(before);
    expect(seen).toEqual([claimedAt + (245 - 5 - SOLVE_SLACK_S) * 1000]); // optimizeInput: timeLimitS 5
    await w.stop(200);
    await queue.close();
  });
});

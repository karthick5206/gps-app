import { MemoryJobQueue } from './job-queue';
import { JobRecord, MemoryJobStore } from './job-store';
import { JobError, JobRunner, RoutingJobWorker, WorkerOptions } from './job-worker';
import { optimizeRunner } from './optimize-runner';
import { FakeMatrix, FakePlans, FakeSolver, optimizeInput, sleep, until } from './testing/fakes';
import { InMemoryUsageHook } from './usage-hook';

/**
 * Worker lifecycle (WP 4.2; doc 11 chaos R4 "worker crash" and R5 "engine down", in-process): several workers on one
 * store and queue, short leases. Synthetic plan only.
 */
describe('routing worker lifecycle', () => {
  let store: MemoryJobStore;
  let queue: MemoryJobQueue;
  let plans: FakePlans;
  let matrix: FakeMatrix;
  let solver: FakeSolver;
  let usage: InMemoryUsageHook;
  const workers: RoutingJobWorker[] = [];
  let lockOwner: string | null = null;

  const opts = (over: Partial<WorkerOptions> = {}): WorkerOptions => ({
    leaseMs: 300,
    heartbeatMs: 60,
    sweepMs: 100,
    republishAfterMs: 50,
    // one sweeper at a time (the holder keeps it; another takes over when the holder is gone)
    sweepLock: async (owner) => {
      if (!lockOwner || !workers.some((w) => w.id === lockOwner && !(w as unknown as { killed: boolean }).killed)) lockOwner = owner;
      return lockOwner === owner;
    },
    ...over,
  });
  const runners = () => new Map<string, JobRunner>([['optimize', optimizeRunner({ plans, matrix, solver, usage })]]);
  const worker = (id: string, over: Partial<WorkerOptions> = {}, r = runners()) => {
    const w = new RoutingJobWorker(store, queue, r, opts(over), () => plans.release(), Date.now, id);
    workers.push(w);
    return w;
  };
  const newJob = async (over: Partial<{ maxAttempts: number; timeoutS: number }> = {}): Promise<JobRecord> => {
    const j = await store.create({ companyId: 'company-1', userId: 'user-1', planId: 'plan-1', kind: 'optimize', input: optimizeInput(), idempotencyKey: null, requestHash: null, timeoutS: over.timeoutS ?? 30, maxAttempts: over.maxAttempts ?? 3 });
    await queue.publish(j.id);
    return j;
  };

  beforeEach(() => {
    store = new MemoryJobStore();
    queue = new MemoryJobQueue();
    plans = new FakePlans();
    matrix = new FakeMatrix();
    solver = new FakeSolver();
    usage = new InMemoryUsageHook();
    lockOwner = null;
  });
  afterEach(async () => {
    for (const w of workers.splice(0)) {
      (w as unknown as { killed: boolean }).killed ? undefined : await w.stop(200);
    }
    await queue.close();
  });

  it('runs a job QUEUED → MATRIX → SOLVING → DONE and stores one DRAFT plan version', async () => {
    const seen: string[] = [];
    const orig = store.progress.bind(store);
    store.progress = async (id, w, p) => {
      if (p.phase) seen.push(p.phase);
      return orig(id, w, p);
    };
    const j = await newJob();
    expect(await worker('w1').process(j.id)).toBe('succeeded');
    const row = (await store.get(j.id))!;
    expect(row).toMatchObject({ status: 'SUCCEEDED', phase: 'done', progress: 100, attempts: 1, graphVersion: 'gh-test/2026-11-10' });
    expect(seen).toEqual(['matrix', 'solve']);
    expect(plans.writes).toHaveLength(1);
    expect(plans.plan).toMatchObject({ status: 'DRAFT', version: 5 });
    // IN plan: pickups on a route, the site drops last on the same route.
    const a = plans.writes[0].write.assignments.find((x) => x.assignmentId === 'veh-a')!;
    expect(a.visits.map((v) => v.stopId)).toEqual(['pick-1', 'pick-2', 'pick-3', 'drop-1', 'drop-2', 'drop-3']);
    expect(a.visits.map((v) => v.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(usage.totals).toMatchObject({ optimizeJobs: 1, matrixCells: 25 });
    // The stored result holds ids and times only.
    expect(JSON.stringify(row.result)).not.toMatch(/"lat"|"lng"|13\.0|80\.2/);
    expect(JSON.stringify(row.input)).not.toMatch(/"lat"|"lng"/);
  });

  it('a job id delivered to five workers runs exactly once', async () => {
    const j = await newJob();
    const ws = ['a', 'b', 'c', 'd', 'e'].map((id) => worker(id));
    const out = await Promise.all(ws.map((w) => w.process(j.id)));
    expect(out.filter((o) => o === 'succeeded')).toHaveLength(1);
    expect(out.filter((o) => o === 'skipped')).toHaveLength(4);
    expect(matrix.calls).toBe(1);
    expect(plans.writes).toHaveLength(1);
  });

  it('R4: a worker killed mid-job → its lease expires → another worker takes over and finishes; one plan write', async () => {
    matrix.mode = 'hang';
    const j = await newJob();
    const w1 = worker('w1');
    w1.start(1);
    await until(async () => (await store.get(j.id))?.status === 'RUNNING');
    expect((await store.get(j.id))!.lockedBy).toBe('w1');
    w1.kill(); // SIGKILL: no heartbeat, nothing written
    matrix.mode = 'ok';
    const w2 = worker('w2');
    w2.start(1);
    await until(async () => (await store.get(j.id))?.status === 'SUCCEEDED', 5_000);
    const row = (await store.get(j.id))!;
    expect(row.attempts).toBe(2);
    expect(row.lockedBy).toBe('w2');
    expect(plans.writes).toHaveLength(1);
    expect(w2.metrics().takenOver).toBe(1);
  });

  it('R4: a slow worker that lost its lease cannot write its late result', async () => {
    solver.mode = 'hang';
    const j = await newJob();
    const w1 = worker('w1', { heartbeatMs: 10_000 }); // no heartbeat within the lease: the lease expires
    const run = w1.process(j.id);
    await until(async () => (await store.get(j.id))?.phase === 'solve');
    await sleep(350);
    const w2 = worker('w2');
    expect(await w2.sweep()).toMatchObject({ requeued: 1 });
    solver.mode = 'ok';
    expect(await w2.process(j.id)).toBe('succeeded');
    // w1 is still waiting on its solver call: end it like a dead process (it writes nothing more).
    w1.kill();
    await w1.stop(50);
    void run;
    expect(plans.writes).toHaveLength(1);
    expect(plans.writes[0].jobId).toBe(j.id);
  });

  it('R4: a job whose worker keeps dying is FAILED with WORKER_LOST after maxAttempts (no endless loop)', async () => {
    matrix.mode = 'hang';
    const j = await newJob({ maxAttempts: 2 });
    const sweeper = worker('sweeper');
    for (const id of ['w1', 'w2']) {
      const w = worker(id);
      await queue.publish(j.id);
      const run = w.process(j.id);
      await until(async () => (await store.get(j.id))?.status === 'RUNNING' && (await store.get(j.id))?.lockedBy === id);
      w.kill();
      void run;
      await sleep(350);
      await sweeper.sweep();
    }
    const row = (await store.get(j.id))!;
    expect(row).toMatchObject({ status: 'FAILED', error: { code: 'WORKER_LOST' } });
    expect(row.finishedAt).not.toBeNull();
    expect(plans.writes).toHaveLength(0);
    expect(plans.plan.status).toBe('DRAFT'); // released
  });

  it('optimiser down → retried with back-off, then FAILED with OPTIMIZER_UNAVAILABLE; no plan written', async () => {
    solver.mode = 'down';
    const j = await newJob({ maxAttempts: 2 });
    const w = worker('w1');
    expect(await w.process(j.id)).toBe('retry');
    let row = (await store.get(j.id))!;
    expect(row).toMatchObject({ status: 'QUEUED', error: { code: 'OPTIMIZER_UNAVAILABLE', retry: 5 } });
    expect(row.notBefore!.getTime()).toBeGreaterThan(Date.now() + 4_000);
    expect(await w.process(j.id)).toBe('skipped'); // not due yet
    row.notBefore = new Date(0);
    store.rows.get(j.id)!.notBefore = new Date(0);
    expect(await w.process(j.id)).toBe('failed');
    row = (await store.get(j.id))!;
    expect(row).toMatchObject({ status: 'FAILED', attempts: 2, error: { code: 'OPTIMIZER_UNAVAILABLE' } });
    expect(row.error!.message).toMatch(/gave up after 2 attempts/);
    expect(plans.writes).toHaveLength(0);
    expect(plans.plan.status).toBe('DRAFT');
  });

  it('R5: GraphHopper down → ENGINE_UNREACHABLE, retried, then FAILED; the solver is never called with invented numbers', async () => {
    matrix.mode = 'down';
    const j = await newJob({ maxAttempts: 2 });
    const w = worker('w1');
    expect(await w.process(j.id)).toBe('retry');
    expect((await store.get(j.id))!.error).toMatchObject({ code: 'ENGINE_UNREACHABLE' });
    store.rows.get(j.id)!.notBefore = new Date(0);
    expect(await w.process(j.id)).toBe('failed');
    expect((await store.get(j.id))!).toMatchObject({ status: 'FAILED', error: { code: 'ENGINE_UNREACHABLE' }, result: null });
    expect(solver.calls).toBe(0);
    expect(plans.writes).toHaveLength(0);
  });

  it('matrix not implemented (E4-B not merged) is final at once with that reason', async () => {
    matrix.mode = 'not_implemented';
    const j = await newJob();
    expect(await worker('w1').process(j.id)).toBe('failed');
    expect((await store.get(j.id))!).toMatchObject({ status: 'FAILED', attempts: 1, error: { code: 'NOT_IMPLEMENTED' } });
    expect(solver.calls).toBe(0);
  });

  it('cancel while running stops at the next heartbeat / checkpoint → CANCELLED, plan released, nothing written', async () => {
    solver.mode = 'hang';
    const j = await newJob();
    const w = worker('w1');
    const run = w.process(j.id);
    await until(async () => (await store.get(j.id))?.phase === 'solve');
    expect((await store.requestCancel('company-1', j.id, new Date()))!.outcome).toBe('requested');
    expect(await run).toBe('cancelled');
    expect((await store.get(j.id))!).toMatchObject({ status: 'CANCELLED' });
    expect(plans.writes).toHaveLength(0);
    expect(plans.plan.status).toBe('DRAFT');
  });

  it('per-job timeout → FAILED TIMEOUT (final, not retried)', async () => {
    solver.mode = 'hang';
    const j = await newJob({ timeoutS: 0.2 as unknown as number });
    expect(await worker('w1').process(j.id)).toBe('failed');
    expect((await store.get(j.id))!).toMatchObject({ status: 'FAILED', attempts: 1, error: { code: 'TIMEOUT' } });
  });

  it('a plan edited meanwhile → PLAN_STALE, result discarded', async () => {
    const j = await newJob();
    plans.plan.version = 9; // e.g. consent withdrawal bumped the version
    expect(await worker('w1').process(j.id)).toBe('failed');
    expect((await store.get(j.id))!).toMatchObject({ status: 'FAILED', error: { code: 'PLAN_STALE' } });
    expect(matrix.calls).toBe(0);
  });

  it('an optimiser answer that breaks a hard constraint is never stored', async () => {
    plans.plan.vehicles = [{ assignmentId: 'veh-a', label: 'Car', capacity: 1, type: null, wheelchairSpaces: 0 }];
    const j = await newJob();
    expect(await worker('w1').process(j.id)).toBe('failed');
    expect((await store.get(j.id))!.error).toMatchObject({ code: 'INVALID_INPUT' });
    expect((await store.get(j.id))!.error!.message).toMatch(/over capacity/);
    expect(plans.writes).toHaveLength(0);
  });

  it('an unknown runner error fails the job with a generic message (no internals leaked)', async () => {
    const boom: JobRunner = async () => {
      throw new Error('secret connection string postgres://x');
    };
    const j = await newJob();
    expect(await worker('w1', {}, new Map([['optimize', boom]])).process(j.id)).toBe('failed');
    expect((await store.get(j.id))!.error).toEqual({ code: 'INTERNAL_ERROR', message: 'Internal error while optimising; see the worker log', attempt: 1 });
  });

  it('the consumer loop picks jobs from the queue; the sweeper re-publishes a lost delivery', async () => {
    const j = await store.create({ companyId: 'company-1', userId: null, planId: 'plan-1', kind: 'optimize', input: optimizeInput(), idempotencyKey: null, requestHash: null, timeoutS: 30, maxAttempts: 3 });
    // never published (XADD failed after the insert)
    store.rows.get(j.id)!.createdAt = new Date(Date.now() - 1_000);
    const w = worker('w1');
    w.start(2);
    await until(async () => (await store.get(j.id))?.status === 'SUCCEEDED', 3_000);
    expect(plans.writes).toHaveLength(1);
  });

  it('graceful stop waits for the running job', async () => {
    const slow: JobRunner = async () => {
      await sleep(150);
      return { result: { ok: true }, graphVersion: null };
    };
    const j = await newJob();
    const w = worker('w1', {}, new Map([['optimize', slow]]));
    w.start(1);
    await until(async () => (await store.get(j.id))?.status === 'RUNNING');
    await w.stop(5_000);
    expect((await store.get(j.id))!.status).toBe('SUCCEEDED');
  });

  it('a stop outside the coverage is unassigned (outside_coverage) and never sent to the engine', async () => {
    plans.plan.stops[0] = { ...plans.plan.stops[0], lat: 51.5, lng: -0.12 }; // synthetic point outside India
    const j = await newJob();
    expect(await worker('w1').process(j.id)).toBe('succeeded');
    expect(matrix.lastPoints).not.toContainEqual({ lat: 51.5, lng: -0.12 });
    expect(plans.writes[0].write.unassigned).toContainEqual({ stopId: 'pick-1', reason: 'outside_coverage' });
    expect(plans.writes[0].write.unassigned).toContainEqual({ stopId: 'drop-1', reason: 'outside_coverage' });
  });

  it('every passenger without consent left out: no engine or solver call, an empty DRAFT is stored', async () => {
    plans.plan.excluded = plans.plan.stops.filter((s) => !s.atSite).map((s) => ({ stopId: s.id, reason: 'consent_withdrawn' }));
    plans.plan.stops = plans.plan.stops.filter((s) => s.atSite);
    const j = await newJob();
    expect(await worker('w1').process(j.id)).toBe('succeeded');
    expect(matrix.calls + solver.calls).toBe(0);
    expect(plans.writes[0].write.unassigned.map((u) => u.reason)).toEqual(expect.arrayContaining(['consent_withdrawn']));
  });

  it('JobError codes surface unchanged (typed degraded reasons, never a number)', async () => {
    const r: JobRunner = async () => {
      throw new JobError('POINT_NOT_ON_ROAD', 'The depot or site is not on the road network');
    };
    const j = await newJob();
    await worker('w1', {}, new Map([['optimize', r]])).process(j.id);
    expect((await store.get(j.id))!.error).toMatchObject({ code: 'POINT_NOT_ON_ROAD' });
  });
});

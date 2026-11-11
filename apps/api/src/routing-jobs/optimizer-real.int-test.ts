/**
 * Real-process check of the worker against the actual OR-Tools service (services/routing-optimizer, contract v2):
 * the problems the worker builds are accepted, the answers pass the worker's own verification and are stored as a
 * DRAFT write, pins are honoured, and a stopped optimiser ends as FAILED OPTIMIZER_UNAVAILABLE (never a made-up plan).
 * Matrices are synthetic test fixtures (|i − j| × 60 s), never ETAs. Not part of the normal run:
 *
 *   # start the service (venv per services/routing-optimizer/README.md; loopback only)
 *   OPTIMIZER_TOKEN=<token> python -m optimizer.server --host 127.0.0.1 --port 18090
 *   ROUTING_OPTIMIZER_TEST_URL=http://127.0.0.1:18090 ROUTING_OPTIMIZER_TEST_TOKEN=<token> \
 *     npx jest --testRegex 'optimizer-real\.int-test\.ts$' --runInBand
 */
import { OptimizerClient, readOptimizerConfig } from '../routing/optimizer/optimizer.client';
import { MemoryJobQueue } from './job-queue';
import { MemoryJobStore } from './job-store';
import { RoutingJobWorker } from './job-worker';
import { optimizeRunner } from './optimize-runner';
import { solverPort } from './optimizer-port';
import { FakeMatrix, FakePlans, optimizeInput, syntheticPlan } from './testing/fakes';
import { InMemoryUsageHook } from './usage-hook';
import type { PlanInputs } from './optimize-problem';

const URL_ = process.env.ROUTING_OPTIMIZER_TEST_URL ?? '';
const TOKEN = process.env.ROUTING_OPTIMIZER_TEST_TOKEN ?? '';
if (process.env.OPTIMIZER_INT_REQUIRED === '1' && !(URL_ && TOKEN)) {
  throw new Error('OPTIMIZER_INT_REQUIRED=1 but ROUTING_OPTIMIZER_TEST_URL / ROUTING_OPTIMIZER_TEST_TOKEN are not set');
}
const d = URL_ && TOKEN ? describe : describe.skip;

const client = (url = URL_) => new OptimizerClient(readOptimizerConfig({ ETMS_ROUTING: 'on', OPTIMIZER_URL: url, OPTIMIZER_TOKEN: TOKEN }));

/** 8 pickups (2 seats each way round), 3 vans of 4 seats, site arrival window [3000, 3600]. */
function bigPlan(direction: 'IN' | 'OUT'): PlanInputs {
  const base = syntheticPlan({ direction });
  const pickups = Array.from({ length: 8 }, (_, i) => ({
    id: `pick-${i}`,
    ref: `P${i}`,
    lat: 13 + i / 200,
    lng: 80.2 + i / 200,
    demand: 1,
    serviceS: 30,
    timeWindows: direction === 'IN' ? ([[0, 3_600]] as [number, number][]) : ([[3_000, 9_000]] as [number, number][]),
    stopKind: (direction === 'IN' ? 'PICKUP' : 'DROP') as 'PICKUP' | 'DROP',
    bookingId: `booking-${i}`,
    personal: true,
    atSite: false,
    customerId: 'cust-1',
  }));
  const site = pickups.map((p, i) => ({ ...p, id: `site-${i}`, ref: `S${i}`, lat: 13.0827, lng: 80.2707, demand: 0, serviceS: 0, timeWindows: [[3_000, 3_600]] as [number, number][], stopKind: (direction === 'IN' ? 'DROP' : 'PICKUP') as 'PICKUP' | 'DROP', personal: false, atSite: true }));
  return {
    ...base,
    stops: [...pickups, ...site],
    vehicles: ['v1', 'v2', 'v3'].map((id) => ({ assignmentId: id, label: id, capacity: 4, type: 'VAN', wheelchairSpaces: 0 })),
  };
}

d('worker ↔ real routing optimiser (contract v2)', () => {
  jest.setTimeout(120_000);

  async function run(plan: PlanInputs, c = client(), maxAttempts = 3) {
    const store = new MemoryJobStore();
    const plans = new FakePlans();
    plans.plan = { ...plan, status: 'OPTIMIZING' };
    const matrix = new FakeMatrix();
    const w = new RoutingJobWorker(
      store,
      new MemoryJobQueue(),
      new Map([['optimize', optimizeRunner({ plans, matrix, solver: solverPort(c), usage: new InMemoryUsageHook() })]]),
      { leaseMs: 30_000, heartbeatMs: 5_000, sweepMs: 60_000, republishAfterMs: 60_000, sweepLock: async () => true },
      async () => undefined,
      Date.now,
      'real-1',
    );
    const job = await store.create({ companyId: 'company-1', userId: null, planId: 'plan-1', kind: 'optimize', input: optimizeInput(plan.version), idempotencyKey: null, requestHash: null, timeoutS: 60, maxAttempts });
    const outcome = await w.process(job.id);
    return { outcome, row: (await store.get(job.id))!, plans, store, w, jobId: job.id };
  }

  it('the service is up and accepts the token', async () => {
    expect(await client().health()).toBe(true);
  });

  it('IN (login): every passenger routed within 4 seats per van, site drops last at the site arrival, DRAFT written', async () => {
    const { outcome, row, plans } = await run(bigPlan('IN'));
    expect(outcome).toBe('succeeded');
    const w = plans.writes[0].write;
    const routed = w.assignments.flatMap((a) => a.visits.map((v) => v.stopId));
    expect(routed.filter((s) => s.startsWith('pick-')).sort()).toEqual(Array.from({ length: 8 }, (_, i) => `pick-${i}`).sort());
    for (const a of w.assignments.filter((x) => x.visits.length)) {
      expect(a.visits.filter((v) => v.stopId.startsWith('pick-')).length).toBeLessThanOrEqual(4);
      const last = a.visits[a.visits.length - 1];
      expect(last.stopId).toMatch(/^site-/);
      expect(last.etaS).toBe(a.endS);
      expect(a.endS!).toBeGreaterThanOrEqual(3_000);
      expect(a.endS!).toBeLessThanOrEqual(3_600);
    }
    expect(row.result).toMatchObject({ provenOptimal: expect.any(Boolean) });
  });

  it('OUT (logout): site pickups first, drops after the site departure', async () => {
    const { outcome, plans } = await run(bigPlan('OUT'));
    expect(outcome).toBe('succeeded');
    for (const a of plans.writes[0].write.assignments.filter((x) => x.visits.length)) {
      expect(a.visits[0].stopId).toMatch(/^site-/);
      expect(a.visits[0].etaS!).toBeGreaterThanOrEqual(3_000);
    }
  });

  it('a pinned stop stays on its vehicle', async () => {
    const plan = bigPlan('IN');
    plan.stops[0].pinnedAssignmentId = 'v3';
    const { outcome, plans } = await run(plan);
    expect(outcome).toBe('succeeded');
    expect(plans.writes[0].write.assignments.find((a) => a.assignmentId === 'v3')!.visits.map((v) => v.stopId)).toContain('pick-0');
  });

  it('too many passengers for the seats: the rest are unassigned with a reason and code, nothing invented', async () => {
    const plan = bigPlan('IN');
    plan.vehicles = [{ assignmentId: 'v1', label: 'v1', capacity: 4, type: 'VAN', wheelchairSpaces: 0 }];
    const { outcome, plans } = await run(plan);
    expect(outcome).toBe('succeeded');
    const un = plans.writes[0].write.unassigned.filter((u) => u.stopId.startsWith('pick-'));
    expect(un).toHaveLength(4);
    for (const u of un) expect(u).toMatchObject({ reason: 'not_scheduled_capacity_or_time', code: 'CAPACITY_EXHAUSTED' });
  });

  it('optimiser stopped (nothing listening): retried, then FAILED OPTIMIZER_UNAVAILABLE; no plan written', async () => {
    const dead = client('http://127.0.0.1:18099');
    const first = await run(bigPlan('IN'), dead, 1);
    expect(first.outcome).toBe('failed');
    expect(first.row).toMatchObject({ status: 'FAILED', error: { code: 'OPTIMIZER_UNAVAILABLE' } });
    expect(first.plans.writes).toHaveLength(0);
  });

  it('wrong token: OPTIMIZER_UNAVAILABLE (401 is not a solved plan)', async () => {
    const bad = new OptimizerClient(readOptimizerConfig({ ETMS_ROUTING: 'on', OPTIMIZER_URL: URL_, OPTIMIZER_TOKEN: 'x'.repeat(32) }));
    const r = await run(bigPlan('IN'), bad, 1);
    expect(r.row).toMatchObject({ status: 'FAILED', error: { code: 'OPTIMIZER_UNAVAILABLE' } });
  });
});

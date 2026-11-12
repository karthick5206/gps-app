import type { SolverResult } from '@veetracer/shared';
import { MemoryJobQueue } from './job-queue';
import { MemoryJobStore } from './job-store';
import { RoutingJobWorker } from './job-worker';
import { mapSolverResult, planPoints, siteWindowConflicts } from './optimize-problem';
import { optimizeRunner } from './optimize-runner';
import { FakeMatrix, FakePlans, FakeSolver, optimizeInput, syntheticPlan } from './testing/fakes';
import { InMemoryUsageHook } from './usage-hook';

/**
 * Regressions for the T1 E2E defects (E4 backend end-to-end, 2026-11-11). Synthetic plan only.
 *  - T1-D2: trip-mode site windows that share no span (a plan holding 08:20–08:55 and 10:20–10:55 bookings) fell back to
 *    the widest span, so the solver timed 08:20–08:55 passengers at the site at 10:55 and nothing caught it.
 *  - T1-D3: the site end of a booking the solver left out was reported without the solver's code.
 */
describe('T1 E2E regressions', () => {
  const withDrop1Window = (w: [number, number]) => {
    const inp = syntheticPlan();
    inp.stops = inp.stops.map((s) => (s.id === 'drop-1' ? { ...s, timeWindows: [w] } : s));
    return inp;
  };

  it('T1-D2: non-overlapping site windows → the minority booking (both stops) is left out as time_window_unreachable', () => {
    expect(siteWindowConflicts(syntheticPlan())).toEqual([]);
    expect(siteWindowConflicts(withDrop1Window([9_000, 9_600]))).toEqual([
      { stopId: 'pick-1', reason: 'time_window_unreachable', bookingId: 'booking-1' },
      { stopId: 'drop-1', reason: 'time_window_unreachable', bookingId: 'booking-1' },
    ]);
    // overlapping (not identical) windows are compatible
    expect(siteWindowConflicts(withDrop1Window([3_300, 4_000]))).toEqual([]);
  });

  it('T1-D2: through the worker, the solver gets a site window inside every routed booking window; the other booking is unassigned', async () => {
    const store = new MemoryJobStore();
    const queue = new MemoryJobQueue();
    const plans = new FakePlans();
    plans.plan = { ...withDrop1Window([9_000, 9_600]), status: 'OPTIMIZING' };
    const solver = new FakeSolver();
    const w = new RoutingJobWorker(store, queue, new Map([['optimize', optimizeRunner({ plans, matrix: new FakeMatrix(), solver, usage: new InMemoryUsageHook() })]]), { leaseMs: 5_000, heartbeatMs: 500, sweepMs: 60_000, republishAfterMs: 60_000, sweepLock: async () => true }, () => plans.release(), Date.now, 't1-w');
    const j = await store.create({ companyId: 'company-1', userId: 'user-1', planId: 'plan-1', kind: 'optimize', input: optimizeInput(), idempotencyKey: null, requestHash: null, timeoutS: 30, maxAttempts: 3 });
    try {
      expect(await w.process(j.id)).toBe('succeeded');
    } finally {
      await w.stop(200);
      await queue.close();
    }
    expect(solver.lastProblem!.trip!.siteWindow).toEqual([3_000, 3_600]);
    expect(solver.lastProblem!.stops.map((s) => s.id)).toEqual(['pick-2', 'pick-3']);
    expect(plans.writes[0].write.unassigned).toEqual(
      expect.arrayContaining([
        { stopId: 'pick-1', reason: 'time_window_unreachable' },
        { stopId: 'drop-1', reason: 'time_window_unreachable' },
      ]),
    );
    expect(plans.writes[0].write.assignments.flatMap((a) => a.visits.map((v) => v.stopId))).not.toContain('drop-1');
  });

  it("T1-D2: a site arrival inside the trip window but outside the booking's own window is never stored", () => {
    const inp = withDrop1Window([9_000, 9_600]);
    const b = planPoints(inp);
    const r = {
      status: 'FEASIBLE',
      provenOptimal: false,
      routes: [{ vehicleId: 'veh-a', startS: 2_000, endS: 3_500, durationS: 1_500, distanceM: 1_000, locationSequence: [], load: 3, stops: ['pick-1', 'pick-2', 'pick-3'].map((stopId, i) => ({ stopId, locationIndex: 2 + i, arrivalS: 2_300 + 300 * i, serviceStartS: 2_300 + 300 * i, waitS: 0, departureS: 2_360 + 300 * i, load: i + 1 })) }],
      unassigned: [],
      trip: { siteWindow: [3_000, 9_600] },
    } as unknown as SolverResult;
    expect(() => mapSolverResult(inp, b, r, 'gh')).toThrow(/outside the booking's own window/);
  });

  it("T1-D3: the site end of a booking the solver left out carries the solver's code", () => {
    const inp = syntheticPlan();
    const b = planPoints(inp);
    const r = {
      status: 'FEASIBLE',
      provenOptimal: false,
      routes: [{ vehicleId: 'veh-a', startS: 2_000, endS: 3_500, durationS: 1_500, distanceM: 1_000, locationSequence: [], load: 2, stops: ['pick-2', 'pick-3'].map((stopId, i) => ({ stopId, locationIndex: 3 + i, arrivalS: 2_600 + 300 * i, serviceStartS: 2_600 + 300 * i, waitS: 0, departureS: 2_660 + 300 * i, load: i + 1 })) }],
      unassigned: [{ stopId: 'pick-1', reason: 'max_ride_unachievable', code: 'MAX_RIDE_UNACHIEVABLE' }],
    } as unknown as SolverResult;
    const { result } = mapSolverResult(inp, b, r, 'gh');
    expect(result.unassigned).toEqual(
      expect.arrayContaining([
        { stopId: 'pick-1', reason: 'max_ride_unachievable', code: 'MAX_RIDE_UNACHIEVABLE' },
        { stopId: 'drop-1', reason: 'max_ride_unachievable', code: 'MAX_RIDE_UNACHIEVABLE' },
      ]),
    );
  });
});

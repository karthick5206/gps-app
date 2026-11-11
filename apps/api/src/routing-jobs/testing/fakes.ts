import type { SolverResult } from '@veetracer/shared';
import type { JobRecord, StoreTx } from '../job-store';
import { JobError } from '../job-worker';
import type { BuiltMatrix, MatrixOutcome, MatrixPoint, MatrixPort } from '../matrix-port';
import type { PlanInputs, PlanWrite, SolverProblemV2 } from '../optimize-problem';
import type { OptimizeJobInput, PlanGateway, SolverPort } from '../optimize-runner';

/**
 * Test doubles for the optimisation worker (synthetic data only: made-up Chennai-area points, no real passenger).
 * Matrices here are test fixtures, never ETAs.
 */
export const SITE = { lat: 13.0827, lng: 80.2707 };
export const DEPOT = { lat: 13.06, lng: 80.25 };

export function syntheticPlan(over: Partial<PlanInputs> = {}): PlanInputs {
  const stops = [1, 2, 3].map((i) => ({
    id: `pick-${i}`,
    ref: `P${i}`,
    lat: 13 + i / 100,
    lng: 80.2 + i / 100,
    demand: 1,
    serviceS: 60,
    timeWindows: null,
    stopKind: 'PICKUP' as const,
    bookingId: `booking-${i}`,
    personal: true,
    atSite: false,
    customerId: 'cust-1',
  }));
  const drops = [1, 2, 3].map((i) => ({
    id: `drop-${i}`,
    ref: `D${i}`,
    ...SITE,
    demand: 0,
    serviceS: 0,
    timeWindows: [[3_000, 3_600]] as [number, number][],
    stopKind: 'DROP' as const,
    bookingId: `booking-${i}`,
    personal: false,
    atSite: true,
    customerId: 'cust-1',
  }));
  return {
    planId: 'plan-1',
    companyId: 'company-1',
    version: 4,
    profile: 'car',
    direction: 'IN',
    depot: DEPOT,
    site: SITE,
    maxRideS: null,
    stops: [...stops, ...drops],
    vehicles: [
      { assignmentId: 'veh-a', label: 'Van A', capacity: 4, type: 'VAN', wheelchairSpaces: 0 },
      { assignmentId: 'veh-b', label: 'Van B', capacity: 4, type: 'VAN', wheelchairSpaces: 0 },
    ],
    excluded: [],
    ...over,
  };
}

/** Square test matrix: |i − j| × 60 s and × 500 m. */
export function testMatrix(n: number, graphVersion = 'gh-test/2026-11-10'): BuiltMatrix {
  const grid = (k: number) => Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => Math.abs(i - j) * k));
  return { durationsS: grid(60), distancesM: grid(500), snapped: Array(n).fill(null), invalid: [], graphVersion, cells: { requested: n * n, computed: n * n, cached: 0 } };
}

export class FakeMatrix implements MatrixPort {
  calls = 0;
  /** What the next calls answer (default: a test matrix of the requested size). */
  mode: 'ok' | 'down' | 'not_implemented' | 'hang' = 'ok';
  lastPoints: MatrixPoint[] = [];
  async build(points: MatrixPoint[], _p: string, opts?: { signal?: AbortSignal; onProgress?: (d: number, t: number) => Promise<void> }): Promise<MatrixOutcome> {
    this.calls++;
    this.lastPoints = points;
    if (this.mode === 'down') return { ok: false, degraded: 'ENGINE_UNREACHABLE', message: 'GraphHopper not reachable' };
    if (this.mode === 'not_implemented') return { ok: false, degraded: 'NOT_IMPLEMENTED', message: 'matrix not implemented' };
    if (this.mode === 'hang') await new Promise<never>((_, reject) => opts?.signal?.addEventListener('abort', () => reject(opts.signal!.reason as Error), { once: true }));
    await opts?.onProgress?.(points.length, points.length);
    return { ok: true, value: testMatrix(points.length) };
  }
}

/** Puts every stop on the first vehicle, in order, 300 s apart (IN: arrival at the site afterwards). */
export function greedySolve(p: SolverProblemV2): SolverResult {
  const v = p.vehicles[0];
  const window = p.trip?.siteWindow ?? [0, p.horizonS];
  let t = Math.max(0, window[1] - 300 * (p.stops.length + 1));
  const stops = p.stops.map((s, i) => {
    t += 300;
    return { stopId: s.id, locationIndex: s.locationIndex, arrivalS: t, serviceStartS: t, waitS: 0, departureS: t + (s.serviceS ?? 0), load: i + 1 };
  });
  const endS = p.trip?.direction === 'IN' ? window[1] : t + 300;
  return {
    status: 'FEASIBLE',
    provenOptimal: false,
    routes: stops.length ? [{ vehicleId: v.id, startS: stops[0].arrivalS - 300, endS, durationS: endS - stops[0].arrivalS + 300, distanceM: 1234, locationSequence: [], stops, load: stops.length }] : [],
    unassigned: [],
    ...(p.trip ? { trip: p.trip } : {}),
  } as SolverResult;
}

export class FakeSolver implements SolverPort {
  calls = 0;
  mode: 'ok' | 'down' | 'busy' | 'hang' = 'ok';
  lastProblem: SolverProblemV2 | null = null;
  async solve(p: SolverProblemV2, signal?: AbortSignal): Promise<SolverResult> {
    this.calls++;
    this.lastProblem = p;
    if (this.mode === 'down') throw new JobError('OPTIMIZER_UNAVAILABLE', 'Optimizer unavailable');
    if (this.mode === 'busy') throw new JobError('OPTIMIZER_BUSY', 'Optimizer busy; retried shortly');
    if (this.mode === 'hang') await new Promise<never>((_, reject) => signal?.addEventListener('abort', () => reject(signal.reason as Error), { once: true }));
    return greedySolve(p);
  }
}

/** In-memory plan: version / status checks like PrismaPlanGateway; records each write (one per committed result). */
export class FakePlans implements PlanGateway {
  plan: PlanInputs & { status: 'DRAFT' | 'OPTIMIZING' | 'PLANNED' } = { ...syntheticPlan(), status: 'OPTIMIZING' };
  writes: { jobId: string; version: number; write: PlanWrite }[] = [];
  loads = 0;
  async load(job: JobRecord, input: OptimizeJobInput): Promise<PlanInputs> {
    this.loads++;
    if (this.plan.version !== input.planVersion || this.plan.status !== 'OPTIMIZING') throw new JobError('PLAN_STALE', 'The plan changed');
    const { status: _s, ...inputs } = this.plan;
    return structuredClone(inputs);
  }
  async write(_tx: StoreTx, job: JobRecord, inputs: PlanInputs, write: PlanWrite): Promise<void> {
    if (this.plan.version !== inputs.version || this.plan.status !== 'OPTIMIZING') throw new JobError('PLAN_STALE', 'The plan changed while optimising');
    this.plan.version++;
    this.plan.status = 'DRAFT';
    this.writes.push({ jobId: job.id, version: this.plan.version, write });
  }
  async release(): Promise<void> {
    if (this.plan.status === 'OPTIMIZING') this.plan.status = 'DRAFT';
  }
}

export const optimizeInput = (planVersion = 4): OptimizeJobInput => ({ kind: 'optimize', planId: 'plan-1', planVersion, profile: 'car', timeLimitS: 5 });

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls `cond` every 10 ms until true or `ms` elapsed. */
export async function until(cond: () => boolean | Promise<boolean>, ms = 3_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('condition not reached in time');
    await sleep(10);
  }
}

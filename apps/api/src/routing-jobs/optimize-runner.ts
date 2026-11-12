import { planBookingsLimitMessage, ROUTING_AVAILABLE_PROFILES, ROUTING_LIMITS, RoutingJobInput, SolverResult } from '@veetracer/shared';
import type { JobRecord, StoreTx } from './job-store';
import { PROGRESS, phaseProgress } from './job-state';
import { JobError, JobRunner } from './job-worker';
import { BuiltMatrix, matrixShapeProblem, MatrixPort } from './matrix-port';
import { mapSolverResult, PlanInputs, planPoints, PlanWrite, siteWindowConflicts, snapExclusions, SolverProblemV2, solverProblem } from './optimize-problem';
import type { RoutingUsageHook } from './usage-hook';
import { weightsOf } from './prisma-plan-gateway';
import type { SolverWeights } from './optimize-problem';
import { coverageIssue } from '../routing/service-area/coverage';
import { scrubCoordinates } from '../routing/engine-text';

/** The optimise job input (shared RoutingJobInput) plus the explicit objective weights (P6). */
export type OptimizeJobInput = Extract<RoutingJobInput, { kind: 'optimize' }> & { weights?: SolverWeights };

/** Reads the plan inputs and writes the DRAFT result (Prisma in production, fakes in tests). */
export interface PlanGateway {
  /**
   * The plan's stops, vehicles, seats and windows, read at run time (so an erasure or consent withdrawal before the
   * run is honoured). Personal points without active routing consent and stops of inactive bookings are moved to
   * `excluded` and their coordinates never leave this call. Throws PLAN_STALE / INVALID_INPUT / LIMIT_EXCEEDED.
   */
  load(job: JobRecord, input: OptimizeJobInput): Promise<PlanInputs>;
  /** Writes the result as a DRAFT plan version inside the job's SUCCEEDED transaction. Throws PLAN_STALE. */
  write(tx: StoreTx, job: JobRecord, inputs: PlanInputs, write: PlanWrite, matrix: BuiltMatrix | null, points: { stopId: string; index: number }[], graphVersion: string | null): Promise<void>;
}

export interface SolverPort {
  solve(problem: SolverProblemV2, signal?: AbortSignal): Promise<SolverResult>;
}

export function parseOptimizeInput(job: JobRecord): OptimizeJobInput {
  const i = job.input as Partial<OptimizeJobInput> | null;
  const weights = i?.weights ? weightsOf(i.weights) : undefined;
  if (!i || i.kind !== 'optimize' || typeof i.planId !== 'string' || i.planId !== job.planId || !Number.isInteger(i.planVersion)) {
    throw new JobError('INVALID_INPUT', 'Job input is not an optimise request for its plan');
  }
  return {
    kind: 'optimize',
    planId: i.planId,
    planVersion: i.planVersion as number,
    profile: i.profile ?? 'car',
    timeLimitS: Math.max(1, Math.min(ROUTING_LIMITS.optimizeTimeLimitS, Math.round(Number(i.timeLimitS) || 10))),
    ...(i.objective ? { objective: i.objective } : {}),
    ...(weights ? { weights } : {}),
  };
}

/** Rows / columns `keep` of a square matrix (stops dropped because the engine could not snap them). */
function subMatrix(m: BuiltMatrix, keep: number[]): BuiltMatrix {
  const pick = <T>(rows: T[][]) => keep.map((i) => keep.map((j) => rows[i][j]));
  return { ...m, durationsS: pick(m.durationsS), distancesM: pick(m.distancesM), snapped: keep.map((i) => m.snapped[i] ?? null), invalid: [] };
}

/**
 * The optimise job (kind `optimize`): load the plan → build the matrix (E4-B port) → solve (OR-Tools service) → store
 * the result as a DRAFT plan version. It never publishes: publishing into PlannedTrip / TransportTrip is the plans
 * service's command (doc 15 §8.4). Logs carry ids and counts only, never coordinates or names.
 */
export function optimizeRunner(deps: { plans: PlanGateway; matrix: MatrixPort; solver: SolverPort; usage: RoutingUsageHook }): JobRunner {
  return async (ctx) => {
    const { job } = ctx;
    const input = parseOptimizeInput(job);
    await ctx.checkpoint();
    let inputs = await deps.plans.load(job, input);
    // The job's own weights win over the plan's stored ones (they are the same unless the plan was edited meanwhile).
    if (input.weights) inputs = { ...inputs, solver: { ...inputs.solver, weights: input.weights } };
    if (!(ROUTING_AVAILABLE_PROFILES as readonly string[]).includes(inputs.profile)) {
      throw new JobError('PROFILE_NOT_AVAILABLE', `Routing profile "${inputs.profile}" is not available on this server`);
    }
    // Owner decision 2 (T3-D9): the same bookings limit and message as plan creation and the API reservation.
    const bookings = new Set(inputs.stops.flatMap((s) => (s.bookingId ? [s.bookingId] : []))).size;
    if (bookings > ROUTING_LIMITS.planBookings) throw new JobError('LIMIT_EXCEEDED', planBookingsLimitMessage(bookings));
    if (inputs.stops.length > ROUTING_LIMITS.optimizeStops) throw new JobError('LIMIT_EXCEEDED', `At most ${ROUTING_LIMITS.optimizeStops} stops per optimisation (plan has ${inputs.stops.length})`);
    if (inputs.vehicles.length > ROUTING_LIMITS.optimizeVehicles) throw new JobError('LIMIT_EXCEEDED', `At most ${ROUTING_LIMITS.optimizeVehicles} vehicles per optimisation`);
    // Coverage first (India polygon / graph bbox, routing/service-area): an uncovered stop is unassigned
    // (outside_coverage) and never reaches the engine; an uncovered depot or site fails the job.
    for (const p of [inputs.depot, inputs.site]) if (p && coverageIssue(p)) throw new JobError('OUTSIDE_COVERAGE', 'The plan depot or site is outside the routing coverage');
    const uncovered = inputs.stops.filter((s) => coverageIssue(s));
    if (uncovered.length) {
      const out = new Set(uncovered.map((s) => s.id));
      inputs = { ...inputs, stops: inputs.stops.filter((s) => !out.has(s.id)), excluded: [...inputs.excluded, ...uncovered.map((s) => ({ stopId: s.id, reason: 'outside_coverage' as const, bookingId: s.bookingId }))] };
    }
    // Site windows that share no span (T1-D2): keep the largest compatible group; the others are unassigned
    // (time_window_unreachable) before the engine is asked, so nobody is timed outside their own window.
    const conflicts = siteWindowConflicts(inputs);
    if (conflicts.length) {
      const out = new Set(conflicts.map((c) => c.stopId));
      inputs = { ...inputs, stops: inputs.stops.filter((s) => !out.has(s.id)), excluded: [...inputs.excluded, ...conflicts] };
    }
    let built = planPoints(inputs);
    if (built.points.length > ROUTING_LIMITS.optimizeLocations) throw new JobError('LIMIT_EXCEEDED', `At most ${ROUTING_LIMITS.optimizeLocations} locations per optimisation`);

    if (!built.solverStops.length) {
      // Nothing to route (e.g. every passenger withdrew consent): store the empty result, no engine or solver call.
      const empty: SolverResult = { status: 'FEASIBLE', provenOptimal: false, routes: [], unassigned: [] };
      const { write, result } = mapSolverResult(inputs, built, empty, null);
      const frozen = inputs;
      return { result, graphVersion: null, within: (tx: StoreTx) => deps.plans.write(tx, job, frozen, write, null, [], null) };
    }

    await ctx.phase('matrix', PROGRESS.matrixStart);
    const m = await deps.matrix.build(built.points, inputs.profile, {
      signal: ctx.signal,
      depots: [...Array(built.firstStopIndex).keys()],
      onProgress: async (done, total) => ctx.progress(phaseProgress(PROGRESS.matrixStart, PROGRESS.matrixEnd, total ? done / total : 0)),
    });
    if (!m.ok) throw new JobError(m.degraded, `Road matrix unavailable: ${scrubCoordinates(m.message)}`);
    let matrix = m.value;
    const shape = matrixShapeProblem(matrix, built.points.length);
    if (shape) throw new JobError('ENGINE_UNREACHABLE', `Road matrix unusable (${shape})`);
    if (matrix.invalid.some((i) => i.index < built.firstStopIndex)) {
      const r = matrix.invalid.find((i) => i.index < built.firstStopIndex)!.reason;
      throw new JobError(r === 'outside_coverage' ? 'OUTSIDE_COVERAGE' : 'POINT_NOT_ON_ROAD', `The depot or site cannot be routed (${r}); no plan was computed`);
    }
    await deps.usage.add(job.companyId, { matrixCells: matrix.cells.computed, cacheHits: matrix.cells.cached });

    // Stops the engine could not snap: unassigned with their reason, removed from the problem (never guessed).
    const bad = snapExclusions(built, matrix);
    if (bad.size) {
      const keepStops = inputs.stops.filter((s) => !bad.has(s.id));
      const keepIdx = [...Array(built.firstStopIndex).keys(), ...built.solverStops.map((s, i) => (bad.has(s.id) ? -1 : built.firstStopIndex + i)).filter((i) => i >= 0)];
      inputs = { ...inputs, stops: keepStops, excluded: [...inputs.excluded, ...[...bad].map(([stopId, reason]) => ({ stopId, reason, bookingId: inputs.stops.find((s) => s.id === stopId)?.bookingId ?? null }))] };
      matrix = subMatrix(matrix, keepIdx);
      built = planPoints(inputs);
    }
    await ctx.checkpoint();

    await ctx.phase('solve', PROGRESS.solveStart);
    let solved: SolverResult;
    if (built.solverStops.length) {
      const problem = solverProblem(inputs, built, matrix, { timeLimitS: input.timeLimitS, objective: input.objective });
      await deps.usage.add(job.companyId, { optimizeJobs: 1 });
      solved = await deps.solver.solve(problem, ctx.signal);
      if (solved.status === 'NO_SOLUTION') throw new JobError('NO_ROUTE', 'The optimiser found no feasible plan for these stops and vehicles');
    } else {
      solved = { status: 'FEASIBLE', provenOptimal: false, routes: [], unassigned: [] };
    }
    await ctx.progress(PROGRESS.writing);
    await ctx.checkpoint();

    const { write, result } = mapSolverResult(inputs, built, solved, matrix.graphVersion);
    const points = built.solverStops.map((s, i) => ({ stopId: s.id, index: built.firstStopIndex + i }));
    const frozen = inputs;
    const usedMatrix = matrix;
    return {
      result,
      graphVersion: matrix.graphVersion,
      within: (tx: StoreTx) => deps.plans.write(tx, job, frozen, write, usedMatrix, points, usedMatrix.graphVersion),
    };
  };
}

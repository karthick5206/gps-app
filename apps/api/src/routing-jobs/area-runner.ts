import { DEFAULT_TURNAROUND_S, uncalibratedEta, type OptimizeResult, type RidePreference, type SharingLimits, type SolverStatus } from '@veetracer/shared';
import type { JobContext } from './job-worker';
import { JobError } from './job-worker';
import { PROGRESS, phaseProgress } from './job-state';
import type { BuiltMatrix, MatrixPort } from './matrix-port';
import type { PlanInputs, PlanWrite } from './optimize-problem';
import type { PdpProblem, PdpResult } from './pdp-contract';
import { buildPdpProblem, mapPdpResult, verifyPdp } from './pdp-problem';
import type { RoutingUsageHook } from './usage-hook';

/**
 * Pooling C2 (doc 20 §3.5–3.6): the optimise job of an AREA plan (point-to-point pooling over an operating window).
 * Points = [depot, every pickup / drop stop]; one pdp request per booking with its accepted limits; vehicles start at
 * the depot inside their free time (WP-A availability) with the turnaround between trips. The answer is verified
 * independently, then written like any plan result plus RoutePlanStop.tripIndex (trip boundaries). An optimiser without
 * contract v3 fails the job as PDP_UNSUPPORTED (final, nothing written; the plan goes back to DRAFT like any failure).
 */

/** One booking of an AREA plan as the pdp request needs it (built by the plan gateway at load). */
export interface AreaRequestInput {
  bookingId: string;
  pickupStopId: string;
  dropStopId: string;
  passengers: number;
  preference: RidePreference;
  windowStartS: number;
  windowEndS: number;
  limits: SharingLimits | null;
  wheelchair: number;
}

export interface AreaInputs {
  requests: AreaRequestInput[];
  companyMaxRideS: number | null;
  priority?: Partial<Record<RidePreference, number>>;
}

export interface PdpSolverPort {
  solvePdp?(problem: PdpProblem, signal?: AbortSignal): Promise<PdpResult>;
}

export interface AreaRunResult {
  write: PlanWrite;
  result: OptimizeResult;
  matrix: BuiltMatrix;
  points: { stopId: string; index: number }[];
}

export async function runAreaPlan(ctx: Pick<JobContext, 'job' | 'signal' | 'phase' | 'progress' | 'checkpoint'>, inputs: PlanInputs & { area: AreaInputs }, deps: { matrix: MatrixPort; solver: PdpSolverPort; usage: RoutingUsageHook }, opts: { timeLimitS: number; strategy?: string | null; deadlineAt?: number }): Promise<AreaRunResult> {
  if (!inputs.depot) throw new JobError('INVALID_INPUT', 'An area plan needs a depot (the place its vehicles start from)');
  if (!deps.solver.solvePdp) throw new JobError('PDP_UNSUPPORTED', 'The optimiser does not offer the pickup-and-delivery mode (contract v3)');
  const stopIndex = new Map<string, number>();
  const points = [inputs.depot, ...inputs.stops.map((s) => ({ lat: s.lat, lng: s.lng }))];
  inputs.stops.forEach((s, i) => stopIndex.set(s.id, i + 1));
  await ctx.phase('matrix', PROGRESS.matrixStart);
  const m = await deps.matrix.build(points, inputs.profile, {
    signal: ctx.signal,
    deadlineAt: opts.deadlineAt,
    depots: [0],
    onProgress: async (done, total) => ctx.progress(phaseProgress(PROGRESS.matrixStart, PROGRESS.matrixEnd, total ? done / total : 0)),
  });
  if (!m.ok) throw new JobError(m.degraded, 'Road matrix unavailable');
  const matrix = m.value;
  if (matrix.invalid.some((i) => i.index === 0)) throw new JobError('POINT_NOT_ON_ROAD', 'The depot cannot be routed; no plan was computed');
  await deps.usage.add(ctx.job.companyId, { matrixCells: matrix.cells.computed, cacheHits: matrix.cells.cached });
  const badIdx = new Set(matrix.invalid.map((i) => i.index));
  const unassigned: PlanWrite['unassigned'] = inputs.excluded.map((e) => ({ stopId: e.stopId, reason: e.reason }));
  const requests = inputs.area.requests.filter((r) => {
    const p = stopIndex.get(r.pickupStopId);
    const d = stopIndex.get(r.dropStopId);
    if (p !== undefined && d !== undefined && !badIdx.has(p) && !badIdx.has(d)) return true;
    for (const id of [r.pickupStopId, r.dropStopId]) if (stopIndex.has(id)) unassigned.push({ stopId: id, reason: 'not_on_road' });
    return false;
  });
  const horizonS = 86_400 * 2;
  const problem = buildPdpProblem({
    durationsS: matrix.durationsS,
    distancesM: matrix.distancesM,
    horizonS,
    vehicles: inputs.vehicles.map((v) => ({
      id: v.assignmentId,
      startIndex: 0,
      availableFromS: v.availability?.[0] ?? 0,
      shiftEndS: v.availability?.[1] ?? horizonS,
      capacity: v.capacity ?? 50,
      wheelchairSpaces: v.wheelchairSpaces,
      type: v.type,
      turnaroundS: v.turnaroundS ?? DEFAULT_TURNAROUND_S,
    })),
    requests: requests.map((r) => ({ bookingId: r.bookingId, pickupIndex: stopIndex.get(r.pickupStopId)!, dropIndex: stopIndex.get(r.dropStopId)!, passengers: r.passengers, preference: r.preference, windowStartS: r.windowStartS, windowEndS: r.windowEndS, limits: r.limits, companyMaxRideS: inputs.area.companyMaxRideS, wheelchair: r.wheelchair })),
    priority: inputs.area.priority,
    strategy: opts.strategy ?? undefined,
    timeLimitS: opts.timeLimitS,
    deterministic: inputs.solver?.deterministic,
  });
  await ctx.checkpoint();
  await ctx.phase('solve', PROGRESS.solveStart);
  await deps.usage.add(ctx.job.companyId, { optimizeJobs: 1 });
  const res = requests.length ? await deps.solver.solvePdp(problem, ctx.signal) : ({ schemaVersion: 3, status: 'FEASIBLE', vehicles: [], unserved: [], commitmentViolations: [] } as PdpResult);
  if (res.status === 'INVALID_INPUT') throw new JobError('INVALID_INPUT', 'Optimizer rejected the pickup-and-delivery problem');
  verifyPdp(problem, res);
  const byBooking = new Map(requests.map((r) => [r.bookingId, r]));
  const mapped = mapPdpResult(res, (bookingId, kind) => {
    const r = byBooking.get(bookingId);
    return r ? (kind === 'PICKUP' ? r.pickupStopId : r.dropStopId) : null;
  });
  // Every request exactly once: on a route or unserved.
  const routed = new Set(mapped.routes.flatMap((r) => r.visits.map((v) => v.stopId)));
  const listed = new Set(mapped.unassigned.map((u) => u.stopId));
  for (const r of requests) {
    for (const id of [r.pickupStopId, r.dropStopId]) {
      if (routed.has(id) && listed.has(id)) throw new JobError('SOLVER_RESULT_INVALID', 'Optimiser answer rejected: a request both routed and unserved');
      if (!routed.has(id) && !listed.has(id)) unassigned.push({ stopId: id, reason: 'not_scheduled_capacity_or_time' });
    }
  }
  unassigned.push(...mapped.unassigned.map((u) => ({ stopId: u.stopId, reason: u.reason, code: u.code })));
  const known = new Set(inputs.vehicles.map((v) => v.assignmentId));
  const assignments = mapped.routes.filter((r) => known.has(r.vehicleId)).map((r) => ({ assignmentId: r.vehicleId, visits: r.visits.map((v) => ({ stopId: v.stopId, sequence: v.sequence + 1, etaS: v.etaS, tripIndex: v.tripIndex })), startS: r.startS, endS: r.endS, durationS: r.durationS, distanceM: r.distanceM }));
  for (const v of inputs.vehicles) if (!assignments.some((a) => a.assignmentId === v.assignmentId)) assignments.push({ assignmentId: v.assignmentId, visits: [], startS: null, endS: null, durationS: null, distanceM: null });
  const eta = uncalibratedEta(matrix.graphVersion);
  const status = (['OPTIMAL', 'FEASIBLE', 'NO_SOLUTION'] as string[]).includes(res.status) ? (res.status as SolverStatus) : 'FEASIBLE';
  const result: OptimizeResult = {
    status,
    provenOptimal: false,
    routes: assignments
      .filter((a) => a.visits.length)
      .map((a) => ({ vehicleId: a.assignmentId, startS: a.startS ?? 0, endS: a.endS ?? 0, durationS: a.durationS ?? 0, adjustedDurationS: a.durationS ?? 0, distanceM: a.distanceM, stops: a.visits.map((v) => ({ stopId: v.stopId, arrivalS: v.etaS, serviceStartS: v.etaS, waitS: 0, departureS: v.etaS, load: 0 })), eta })),
    unassigned: unassigned.map((u) => ({ stopId: u.stopId, reason: u.reason, ...(u.code ? { code: u.code } : {}) })),
    ...(inputs.strategy ? { strategy: inputs.strategy } : {}),
    note: `Pickup-and-delivery (contract v3): ${new Set(assignments.flatMap((a) => a.visits.map((v) => `${a.assignmentId}:${v.tripIndex}`))).size} trip(s)`,
  };
  return { write: { assignments, unassigned }, result, matrix, points: inputs.stops.map((s) => ({ stopId: s.id, index: stopIndex.get(s.id)! })) };
}

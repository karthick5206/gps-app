import type { OptimizeResult, OptimizeUnassignedReason, RoutingProfile, SolverProblem, SolverResult, SolverStop, SolverVehicle } from '@veetracer/shared';
import { uncalibratedEta } from '@veetracer/shared';
import { JobError } from './job-worker';
import type { BuiltMatrix, MatrixPoint } from './matrix-port';

/**
 * Pure mapping between a route plan and the OR-Tools service (E4 WP 4.2; solver contract in
 * services/routing-optimizer/README.md and shared `SolverProblem`). No I/O, no logging.
 *
 * Model (doc 06 §3, ETMS login / logout):
 * - IN (to the site): every vehicle starts at the plan depot (a company place; the site when there is none) and ends
 *   at the site. Passenger PICKUP stops are solver stops; DROP stops at the site are not (they are the route end) and
 *   are put last on the route of their booking's pickup, with the route's arrival time.
 * - OUT (from the site): mirrored — vehicles start at the site, end at the depot (the site when there is none);
 *   PICKUP stops at the site go first on the route of their booking's drop.
 * - No direction (generic plan): start and end at the depot; every stop is a solver stop.
 * Seats = vehicle capacity, passengers = demand. Times are integer seconds after `planStartAt`.
 * Matrix cells are the engine's numbers or null (forbidden arc); nothing here estimates a time or a distance.
 */
export interface PlanStopInput {
  id: string;
  ref: string;
  lat: number;
  lng: number;
  demand: number;
  serviceS: number;
  timeWindows: [number, number][] | null;
  stopKind: 'PICKUP' | 'DROP' | null;
  bookingId: string | null;
  /** A passenger's personal point (consent re-checked by the loader before it gets here). */
  personal: boolean;
  /** At the plan's site (route end for IN, route start for OUT): not a solver stop. */
  atSite: boolean;
}

export interface PlanVehicleInput {
  /** RouteAssignment id (the solver's vehicle id). */
  assignmentId: string;
  label: string;
  /** Passenger seats; null = unlimited. */
  capacity: number | null;
}

export interface PlanInputs {
  planId: string;
  companyId: string;
  version: number;
  profile: RoutingProfile;
  direction: 'IN' | 'OUT' | null;
  depot: MatrixPoint | null;
  site: MatrixPoint | null;
  stops: PlanStopInput[];
  vehicles: PlanVehicleInput[];
  /** Stops left out before solving (consent withdrawn, booking no longer active …), with the reason. */
  excluded: { stopId: string; reason: string }[];
}

export interface BuiltProblem {
  /** Matrix points: [start depot, end depot (if different), …solver stops]. */
  points: MatrixPoint[];
  startIndex: number;
  endIndex: number;
  /** Solver stops (location index i + firstStopIndex). */
  solverStops: PlanStopInput[];
  firstStopIndex: number;
  siteStops: PlanStopInput[];
  /** Latest arrival at the site for IN plans (min of the site stops' window ends), else null. */
  arriveBy: number | null;
  /** Earliest departure from the site for OUT plans (max of the site stops' window starts), else null. */
  departAfter: number | null;
}

export const DEFAULT_HORIZON_S = 86_400;

/** Points and roles of the problem; throws INVALID_INPUT when the plan cannot be solved at all. */
export function planPoints(inp: PlanInputs): BuiltProblem {
  if (!inp.vehicles.length) throw new JobError('INVALID_INPUT', 'The plan has no vehicles: add at least one vehicle before optimising');
  const useSite = inp.direction !== null && inp.site !== null;
  const siteStops = useSite ? inp.stops.filter((s) => s.atSite) : [];
  const solverStops = inp.stops.filter((s) => !useSite || !s.atSite);
  let start: MatrixPoint | null;
  let end: MatrixPoint | null;
  if (inp.direction === 'IN' && inp.site) {
    start = inp.depot ?? inp.site;
    end = inp.site;
  } else if (inp.direction === 'OUT' && inp.site) {
    start = inp.site;
    end = inp.depot ?? inp.site;
  } else {
    start = inp.depot ?? inp.site;
    end = start;
  }
  if (!start || !end) throw new JobError('INVALID_INPUT', 'The plan has no depot or site to start the routes from');
  const same = start.lat === end.lat && start.lng === end.lng;
  const points: MatrixPoint[] = same ? [start] : [start, end];
  const firstStopIndex = points.length;
  for (const s of solverStops) points.push({ lat: s.lat, lng: s.lng });
  const ends = siteStops.flatMap((s) => (s.timeWindows ?? []).map((w) => w[1]));
  const starts = siteStops.flatMap((s) => (s.timeWindows ?? []).map((w) => w[0]));
  return {
    points,
    startIndex: 0,
    endIndex: same ? 0 : 1,
    solverStops,
    firstStopIndex,
    siteStops,
    arriveBy: inp.direction === 'IN' && ends.length ? Math.min(...ends) : null,
    departAfter: inp.direction === 'OUT' && starts.length ? Math.max(...starts) : null,
  };
}

const int = (v: number | null) => (v === null ? null : Math.round(v));

/** The `POST /optimize` body. */
export function solverProblem(inp: PlanInputs, b: BuiltProblem, m: BuiltMatrix, opts: { timeLimitS: number; objective?: 'duration' | 'distance' }): SolverProblem {
  const windowEnds = [...b.solverStops, ...b.siteStops].flatMap((s) => (s.timeWindows ?? []).map((w) => w[1]));
  const horizonS = Math.max(DEFAULT_HORIZON_S, ...windowEnds.map((e) => e + 3_600));
  const shift: [number, number] = [b.departAfter ?? 0, b.arriveBy ?? horizonS];
  const vehicles: SolverVehicle[] = inp.vehicles.map((v) => ({
    id: v.assignmentId,
    startIndex: b.startIndex,
    endIndex: b.endIndex,
    capacity: v.capacity,
    timeWindow: shift,
  }));
  const stops: SolverStop[] = b.solverStops.map((s, i) => ({
    id: s.id,
    locationIndex: b.firstStopIndex + i,
    demand: Math.max(0, Math.round(s.demand)),
    serviceS: Math.max(0, Math.round(s.serviceS)),
    ...(s.timeWindows?.length ? { timeWindows: s.timeWindows.map(([a, z]) => [Math.round(a), Math.round(z)] as [number, number]) } : {}),
    priority: 1,
  }));
  return {
    matrix: { durationsS: m.durationsS.map((r) => r.map(int)), distancesM: m.distancesM.map((r) => r.map(int)) },
    vehicles,
    stops,
    horizonS,
    // solver.py: "distance" uses distancesM (always sent here); anything else minimises time.
    options: { timeLimitS: opts.timeLimitS, objective: opts.objective ?? 'duration' },
  };
}

/** One assignment's result, as written to the DRAFT plan. */
export interface AssignmentWrite {
  assignmentId: string;
  /** Ordered: [stopId, etaS]. */
  visits: { stopId: string; sequence: number; etaS: number | null }[];
  startS: number | null;
  endS: number | null;
  durationS: number | null;
  distanceM: number | null;
}

export interface PlanWrite {
  assignments: AssignmentWrite[];
  unassigned: { stopId: string; reason: string }[];
}

/**
 * Solver answer → plan rows + the job result (stop ids, sequences and times only; no coordinates). NO_SOLUTION and
 * INVALID_INPUT are failures (no plan is written); FEASIBLE / OPTIMAL are written as a DRAFT.
 */
export function mapSolverResult(inp: PlanInputs, b: BuiltProblem, r: SolverResult, graphVersion: string | null): { write: PlanWrite; result: OptimizeResult } {
  if (r.status === 'INVALID_INPUT') throw new JobError('INVALID_INPUT', `Optimizer rejected the problem: ${(r.error ?? 'invalid input').slice(0, 200)}`);
  const known = new Set(inp.vehicles.map((v) => v.assignmentId));
  const stopIds = new Set(b.solverStops.map((s) => s.id));
  const seen = new Set<string>();
  const assignments: AssignmentWrite[] = [];
  for (const route of r.routes) {
    if (!known.has(route.vehicleId)) throw new JobError('INVALID_INPUT', 'Optimizer answered with an unknown vehicle');
    const visits: AssignmentWrite['visits'] = [];
    for (const v of route.stops) {
      if (!stopIds.has(v.stopId) || seen.has(v.stopId)) throw new JobError('INVALID_INPUT', 'Optimizer answered with an unknown or repeated stop');
      seen.add(v.stopId);
      visits.push({ stopId: v.stopId, sequence: 0, etaS: Math.round(v.serviceStartS ?? v.arrivalS) });
    }
    assignments.push({ assignmentId: route.vehicleId, visits, startS: int(route.startS), endS: int(route.endS), durationS: int(route.durationS), distanceM: int(route.distanceM) });
  }
  const unassigned: PlanWrite['unassigned'] = [...inp.excluded];
  for (const u of r.unassigned) {
    if (stopIds.has(u.stopId) && !seen.has(u.stopId)) {
      unassigned.push({ stopId: u.stopId, reason: u.reason });
      seen.add(u.stopId);
    }
  }
  // Every solver stop is either on a route or unassigned (the service guarantees it; enforce it anyway).
  for (const s of b.solverStops) if (!seen.has(s.id)) unassigned.push({ stopId: s.id, reason: 'no_solution_found' });

  // Site stops follow their booking's other end (IN: last, at the route end; OUT: first, at the route start).
  const routeOfBooking = new Map<string, AssignmentWrite>();
  const stopById = new Map(inp.stops.map((s) => [s.id, s]));
  for (const a of assignments) for (const v of a.visits) {
    const bookingId = stopById.get(v.stopId)?.bookingId;
    if (bookingId) routeOfBooking.set(bookingId, a);
  }
  const reasonOf = new Map(unassigned.map((u) => [u.stopId, u.reason]));
  for (const s of b.siteStops) {
    const a = s.bookingId ? routeOfBooking.get(s.bookingId) : undefined;
    if (!a) {
      const other = inp.stops.find((o) => o.bookingId && o.bookingId === s.bookingId && o.id !== s.id);
      unassigned.push({ stopId: s.id, reason: (other && reasonOf.get(other.id)) ?? 'not_scheduled_capacity_or_time' });
      continue;
    }
    if (inp.direction === 'OUT') a.visits.unshift({ stopId: s.id, sequence: 0, etaS: a.startS });
    else a.visits.push({ stopId: s.id, sequence: 0, etaS: a.endS });
  }
  for (const a of assignments) a.visits.forEach((v, i) => (v.sequence = i + 1));
  // Vehicles the solver did not use still get an (empty) assignment row update.
  for (const v of inp.vehicles) if (!assignments.some((a) => a.assignmentId === v.assignmentId)) assignments.push({ assignmentId: v.assignmentId, visits: [], startS: null, endS: null, durationS: null, distanceM: null });

  const eta = uncalibratedEta(graphVersion);
  const result: OptimizeResult = {
    status: r.status,
    provenOptimal: r.provenOptimal === true,
    ...(r.solverStatus ? { solverStatus: r.solverStatus } : {}),
    routes: assignments
      .filter((a) => a.visits.length)
      .map((a) => {
        const route = r.routes.find((x) => x.vehicleId === a.assignmentId);
        const visit = new Map((route?.stops ?? []).map((v) => [v.stopId, v]));
        return {
          vehicleId: a.assignmentId,
          startS: a.startS ?? 0,
          endS: a.endS ?? 0,
          durationS: a.durationS ?? 0,
          adjustedDurationS: a.durationS ?? 0,
          distanceM: a.distanceM,
          stops: a.visits.map((v) => {
            const s = visit.get(v.stopId);
            return s
              ? { stopId: v.stopId, arrivalS: s.arrivalS, serviceStartS: s.serviceStartS, waitS: s.waitS, departureS: s.departureS, load: s.load }
              : { stopId: v.stopId, arrivalS: v.etaS ?? 0, serviceStartS: v.etaS ?? 0, waitS: 0, departureS: v.etaS ?? 0, load: 0 };
          }),
          eta,
        };
      }),
    unassigned: unassigned.map((u) => ({ stopId: u.stopId, reason: u.reason as OptimizeUnassignedReason })),
    ...(r.stats ? { stats: r.stats } : {}),
    ...(r.note ? { note: r.note } : {}),
  };
  return { write: { assignments, unassigned }, result };
}

/** Points the engine could not use become unassigned stops (no number is ever guessed for them). */
export function snapExclusions(b: BuiltProblem, m: BuiltMatrix): Map<string, OptimizeUnassignedReason> {
  const out = new Map<string, OptimizeUnassignedReason>();
  for (const inv of m.invalid) {
    const i = inv.index - b.firstStopIndex;
    if (i < 0) continue; // a depot / site problem fails the whole job (see the runner)
    const s = b.solverStops[i];
    if (s) out.set(s.id, inv.reason === 'OUTSIDE_COVERAGE' ? 'outside_coverage' : inv.reason === 'POINT_NOT_ON_ROAD' ? 'not_on_road' : 'unreachable_location');
  }
  return out;
}

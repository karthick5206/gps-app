import type { OptimizeResult, OptimizeUnassignedReason, RoutingProfile, SolverOptions, SolverResult, SolverStop } from '@veetracer/shared';
import { uncalibratedEta } from '@veetracer/shared';
import { JobError } from './job-worker';
import type { BuiltMatrix, MatrixPoint } from './matrix-port';

/**
 * Pure mapping between a route plan and the OR-Tools service (E4 WP 4.2; `services/routing-optimizer`, contract v2 of
 * WP 4.3 `trip` mode). No I/O, no logging.
 *
 * Model (doc 06 §4.2, ETMS login / logout), when the plan has a direction and a site:
 * - IN (login, homes → site): `trip: { direction: 'IN', siteIndex, siteWindow }`; every vehicle starts at the plan
 *   depot (or anywhere — open start — when the plan has none) and ends at the site within the site window. Passenger
 *   PICKUP stops are solver stops; DROP stops at the site are not (they are the route end) and go last on the route of
 *   their booking's pickup, at the route's site arrival.
 * - OUT (logout, site → homes): mirrored — vehicles leave the site within the window, end at the depot (open end when
 *   none); PICKUP stops at the site go first on the route of their booking's drop, at the site departure.
 * - Generic plan (no direction or no site): contract v1, start and end at the depot (or the site).
 * Seats = vehicle capacity, passengers = demand, `RoutePlan.options.maxRideS` = max ride time per passenger. Times are
 * integer seconds after `planStartAt`. Matrix cells are the engine's numbers or null (forbidden arc); nothing here
 * estimates a time or a distance.
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
  /** Data owner (customer company) of a passenger stop: one customer per vehicle (README P2). */
  customerId: string | null;
  /** Pinned stop: stays on this assignment (solver pinnedVehicleId). */
  pinnedAssignmentId?: string | null;
}

export interface PlanVehicleInput {
  /** RouteAssignment id (the solver's vehicle id). */
  assignmentId: string;
  label: string;
  /** Passenger seats; null = unlimited. */
  capacity: number | null;
  /** TransportVehicleProfile.category (matched against allowed vehicle types later). */
  type: string | null;
  wheelchairSpaces: number;
}

/** Objective weights (README P6: always explicit). */
export interface SolverWeights {
  vehicle: number;
  distance: number;
  time: number;
  routeDuration: number;
}

/** Defaults: vehicles first, then road time (or distance). Overridable per plan (RoutePlan.options.weights). */
export function defaultWeights(objective: 'duration' | 'distance' = 'duration'): SolverWeights {
  return objective === 'distance' ? { vehicle: 50_000, distance: 1, time: 0, routeDuration: 0 } : { vehicle: 7_200, distance: 0, time: 1, routeDuration: 0 };
}

export interface PlanInputs {
  planId: string;
  companyId: string;
  version: number;
  profile: RoutingProfile;
  direction: 'IN' | 'OUT' | null;
  depot: MatrixPoint | null;
  site: MatrixPoint | null;
  /** Locked routes (RoutePlan.options.lockedAssignmentIds): not re-solved, their stops untouched by the write. */
  lockedAssignmentIds?: string[];
  /** Max ride time per passenger (s), from the plan options; null = none. */
  maxRideS: number | null;
  /** RoutePlan.options solver settings (validated by the loader). */
  solver?: { weights?: SolverWeights; deterministic?: boolean; allowMixedCustomers?: boolean };
  stops: PlanStopInput[];
  vehicles: PlanVehicleInput[];
  /** Stops left out before solving (consent withdrawn, booking no longer active …), with the reason. */
  excluded: { stopId: string; reason: string; bookingId?: string | null }[];
}

export interface BuiltProblem {
  /** Matrix points: trip = [site, depot?, …stops]; generic = [start, end (if different), …stops]. */
  points: MatrixPoint[];
  trip: { direction: 'IN' | 'OUT'; siteIndex: number } | null;
  /** Vehicle start / end matrix index (null = open start / end, trip mode only). */
  startIndex: number | null;
  endIndex: number | null;
  /** Solver stops (location index i + firstStopIndex). */
  solverStops: PlanStopInput[];
  firstStopIndex: number;
  siteStops: PlanStopInput[];
}

export const DEFAULT_HORIZON_S = 86_400;

/** Points and roles of the problem; throws INVALID_INPUT when the plan cannot be solved at all. */
export function planPoints(inp: PlanInputs): BuiltProblem {
  if (!inp.vehicles.length) {
    throw new JobError('INVALID_INPUT', inp.lockedAssignmentIds?.length ? 'Every vehicle of the plan is locked: unlock a route to optimise' : 'The plan has no vehicles: add at least one vehicle before optimising');
  }
  if (inp.direction && inp.site) {
    const siteStops = inp.stops.filter((s) => s.atSite);
    const solverStops = inp.stops.filter((s) => !s.atSite);
    const points: MatrixPoint[] = [inp.site];
    const depotIndex = inp.depot ? points.push(inp.depot) - 1 : null;
    const firstStopIndex = points.length;
    for (const s of solverStops) points.push({ lat: s.lat, lng: s.lng });
    return {
      points,
      trip: { direction: inp.direction, siteIndex: 0 },
      // IN: the vehicle comes from the depot (open start without one) and the solver ends it at the site.
      // OUT: the solver starts it at the site; it ends at the depot (open end without one).
      startIndex: inp.direction === 'IN' ? depotIndex : depotIndex ?? 0,
      endIndex: inp.direction === 'OUT' ? depotIndex : depotIndex ?? 0,
      solverStops,
      firstStopIndex,
      siteStops,
    };
  }
  const start = inp.depot ?? inp.site;
  if (!start) throw new JobError('INVALID_INPUT', 'The plan has no depot or site to start the routes from');
  const points: MatrixPoint[] = [start];
  for (const s of inp.stops) points.push({ lat: s.lat, lng: s.lng });
  return { points, trip: null, startIndex: 0, endIndex: 0, solverStops: inp.stops, firstStopIndex: 1, siteStops: [] };
}

const int = (v: number | null) => (v === null ? null : Math.round(v));

/** `POST /optimize` body (contract v2 when `trip` is set). */
export interface SolverProblemV2 {
  schemaVersion?: 1 | 2;
  matrix: { durationsS: (number | null)[][]; distancesM?: (number | null)[][] | null };
  vehicles: { id: string; startIndex: number | null; endIndex: number | null; capacity?: number | null; timeWindow?: [number, number] | null; type?: string; wheelchairSpaces?: number }[];
  stops: (SolverStop & { customerId?: string; pinnedVehicleId?: string })[];
  horizonS: number;
  trip?: { direction: 'IN' | 'OUT'; siteIndex: number; siteWindow: [number, number]; maxRideS?: number };
  options: SolverOptions & { weights: SolverWeights; deterministic?: boolean; allowMixedCustomers?: boolean };
}

/** The site window: IN = when the vehicles may arrive, OUT = when they may leave (from the site stops' windows). */
export function siteWindow(b: BuiltProblem, horizonS: number): [number, number] {
  const ws = b.siteStops.flatMap((s) => s.timeWindows ?? []);
  if (!ws.length) return [0, horizonS];
  const lo = Math.max(0, Math.max(...ws.map((w) => w[0])));
  const hi = Math.min(horizonS, Math.min(...ws.map((w) => w[1])));
  // Several shifts' windows that do not overlap: fall back to the widest common span instead of an empty window.
  return lo <= hi ? [Math.round(lo), Math.round(hi)] : [Math.round(Math.max(0, Math.min(...ws.map((w) => w[0])))), Math.round(Math.min(horizonS, Math.max(...ws.map((w) => w[1]))))];
}

export function solverProblem(inp: PlanInputs, b: BuiltProblem, m: BuiltMatrix, opts: { timeLimitS: number; objective?: 'duration' | 'distance' }): SolverProblemV2 {
  const windowEnds = [...b.solverStops, ...b.siteStops].flatMap((s) => (s.timeWindows ?? []).map((w) => w[1]));
  const horizonS = Math.max(DEFAULT_HORIZON_S, ...windowEnds.map((e) => Math.ceil(e) + 3_600));
  const vehicleIds = new Set(inp.vehicles.map((v) => v.assignmentId));
  const stops: SolverStop[] = b.solverStops.map((s, i) => ({
    id: s.id,
    locationIndex: b.firstStopIndex + i,
    demand: Math.max(0, Math.round(s.demand)),
    serviceS: Math.max(0, Math.round(s.serviceS)),
    ...(s.timeWindows?.length ? { timeWindows: s.timeWindows.map(([a, z]) => [Math.round(a), Math.round(z)] as [number, number]) } : {}),
    priority: 1,
    ...(s.customerId ? { customerId: s.customerId } : {}),
    ...(s.pinnedAssignmentId && vehicleIds.has(s.pinnedAssignmentId) ? { pinnedVehicleId: s.pinnedAssignmentId } : {}),
  }));
  return {
    schemaVersion: 2,
    matrix: { durationsS: m.durationsS.map((r) => r.map(int)), distancesM: m.distancesM.map((r) => r.map(int)) },
    // Start / end always explicit (a missing startIndex means 0, which is the site in trip mode).
    vehicles: inp.vehicles.map((v) => ({
      id: v.assignmentId,
      startIndex: b.startIndex,
      endIndex: b.endIndex,
      capacity: v.capacity,
      ...(v.type ? { type: v.type } : {}),
      ...(v.wheelchairSpaces ? { wheelchairSpaces: v.wheelchairSpaces } : {}),
    })),
    stops,
    horizonS,
    ...(b.trip
      ? { trip: { direction: b.trip.direction, siteIndex: b.trip.siteIndex, siteWindow: siteWindow(b, horizonS), ...(inp.maxRideS ? { maxRideS: Math.round(inp.maxRideS) } : {}) } }
      : {}),
    options: {
      timeLimitS: opts.timeLimitS,
      weights: inp.solver?.weights ?? defaultWeights(opts.objective),
      ...(inp.solver?.deterministic ? { deterministic: true } : {}),
      ...(inp.solver?.allowMixedCustomers ? { allowMixedCustomers: true } : {}),
    },
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
  unassigned: { stopId: string; reason: string; code?: string }[];
}

/**
 * Essential re-checks of a solver answer before anything is stored (mirrors the core of `optimizer.verify`; doc 06
 * §4.5 "optimiser output is never trusted"): seats per route, every visit inside one of its stop's windows, and in
 * trip mode the site arrival (IN) / departure (OUT) inside the site window. A violation fails the job; no plan is written.
 */
export function verifyRoutes(inp: PlanInputs, b: BuiltProblem, r: SolverResult): void {
  const stop = new Map(b.solverStops.map((s) => [s.id, s]));
  const vehicle = new Map(inp.vehicles.map((v) => [v.assignmentId, v]));
  const site = (r as SolverResult & { trip?: { siteWindow?: [number, number] } }).trip?.siteWindow ?? null;
  const bad = (what: string) => {
    throw new JobError('INVALID_INPUT', `Optimizer result failed verification: ${what}`);
  };
  for (const route of r.routes) {
    const cap = vehicle.get(route.vehicleId)?.capacity ?? null;
    const seats = route.stops.reduce((n, v) => n + Math.max(0, Math.round(stop.get(v.stopId)?.demand ?? 0)), 0);
    if (cap !== null && seats > cap) bad(`vehicle over capacity (${seats} > ${cap})`);
    for (const v of route.stops) {
      const tw = stop.get(v.stopId)?.timeWindows;
      if (tw?.length && !tw.some(([a, z]) => v.serviceStartS >= a - 1 && v.serviceStartS <= z + 1)) bad('a visit outside its time window');
    }
    if (site && b.trip) {
      const at = b.trip.direction === 'IN' ? route.endS : (route as { siteDepartureS?: number }).siteDepartureS ?? route.startS;
      if (at < site[0] - 1 || at > site[1] + 1) bad(`site ${b.trip.direction === 'IN' ? 'arrival' : 'departure'} outside the site window`);
    }
  }
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
  const unassigned: PlanWrite['unassigned'] = inp.excluded.map((e) => ({ stopId: e.stopId, reason: e.reason }));
  for (const u of r.unassigned as (SolverResult['unassigned'][number] & { code?: string })[]) {
    if (!stopIds.has(u.stopId) || seen.has(u.stopId)) throw new JobError('INVALID_INPUT', 'Optimizer answered with an unknown or repeated unassigned stop');
    unassigned.push({ stopId: u.stopId, reason: u.reason, ...(u.code ? { code: u.code } : {}) });
    seen.add(u.stopId);
  }
  // Every solver stop exactly once: on a route or unassigned ("optimiser output is never trusted", doc 06 §4.5).
  const missing = b.solverStops.filter((s) => !seen.has(s.id)).length;
  if (missing) throw new JobError('INVALID_INPUT', `Optimizer result incomplete: ${missing} stop(s) neither routed nor unassigned`);
  verifyRoutes(inp, b, r);

  // Site stops follow their booking's other end (IN: last, at the route end; OUT: first, at the route start).
  const routeOfBooking = new Map<string, AssignmentWrite>();
  const stopById = new Map(inp.stops.map((s) => [s.id, s]));
  for (const a of assignments) for (const v of a.visits) {
    const bookingId = stopById.get(v.stopId)?.bookingId;
    if (bookingId) routeOfBooking.set(bookingId, a);
  }
  // Why the booking's other end is not routed (left out before the solve, or unassigned by the solver).
  const reasonOfBooking = new Map<string, string>();
  for (const e of inp.excluded) if (e.bookingId) reasonOfBooking.set(e.bookingId, e.reason);
  for (const u of unassigned) {
    const bk = stopById.get(u.stopId)?.bookingId;
    if (bk && !reasonOfBooking.has(bk)) reasonOfBooking.set(bk, u.reason);
  }
  // OUT prepends: walk the site stops backwards so they keep their order.
  for (const s of inp.direction === 'OUT' ? [...b.siteStops].reverse() : b.siteStops) {
    const a = s.bookingId ? routeOfBooking.get(s.bookingId) : undefined;
    if (!a) {
      unassigned.push({ stopId: s.id, reason: (s.bookingId && reasonOfBooking.get(s.bookingId)) || 'not_scheduled_capacity_or_time' });
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
    unassigned: unassigned.map((u) => ({ stopId: u.stopId, reason: u.reason as OptimizeUnassignedReason, ...(u.code ? { code: u.code } : {}) })),
    ...(r.stats ? { stats: r.stats } : {}),
    ...(r.note ? { note: r.note } : {}),
  };
  return { write: { assignments, unassigned }, result };
}

/** Points the engine could not use become unassigned stops (no number is ever guessed for them). */
export function snapExclusions(b: BuiltProblem, m: BuiltMatrix): Map<string, string> {
  const out = new Map<string, string>();
  for (const inv of m.invalid) {
    const i = inv.index - b.firstStopIndex;
    if (i < 0) continue; // a depot / site problem fails the whole job (see the runner)
    const s = b.solverStops[i];
    if (s) out.set(s.id, inv.reason);
  }
  return out;
}

/**
 * Wire types of `services/routing-optimizer` (`POST /optimize`, `GET /health`), ported from the routing branch
 * (`OptimizerProblem` in `optimizer.adapter.ts`, `OptimizeResult` in `packages/shared/src/routing.ts`). They stay in
 * the API until the shared routing contracts (P4) and the solver extensions (WP 4.3) settle them; fields the solver
 * adds later pass through untouched.
 */

/** Problem as accepted by `solve()`: a precomputed matrix (null = forbidden arc), seconds since plan start. */
export interface OptimizerProblem {
  matrix: { durationsS: (number | null)[][]; distancesM?: (number | null)[][] };
  vehicles: { id: string; startIndex: number; endIndex: number; capacity?: number; timeWindow?: [number, number]; maxDurationS?: number }[];
  stops: { id: string; locationIndex: number; demand?: number; serviceS?: number; timeWindows?: [number, number][]; priority?: number }[];
  options: { timeLimitS: number };
  /** Upper bound of every time value (seconds after plan start). */
  horizonS?: number;
}

export type OptimizeUnassignedReason =
  | 'outside_coverage'
  | 'not_on_road'
  | 'invalid_time_window'
  | 'demand_exceeds_vehicle_capacity'
  | 'unreachable_location'
  | 'time_window_unreachable'
  | 'exceeds_max_route_duration'
  | 'not_scheduled_capacity_or_time'
  | 'no_solution_found';

export interface OptimizeVisit {
  stopId: string;
  arrivalS: number;
  serviceStartS: number;
  waitS: number;
  departureS: number;
  load: number;
}

export interface OptimizeRoute {
  vehicleId: string;
  startS: number;
  endS: number;
  durationS: number;
  distanceM: number | null;
  stops: OptimizeVisit[];
}

export interface OptimizeResult {
  /** FEASIBLE = best found within the time limit (never claimed optimal without proof). */
  status: 'OPTIMAL' | 'FEASIBLE' | 'NO_SOLUTION' | 'INVALID_INPUT';
  provenOptimal: boolean;
  solverStatus?: string;
  routes: OptimizeRoute[];
  unassigned: { stopId: string; reason: OptimizeUnassignedReason }[];
  stats?: { wallTimeMs: number; timeLimitS: number };
  note?: string;
  error?: string;
}

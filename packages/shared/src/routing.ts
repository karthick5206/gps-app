import type { LatLng } from './geo';
import type { TransportDirection } from './transport-trips';

/**
 * ETMS E4 routing and optimisation contracts (WP 4.0, doc 17 §7 P4), shared by the API, the routing worker and the web
 * planner. Engine-neutral by design: GraphHopper is the only road engine (README §5 D3); OR-Tools is the optional
 * optimiser (`services/routing-optimizer`). Nothing here names another engine.
 *
 * Conventions
 * - Request coordinates are `{ lat, lng }`; every geometry in a response is GeoJSON `[lng, lat]` (as `PlannedTrip.path`).
 * - Every duration a user may see carries an `EtaModel`. Engine numbers are free-flow (no live traffic) and
 *   **uncalibrated** until a GraphHopper calibration (benchmark B9) is fitted: `DEFAULT_ETA_FACTORS` is empty.
 * - A failed engine call is a typed degraded reason, never a straight-line, proportional or default-speed number.
 * - Times inside a plan / solver problem are integer seconds after the plan start (`planStartAt`).
 *
 * Database names (migration `routing_engine_v2` + `etms_planning_links`): `RoutePlan`, `RouteAssignment`,
 * `RoutePlanStop` (renamed from the old branch's `RouteStop`, which clashes with v1.8 `RouteStop`), `RoutingJob`,
 * `RoutingUsage`, `RoutePlanVersion`; enums `RoutePlanStatus`, `RoutingJobStatus` (upper case in the database, lower case
 * job states in the API, see `ROUTING_JOB_STATE_OF`).
 *
 * Flags: everything is off by default. Server: `ETMS` (kill switch) **and** `ETMS_ROUTING=on`; company add-on `etms`.
 */

// ───────────────────────────── engine, profiles, coverage, limits ─────────────────────────────

/** The only road engine (D3). */
export const ROUTING_ENGINE = 'graphhopper' as const;
export type RoutingEngine = typeof ROUTING_ENGINE;

/** Server env switch for ETMS planning / optimisation / the routing worker; on only when exactly `on` (default off). */
export const ETMS_ROUTING_ENV = 'ETMS_ROUTING' as const;

export const ROUTING_PROFILES = ['car', 'van', 'bus', 'foot'] as const;
export type RoutingProfile = (typeof ROUTING_PROFILES)[number];
/** Profiles the production graph has today (car only until owner decision O3 / benchmark B8 re-imports van / foot). */
export const ROUTING_AVAILABLE_PROFILES: readonly RoutingProfile[] = ['car'];
/** Default `RoutePlan.profile`. */
export const DEFAULT_ROUTING_PROFILE: RoutingProfile = 'car';

/** Coverage the API accepts (India bbox). Points outside → OUTSIDE_COVERAGE (also catches lat/lng swaps). */
export const ROUTING_COVERAGE = { minLat: 6, maxLat: 37.5, minLng: 68, maxLng: 97.5 } as const;

export const ROUTING_LIMITS = {
  /** Points of one synchronous route request. */
  routeLocations: 25,
  /** Synchronous matrix: locations and cells. */
  matrixLocations: 50,
  matrixCells: 2500,
  /** Matrix jobs (background): sources × targets. */
  asyncMatrixLocations: 200,
  asyncMatrixCells: 40_000,
  /** Plan editing. */
  planStops: 200,
  /** One optimisation job (stops + depots ≤ optimizeLocations; the solver service itself accepts up to 600). */
  optimizeStops: 150,
  optimizeVehicles: 20,
  optimizeLocations: 200,
  optimizeTimeLimitS: 60,
  concurrentOptimizePerCompany: 2,
  perUserPerMinute: 60,
  perCompanyPerDay: 5000,
} as const;

/** Why an engine result is unavailable (`RoutingProvider` `Unavailable.degraded`). Never paired with a number. */
export type RoutingDegradedReason =
  | 'ENGINE_DISABLED'
  | 'ENGINE_NOT_SUPPORTED'
  | 'ENGINE_UNREACHABLE'
  | 'ENGINE_TIMEOUT'
  | 'GRAPH_REBUILDING'
  | 'PROFILE_NOT_AVAILABLE'
  | 'OUTSIDE_COVERAGE'
  | 'POINT_NOT_ON_ROAD'
  | 'NO_ROUTE'
  | 'LIMIT_EXCEEDED'
  | 'INVALID_INPUT'
  | 'NOT_IMPLEMENTED';

/** API error codes of the routing / planning endpoints (in addition to the common ones, doc 05 §4). */
export type RoutingErrorCode =
  | 'ROUTING_DISABLED'
  | 'ROUTING_UNAVAILABLE'
  | 'NO_ROUTE'
  | 'OUTSIDE_COVERAGE'
  | 'LIMIT_EXCEEDED'
  | 'QUOTA_EXCEEDED'
  | 'OPTIMIZER_UNAVAILABLE'
  | 'OPTIMIZER_BUSY'
  | 'JOB_NOT_FOUND'
  | 'PLAN_NOT_EDITABLE'
  | 'PLAN_STALE'
  | 'IDEMPOTENCY_KEY_REUSED';

export const OSM_ATTRIBUTION = '© OpenStreetMap contributors';
/** Text shown with every ETA (API warnings and UI). */
export const NO_LIVE_TRAFFIC_NOTICE = 'Estimated times do not include live traffic.';
/** Shown with every uncalibrated number (all of them until a GraphHopper calibration exists). */
export const UNCALIBRATED_ETA_NOTICE = 'ETA is uncalibrated: free-flow road time, no correction and no live traffic.';

// ───────────────────────────── ETA provenance ─────────────────────────────

export const ETA_BANDS = ['short_lt10km', 'mid_10_40km', 'long_gt40km'] as const;
export type EtaBand = (typeof ETA_BANDS)[number];
export type EtaBandStatus = Record<EtaBand, 'calibrated' | 'uncalibrated'>;

/**
 * Correction factors per distance band, fitted against **GraphHopper** free-flow times (benchmark B9). Empty until that
 * calibration exists: every band is uncalibrated and the factor is 1. (The old branch's 1.60 factor was fitted against
 * another engine and is deliberately not carried over.)
 */
export const DEFAULT_ETA_FACTORS: Readonly<Partial<Record<EtaBand, number>>> = {};

/** Provenance of every number a user may see (doc 06 §3). */
export interface EtaModel {
  source: 'engine_free_flow' | 'engine_calibrated' | 'live_heuristic';
  /** false unless a measured factor for the band was applied. */
  calibrated: boolean;
  liveTraffic: false;
  /** OSM extract date + engine version (e.g. "gh-11.1/india-2026-11-10"); null until the engine `/info` was read. */
  graphVersion: string | null;
  /** Distance band the factor was looked up for (null when no band applies, e.g. a matrix cell). */
  band?: EtaBand | null;
  /** Factor applied to the free-flow time; 1 when uncalibrated. */
  factor?: number;
  /** Where the factor came from (e.g. "gh-b9-2027-01"); null when uncalibrated. */
  factorSource?: string | null;
}

/** The default provenance: free-flow engine time, uncalibrated, no live traffic. */
export function uncalibratedEta(graphVersion: string | null = null): EtaModel {
  return { source: 'engine_free_flow', calibrated: false, liveTraffic: false, graphVersion, band: null, factor: 1, factorSource: null };
}

// ───────────────────────────── routes and matrices (API level) ─────────────────────────────

export interface LineStringGeometry {
  type: 'LineString';
  /** [lng, lat] positions (GeoJSON order). */
  coordinates: [number, number][];
}

export interface RouteRequest {
  locations: LatLng[];
  profile?: RoutingProfile;
  /** Return road geometry (default true). */
  geometry?: boolean;
}

/** One leg per consecutive pair of points; always the engine's own numbers (never proportionally split). */
export interface RouteLeg {
  fromIndex: number;
  toIndex: number;
  distanceM: number;
  durationS: number;
}

export interface RouteResult {
  distanceM: number;
  /** Free-flow engine duration (no traffic). */
  durationS: number;
  /** durationS × the band factor (= durationS while uncalibrated); still no live traffic. */
  adjustedDurationS: number;
  eta: EtaModel;
  geometry: LineStringGeometry | null;
  legs: RouteLeg[];
  /** Points moved onto the road network by the engine. */
  snapped: { index: number; snapDistanceM: number }[];
}

export interface RouteResponse {
  engine: RoutingEngine;
  graphVersion: string | null;
  route: RouteResult;
  warnings: string[];
  attribution: string;
  /** Route cache (keyed by graph version and profile): hit or miss. */
  cache?: 'hit' | 'miss';
}

export interface RoutingInvalidLocation {
  side: 'source' | 'target' | 'location' | 'stop';
  index: number;
  reason: RoutingDegradedReason;
  message: string;
}

export interface MatrixRequest {
  sources: LatLng[];
  targets: LatLng[];
  profile?: RoutingProfile;
}

export interface MatrixResponse {
  engine: RoutingEngine;
  graphVersion: string | null;
  /** null where the engine found no road route or the pair was not requested (never filled with an estimate). */
  distancesM: (number | null)[][];
  durationsS: (number | null)[][];
  invalidLocations: RoutingInvalidLocation[];
  cells: { requested: number; computed: number; cached: number };
  eta: EtaModel;
  warnings: string[];
  attribution: string;
}

// ───────────────────────────── optimisation (API level) ─────────────────────────────

export interface OptimizeVehicle {
  /** Client id of the vehicle slot (e.g. the TrackedObject id or "van-1"). */
  id: string;
  objectId?: string | null;
  driverId?: string | null;
  start: LatLng;
  end?: LatLng;
  /** Seats (passengers); unlimited when absent. */
  capacity?: number;
  /** Seconds after the plan start. */
  shiftStartS?: number;
  shiftEndS?: number;
  maxDurationS?: number;
}

export interface OptimizeStop {
  /** RoutePlanStop id (or a client id for ad-hoc requests). */
  id: string;
  location: LatLng;
  demand?: number;
  serviceS?: number;
  /** Windows in seconds after the plan start. */
  timeWindows?: [number, number][];
  /** Drop penalty weight (≥ 1). */
  priority?: number;
}

export interface OptimizeRequest {
  vehicles: OptimizeVehicle[];
  stops: OptimizeStop[];
  profile?: RoutingProfile;
  timeLimitS?: number;
  objective?: 'duration' | 'distance';
  /** Also route each vehicle's sequence for road geometry. */
  includeGeometry?: boolean;
}

/** Optimise a saved plan (POST /route-plans/:id/optimize). The worker reads stops / vehicles from the plan rows. */
export interface OptimizePlanRequest {
  /** The plan version the client saw (409 PLAN_STALE when it moved on). */
  expectedVersion: number;
  timeLimitS?: number;
  objective?: 'duration' | 'distance';
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
  /** Re-routed travel + service with the band factor (= durationS while uncalibrated). */
  adjustedDurationS?: number;
  distanceM: number | null;
  stops: OptimizeVisit[];
  geometry?: LineStringGeometry | null;
  eta: EtaModel;
}

export interface OptimizeResult {
  /** FEASIBLE = best found within the time limit (not proven optimal). */
  status: SolverStatus;
  provenOptimal: boolean;
  solverStatus?: string;
  routes: OptimizeRoute[];
  unassigned: { stopId: string; reason: OptimizeUnassignedReason }[];
  stats?: { wallTimeMs: number; timeLimitS: number; stops?: number; vehicles?: number };
  note?: string;
}

// ───────────────────────────── solver wire format (API / worker ↔ services/routing-optimizer) ─────────────────────────────

/** POST {OPTIMIZER_URL}/optimize body. Mirrors `optimizer/solver.py` `validate()`; all times are seconds after plan start. */
export interface SolverProblem {
  /** n × n; null = no road route (forbidden arc). Built from GraphHopper by the API / worker, never estimated. */
  matrix: { durationsS: (number | null)[][]; distancesM?: (number | null)[][] | null };
  vehicles: SolverVehicle[];
  stops: SolverStop[];
  /** Default 86 400. */
  horizonS?: number;
  options?: SolverOptions;
}

export interface SolverVehicle {
  id: string;
  startIndex: number;
  /** Defaults to startIndex. */
  endIndex?: number;
  /** [startS, endS]; default [0, horizonS]. */
  timeWindow?: [number, number] | null;
  /** null / absent = unlimited. */
  capacity?: number | null;
  maxDurationS?: number | null;
}

export interface SolverStop {
  id: string;
  locationIndex: number;
  /** One or more [startS, endS]; absent = whole horizon. */
  timeWindows?: [number, number][] | null;
  demand?: number;
  serviceS?: number;
  /** ≥ 1; scales the drop penalty. */
  priority?: number;
}

export interface SolverOptions {
  /** 1..120 (service cap); default 10. */
  timeLimitS?: number;
  objective?: 'duration' | 'distance';
  localSearch?: 'guided' | 'none';
  solutionLimit?: number;
}

export type SolverStatus = 'OPTIMAL' | 'FEASIBLE' | 'NO_SOLUTION' | 'INVALID_INPUT';

export interface SolverVisit extends OptimizeVisit {
  locationIndex: number;
}

export interface SolverRoute {
  vehicleId: string;
  startS: number;
  endS: number;
  durationS: number;
  distanceM: number | null;
  /** [start, …stops, end] location indexes. */
  locationSequence: number[];
  stops: SolverVisit[];
  load: number | null;
}

export interface SolverResult {
  status: SolverStatus;
  provenOptimal: boolean;
  solverStatus?: string;
  objective?: number;
  /** INVALID_INPUT only. */
  error?: string;
  routes: SolverRoute[];
  unassigned: { stopId: string; reason: OptimizeUnassignedReason }[];
  stats?: { wallTimeMs: number; timeLimitS: number; stops?: number; vehicles?: number };
  note?: string;
}

/** Limits enforced by the solver service itself (`LIMITS` in solver.py). */
export const SOLVER_LIMITS = { stops: 500, vehicles: 50, locations: 600, timeLimitS: 120 } as const;

// ───────────────────────────── jobs ─────────────────────────────

/** `RoutingJobStatus` enum values in the database. */
export const ROUTING_JOB_STATUSES = ['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED'] as const;
export type RoutingJobStatus = (typeof ROUTING_JOB_STATUSES)[number];
/** Job state in the API (doc 06 §3 `JobState`). */
export type RoutingJobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export const ROUTING_JOB_STATE_OF: Record<RoutingJobStatus, RoutingJobState> = {
  QUEUED: 'queued',
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};
export const ROUTING_JOB_FINISHED: readonly RoutingJobStatus[] = ['SUCCEEDED', 'FAILED', 'CANCELLED'];

/** `RoutingJob.kind` (CHECK in the database). */
export const ROUTING_JOB_KINDS = ['optimize', 'matrix'] as const;
export type RoutingJobKind = (typeof ROUTING_JOB_KINDS)[number];
/** `RoutingJob.phase` (CHECK in the database). */
export const ROUTING_JOB_PHASES = ['matrix', 'assign_stops', 'solve', 'route_legs', 'done'] as const;
export type RoutingJobPhase = (typeof ROUTING_JOB_PHASES)[number];

/**
 * `RoutingJob.input` (JSON). Privacy rule: no passenger coordinates and no names. An optimise job references its plan
 * (the worker reads the stops at run time, so an erasure or consent withdrawal before the run is honoured); a matrix
 * job holds company / site points only.
 */
export type RoutingJobInput =
  | { kind: 'optimize'; planId: string; planVersion: number; profile: RoutingProfile; timeLimitS: number; objective?: 'duration' | 'distance' }
  | { kind: 'matrix'; profile: RoutingProfile; sources: LatLng[]; targets: LatLng[]; timeoutS?: number };

export interface RoutingJobError {
  code: RoutingDegradedReason | 'OPTIMIZER_BUSY' | 'OPTIMIZER_UNAVAILABLE' | 'INVALID_INPUT' | 'TIMEOUT' | 'CANCELLED' | 'PLAN_STALE';
  message: string;
  /** Seconds until the worker retries (when it will). */
  retry?: number;
}

export interface RoutingJobDto {
  jobId: string;
  kind: RoutingJobKind;
  state: RoutingJobState;
  phase: RoutingJobPhase | null;
  /** 0..100 */
  progress: number;
  attempts: number;
  maxAttempts: number;
  cancelRequested: boolean;
  planId: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  graphVersion: string | null;
  /** OptimizeResult (stop ids, sequences and times only) or MatrixResponse. */
  result?: OptimizeResult | MatrixResponse;
  error?: RoutingJobError;
  attribution: string;
}

export interface MatrixJobRequest extends MatrixRequest {
  /** Overall job timeout (default 300 s). */
  timeoutS?: number;
}

export interface RoutingUsageDay {
  day: string;
  routes: number;
  matrixCells: number;
  optimizeJobs: number;
  cacheHits: number;
}

// ───────────────────────────── access and capabilities ─────────────────────────────

/**
 * Menu key of the ETMS planner (R2 Q-d: an `etms_*` key under the `etms` company feature; the old `route_plans` key,
 * its build-time flag and its Manager preset are not ported). Added to `MENUS` with the planner page (WP 4.5).
 */
export const ETMS_PLANNING_MENU = 'etms_planning' as const;

/** Plan visibility: whole company, the caller's branches / vehicles, only plans assigned to the caller's driver, or none. */
export type RoutingScope = 'COMPANY' | 'ASSIGNED' | 'OWN' | 'NONE';

export interface RoutingAccess {
  enabled: boolean;
  canView: boolean;
  /** Create plans and optimise. */
  canPlan: boolean;
  canEdit: boolean;
  canDelete: boolean;
  /** Publish a plan into dispatch (PlannedTrip + TransportTrip). */
  canPublish: boolean;
  scope: RoutingScope;
  /** Super Admin acting in another company: read-only, every request audited. */
  support: boolean;
  reason?: string;
}

export interface RoutingCapabilities {
  /** ETMS on, ETMS_ROUTING=on and the company add-on `etms`. */
  enabled: boolean;
  engine: RoutingEngine | null;
  engineReachable: boolean;
  engineVersion: string | null;
  graphVersion: string | null;
  optimizer: boolean;
  /** Routing worker processes alive (jobs wait in the queue while this is 0). */
  workers: number;
  etaBands: EtaBandStatus;
  profiles: readonly RoutingProfile[];
  limits: typeof ROUTING_LIMITS;
  /** Always false: no live traffic source exists. */
  liveTraffic: false;
  attribution: string;
  access: RoutingAccess;
}

// ───────────────────────────── plans ─────────────────────────────

/** `RoutePlanStatus` (no COMPLETED: execution lives on PlannedTrip / TransportTrip, D2). */
export const ROUTE_PLAN_STATUSES = ['DRAFT', 'OPTIMIZING', 'PLANNED', 'PUBLISHED', 'CANCELLED'] as const;
export type RoutePlanStatus = (typeof ROUTE_PLAN_STATUSES)[number];
/** Statuses in which stops / assignments may still be edited (after PUBLISHED a plan is read-only history, D2). */
export const ROUTE_PLAN_EDITABLE: readonly RoutePlanStatus[] = ['DRAFT', 'PLANNED'];

/** `RoutePlanStop.stopKind` for ETMS stops (one booking end each); null for generic stops. */
export type RoutePlanStopKind = 'PICKUP' | 'DROP';

export interface RoutePlanStopDto {
  id: string;
  ref: string;
  /** Generic label; personal points carry no address (as PERSONAL_STOP_NAME on planned stops). */
  name: string | null;
  /** Exact for whole-company roles; rounded to 4 decimals for branch-scoped / provider views (doc 02 §7.2). */
  lat: number;
  lng: number;
  /** Road-snapped point used for routing (null until snapped). */
  snappedLat: number | null;
  snappedLng: number | null;
  snapDistanceM: number | null;
  demand: number;
  serviceS: number;
  timeWindows: [number, number][] | null;
  assignmentId: string | null;
  sequence: number | null;
  etaS: number | null;
  unassignedReason: OptimizeUnassignedReason | string | null;
  /** ETMS links (null for generic stops). */
  stopKind: RoutePlanStopKind | null;
  bookingId: string | null;
  profileId: string | null;
  poiId: string | null;
  customerCompanyId: string | null;
  /** true when the point is a passenger's personal point (profileId set, no poiId): access-audited, erasable. */
  personal: boolean;
}

export interface RoutePlanAssignmentDto {
  id: string;
  seq: number;
  vehicleLabel: string;
  objectId: string | null;
  driverId: string | null;
  capacity: number | null;
  distanceM: number | null;
  durationS: number | null;
  adjustedDurationS: number | null;
  startS: number | null;
  endS: number | null;
  geometry: LineStringGeometry | null;
  eta: EtaModel | null;
  /** The TransportTrip this assignment was published into (null before publish). */
  transportTripId: string | null;
}

export interface RoutePlanDto {
  id: string;
  name: string;
  planDate: string;
  /** Seconds in the plan are relative to this instant (ISO). */
  planStartAt: string | null;
  status: RoutePlanStatus;
  profile: RoutingProfile;
  branchId: string | null;
  graphVersion: string | null;
  /** Company place (never a personal point). */
  depot: LatLng | null;
  /** ETMS links. */
  direction: TransportDirection | null;
  shiftId: string | null;
  sitePoiId: string | null;
  version: number;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  stops: RoutePlanStopDto[];
  assignments: RoutePlanAssignmentDto[];
}

export interface RoutePlanSummaryDto {
  id: string;
  name: string;
  planDate: string;
  status: RoutePlanStatus;
  direction: TransportDirection | null;
  stops: number;
  assignments: number;
  unassigned: number;
  version: number;
  updatedAt: string;
}

/** `RoutePlanVersion.changeType` (open set in the database). */
export type RoutePlanChangeType = 'CREATED' | 'EDITED' | 'OPTIMIZED' | 'RESEQUENCED' | 'RECALCULATED' | 'PUBLISHED' | 'CANCELLED' | 'ERASED';

/**
 * `RoutePlanVersion.snapshot` (JSON). Privacy rule: stop ids, sequences and times only, **no coordinates or names** of
 * any stop (the live rows hold those, and erasure / consent withdrawal scrub the live rows).
 */
export interface RoutePlanVersionSnapshot {
  status: RoutePlanStatus;
  assignments: { id: string; vehicleLabel: string; objectId: string | null; driverId: string | null; stopIds: string[] }[];
  stops: { id: string; ref: string; assignmentId: string | null; sequence: number | null; etaS: number | null; unassignedReason: string | null }[];
}

export interface RoutePlanVersionDto {
  version: number;
  changeType: RoutePlanChangeType | string;
  changedById: string | null;
  createdAt: string;
  snapshot: RoutePlanVersionSnapshot;
}

/** Time-window check after a manual reorder / recalculation (renamed from the branch's RouteStopViolation). */
export interface RoutePlanStopViolation {
  stopId: string;
  ref: string;
  kind: 'late' | 'early_wait' | 'unreachable' | 'over_capacity' | 'max_ride_exceeded';
  etaS: number | null;
  window: [number, number] | null;
}

// ───────────────────────────── plan requests ─────────────────────────────

export interface CreateRoutePlanRequest {
  name: string;
  planDate: string;
  planStartAt?: string;
  profile?: RoutingProfile;
  branchId?: string | null;
  depot?: LatLng | null;
  /** ETMS: build stops from the bookings of this service date / direction / shift / site. */
  direction?: TransportDirection;
  shiftId?: string | null;
  sitePoiId?: string | null;
}

export interface RoutePlanStopInput {
  ref: string;
  name?: string | null;
  /** Company / site points only; passenger points come from bookingId (consent-gated at the source). */
  location?: LatLng;
  poiId?: string | null;
  bookingId?: string | null;
  stopKind?: RoutePlanStopKind | null;
  demand?: number;
  serviceS?: number;
  timeWindows?: [number, number][] | null;
}

export interface RoutePlanResequenceRequest {
  expectedVersion: number;
  assignments: { assignmentId: string; stopIds: string[] }[];
}

/** POST /route-plans/:id/publish — into PlannedTrip + TransportTrip through the doc 15 §8.4 publish transaction. */
export interface PublishRoutePlanRequest {
  expectedVersion: number;
  idempotencyKey: string;
}

export interface PublishRoutePlanResult {
  planId: string;
  version: number;
  trips: { assignmentId: string; transportTripId: string; plannedTripId: string | null }[];
  changeSetId: string;
}

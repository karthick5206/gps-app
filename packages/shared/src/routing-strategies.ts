/**
 * ETMS E4 WP-A (doc 18 §6–7): optimisation strategies, run preferences, alternative plans and the compare metric
 * definitions. Types and English texts only (the web package translates them); the server maps a strategy to solver
 * weights in `apps/api/src/routing-jobs/strategies.ts`.
 *
 * Nothing here can override safety, seats, consent, company isolation, time windows or the company max-ride policy: a
 * strategy only changes the objective weights, and every preference is either a cost (soft) or a tighter limit.
 */

// ───────────────────────────── strategies ─────────────────────────────

export const ROUTING_STRATEGIES = ['BALANCED', 'FEWER_VEHICLES', 'SHORTEST_DISTANCE', 'FASTEST', 'COMFORT'] as const;
export type RoutingStrategy = (typeof ROUTING_STRATEGIES)[number];
export const DEFAULT_ROUTING_STRATEGY: RoutingStrategy = 'BALANCED';

export const isRoutingStrategy = (v: unknown): v is RoutingStrategy => typeof v === 'string' && (ROUTING_STRATEGIES as readonly string[]).includes(v);

/** What a strategy is for and what it gives up (shown next to the strategy picker; English, translated by the web). */
export interface RoutingStrategyInfo {
  label: string;
  summary: string;
  tradeOffs: string;
}

export const ROUTING_STRATEGY_INFO: Record<RoutingStrategy, RoutingStrategyInfo> = {
  BALANCED: {
    label: 'Balanced',
    summary: 'A fair mix of vehicles, driving time and passenger ride time.',
    tradeOffs: 'May use one more vehicle than "Fewer vehicles" when that clearly shortens rides; rides stay close to direct.',
  },
  FEWER_VEHICLES: {
    label: 'Fewer vehicles',
    summary: 'Uses as few vehicles as possible and fills them up.',
    tradeOffs: 'Longer rides and detours: passengers from different directions may share a vehicle, up to the maximum ride time.',
  },
  SHORTEST_DISTANCE: {
    label: 'Shortest distance',
    summary: 'Least total kilometres driven by the fleet.',
    tradeOffs: 'Can take slower roads, so driving and ride times may be longer; uses a vehicle more only when it saves distance.',
  },
  FASTEST: {
    label: 'Fastest',
    summary: 'Least total driving time; vehicles are cheap to add.',
    tradeOffs: 'Usually needs more vehicles (and drivers), each less full.',
  },
  COMFORT: {
    label: 'Comfort',
    summary: 'Shortest passenger rides, fewer detours.',
    tradeOffs: 'More vehicles and more total driving than Balanced.',
  },
};

// ───────────────────────────── preferences (optimise request, stored in RoutePlan.options.preferences) ─────────────────────────────

export const VEHICLE_SIZE_PREFERENCES = ['ANY', 'SMALLER', 'LARGER'] as const;
export type VehicleSizePreference = (typeof VEHICLE_SIZE_PREFERENCES)[number];
export const GROUPING_PREFERENCES = ['ALLOW_MIXED_DIRECTIONS', 'KEEP_DIRECTIONS'] as const;
export type GroupingPreference = (typeof GROUPING_PREFERENCES)[number];

/** Bounds of the run preferences (validated by the API). */
export const ROUTE_PLAN_PREFERENCE_BOUNDS = {
  detourRatio: { min: 1.2, max: 3 },
  detourExtraMin: { min: 0, max: 60 },
  preferredOccupancy: { min: 0.5, max: 1 },
} as const;

/** The detour guard used by KEEP_DIRECTIONS when the request names none. */
export const KEEP_DIRECTIONS_DETOUR = { ratio: 1.6, extraMin: 10 } as const;

/**
 * Optional preferences of one optimisation (POST /routing/jobs/optimize, /route-plans/:id/optimize, alternatives):
 * - `maxRideS`: a tighter max ride for this run only. Never above the plan's effective max ride (override, else company
 *   policy; 400 MAX_RIDE_ABOVE_POLICY); raising the limit needs `maxRideOverride` (authorised callers only).
 * - `detourGuard`: soft per-passenger ride bound max(direct × ratio, direct + extraMin), costed in the solver.
 * - `preferredOccupancy` (0.5–1): scales the vehicle weight by 2^(4 × (p − 0.75)) — 0.5 → × 0.5, 0.75 → × 1, 1 → × 2 —
 *   so a higher target fills vehicles more before another is used.
 * - `vehicleSize`: SMALLER makes large vehicles dearer (fixed cost × seats / average seats), LARGER makes them cheaper
 *   (× average seats / seats); factors clamped to 0.25–4; ANY = unchanged.
 * - `groupingPreference`: KEEP_DIRECTIONS turns on a default detour guard (ratio 1.6, +10 min) when none is given.
 * - `preservePins` (default true): false = ignore the pinned stops for this run.
 * - `preserveLocks` (default true): false re-solves locked routes too; only for callers with etms_planning:edit, audited.
 *   Published routes are never re-solved.
 */
export interface RoutePlanPreferences {
  maxRideS?: number;
  detourGuard?: { ratio: number; extraMin: number };
  preferredOccupancy?: number;
  vehicleSize?: VehicleSizePreference;
  groupingPreference?: GroupingPreference;
  preservePins?: boolean;
  preserveLocks?: boolean;
}

/** Fixed solver cost per second of detour above the guard (server-side constant, not a request field). */
export const DETOUR_GUARD_COST_PER_S = 20;

/** API error codes added by WP-A (in addition to the routing codes). */
export const ROUTE_PLAN_STRATEGY_ERROR_CODES = {
  /** 400: the preference max ride is above the plan's effective max ride (override, else policy). */
  MAX_RIDE_ABOVE_POLICY: 400,
  /** 403: preserveLocks=false without etms_planning:edit (also the max-ride override rule). */
  FORBIDDEN_GRANT: 403,
} as const;

// ───────────────────────────── alternatives ─────────────────────────────

export const ROUTE_PLAN_ALTERNATIVES = { min: 2, max: 5 } as const;

/**
 * POST /transport/route-plans/:id/alternatives (etms_planning:create, Idempotency-Key): one sibling DRAFT plan per
 * strategy (same bookings / stops, vehicles, depot, site, shift, branch and max-ride override as the source; stops
 * unassigned; published routes and their passengers are not cloned; locks and pins are not copied), each with one
 * optimise job queued through the normal job service. A replay with the same key and body answers the same siblings and
 * starts the jobs that could not start before (per-company concurrency).
 */
export interface RoutePlanAlternativesRequest {
  strategies: RoutingStrategy[];
  expectedVersion: number;
  timeLimitS?: number;
  preferences?: RoutePlanPreferences;
}

export interface RoutePlanAlternativeJob {
  strategy: RoutingStrategy;
  planId: string;
  /** null when the job could not start yet (QUOTA_EXCEEDED: concurrency); replay the request or optimise the plan later. */
  jobId: string | null;
  jobState: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | null;
  error?: { code: string; message: string };
}

export interface RoutePlanAlternativesResult {
  sourcePlanId: string;
  alternatives: RoutePlanAlternativeJob[];
  /** Bookings of the source not cloned (consent_required: no active routing consent any more; published: on a published route). */
  skippedBookings: { bookingId: string; reason: 'consent_required' | 'published' }[];
}

/** GET /transport/route-plans/:id/alternatives — the siblings of a plan (the plan itself when it is one, its source's otherwise). */
export interface RoutePlanAlternativeDto {
  planId: string;
  name: string;
  strategy: RoutingStrategy | null;
  status: string;
  version: number;
  createdAt: string;
  job: { jobId: string; state: string; progress: number; error?: { code: string; message: string } } | null;
}

export interface RoutePlanAlternativesList {
  sourcePlanId: string;
  alternatives: RoutePlanAlternativeDto[];
}

// ───────────────────────────── compare metrics ─────────────────────────────

/**
 * Definitions of the compare metrics (RoutePlanMetricsDto, computed from the stored plan rows by plan-metrics.ts):
 */
export const ROUTE_PLAN_METRIC_DEFINITIONS = {
  vehiclesUsed: 'Routes carrying at least one stop.',
  passengersAssigned: "Seats (the bookings' passenger counts) of bookings whose passenger end (IN: pickup, OUT: drop) is on a route.",
  bookingsAssigned: 'Bookings whose passenger end is on a route.',
  totalDistanceM: 'Sum of RouteAssignment.distanceM over the routes used; null when any used route has no distance.',
  totalTravelS: 'Sum of RouteAssignment.durationS over the routes used (estimated, uncalibrated); null when any used route is not timed.',
  maxRideS: 'Longest passenger ride: drop ETA − pickup ETA on the same route (IN: pickup → site arrival, OUT: site departure → drop); null without timed rides.',
  avgRideS: 'Mean of those rides, rounded to the second.',
  occupancy: 'Per used route: seats taken / vehicle seats (null without seats).',
  avgOccupancy: 'Mean of the per-route occupancies that have seats; null when none.',
  deadlineCompliance: "Assigned bookings whose site arrival (IN) / departure (OUT) ETA lies inside the booking's own window, out of assigned bookings with a window and an ETA.",
  excluded: "Bookings not on any route, counted by the passenger end's unassigned reason ('not_optimised' when none).",
  strategy: 'The strategy of the last optimisation (RoutePlan.options.strategy); null for raw weights / never optimised.',
} as const;

export interface RoutePlanVehicleOccupancy {
  assignmentId: string;
  vehicleLabel: string;
  passengers: number;
  seats: number | null;
  ratio: number | null;
}

export interface RoutePlanExcludedCount {
  reason: string;
  bookings: number;
}

// ───────────────────────────── unassigned / unusable reasons ─────────────────────────────

/**
 * Why a vehicle could not be used in an optimisation (OptimizeResult.unusableVehicles): VEHICLE_BUSY / DRIVER_BUSY are
 * decided by the API before the solve (another planned trip overlaps the whole usable time); the others come from the
 * solver.
 */
export const OPTIMIZE_UNUSABLE_VEHICLE_REASONS = ['VEHICLE_BUSY', 'DRIVER_BUSY', 'invalid_availability_window', 'availability_outside_site_window', 'cannot_reach_site'] as const;
export type OptimizeUnusableVehicleReason = (typeof OPTIMIZE_UNUSABLE_VEHICLE_REASONS)[number];

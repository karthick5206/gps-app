/**
 * Pure helpers of the ETMS route planner (E4 WP 4.5, doc 17 §7 P10). No React, DOM or path aliases, so `node --test`
 * runs them. Labels are English i18n keys; components pass them through `t()`.
 *
 * Rules carried here (docs 06 §3, 07 §5, 02 §7.2, P6):
 * - An ETA is shown only when the routing engine produced it (`EtaModel.source` engine_*); a live / heuristic source is
 *   never shown, and nothing is estimated in the browser (no straight lines, no default speeds).
 * - Every time carries "uncalibrated · no live traffic" until a calibration exists.
 * - A passenger's personal point is drawn only when the API sent coordinates for it (consent / branch scope gate at the
 *   source); branch-scoped viewers get 4 decimals.
 * - Compare: a "Best" marker only where better is unambiguous; no overall winner unless the user set weights.
 * - Edits are explicit actions (move, up / down, change vehicle, pin); no drag library.
 * Salvaged from the routing branch `planner-utils.ts` (vehicle colours, sequence helpers, unassigned labels).
 */
import type {
  EtaModel,
  OptimizeUnassignedReason,
  RoutePlanAssignmentDto,
  RoutePlanAssignmentViewDto,
  RoutePlanDetailDto,
  RoutePlanEditResult,
  RoutePlanMetricsDto,
  RoutePlanStatus,
  RoutePlanStopDto,
  RoutePlanStopViewDto,
  RoutePlanStopViolation,
  RoutingAccess,
  RoutingCapabilities,
  RoutingJobDto,
  RoutingJobState,
  TransportDirection,
} from '@veetracer/shared';

export type Tone = 'success' | 'warning' | 'destructive' | 'info' | 'neutral' | 'muted';
type Translate = (key: string, vars?: Record<string, string | number>) => string;
const english: Translate = (key, vars) => key.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(vars?.[name] ?? ''));

// ───────────────────────────── plans API views (E4-F routing-plans.ts) ─────────────────────────────

/** A stop as the caller may see it (consent-gated point: lat / lng null when withheld; `passengerName` "First L." when the caller may see names). */
export type PlannerStop = RoutePlanStopViewDto;
export type PlannerAssignment = RoutePlanAssignmentViewDto;

/** The plan detail (GET /transport/route-plans/:id) plus what the web keeps for its own screens. */
export type PlannerPlan = Omit<RoutePlanDetailDto, 'stops'> & {
  stops: PlannerStop[];
  /** Weights the user set when this plan was optimised from this browser (the API stores them on the plan). */
  weights?: PlannerWeights | null;
  /** The last optimise job started for the plan (web-side). */
  lastJobId?: string | null;
};

/** Result of an edit: the new version, its re-validation, and `degraded` when routes could not be re-timed. */
export type PlanEditResult = Omit<RoutePlanEditResult, 'plan'> & { plan: PlannerPlan };

/** Accepts `{ plan, violations, degraded }` or a bare plan. */
export function toEditResult(raw: unknown): PlanEditResult {
  const r = raw as Partial<PlanEditResult> & PlannerPlan;
  if (r && typeof r === 'object' && r.plan && typeof r.plan === 'object') return { plan: r.plan, violations: r.violations ?? r.plan.violations ?? [], degraded: r.degraded ?? null };
  return { plan: r, violations: r?.violations ?? [], degraded: null };
}

/** Lists may come as an array or `Paginated`. */
export function toList<T>(raw: T[] | { items: T[] } | null | undefined): T[] {
  if (!raw) return [];
  return Array.isArray(raw) ? raw : (raw.items ?? []);
}

// ───────────────────────────── objective weights (P6: explicit, never implied) ─────────────────────────────

/**
 * The solver weights exactly as the jobs API takes them (`OptimizeOptionsDto.weights`, solver `options.weights`):
 * vehicle = fixed cost of each vehicle used; distance = cost per metre; time = cost per second of drive time;
 * routeDuration = cost per second of each route's span. All in the same cost unit. No defaults: the user sets each.
 */
export const WEIGHT_KEYS = ['vehicle', 'distance', 'time', 'routeDuration'] as const;
export type WeightKey = (typeof WEIGHT_KEYS)[number];
export type PlannerWeights = Record<WeightKey, number>;
/** Form state: null = not set yet (the user must set every weight; 0 = ignore). */
export type WeightDraft = Record<WeightKey, number | null>;

export const WEIGHT_LABEL: Record<WeightKey, string> = {
  vehicle: 'Cost of each vehicle used',
  distance: 'Cost per metre driven',
  time: 'Cost per second of driving',
  routeDuration: 'Cost per second of route length',
};
export const WEIGHT_HINT: Record<WeightKey, string> = {
  vehicle: 'Counted in seconds of driving: 7200 means a vehicle is used only if it saves about 2 h.',
  distance: 'Use with a road distance objective; 0 to ignore distance.',
  time: 'Total drive time of all routes; 1 is a common start.',
  routeDuration: 'Keeps each route (and so the longest ride) short; 0 to ignore.',
};
/** Limits of the API DTO (SolverWeightsDto). */
export const WEIGHT_MIN = 0;
export const WEIGHT_MAX: Record<WeightKey, number> = { vehicle: 10_000_000, distance: 10_000, time: 10_000, routeDuration: 10_000 };

export function emptyWeights(): WeightDraft {
  return { vehicle: null, distance: null, time: null, routeDuration: null };
}

/** Parses one weight input ("" → null; clamps to the API range; decimals allowed). */
export function parseWeight(text: string, key: WeightKey): number | null {
  const s = text.trim().replace(',', '.');
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return Math.max(WEIGHT_MIN, Math.min(WEIGHT_MAX[key], n));
}

/** The weights when every one is set and one of distance / time / routeDuration is above 0 (the API rule); else null. */
export function completeWeights(d: WeightDraft): PlannerWeights | null {
  if (WEIGHT_KEYS.some((k) => d[k] === null)) return null;
  const w = d as PlannerWeights;
  return w.distance > 0 || w.time > 0 || w.routeDuration > 0 ? { ...w } : null;
}

/** The P3 objective sent alongside (informational; explicit weights win on the solver). */
export function solverObjective(w: PlannerWeights): 'distance' | 'duration' {
  return w.distance > 0 && w.time === 0 && w.routeDuration === 0 ? 'distance' : 'duration';
}

// ───────────────────────────── ETA provenance ─────────────────────────────

/** true only for numbers the routing engine produced (never a live / heuristic source). */
export function engineEta(eta: EtaModel | null | undefined): eta is EtaModel {
  return !!eta && (eta.source === 'engine_free_flow' || eta.source === 'engine_calibrated') && eta.liveTraffic === false;
}

export type EtaQuality = 'calibrated' | 'uncalibrated' | 'none';

/** Worst ETA quality over the plan's routes with stops (07 §5: the column shows the worst case). */
export function etaQuality(assignments: readonly Pick<RoutePlanAssignmentDto, 'eta'>[]): EtaQuality {
  const models = assignments.map((a) => a.eta).filter(engineEta);
  if (!models.length) return 'none';
  return models.every((m) => m.calibrated) ? 'calibrated' : 'uncalibrated';
}

export const ETA_QUALITY_META: Record<EtaQuality, { label: string; tone: Tone; hint: string }> = {
  calibrated: { label: 'Calibrated', tone: 'success', hint: 'Engine time with a measured correction. No live traffic.' },
  uncalibrated: { label: 'Uncalibrated', tone: 'warning', hint: 'ETA is uncalibrated: free-flow road time, no correction and no live traffic.' },
  none: { label: 'No engine times', tone: 'muted', hint: 'The routing engine has not produced times for this plan.' },
};

/** Clock text for `offsetS` after the plan start in the zone (HH:MM, with the date when it is another day). */
export function planClock(planStartAt: string | null, offsetS: number | null | undefined, tz: string | undefined): string | null {
  if (!planStartAt || offsetS === null || offsetS === undefined || !Number.isFinite(offsetS)) return null;
  const ms = Date.parse(planStartAt);
  if (!Number.isFinite(ms)) return null;
  const at = new Date(ms + Math.round(offsetS) * 1000);
  try {
    return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: tz }).format(at);
  } catch {
    return `${String(at.getUTCHours()).padStart(2, '0')}:${String(at.getUTCMinutes()).padStart(2, '0')}`;
  }
}

export interface StopEtaView {
  /** HH:MM or null (never a guessed time). */
  at: string | null;
  note: string;
}

/** A stop's time: only an engine-produced one, labelled; otherwise the reason there is none. */
export function stopEta(stop: Pick<RoutePlanStopDto, 'etaS'>, assignment: Pick<RoutePlanAssignmentDto, 'eta'> | null | undefined, planStartAt: string | null, tz: string | undefined): StopEtaView {
  if (!assignment) return { at: null, note: 'Not on a route' };
  if (!engineEta(assignment.eta)) return { at: null, note: 'No engine time' };
  const at = planClock(planStartAt, stop.etaS, tz);
  if (!at) return { at: null, note: 'No engine time' };
  return { at, note: assignment.eta.calibrated ? 'estimate · no live traffic' : 'estimate · uncalibrated · no live traffic' };
}

// ───────────────────────────── units ─────────────────────────────

export function formatKm(m: number | null | undefined): string {
  if (m === null || m === undefined || !Number.isFinite(m)) return '—';
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(m < 10_000 ? 1 : 0)} km`;
}

export function formatDuration(s: number | null | undefined, t: Translate = english): string {
  if (s === null || s === undefined || !Number.isFinite(s)) return '—';
  const min = Math.round(s / 60);
  if (min < 60) return t('{{n}} min', { n: min });
  return t('{{h}} h {{m}} min', { h: Math.floor(min / 60), m: String(min % 60).padStart(2, '0') });
}

/** Distinct, colour-blind-friendly route colours (Okabe-Ito), one per vehicle; the list also shows the route number. */
export const VEHICLE_COLORS = ['#0072B2', '#D55E00', '#009E73', '#CC79A7', '#E69F00', '#56B4E9', '#7A5195', '#4D4D4D'] as const;
export const vehicleColor = (i: number): string => VEHICLE_COLORS[((i % VEHICLE_COLORS.length) + VEHICLE_COLORS.length) % VEHICLE_COLORS.length];

// ───────────────────────────── routes, stops and metrics ─────────────────────────────

/** Stops of one route in sequence order. */
export function routeStops<S extends Pick<RoutePlanStopDto, 'assignmentId' | 'sequence'>>(stops: readonly S[], assignmentId: string): S[] {
  return stops.filter((s) => s.assignmentId === assignmentId).sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
}

export function unassignedStops<S extends Pick<RoutePlanStopDto, 'assignmentId'>>(stops: readonly S[]): S[] {
  return stops.filter((s) => !s.assignmentId);
}

/**
 * Passengers without a seat: one row per passenger (the stop that stands for them, see passengerEnd), not both ends of
 * the booking. The office end of an unassigned booking is not a passenger (T2 E2E: "Unassigned 42 / 25").
 */
export function unassignedPassengers<S extends Pick<RoutePlanStopDto, 'assignmentId' | 'stopKind'>>(stops: readonly S[], direction: TransportDirection | null): S[] {
  return unassignedStops(stops).filter((s) => passengerEnd(s, direction));
}

/** Seats a route uses: each passenger counted once (at the stop that stands for them, see passengerEnd). */
export function routeLoad(stops: readonly (Pick<RoutePlanStopDto, 'demand' | 'stopKind'> & { seats?: number })[], direction: TransportDirection | null): number {
  return stops.filter((s) => passengerEnd(s, direction)).reduce((n, s) => n + Math.max(0, (s.seats ?? s.demand) || 0), 0);
}

/**
 * Ride time of one passenger stop: login (IN) = route end (site) − pickup time; logout (OUT) = drop time − route start.
 * null when an engine time is missing or the direction is unknown (generic stops).
 */
export function rideSeconds(stop: Pick<RoutePlanStopDto, 'etaS' | 'stopKind'>, a: Pick<RoutePlanAssignmentDto, 'startS' | 'endS' | 'eta'>, direction: TransportDirection | null): number | null {
  if (!engineEta(a.eta) || stop.etaS === null || !direction) return null;
  if (direction === 'IN' && stop.stopKind !== 'DROP' && a.endS !== null) return Math.max(0, a.endS - stop.etaS);
  if (direction === 'OUT' && stop.stopKind !== 'PICKUP' && a.startS !== null) return Math.max(0, stop.etaS - a.startS);
  return null;
}

/** The stop that stands for a passenger: the pickup of a login (IN), the drop of a logout (OUT), any generic stop. */
export function passengerEnd(s: Pick<RoutePlanStopDto, 'stopKind'>, direction: TransportDirection | null): boolean {
  if (direction === 'IN') return s.stopKind !== 'DROP';
  if (direction === 'OUT') return s.stopKind !== 'PICKUP';
  return true;
}

export interface PlanMetrics {
  vehiclesUsed: number;
  vehiclesTotal: number;
  /** Sum over routes with stops; null when any such route lacks an engine number. */
  distanceM: number | null;
  driveS: number | null;
  maxRideS: number | null;
  avgRideS: number | null;
  seatsUsed: number;
  /** Seats of the vehicles used; null when any used vehicle has no capacity. */
  seats: number | null;
  passengers: number;
  unassigned: number;
  unassignedByReason: Record<string, number>;
  violations: number;
  violationsByKind: Record<string, number>;
  etaQuality: EtaQuality;
}

export function planMetrics(plan: Pick<PlannerPlan, 'stops' | 'assignments' | 'direction' | 'violations'>, extraViolations?: readonly RoutePlanStopViolation[]): PlanMetrics {
  const used = plan.assignments.filter((a) => plan.stops.some((s) => s.assignmentId === a.id));
  const sum = (vals: (number | null)[]) => (vals.length && vals.every((v) => v !== null) ? vals.reduce<number>((n, v) => n + (v as number), 0) : vals.length ? null : 0);
  const rides: number[] = [];
  let ridesMissing = false;
  for (const a of used) {
    for (const s of routeStops(plan.stops, a.id)) {
      if (!plan.direction || !passengerEnd(s, plan.direction)) continue;
      const r = rideSeconds(s, a, plan.direction);
      if (r === null) ridesMissing = true;
      else rides.push(r);
    }
  }
  const unassigned = unassignedPassengers(plan.stops, plan.direction);
  const unassignedByReason: Record<string, number> = {};
  for (const s of unassigned) {
    const k = s.unassignedReason ?? 'not_optimised';
    unassignedByReason[k] = (unassignedByReason[k] ?? 0) + 1;
  }
  const violations = mergeViolations(plan.violations ?? [], extraViolations ?? []);
  const violationsByKind: Record<string, number> = {};
  for (const v of violations) violationsByKind[v.kind] = (violationsByKind[v.kind] ?? 0) + 1;
  const engineOk = used.every((a) => engineEta(a.eta));
  return {
    vehiclesUsed: used.length,
    vehiclesTotal: plan.assignments.length,
    distanceM: engineOk ? sum(used.map((a) => a.distanceM)) : null,
    driveS: engineOk ? sum(used.map((a) => a.adjustedDurationS ?? a.durationS)) : null,
    maxRideS: !ridesMissing && rides.length ? Math.max(...rides) : null,
    avgRideS: !ridesMissing && rides.length ? Math.round(rides.reduce((n, r) => n + r, 0) / rides.length) : null,
    seatsUsed: used.reduce((n, a) => n + routeLoad(routeStops(plan.stops, a.id), plan.direction), 0),
    seats: used.length && used.every((a) => a.capacity !== null) ? used.reduce((n, a) => n + (a.capacity ?? 0), 0) : null,
    passengers: plan.stops.filter((s) => passengerEnd(s, plan.direction)).length,
    unassigned: unassigned.length,
    unassignedByReason,
    violations: violations.length,
    violationsByKind,
    etaQuality: etaQuality(used),
  };
}

/**
 * Metrics of GET /transport/route-plans/compare (metrics only, no stops). Ride times and ETA quality are not in that
 * DTO: they come from the plan detail when it is at hand (same version), else stay unknown.
 */
export function metricsFromCompare(d: RoutePlanMetricsDto, detail?: PlanMetrics | null): PlanMetrics {
  const vehicleSeats = d.seatUtilisation && d.seatUtilisation > 0 ? Math.round(d.seats / d.seatUtilisation) : null;
  return {
    vehiclesUsed: d.activeRoutes,
    vehiclesTotal: d.routes,
    distanceM: d.distanceM,
    driveS: d.durationS,
    maxRideS: detail?.maxRideS ?? null,
    avgRideS: detail?.avgRideS ?? null,
    seatsUsed: d.seats,
    seats: vehicleSeats,
    passengers: d.passengers,
    // The server counts unassigned stops (both ends of a booking); the detail of the same version counts passengers.
    unassigned: detail ? detail.unassigned : d.unassigned,
    unassignedByReason: detail?.unassignedByReason ?? {},
    violations: d.violations,
    violationsByKind: detail?.violationsByKind ?? {},
    etaQuality: detail?.etaQuality ?? (d.durationS === null ? 'none' : 'uncalibrated'),
  };
}

/** One entry per stop and kind (a later re-validation replaces an earlier one). */
export function mergeViolations(a: readonly RoutePlanStopViolation[], b: readonly RoutePlanStopViolation[]): RoutePlanStopViolation[] {
  const m = new Map<string, RoutePlanStopViolation>();
  for (const v of [...a, ...b]) m.set(`${v.stopId}|${v.kind}`, v);
  return [...m.values()];
}

export const UNASSIGNED_REASON_LABEL: Record<OptimizeUnassignedReason | 'not_optimised', string> = {
  outside_coverage: 'Point outside the routing area',
  not_on_road: 'Point not near a road',
  invalid_time_window: 'Time window ends before it starts',
  demand_exceeds_vehicle_capacity: 'More seats than any vehicle has',
  unreachable_location: 'No road route to this point',
  time_window_unreachable: 'Cannot be reached within its time window',
  exceeds_max_route_duration: 'Would exceed the maximum route duration',
  not_scheduled_capacity_or_time: 'Did not fit (seats or time) in the solution found',
  no_solution_found: 'No solution found',
  not_optimised: 'Not optimised yet',
  consent_withdrawn: 'Passenger consent withdrawn',
  needs_location: 'Pickup or drop point missing',
  booking_not_active: 'Booking no longer active',
  far_from_road: 'Point too far from the road (check the pin)',
  not_checked: 'Point could not be checked on the road map',
  invalid_location: 'Invalid point',
  no_vehicle_available: 'No vehicle available',
  no_compatible_vehicle: 'No suitable vehicle (seats, type or wheelchair)',
  safety_rule: 'Blocked by a safety rule (escort)',
  pinned_assignment_infeasible: 'The pinned vehicle cannot serve it',
  max_ride_unachievable: 'Ride would exceed the maximum ride time',
};

/** Why plan creation left a booking out (CreatedRoutePlanDto.skippedBookings[].reason). */
export const SKIPPED_REASON_LABEL: Record<string, string> = {
  consent_required: 'Passenger consent missing',
  needs_location: 'Pickup or drop point missing',
  out_of_scope: 'Outside your branches',
};

/** Bookings a new plan left out, counted per reason (in the order first seen). */
export function skippedSummary(skipped: readonly { bookingId: string; reason: string }[] | null | undefined): { reason: string; label: string; n: number }[] {
  const m = new Map<string, number>();
  for (const s of skipped ?? []) m.set(s.reason, (m.get(s.reason) ?? 0) + 1);
  return [...m].map(([reason, n]) => ({ reason, label: SKIPPED_REASON_LABEL[reason] ?? reason, n }));
}

/**
 * The job whose progress the plan page shows: the one started on this page, else (after a reload, or a job started
 * elsewhere) the plan's open job from GET /routing/jobs?planId (the plan detail carries no job id).
 */
export function activeJobId(plan: Pick<PlannerPlan, 'status' | 'lastJobId'>, localJobId: string | null, planJobs: readonly Pick<RoutingJobDto, 'jobId' | 'state'>[] | null | undefined): string | null {
  if (localJobId) return localJobId;
  if (plan.status !== 'OPTIMIZING') return null;
  return plan.lastJobId ?? planJobs?.find((j) => j.state === 'queued' || j.state === 'running')?.jobId ?? null;
}

export function unassignedReason(code: string | null | undefined): string {
  if (!code) return UNASSIGNED_REASON_LABEL.not_optimised;
  return (UNASSIGNED_REASON_LABEL as Record<string, string>)[code] ?? code;
}

export const VIOLATION_LABEL: Record<RoutePlanStopViolation['kind'], string> = {
  late: 'Arrives after its window',
  early_wait: 'Arrives early and waits',
  unreachable: 'Cannot be reached',
  over_capacity: 'More passengers than seats',
  max_ride_exceeded: 'Ride longer than the maximum',
};

// ───────────────────────────── statuses and jobs ─────────────────────────────

export const PLAN_STATUS_META: Record<RoutePlanStatus, { label: string; tone: Tone }> = {
  DRAFT: { label: 'Draft', tone: 'neutral' },
  OPTIMIZING: { label: 'Optimising', tone: 'info' },
  PLANNED: { label: 'Ready to review', tone: 'info' },
  PUBLISHED: { label: 'Published', tone: 'success' },
  CANCELLED: { label: 'Discarded', tone: 'muted' },
};

/** Violations that make a route unpublishable (the rest are warnings the user acknowledges). */
export const BLOCKING_VIOLATIONS: readonly RoutePlanStopViolation['kind'][] = ['over_capacity', 'unreachable'];

/**
 * Whether to offer Publish (B3): a DRAFT or PLANNED plan that is still editable with at least one route that has
 * passengers and no blocking violation. The server decides the rest (409 PLAN_NOT_PUBLISHABLE with routes[]).
 */
export function publishable(plan: Pick<PlannerPlan, 'status' | 'editable' | 'stops' | 'assignments' | 'violations'>, extra?: readonly RoutePlanStopViolation[]): boolean {
  if (plan.status !== 'DRAFT' && plan.status !== 'PLANNED') return false;
  if (plan.editable === false) return false;
  const blocked = new Set(mergeViolations(plan.violations ?? [], extra ?? []).filter((v) => BLOCKING_VIOLATIONS.includes(v.kind)).map((v) => v.stopId));
  return plan.assignments.some((a) => {
    const stops = plan.stops.filter((s) => s.assignmentId === a.id);
    return stops.length > 0 && !stops.some((s) => blocked.has(s.id)) && !(a.violations ?? []).some((v) => BLOCKING_VIOLATIONS.includes(v.kind));
  });
}

export function isEditablePlan(status: RoutePlanStatus): boolean {
  return status === 'DRAFT' || status === 'PLANNED';
}

export const JOB_STATE_META: Record<RoutingJobState, { label: string; tone: Tone }> = {
  queued: { label: 'Waiting in the queue', tone: 'neutral' },
  running: { label: 'Optimising', tone: 'info' },
  succeeded: { label: 'Done', tone: 'success' },
  failed: { label: 'Failed', tone: 'destructive' },
  cancelled: { label: 'Cancelled', tone: 'muted' },
};

export const JOB_PHASE_LABEL: Record<string, string> = {
  matrix: 'Road distances',
  assign_stops: 'Preparing stops',
  solve: 'Solving',
  route_legs: 'Road routes',
  done: 'Finishing',
};

export function jobFinished(job: Pick<RoutingJobDto, 'state'> | null | undefined): boolean {
  return !!job && (job.state === 'succeeded' || job.state === 'failed' || job.state === 'cancelled');
}

/** Poll interval for a job (null = stop polling). */
export function jobPollMs(job: Pick<RoutingJobDto, 'state'> | null | undefined): number | false {
  if (!job) return 1500;
  if (jobFinished(job)) return false;
  return job.state === 'queued' ? 3000 : 1500;
}

/** Why a job failed / why the planner cannot run, as text (job errors and API error codes). */
export const PLANNER_ERROR_TEXT: Record<string, string> = {
  // API error codes (RoutingErrorCode).
  ROUTING_DISABLED: 'Route planning is switched off for this company.',
  ROUTING_UNAVAILABLE: 'Routing unavailable: the road engine is not answering. No times were produced; dispatch manually from the board meanwhile.',
  NO_ROUTE: 'No road route between some points.',
  OUTSIDE_COVERAGE: 'Some points are outside the routing area.',
  LIMIT_EXCEEDED: 'Too many stops or vehicles for one optimisation. Split by shift or site.',
  QUOTA_EXCEEDED: 'The daily routing allowance is used up. Try again tomorrow.',
  OPTIMIZER_UNAVAILABLE: 'The optimiser is not running. Plans can still be edited by hand; dispatch manually meanwhile.',
  OPTIMIZER_BUSY: 'The optimiser is busy with other plans. Try again in a minute.',
  JOB_NOT_FOUND: 'This optimisation no longer exists.',
  PLAN_NOT_EDITABLE: 'This plan is published or discarded and can no longer change.',
  PLAN_STALE: 'Someone changed this plan meanwhile. The latest version was loaded; check it and try again.',
  VERSION_CONFLICT: 'Someone changed this plan meanwhile. The latest version was loaded; check it and try again.',
  IDEMPOTENCY_KEY_REUSED: 'This request was already sent with other content. Review and try again.',
  PLAN_NOT_PUBLISHABLE: 'This plan cannot be published yet: some routes need attention (see below).',
  ROUTE_LOCKED: 'That route is locked. Unlock it first.',
  STOP_PINNED: 'That stop is pinned. Unpin it first.',
  SITE_REQUIRED: 'A chosen shift has no site: choose exactly one site for it.',
  IDEMPOTENCY_KEY_REQUIRED: 'The request was missing its retry key. Try again.',
  // Job error codes (RoutingJobError.code / RoutingDegradedReason).
  ENGINE_DISABLED: 'Routing unavailable: the road engine is switched off.',
  ENGINE_NOT_SUPPORTED: 'Routing unavailable: this engine is not supported.',
  ENGINE_UNREACHABLE: 'Routing unavailable: the road engine is not answering.',
  ENGINE_TIMEOUT: 'Routing unavailable: the road engine took too long.',
  GRAPH_REBUILDING: 'Routing unavailable: the road map is being rebuilt. Try again later.',
  PROFILE_NOT_AVAILABLE: 'This vehicle type has no road profile yet.',
  POINT_NOT_ON_ROAD: 'A point is not near any road.',
  INVALID_INPUT: 'The plan has invalid stops or vehicles (check seats and time windows).',
  NOT_IMPLEMENTED: 'Not available yet.',
  TIMEOUT: 'The optimisation ran out of time without a result.',
  CANCELLED: 'Cancelled.',
  // Routing worker codes (shared RoutingJobErrorCode).
  WORKER_LOST: 'The optimisation worker stopped repeatedly. Try again, or dispatch manually meanwhile.',
  INTERNAL_ERROR: 'Unexpected error while optimising. Try again; if it repeats, tell your administrator.',
  MATRIX_INCOMPLETE: 'Not all road distances could be computed yet. The optimisation is retried shortly.',
  MATRIX_BUSY: 'Road distance calculation is busy. The optimisation is retried shortly.',
};

/** Error kind for presentation (E3 pattern): unavailable = engine / optimiser down; conflict = reload and redo. */
export type PlannerErrorKind = 'unavailable' | 'conflict' | 'forbidden' | 'invalid' | 'busy' | 'other';

export function plannerErrorKind(code: string | null | undefined, status?: number): PlannerErrorKind {
  switch (code) {
    case 'ROUTING_UNAVAILABLE':
    case 'OPTIMIZER_UNAVAILABLE':
    case 'ENGINE_DISABLED':
    case 'ENGINE_UNREACHABLE':
    case 'ENGINE_TIMEOUT':
    case 'GRAPH_REBUILDING':
    case 'ROUTING_DISABLED':
    case 'WORKER_LOST':
    case 'MATRIX_INCOMPLETE':
      return 'unavailable';
    case 'PLAN_STALE':
    case 'VERSION_CONFLICT':
      return 'conflict';
    case 'OPTIMIZER_BUSY':
    case 'MATRIX_BUSY':
    case 'QUOTA_EXCEEDED':
    case 'RATE_LIMITED':
      return 'busy';
    case 'PLAN_NOT_EDITABLE':
    case 'PLAN_NOT_PUBLISHABLE':
    case 'ROUTE_LOCKED':
    case 'STOP_PINNED':
    case 'LIMIT_EXCEEDED':
    case 'INVALID_INPUT':
    case 'OUTSIDE_COVERAGE':
    case 'NO_ROUTE':
      return 'invalid';
  }
  if (status === 403) return 'forbidden';
  if (status === 409) return 'conflict';
  if (status === 503) return 'unavailable';
  return 'other';
}

export function plannerErrorText(code: string | null | undefined): string | null {
  return code ? (PLANNER_ERROR_TEXT[code] ?? null) : null;
}

export interface CapabilityView {
  /** Optimise can start now. */
  canOptimise: boolean;
  tone: Tone;
  label: string;
  /** Why not / what to expect (null when all is well). */
  detail: string | null;
}

/** Routing health of the planner header (text, never colour alone). */
export function capabilityView(c: Pick<RoutingCapabilities, 'enabled' | 'engineReachable' | 'optimizer' | 'workers'> | null | undefined): CapabilityView {
  if (!c || !c.enabled) return { canOptimise: false, tone: 'muted', label: 'Route planning off', detail: 'Route planning is switched off for this company.' };
  if (!c.engineReachable) return { canOptimise: false, tone: 'warning', label: 'Routing unavailable', detail: 'Routing unavailable: the road engine is not answering. No new times can be produced; dispatch manually from the board meanwhile.' };
  if (!c.optimizer) return { canOptimise: false, tone: 'warning', label: 'Optimiser offline', detail: 'The optimiser is not running. Existing plans can be reviewed and edited; dispatch manually meanwhile.' };
  if (c.workers <= 0) return { canOptimise: true, tone: 'warning', label: 'Routing OK · queue paused', detail: 'No routing worker is running: new optimisations wait in the queue until one starts.' };
  return { canOptimise: true, tone: 'success', label: 'Routing OK', detail: null };
}

/** Short label of the caller's routing access for the header. */
export function accessLabel(a: Pick<RoutingAccess, 'support' | 'canView' | 'canPlan' | 'scope'>): string {
  if (a.support) return 'Support (read-only, audited)';
  if (!a.canView) return 'No planning access';
  if (a.canPlan) return a.scope === 'COMPANY' ? 'Plan & optimise · whole company' : 'Plan & optimise · my branches';
  return a.scope === 'COMPANY' ? 'View only · whole company' : 'View only · my branches';
}

// ───────────────────────────── privacy (02 §7.2) ─────────────────────────────

const round4 = (n: number) => Math.round(n * 1e4) / 1e4;

export interface MapPoint {
  id: string;
  lat: number;
  lng: number;
  /** Route index (colour) or -1 when unassigned. */
  route: number;
  /** 1-based position on its route (null when unassigned). */
  position: number | null;
  label: string;
  personal: boolean;
}

/**
 * Points the map may draw: only stops the API sent coordinates for (consent / branch gate at the source) and not
 * flagged hidden; a personal point is rounded to 4 decimals unless the API says the view is precise (whole-company
 * role), even if the API sent more. Company places stay exact.
 */
export function mapPoints(plan: Pick<PlannerPlan, 'stops' | 'assignments'>, precise: boolean): { points: MapPoint[]; hidden: number } {
  const points: MapPoint[] = [];
  let hidden = 0;
  for (const s of plan.stops) {
    if (s.pointHidden || s.lat === null || s.lng === null || !Number.isFinite(s.lat) || !Number.isFinite(s.lng) || (s.lat === 0 && s.lng === 0)) {
      hidden++;
      continue;
    }
    const route = s.assignmentId ? plan.assignments.findIndex((a) => a.id === s.assignmentId) : -1;
    const position = route >= 0 ? routeStops(plan.stops, s.assignmentId as string).findIndex((x) => x.id === s.id) + 1 : null;
    points.push({
      id: s.id,
      lat: precise || !s.personal ? s.lat : round4(s.lat),
      lng: precise || !s.personal ? s.lng : round4(s.lng),
      route,
      position,
      label: s.personal ? (s.stopKind === 'DROP' ? 'Passenger drop' : 'Passenger pickup') : (s.name ?? s.ref),
      personal: s.personal,
    });
  }
  return { points, hidden };
}

/** Road geometry per route (engine only; never straight lines between stops). */
export interface RouteLine {
  id: string;
  route: number;
  color: string;
  coordinates: [number, number][];
}

export function routeLines(plan: Pick<PlannerPlan, 'assignments'>): RouteLine[] {
  return plan.assignments.flatMap((a, i) => (a.geometry && a.geometry.coordinates.length > 1 && engineEta(a.eta) ? [{ id: a.id, route: i, color: vehicleColor(i), coordinates: a.geometry.coordinates }] : []));
}

/** Stop label for lists: never an address for personal points. */
export function stopLabel(s: Pick<PlannerStop, 'personal' | 'name' | 'ref' | 'stopKind' | 'passengerName'>, t: Translate = english): string {
  if (s.personal) {
    const what = s.stopKind === 'DROP' ? t('Drop') : t('Pickup');
    return s.passengerName ? `${what} · ${s.passengerName}` : `${what} · ${s.ref}`;
  }
  return s.name ?? s.ref;
}

// ───────────────────────────── manual edits (explicit actions; salvaged sequence helpers) ─────────────────────────────

export interface SeqRoute {
  assignmentId: string;
  stopIds: string[];
}

export function routesOf(plan: { assignments: readonly { id: string }[]; stops: readonly Pick<RoutePlanStopDto, 'id' | 'assignmentId' | 'sequence'>[] }): SeqRoute[] {
  return plan.assignments.map((a) => ({ assignmentId: a.id, stopIds: routeStops(plan.stops, a.id).map((s) => s.id) }));
}

/**
 * Move a stop to position `index` of route `to` (null = take off every route). Returns new arrays; an index past the
 * end appends. Moving within the same route reorders it.
 */
export function moveStop(routes: readonly SeqRoute[], stopId: string, to: string | null, index = Number.MAX_SAFE_INTEGER): SeqRoute[] {
  const next = routes.map((r) => ({ ...r, stopIds: r.stopIds.filter((s) => s !== stopId) }));
  if (to === null) return next;
  const target = next.find((r) => r.assignmentId === to);
  if (!target) throw new Error(`unknown route ${to}`);
  target.stopIds.splice(Math.max(0, Math.min(index, target.stopIds.length)), 0, stopId);
  return next;
}

/** Move a stop one place up (-1) or down (+1) within its route; unchanged at the ends. */
export function shiftStop(routes: readonly SeqRoute[], stopId: string, delta: -1 | 1): SeqRoute[] {
  const r = routes.find((x) => x.stopIds.includes(stopId));
  if (!r) return routes.map((x) => ({ ...x, stopIds: [...x.stopIds] }));
  const i = r.stopIds.indexOf(stopId);
  const j = i + delta;
  if (j < 0 || j >= r.stopIds.length) return routes.map((x) => ({ ...x, stopIds: [...x.stopIds] }));
  return moveStop(routes, stopId, r.assignmentId, j);
}

/**
 * Stops that travel together: a passenger's pickup and drop (same booking) move between routes as one. Within a
 * route, login pickups come before the site and logout drops after it, so a move appends pickups before the first
 * DROP and drops at the end.
 */
export function movePassenger(routes: readonly SeqRoute[], stops: readonly Pick<RoutePlanStopDto, 'id' | 'bookingId' | 'stopKind'>[], stopId: string, to: string): SeqRoute[] {
  const stop = stops.find((s) => s.id === stopId);
  const group = stop?.bookingId ? stops.filter((s) => s.bookingId === stop.bookingId) : stop ? [stop] : [];
  let next = routes.map((r) => ({ ...r, stopIds: [...r.stopIds] }));
  const kindOf = new Map(stops.map((s) => [s.id, s.stopKind]));
  for (const s of [...group].sort((a, b) => (a.stopKind === 'DROP' ? 1 : 0) - (b.stopKind === 'DROP' ? 1 : 0))) {
    next = moveStop(next, s.id, null);
    const target = next.find((r) => r.assignmentId === to);
    if (!target) throw new Error(`unknown route ${to}`);
    if (s.stopKind === 'DROP') target.stopIds.push(s.id);
    else {
      const firstDrop = target.stopIds.findIndex((id) => kindOf.get(id) === 'DROP');
      target.stopIds.splice(firstDrop < 0 ? target.stopIds.length : firstDrop, 0, s.id);
    }
  }
  return next;
}

/** Only routes whose order changed (the resequence request body). */
export function changedRoutes(before: readonly SeqRoute[], after: readonly SeqRoute[]): SeqRoute[] {
  const b = new Map(before.map((r) => [r.assignmentId, r.stopIds.join(',')]));
  return after.filter((r) => b.get(r.assignmentId) !== r.stopIds.join(','));
}

// ───────────────────────────── optimise selection → plan requests ─────────────────────────────

export interface ShiftChoice {
  id: string;
  name: string;
  siteId: string | null;
  siteName: string | null;
  startMin: number;
  endMin: number;
  /** The shift's IANA zone (falls back to the planner's). */
  timeZone?: string | null;
}

export interface PlanSeed {
  name: string;
  shiftId: string;
  sitePoiId: string | null;
  /** ISO instant the plan's seconds count from (shift start for logins, shift end for logouts) in the zone. */
  planStartAt: string | null;
}

/** Local wall time `day` + `minutes` in IANA zone `tz` → ISO instant (DST-safe two-pass offset). */
export function zonedIso(day: string, minutes: number, tz: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return null;
  const guess = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, Math.round(minutes));
  const offset = (ms: number) => {
    try {
      const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(ms));
      const g = (type: string) => Number(parts.find((p) => p.type === type)?.value);
      return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour') % 24, g('minute')) - ms;
    } catch {
      return 0;
    }
  };
  const first = guess - offset(guess);
  const ms = guess - offset(first);
  return new Date(ms).toISOString();
}

/**
 * One plan per selected shift (a plan has one shift and one site). Logins count from 2 h before the shift start (the
 * solver window ends at the shift start); logouts from the shift end.
 */
export function planSeeds(input: { day: string; direction: TransportDirection; shifts: readonly ShiftChoice[]; shiftIds: readonly string[]; siteIds: readonly string[]; tz: string }, t: Translate = english): PlanSeed[] {
  const chosen = input.shifts.filter((s) => input.shiftIds.includes(s.id) && (input.siteIds.length === 0 || (s.siteId !== null && input.siteIds.includes(s.siteId)) || s.siteId === null));
  return chosen.map((s) => {
    const site = s.siteId ?? (input.siteIds.length === 1 ? input.siteIds[0] : null);
    const startMin = input.direction === 'IN' ? s.startMin - 120 : s.endMin;
    const name = t('{{date}} · {{direction}} · {{shift}}', { date: input.day, direction: input.direction === 'IN' ? t('Login') : t('Logout'), shift: s.name });
    return { name: s.siteName ? `${name} · ${s.siteName}` : name, shiftId: s.id, sitePoiId: site, planStartAt: zonedIso(input.day, startMin, s.timeZone || input.tz) };
  });
}

// ───────────────────────────── compare (07 §5) ─────────────────────────────

export type CompareMetric = 'vehicles' | 'distance' | 'driveTime' | 'maxRide' | 'avgRide' | 'occupancy' | 'unassigned' | 'violations' | 'etaQuality';

export const COMPARE_ROWS: readonly { key: CompareMetric; label: string; best: 'min' | 'max' | null }[] = [
  // "Best" only where better is unambiguous (fewer vehicles / unassigned, less distance).
  { key: 'vehicles', label: 'Vehicles used', best: 'min' },
  { key: 'distance', label: 'Total distance', best: 'min' },
  { key: 'driveTime', label: 'Total drive time', best: null },
  { key: 'maxRide', label: 'Longest ride', best: null },
  { key: 'avgRide', label: 'Average ride', best: null },
  { key: 'occupancy', label: 'Seats used', best: null },
  { key: 'unassigned', label: 'Unassigned passengers', best: 'min' },
  { key: 'violations', label: 'Warnings', best: null },
  { key: 'etaQuality', label: 'ETA quality', best: null },
];

export function metricValue(m: PlanMetrics, key: CompareMetric): number | null {
  switch (key) {
    case 'vehicles':
      return m.vehiclesUsed;
    case 'distance':
      return m.distanceM;
    case 'driveTime':
      return m.driveS;
    case 'maxRide':
      return m.maxRideS;
    case 'avgRide':
      return m.avgRideS;
    case 'occupancy':
      return m.seats ? m.seatsUsed / m.seats : null;
    case 'unassigned':
      return m.unassigned;
    case 'violations':
      return m.violations;
    default:
      return null;
  }
}

export function metricText(m: PlanMetrics, key: CompareMetric, t: Translate = english): string {
  switch (key) {
    case 'vehicles':
      return t('{{used}} of {{total}}', { used: m.vehiclesUsed, total: m.vehiclesTotal });
    case 'distance':
      return formatKm(m.distanceM);
    case 'driveTime':
      return formatDuration(m.driveS, t);
    case 'maxRide':
      return formatDuration(m.maxRideS, t);
    case 'avgRide':
      return formatDuration(m.avgRideS, t);
    case 'occupancy':
      return m.seats ? `${m.seatsUsed} / ${m.seats} (${Math.round((m.seatsUsed / m.seats) * 100)} %)` : t('{{n}} · seats not set', { n: m.seatsUsed });
    case 'unassigned':
      return String(m.unassigned);
    case 'violations':
      return String(m.violations);
    case 'etaQuality':
      return t(ETA_QUALITY_META[m.etaQuality].label);
  }
}

/** Ids of the columns holding the best value of a row (empty when the row has no unambiguous best or all tie). */
export function bestOf(values: readonly (number | null)[], best: 'min' | 'max' | null): number[] {
  if (!best) return [];
  const known = values.map((v, i) => [v, i] as const).filter((x): x is readonly [number, number] => x[0] !== null);
  if (known.length < 2) return [];
  const target = best === 'min' ? Math.min(...known.map((x) => x[0])) : Math.max(...known.map((x) => x[0]));
  const winners = known.filter((x) => x[0] === target).map((x) => x[1]);
  return winners.length === known.length ? [] : winners;
}

/** "−12 %" / "+5 %" vs the baseline; null when either is unknown or the baseline is 0. */
export function deltaPercent(value: number | null, baseline: number | null): string | null {
  if (value === null || baseline === null || baseline === 0) return null;
  const p = Math.round(((value - baseline) / baseline) * 100);
  if (p === 0) return '±0 %';
  return `${p > 0 ? '+' : '−'}${Math.abs(p)} %`;
}

/**
 * Estimated solver cost per plan by the user's weights (lower is better): vehicle × vehicles used + distance × metres
 * + (time + routeDuration) × route seconds (the routes' drive time stands for their spans). Only plans with the fewest
 * unassigned passengers can win (the solver never trades a passenger for cost). No weights → no scores and no winner;
 * a weighted metric missing for some plan (no engine numbers) → no winner, with the missing keys.
 */
export function weightedScores(
  metrics: readonly PlanMetrics[],
  weights: PlannerWeights | null,
): { scores: (number | null)[]; winner: number | null; missing: WeightKey[]; excluded: number[] } {
  const none = { scores: metrics.map(() => null), winner: null, missing: [] as WeightKey[], excluded: [] as number[] };
  if (!weights || metrics.length < 2) return none;
  const missing: WeightKey[] = [];
  if (weights.distance > 0 && metrics.some((m) => m.distanceM === null)) missing.push('distance');
  if (weights.time > 0 && metrics.some((m) => m.driveS === null)) missing.push('time');
  if (weights.routeDuration > 0 && metrics.some((m) => m.driveS === null)) missing.push('routeDuration');
  if (missing.length) return { ...none, missing };
  const scores = metrics.map((m) => weights.vehicle * m.vehiclesUsed + weights.distance * (m.distanceM ?? 0) + (weights.time + weights.routeDuration) * (m.driveS ?? 0));
  const fewest = Math.min(...metrics.map((m) => m.unassigned));
  const excluded = metrics.map((m, i) => (m.unassigned > fewest ? i : -1)).filter((i) => i >= 0);
  const eligible = scores.map((sc, i) => [sc, i] as const).filter(([, i]) => !excluded.includes(i));
  const min = Math.min(...eligible.map(([sc]) => sc));
  const winners = eligible.filter(([sc]) => Math.abs(sc - min) < 1e-9);
  return { scores: scores.map((sc) => Math.round(sc)), winner: winners.length === 1 ? winners[0][1] : null, missing: [], excluded };
}

/** UUID v4 for Idempotency-Key (crypto.randomUUID when available). */
export function newKey(rand: () => number = Math.random): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = Math.floor(rand() * 16);
    return (ch === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

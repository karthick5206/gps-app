import type { PermissionMap } from './permissions';
import { OVERRIDE_REASON_MIN } from './routing';
import type { RoutePlanExcludedCount, RoutePlanPreferences, RoutePlanVehicleOccupancy, RoutingStrategy } from './routing-strategies';
import type {
  PublishRoutePlanResult,
  RoutePlanAssignmentDto,
  RoutePlanDto,
  RoutePlanMaxRide,
  RoutePlanStatus,
  RoutePlanStopDto,
  RoutePlanStopKind,
  RoutePlanStopViolation,
  RoutingDegradedReason,
} from './routing';

/**
 * ETMS E4 route plans API (doc 17 §7 P9, WP 4.2 / 4.5 backend): `/api/transport/route-plans`. Adds to the plan DTOs
 * of `routing.ts` what the ETMS views need: consent-gated stop points (the E3 trip-detail rules), locks / pins, the
 * per-route checks, manual edits with `expectedVersion`, compare (metrics only) and publish into ordinary E3 trips
 * through the E3 publish path (R-7: the plan never becomes an execution record).
 *
 * Gates: server `ETMS` on **and** `ETMS_ROUTING=on` (else 404), company add-on `etms`, menu `etms_planning`.
 * Scope: the caller's own company; branch-scoped (ASSIGNED) roles see plans of their branches (404 otherwise).
 */

// ───────────────────────────── locks and pins (RoutePlan.options) ─────────────────────────────

/**
 * `RoutePlan.options` keys written by the plans API and honoured by the optimiser (WP 4.2 worker): a locked route keeps
 * its stops and order (it is not re-solved); a pinned stop stays on its vehicle (solver `pinnedVehicleId`), but
 * re-optimising may change its place in that vehicle's order (T2-D6: the solver has no position constraint, and a
 * position is not well defined once the route gains or loses passengers; lock the route to keep an exact order).
 * Manual edits follow the same rule (E4 review M1: a pin preserves the stop's vehicle / route, a route lock preserves the
 * exact order): an edit that would change a locked route, or move a pinned stop to another route or out of every route,
 * is refused (409 ROUTE_LOCKED / STOP_PINNED) until it is unlocked / unpinned; a pinned stop may change its place within
 * its own route (an explicit reorder, or other stops leaving / joining), in resequence and move-passenger alike.
 */
export interface RoutePlanLockOptions {
  lockedAssignmentIds?: string[];
  pinnedStopIds?: string[];
}

/** Read the lock / pin sets from `RoutePlan.options` (unknown shapes → empty). */
export function routePlanLocks(options: unknown): { lockedAssignmentIds: Set<string>; pinnedStopIds: Set<string> } {
  const o = (options && typeof options === 'object' ? options : {}) as Record<string, unknown>;
  const ids = (v: unknown) => new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  return { lockedAssignmentIds: ids(o.lockedAssignmentIds), pinnedStopIds: ids(o.pinnedStopIds) };
}

// ───────────────────────────── views ─────────────────────────────

/** Why a stop's point is withheld (as E3 trip detail): no active routing consent, or a passenger of another branch. */
export type RoutePlanPointHidden = 'CONSENT_REQUIRED' | 'OUT_OF_SCOPE';

/**
 * A plan stop as the caller may see it. Personal points (`personal`): only with the passenger's active routing consent
 * and in the caller's branches, exact for whole-company roles of the company and 4 decimals otherwise; hidden points
 * have `lat` / `lng` / snapped point null and a neutral name. Company places are always exact.
 */
export interface RoutePlanStopViewDto extends Omit<RoutePlanStopDto, 'lat' | 'lng'> {
  lat: number | null;
  lng: number | null;
  pointHidden: RoutePlanPointHidden | null;
  pinned: boolean;
  /** planStartAt + etaS (ISO), null while the route is not timed. */
  plannedArrival: string | null;
  /**
   * The booking's passenger as "First L." (driver-manifest rule), only for callers who may see passenger names (dispatch /
   * bookings / passengers view) and never on an anonymised stop; null otherwise. Every read that returns names is
   * ACCESS-audited.
   */
  passengerName?: string | null;
  /** Seats this stop's booking takes (the booking's passengerCount; demand for generic stops). */
  seats: number;
}

/** One route with its checks; geometry withheld (null) when any of its stops is hidden, rounded like the stops. */
export interface RoutePlanAssignmentViewDto extends RoutePlanAssignmentDto {
  locked: boolean;
  vehicleName: string | null;
  plateNumber: string | null;
  driverName: string | null;
  /** Bookings on the route and the seats they take (E3 rule: seats never free up along a trip). */
  passengers: number;
  seats: number;
  violations: RoutePlanStopViolation[];
  /** The E3 trip this route was published into (after PUBLISHED). */
  plannedTripId: string | null;
  /**
   * WP-B: the route was published (its own TransportTrip exists). A published route is immutable while the rest of the
   * plan may still be edited and published (selected-routes publishing): edits, restore and re-optimisation leave it as is.
   */
  published?: boolean;
}

export interface RoutePlanDetailDto extends Omit<RoutePlanDto, 'stops' | 'assignments'> {
  stops: RoutePlanStopViewDto[];
  assignments: RoutePlanAssignmentViewDto[];
  /** Whether the caller's view has exact personal points (whole-company role of the company). */
  precise: boolean;
  /** DRAFT / PLANNED: manual edits allowed (to callers with etms_planning:edit). PUBLISHED / CANCELLED: read-only history. */
  editable: boolean;
  /** Every route's violations together. */
  violations: RoutePlanStopViolation[];
  /** Stops without a route (with the optimiser's reason when it left them out). */
  unassigned: number;
  /** Solver weights stored with the last optimisation (RoutePlan.options.weights); null before any (T2-L4: re-optimise prefills them). */
  weights?: RoutePlanWeights | null;
  /** Decision 5: the server's publish classification for this caller (DRAFT / PLANNED plans). */
  publishCheck?: RoutePlanPublishCheck | null;
  /** Decision 5: what the publish accepted (acknowledged warnings, authorised override); PUBLISHED plans only. */
  publishDecision?: RoutePlanPublishDecision | null;
  /** Owner decision 1: max ride of the last optimisation and its source, the company policy, the plan's override. */
  maxRide?: RoutePlanMaxRide;
  /** E4 WP-A: strategy and preferences of the last optimisation (options.strategy / options.preferences), and the source plan of an alternative. */
  strategy?: RoutingStrategy | null;
  preferences?: RoutePlanPreferences | null;
  alternativeOf?: string | null;
}

/** The four explicit solver weights (OptimizeOptionsDto.weights). */
export interface RoutePlanWeights {
  vehicle: number;
  distance: number;
  time: number;
  routeDuration: number;
  /** E4 WP-A (optional; absent in weights stored before it = 0): cost per passenger-second of ride (trip mode). */
  rideTime?: number;
}

// ───────────────────────────── manual edits (each with the version the client saw: 409 PLAN_STALE otherwise) ─────────────────────────────

/**
 * POST /route-plans/:id/move-passenger — move one booking (its PICKUP and DROP stops together) to another route
 * (`toAssignmentId`) or out of every route (null). The stops are inserted at `pickupIndex` / `dropIndex` of the target
 * route's order (default: pickup before the target's first drop, drop at the end).
 */
export interface RoutePlanMovePassengerRequest {
  expectedVersion: number;
  bookingId: string;
  toAssignmentId: string | null;
  pickupIndex?: number;
  dropIndex?: number;
}

/**
 * PUT /route-plans/:id/sequence — `RoutePlanResequenceRequest` (routing.ts): the full stop order of each listed route.
 * Stops may move between the listed routes (both ends of a booking stay on one route, pickup before drop); stops of a
 * listed route that are not listed become unassigned.
 */

/** PATCH /route-plans/:id/assignments/:assignmentId — change the vehicle / driver, lock or unlock the route. */
export interface RoutePlanAssignmentUpdateRequest {
  expectedVersion: number;
  objectId?: string;
  driverId?: string | null;
  locked?: boolean;
}

/** PATCH /route-plans/:id/stops/:stopId — pin or unpin a stop. */
export interface RoutePlanStopUpdateRequest {
  expectedVersion: number;
  pinned: boolean;
}

/** POST /route-plans/:id/discard — DRAFT / PLANNED → CANCELLED (kept as history; nothing is deleted). */
export interface RoutePlanDiscardRequest {
  expectedVersion: number;
  reason?: string;
}

/** Answer of every manual edit: the plan after the change and the re-validated checks. */
export interface RoutePlanEditResult {
  plan: RoutePlanDetailDto;
  violations: RoutePlanStopViolation[];
  /** Set when changed routes could not be re-timed on the road engine: their ETAs are null (never estimated). */
  degraded: RoutingDegradedReason | null;
  /**
   * Route-level checks of the routes the edit touched (E4 QA B4): VEHICLE_NO_SEATS (the vehicle has no seat profile;
   * publish refuses it). A vehicle already on another route of the plan is refused outright (409 VEHICLE_DUPLICATE).
   */
  routeViolations?: RoutePlanRouteViolation[];
}

export interface RoutePlanRouteViolation {
  assignmentId: string;
  code: (typeof ROUTE_PLAN_ROUTE_VIOLATIONS)[number];
  message: string;
}

export const ROUTE_PLAN_ROUTE_VIOLATIONS = ['VEHICLE_NO_SEATS', 'VEHICLE_DUPLICATE'] as const;

/**
 * Why a newly created plan has no passenger (POST /transport/route-plans answer, E4 QA re-check):
 * NO_BOOKINGS_FOR_SHIFT: no open booking carries the chosen shift on that date / direction / site; NO_BOOKINGS: none at
 * all (no shift chosen); ALL_SKIPPED: bookings exist but none could be planned (see skippedBookings for the reasons).
 */
export const ROUTE_PLAN_EMPTY_REASONS = ['NO_BOOKINGS_FOR_SHIFT', 'NO_BOOKINGS', 'ALL_SKIPPED'] as const;
export type RoutePlanEmptyReason = (typeof ROUTE_PLAN_EMPTY_REASONS)[number];

/**
 * Why plan creation left out a booking of the plan's date / direction (WP 3.9: every booking the caller can see that is
 * waiting for a seat or for approval and was not planned is reported, never silently dropped):
 *   consent_required / needs_location / out_of_scope — as before;
 *   other_site — the office end is not the plan's site (assign it on the dispatch board, or plan that site);
 *   other_shift — the booking carries another shift than the plan's;
 *   outside_shift_window — a shift-less booking whose window does not overlap the plan shift's leg window;
 *   point_to_point — POINT_TO_POINT bookings are dispatched manually (the optimiser plans one site per plan);
 *   needs_approval — REQUESTED / WAITLISTED: approve it first;
 *   on_hold — pooling: the dispatcher put the booking on hold (excluded from runs, not cancelled);
 *   private_ride — pooling: a PRIVATE commute ride is not pooled by a site plan (seat it alone, or use an AREA plan);
 *   outside_plan_window — pooling (AREA plan): the booking window does not overlap the plan's operating window.
 * A shift-less COMMUTE booking at the plan's site IS planned when the plan has no shift or the booking's window overlaps
 * the plan shift's leg window.
 */
export const ROUTE_PLAN_SKIP_REASONS = ['consent_required', 'needs_location', 'out_of_scope', 'other_site', 'other_shift', 'outside_shift_window', 'point_to_point', 'needs_approval', 'on_hold', 'private_ride', 'outside_plan_window'] as const;
export type RoutePlanSkipReason = (typeof ROUTE_PLAN_SKIP_REASONS)[number];
export interface RoutePlanSkippedBooking {
  bookingId: string;
  reason: RoutePlanSkipReason;
}

/** Booking counts of a plan create: found for the scope, put on the plan, skipped (with a reason). */
export interface RoutePlanCreateCounts {
  found: number;
  planned: number;
  skipped: number;
}

// ───────────────────────────── compare (metrics only: no stops, no points, no names of passengers) ─────────────────────────────

export interface RoutePlanMetricsDto {
  planId: string;
  name: string;
  planDate: string;
  status: RoutePlanStatus;
  version: number;
  routes: number;
  /** Routes with a vehicle and at least one stop. */
  activeRoutes: number;
  stops: number;
  passengers: number;
  seats: number;
  unassigned: number;
  /** Sums over routes; null when any active route has no number (not timed / engine unavailable). */
  distanceM: number | null;
  durationS: number | null;
  /** Booked seats / vehicle seats over active routes (0..1+); null without capacities. */
  seatUtilisation: number | null;
  violations: number;
  graphVersion: string | null;
  // E4 WP-A metrics (definitions: ROUTE_PLAN_METRIC_DEFINITIONS in routing-strategies.ts). Optional in the type only so
  // older clients / mocks still compile; the server always fills them.
  vehiclesUsed?: number;
  passengersAssigned?: number;
  bookingsAssigned?: number;
  totalDistanceM?: number | null;
  totalTravelS?: number | null;
  maxRideS?: number | null;
  avgRideS?: number | null;
  occupancy?: RoutePlanVehicleOccupancy[];
  avgOccupancy?: number | null;
  deadlineCompliance?: { inside: number; total: number; ratio: number | null };
  excluded?: RoutePlanExcludedCount[];
  excludedBookings?: number;
  strategy?: RoutingStrategy | null;
  alternativeOf?: string | null;
}

/** GET /route-plans/compare?ids=a,b[,c…] (2..5 plans of the caller's scope; 404 when any is not visible). */
export interface RoutePlanCompareDto {
  plans: RoutePlanMetricsDto[];
}

// ───────────────────────────── publish ─────────────────────────────

/**
 * POST /route-plans/:id/publish — body `{ expectedVersion }` (`PublishRoutePlanRequest.idempotencyKey` may be given in
 * the body or, as for change sets, in the `Idempotency-Key` header). The plan becomes one E3 change set (one
 * CREATE_TRIP + ADD_PASSENGERs per route) published through the E3 publish transaction: all routes or none. A replay
 * with the same key answers the same result (header `Idempotent-Replay: true`).
 */
export interface RoutePlanPublishResult extends PublishRoutePlanResult {
  warnings: string[];
}

/**
 * Owner decision 5 (publishing): the server re-checks the stored plan at publish time and never trusts the client.
 * HARD issues block publishing: an arrival-window violation (`late`: IN = arrival at the site after the booking's
 * arrival window, OUT = departure from the site after the booking's departure window), a stop without an engine time
 * (`unreachable`: never estimated, so the window cannot be proven) and seats above the vehicle's (`over_capacity`).
 * SOFT warnings (`early_wait`; `max_ride_exceeded`: a passenger's ride — drop ETA − pickup ETA, the solver's
 * definition — above the plan's effective max ride: the last optimisation's snapshot, else its override, else the
 * company policy) need an explicit acknowledgement of exactly this warning set (`fingerprint`). Only `late` may be overridden, by an authorised caller with a reason (audited).
 */
export const ROUTE_PLAN_HARD_KINDS = ['late', 'unreachable', 'over_capacity'] as const;
export const ROUTE_PLAN_OVERRIDABLE_KINDS = ['late'] as const;
/** Minimum length (trimmed) of a publish override reason. */
export const ROUTE_PLAN_OVERRIDE_REASON_MIN = OVERRIDE_REASON_MIN;
export const ROUTE_PLAN_OVERRIDE_REASON_MAX = 500;

/** One stop-level publish issue: ids, ref, kind and times only (no coordinates, no passenger names). */
export interface RoutePlanPublishIssue {
  assignmentId: string;
  vehicleLabel: string;
  stopId: string;
  ref: string;
  kind: RoutePlanStopViolation['kind'];
  etaS: number | null;
  window: [number, number] | null;
  /** Hard issues only: true when an authorised override may publish anyway (arrival windows). */
  overridable?: boolean;
}

/** The server's publish classification of a plan (plan detail `publishCheck`, and the 409 bodies of a refused publish). */
export interface RoutePlanPublishCheck {
  hard: RoutePlanPublishIssue[];
  soft: RoutePlanPublishIssue[];
  /** Fingerprint of the soft warning set to send as `acknowledgedWarnings`; null without soft warnings. */
  fingerprint: string | null;
  /** Whether this caller may override overridable hard issues (whole-company scope + Dispatch: command + Planning: command). */
  canOverride: boolean;
  /**
   * WP-B: route-level blockers found before publishing (never overridable): VEHICLE_BUSY / DRIVER_BUSY (an active trip of
   * the vehicle / driver overlaps the route's time span), VEHICLE_INACTIVE / DRIVER_INACTIVE. Unpublished routes only.
   */
  routeErrors?: RoutePlanRouteError[];
}

/** What a publish accepted, stored with the published plan (RoutePlan.options.publishDecision) and shown on its detail. */
export interface RoutePlanPublishDecision {
  /** Acknowledged soft warnings (count and fingerprint); null when there were none. */
  acknowledged: { fingerprint: string; count: number } | null;
  /** The authorised override of hard issues; null when none was needed. */
  override: { reason: string; byUserId: string; at: string; violations: RoutePlanPublishIssue[] } | null;
}

/** POST /route-plans/:id/publish body (decision 5 fields are optional; the server decides whether they are needed). */
export interface RoutePlanPublishRequest {
  expectedVersion: number;
  idempotencyKey?: string;
  /** The `publishCheck.fingerprint` the user acknowledged; a different (stale) set is refused. */
  acknowledgedWarnings?: string;
  /** Exceptional override of overridable hard issues (authorised callers only; reason recorded and audited). */
  override?: { reason: string };
  /**
   * WP-B selected-routes publishing: publish only these routes (unpublished, with stops). Omitted = every unpublished
   * route with stops (the whole-plan publish). The plan stays DRAFT / PLANNED while unpublished routes with stops remain
   * and becomes PUBLISHED with the last of them. Requires `reviewHash`.
   */
  assignmentIds?: string[];
  /**
   * WP-B: the `reviewHash` of GET /route-plans/:id/review for exactly this selection. Required with `assignmentIds`
   * (409 PLAN_REVIEW_REQUIRED); optional for the whole-plan publish (checked when given). A hash that no longer matches
   * the plan is refused with 409 PLAN_REVIEW_STALE carrying the fresh `reviewHash`.
   */
  reviewHash?: string;
}

// ───────────────────────────── WP-B: undo / redo, recalculate, passengers on a draft, review ─────────────────────────────

/**
 * POST /route-plans/:id/restore — put back the route membership and stop order of an earlier version (undo / redo:
 * restore(previous) / restore(next)). Only while the plan's stop set is the version's (else 409 PLAN_RESTORE_CONFLICT
 * with the stop ids added / removed since). Locked and published routes are left as they are (a stop the version had on
 * such a route, now elsewhere, becomes unassigned); a pinned stop is never moved off its route (409 STOP_PINNED). Changed
 * routes are re-timed on the road engine; a new version (EDITED, details.restoredFrom) is recorded. Vehicles, drivers,
 * locks and pins are not restored.
 */
export interface RoutePlanRestoreRequest {
  version: number;
  expectedVersion: number;
}

/** POST /route-plans/:id/recalculate — re-time the listed routes (default: every unpublished route with stops). */
export interface RoutePlanRecalculateRequest {
  expectedVersion: number;
  assignmentIds?: string[];
}

/**
 * POST /route-plans/:id/bookings — add an open booking to a DRAFT / PLANNED plan (its two stops, unassigned). Only a
 * booking plan creation would have taken for this plan (same date, direction, site, shift, branch; PENDING_ASSIGNMENT;
 * COMMUTE; a usable point and, for a personal end, active routing consent) and only up to ROUTING_LIMITS.planBookings.
 * DELETE /route-plans/:id/bookings/:bookingId?expectedVersion=n takes a booking's stops off the plan (not from a locked
 * or published route).
 */
export interface RoutePlanAddBookingRequest {
  bookingId: string;
  expectedVersion: number;
}

/** Why a booking cannot be added to a plan (409 BOOKING_NOT_PLANNABLE `reason`). */
export type RoutePlanAddBookingRefusal = RoutePlanSkipReason | 'other_date' | 'other_direction' | 'not_open';

/** PATCH /route-plans/:id/bookings/:bookingId/pin — pin / unpin both stops of a passenger's booking. */
export interface RoutePlanBookingPinRequest {
  pinned: boolean;
  expectedVersion: number;
}

/** One stop of a route under review (points and names follow the plan detail's consent / branch rules). */
export interface RoutePlanReviewStop {
  stopId: string;
  ref: string;
  sequence: number;
  stopKind: RoutePlanStopKind | null;
  /** null for another branch's passenger (anonymised as in the plan detail). */
  bookingId: string | null;
  /** Pseudonymous passenger profile id (null when anonymised or not a passenger stop). */
  profileId: string | null;
  poiId: string | null;
  name: string | null;
  lat: number | null;
  lng: number | null;
  pointHidden: RoutePlanPointHidden | null;
  passengerName: string | null;
  etaS: number | null;
  plannedArrival: string | null;
  seats: number;
  pinned: boolean;
}

export interface RoutePlanReviewRoute {
  assignmentId: string;
  seq: number;
  vehicleLabel: string;
  objectId: string | null;
  vehicleName: string | null;
  plateNumber: string | null;
  driverId: string | null;
  driverName: string | null;
  /** The vehicle's passenger seats now (as publish checks them); null when not set / not in scope. */
  seats: number | null;
  /** Passengers (bookings) and the seats they take (E3 rule: seats never free up along a trip). */
  passengers: number;
  occupancy: number;
  distanceM: number | null;
  durationS: number | null;
  startS: number | null;
  endS: number | null;
  locked: boolean;
  stops: RoutePlanReviewStop[];
}

/** A passenger (or generic stop group) the selection leaves without a route, with why. */
export interface RoutePlanReviewUnassigned {
  bookingId: string | null;
  profileId: string | null;
  stopIds: string[];
  /** The optimiser's / exclusion reason, or `not_assigned` (left out by hand or never optimised). */
  reason: string;
}

/** Manual changes of one route since the baseline version (ids only). */
export interface RoutePlanRouteChange {
  assignmentId: string;
  addedStopIds: string[];
  removedStopIds: string[];
  /** The stops kept on the route are in another order. */
  reordered: boolean;
  vehicleChanged: boolean;
  driverChanged: boolean;
}

export interface RoutePlanManualChanges {
  /** The last OPTIMIZED version (else the first version) the changes are measured from; null without history. */
  baselineVersion: number | null;
  baselineChangeType: string | null;
  routes: RoutePlanRouteChange[];
}

/**
 * GET /route-plans/:id/review?assignmentIds=a,b — what publishing these routes (default: every unpublished route with
 * stops) would create, for the confirmation step: per route the vehicle, driver, seats, the exact stop order with ETAs,
 * distance, duration and occupancy; the passengers left without a route; the manual changes since the last
 * optimisation; the warnings (soft) and errors (hard / route errors) publish would apply. `reviewHash` binds exactly
 * this content (vehicles, drivers, ordered stops, ETAs, warning set) and the plan version: send it with the publish.
 */
export interface RoutePlanReviewDto {
  planId: string;
  version: number;
  status: RoutePlanStatus;
  planStartAt: string | null;
  assignmentIds: string[];
  routes: RoutePlanReviewRoute[];
  unassigned: RoutePlanReviewUnassigned[];
  /** Routes of the plan outside this selection (published or not), for context. */
  otherRoutes: { assignmentId: string; vehicleLabel: string; published: boolean; stops: number }[];
  manualChanges: RoutePlanManualChanges;
  /** The publish classification of the selected routes (soft warnings to acknowledge, hard issues, route errors). */
  publishCheck: RoutePlanPublishCheck;
  /** Pre-check refusals publish would answer with 409 (PLAN_NOT_PUBLISHABLE, VEHICLE_BUSY, …); empty when publishable. */
  errors: RoutePlanRouteError[];
  reviewHash: string;
}

/** Deterministic fingerprint of a soft warning set (FNV-1a 32 over the sorted `stopId:kind` lines), or null when empty. */
export function publishWarningsFingerprint(issues: Pick<RoutePlanPublishIssue, 'stopId' | 'kind'>[]): string | null {
  if (!issues.length) return null;
  const text = issues.map((i) => `${i.stopId}:${i.kind}`).sort().join('\n');
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `w${issues.length}-${h.toString(16).padStart(8, '0')}`;
}

/** One route's refusal (409 PLAN_NOT_PUBLISHABLE before anything is written, or the E3 error of the failing route). */
export interface RoutePlanRouteError {
  assignmentId: string;
  vehicleLabel: string;
  code: string;
  message: string;
}

/** Error codes of the plans API (besides the common and E3 ones). */
export const ROUTE_PLAN_ERROR_CODES = [
  'PLAN_STALE',
  'PLAN_NOT_EDITABLE',
  'PLAN_NOT_PUBLISHABLE',
  'ROUTE_LOCKED',
  'STOP_PINNED',
  'ROUTING_DISABLED',
  'VEHICLE_DUPLICATE',
  'PLAN_HAS_HARD_VIOLATIONS',
  'PLAN_WARNINGS_NOT_ACKNOWLEDGED',
  'PUBLISH_OVERRIDE_FORBIDDEN',
  'PUBLISH_OVERRIDE_REASON_REQUIRED',
  // WP-B
  'PLAN_RESTORE_CONFLICT',
  'PLAN_REVIEW_REQUIRED',
  'PLAN_REVIEW_STALE',
  'ROUTE_ALREADY_PUBLISHED',
  'BOOKING_NOT_PLANNABLE',
  'BOOKING_ALREADY_ON_PLAN',
  'VEHICLE_BUSY',
  'DRIVER_BUSY',
  'VEHICLE_INACTIVE',
  'DRIVER_INACTIVE',
  'DRIVER_DUPLICATE',
] as const;
export type RoutePlanErrorCode = (typeof ROUTE_PLAN_ERROR_CODES)[number];

// ───────────────────────────── access (P6 templates) ─────────────────────────────

/**
 * Menu `etms_planning` E4 adds to the ETMS role templates (P6), for companies whose add-on is switched on from now on
 * (existing roles are never changed). view = list / detail / compare; edit = manual edits; delete = discard; command =
 * publish (which also needs etms_dispatch:command, like a change set); create = new plans / optimisation (WP 4.2).
 */
export const ETMS_E4_TEMPLATE_PERMISSIONS: Record<string, PermissionMap> = {
  'Transport admin': { etms_planning: ['view', 'create', 'edit', 'delete', 'command'] },
  'Transport dispatcher': { etms_planning: ['view', 'create', 'edit', 'command'] },
};

/** Plans compared at once. */
export const ROUTE_PLAN_COMPARE_MAX = 5;

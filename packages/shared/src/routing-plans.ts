import type { PermissionMap } from './permissions';
import type {
  PublishRoutePlanResult,
  RoutePlanAssignmentDto,
  RoutePlanDto,
  RoutePlanStatus,
  RoutePlanStopDto,
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
 * its stops and order, a pinned stop stays on its route at its position. Manual edits that would change a locked route
 * or move a pinned stop are refused (409 ROUTE_LOCKED / STOP_PINNED) until it is unlocked / unpinned.
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

/** One route's refusal (409 PLAN_NOT_PUBLISHABLE before anything is written, or the E3 error of the failing route). */
export interface RoutePlanRouteError {
  assignmentId: string;
  vehicleLabel: string;
  code: string;
  message: string;
}

/** Error codes of the plans API (besides the common and E3 ones). */
export const ROUTE_PLAN_ERROR_CODES = ['PLAN_STALE', 'PLAN_NOT_EDITABLE', 'PLAN_NOT_PUBLISHABLE', 'ROUTE_LOCKED', 'STOP_PINNED', 'ROUTING_DISABLED'] as const;
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

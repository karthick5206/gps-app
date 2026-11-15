/**
 * Typed client of the APIs the planner uses (shapes mirror the API DTOs; `planner-contract.test.ts` checks them):
 * - plans (`packages/shared/src/routing-plans.ts`): `/api/transport/route-plans` create (Idempotency-Key) / list /
 *   detail / history / compare / move-passenger / sequence / assignments / stops / discard / publish (Idempotency-Key)
 *   and the optimise alias `POST /:id/optimize`;
 * - optimise jobs: `POST /api/routing/jobs/optimize` (Idempotency-Key), `GET /:id`, `POST /:id/cancel`;
 * - `GET /api/routing/capabilities`.
 * Kept free of React so the synthetic stand-in (`planner-mock.ts`) can implement it too.
 */
import type {
  CreateRoutePlanRequest,
  RoutePlanAssignmentUpdateRequest,
  RoutePlanCompareDto,
  RoutePlanMovePassengerRequest,
  RoutePlanPublishResult,
  RoutePlanResequenceRequest,
  RoutePlanStatus,
  RoutePlanStopUpdateRequest,
  RoutePlanSummaryDto,
  RoutePlanVersionDto,
  RoutingCapabilities,
  RoutingJobDto,
  TransportDirection,
} from '@veetracer/shared';
import type {
  MaxRideOverrideInput,
  RoutePlanAddBookingRequest,
  RoutePlanAlternativesList,
  RoutePlanAlternativesRequest,
  RoutePlanAlternativesResult,
  RoutePlanBookingPinRequest,
  RoutePlanCreateCounts,
  RoutePlanEmptyReason,
  RoutePlanPreferences,
  RoutePlanPublishRequest,
  RoutePlanRecalculateRequest,
  RoutePlanRestoreRequest,
  RoutePlanReviewDto,
  RoutingStrategy,
} from '@veetracer/shared';
import type { PlanEditResult, PlannerPlan, PlannerWeights } from './planner-format';

/** POST /transport/route-plans answer: the plan, plus why it has no passenger (null / absent when it has some). */
export type CreatedPlannerPlan = PlannerPlan & {
  emptyReason?: RoutePlanEmptyReason | null;
  /** Bookings found for the scope but left out of the plan, with the reason (no routing consent, no point, scope). */
  skippedBookings?: { bookingId: string; reason: string }[];
  bookingCounts?: RoutePlanCreateCounts | null;
};

export const PLANS_ENDPOINT = '/transport/route-plans';
export const JOBS_ENDPOINT = '/routing/jobs';
export const CAPABILITIES_ENDPOINT = '/routing/capabilities';

export interface PlanListQuery {
  planDate?: string;
  direction?: TransportDirection | null;
  status?: RoutePlanStatus | null;
}

/** `POST /transport/route-plans` (CreateRoutePlanDto): ETMS fields required, plus the plan's vehicles. */
export type CreatePlanRequest = CreateRoutePlanRequest & { direction: TransportDirection; sitePoiId: string; objectIds: string[] };

/**
 * Body of `POST /transport/route-plans/:id/optimize` (OptimizeOptionsDto). E4 WP-A: a strategy (BALANCED by default on
 * the server) and optional run preferences; explicit weights are the "Advanced" option and win over the strategy.
 */
export interface OptimizeOptions {
  expectedVersion: number;
  timeLimitS?: number;
  objective?: 'duration' | 'distance';
  weights?: PlannerWeights;
  strategy?: RoutingStrategy;
  preferences?: RoutePlanPreferences;
  /** Owner decision 1: per-plan max-ride override (authorised callers); null clears it; absent keeps it. */
  maxRideOverride?: MaxRideOverrideInput | null;
}

/** Body of `POST /routing/jobs/optimize` (OptimizeJobDto). */
export type OptimizeJobRequest = OptimizeOptions & { planId: string };

export interface PlannerClient {
  capabilities(signal?: AbortSignal): Promise<RoutingCapabilities>;
  listPlans(q: PlanListQuery, signal?: AbortSignal): Promise<RoutePlanSummaryDto[]>;
  getPlan(id: string, signal?: AbortSignal): Promise<PlannerPlan>;
  history(id: string, signal?: AbortSignal): Promise<RoutePlanVersionDto[]>;
  compare(ids: readonly string[], signal?: AbortSignal): Promise<RoutePlanCompareDto>;
  createPlan(body: CreatePlanRequest, idempotencyKey: string): Promise<CreatedPlannerPlan>;
  optimize(body: OptimizeJobRequest, idempotencyKey: string): Promise<RoutingJobDto>;
  /** Re-optimise a saved plan (alias of the job endpoint, same body minus planId). */
  optimizePlan(planId: string, body: OptimizeOptions, idempotencyKey: string): Promise<RoutingJobDto>;
  getJob(id: string, signal?: AbortSignal): Promise<RoutingJobDto>;
  /** Open (queued / running) jobs of one plan: `GET /routing/jobs?planId&state=queued,running`. */
  planJobs(planId: string, signal?: AbortSignal): Promise<RoutingJobDto[]>;
  cancelJob(id: string): Promise<RoutingJobDto>;
  movePassenger(planId: string, body: RoutePlanMovePassengerRequest): Promise<PlanEditResult>;
  resequence(planId: string, body: RoutePlanResequenceRequest): Promise<PlanEditResult>;
  updateAssignment(planId: string, assignmentId: string, body: RoutePlanAssignmentUpdateRequest): Promise<PlanEditResult>;
  updateStop(planId: string, stopId: string, body: RoutePlanStopUpdateRequest): Promise<PlanEditResult>;
  /**
   * Decision 5: `acknowledgedWarnings` (publishCheck.fingerprint) and `override` ({ reason }) only when needed. WP-B:
   * `assignmentIds` + `reviewHash` (from GET review) publish only the selected routes.
   */
  publish(planId: string, body: Omit<RoutePlanPublishRequest, 'idempotencyKey'>, idempotencyKey: string): Promise<RoutePlanPublishResult>;
  discard(planId: string, body: { expectedVersion: number; reason?: string }): Promise<PlannerPlan>;
  // WP-B: undo / redo, recalculate, passengers on a draft, review.
  /** `POST /:id/restore` (undo / redo = restore(previous / next version)); 409 PLAN_RESTORE_CONFLICT when the stop set changed. */
  restore(planId: string, body: RoutePlanRestoreRequest): Promise<PlanEditResult>;
  recalculate(planId: string, body: RoutePlanRecalculateRequest): Promise<PlanEditResult>;
  addBooking(planId: string, body: RoutePlanAddBookingRequest): Promise<PlanEditResult>;
  /** `DELETE /:id/bookings/:bookingId?expectedVersion=n`. */
  removeBooking(planId: string, bookingId: string, expectedVersion: number): Promise<PlanEditResult>;
  pinBooking(planId: string, bookingId: string, body: RoutePlanBookingPinRequest): Promise<PlanEditResult>;
  /** `GET /:id/review?assignmentIds=a,b` (null / empty = every unpublished route with stops). */
  review(planId: string, assignmentIds: readonly string[] | null, signal?: AbortSignal): Promise<RoutePlanReviewDto>;
  // WP-A: alternatives.
  /** `GET /:id/alternatives`: the siblings of a plan (of its source when it is one). */
  alternatives(planId: string, signal?: AbortSignal): Promise<RoutePlanAlternativesList>;
  /** `POST /:id/alternatives` (Idempotency-Key): one sibling plan + optimise job per strategy. */
  createAlternatives(planId: string, body: RoutePlanAlternativesRequest, idempotencyKey: string): Promise<RoutePlanAlternativesResult>;
}

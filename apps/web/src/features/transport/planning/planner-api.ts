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
import type { RoutePlanCreateCounts, RoutePlanEmptyReason } from '@veetracer/shared';
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

/** Body of `POST /transport/route-plans/:id/optimize` (OptimizeOptionsDto): explicit weights are required (P6). */
export interface OptimizeOptions {
  expectedVersion: number;
  timeLimitS?: number;
  objective?: 'duration' | 'distance';
  weights: PlannerWeights;
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
  publish(planId: string, body: { expectedVersion: number }, idempotencyKey: string): Promise<RoutePlanPublishResult>;
  discard(planId: string, body: { expectedVersion: number; reason?: string }): Promise<PlannerPlan>;
}

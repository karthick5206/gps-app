/**
 * Typed client of the APIs the planner uses:
 * - plans (E4-F, `packages/shared/src/routing-plans.ts`): `/api/transport/route-plans` list / detail / history /
 *   compare / move-passenger / sequence / assignments / stops / discard / publish;
 * - optimise jobs (E4-E): `/api/routing/jobs/optimize`, `/api/routing/jobs/:id`, `/:id/cancel`.
 * Not on the server yet (integration points, see the WP 4.5 evidence): plan creation from the day's bookings
 * (`POST /transport/route-plans`) and a capabilities endpoint (`GET /routing/capabilities`); the HTTP client derives
 * the capabilities meanwhile. Kept free of React so the synthetic stand-in (`planner-mock.ts`) can implement it too.
 */
import type {
  CreateRoutePlanRequest,
  RoutePlanCompareDto,
  RoutePlanMovePassengerRequest,
  RoutePlanAssignmentUpdateRequest,
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
import type { PlanEditResult, PlannerPlan } from './planner-format';

export const PLANS_ENDPOINT = '/transport/route-plans';
export const JOBS_ENDPOINT = '/routing/jobs';
export const CAPABILITIES_ENDPOINT = '/routing/capabilities';

export interface PlanListQuery {
  planDate?: string;
  direction?: TransportDirection | null;
  status?: RoutePlanStatus | null;
}

/** Proposed body of `POST /transport/route-plans` (not on the server yet): the plan and its vehicles in one call. */
export type CreatePlanRequest = CreateRoutePlanRequest & { objectIds: string[] };

/** `POST /routing/jobs/optimize` (E4-E OptimizeJobDto). The objective weights stay in the browser (P6). */
export interface OptimizeJobRequest {
  planId: string;
  expectedVersion: number;
  timeLimitS?: number;
  objective?: 'duration' | 'distance';
}

export interface PlannerClient {
  capabilities(signal?: AbortSignal): Promise<RoutingCapabilities>;
  listPlans(q: PlanListQuery, signal?: AbortSignal): Promise<RoutePlanSummaryDto[]>;
  getPlan(id: string, signal?: AbortSignal): Promise<PlannerPlan>;
  history(id: string, signal?: AbortSignal): Promise<RoutePlanVersionDto[]>;
  compare(ids: readonly string[], signal?: AbortSignal): Promise<RoutePlanCompareDto>;
  createPlan(body: CreatePlanRequest): Promise<PlannerPlan>;
  optimize(body: OptimizeJobRequest, idempotencyKey: string): Promise<RoutingJobDto>;
  getJob(id: string, signal?: AbortSignal): Promise<RoutingJobDto>;
  cancelJob(id: string): Promise<RoutingJobDto>;
  movePassenger(planId: string, body: RoutePlanMovePassengerRequest): Promise<PlanEditResult>;
  resequence(planId: string, body: RoutePlanResequenceRequest): Promise<PlanEditResult>;
  updateAssignment(planId: string, assignmentId: string, body: RoutePlanAssignmentUpdateRequest): Promise<PlanEditResult>;
  updateStop(planId: string, stopId: string, body: RoutePlanStopUpdateRequest): Promise<PlanEditResult>;
  publish(planId: string, body: { expectedVersion: number }, idempotencyKey: string): Promise<RoutePlanPublishResult>;
  discard(planId: string, body: { expectedVersion: number; reason?: string }): Promise<PlannerPlan>;
}

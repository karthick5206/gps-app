/**
 * Typed client of the routing / plans API the planner uses (E4-E jobs, E4-F plans + publish). The endpoint shapes
 * follow `packages/shared/src/routing.ts`; the few fields the contracts do not have yet are the optional web-side
 * extensions in `planner-format.ts` (pinned stops, weights, violations), listed in the WP 4.5 evidence as integration
 * points. Kept free of React so a mock implementation (`planner-mock.ts`) can stand in until the endpoints exist.
 */
import type {
  CreateRoutePlanRequest,
  OptimizePlanRequest,
  PublishRoutePlanRequest,
  PublishRoutePlanResult,
  RoutePlanStatus,
  RoutePlanSummaryDto,
  RoutePlanVersionDto,
  RoutingCapabilities,
  RoutingJobDto,
  TransportDirection,
} from '@veetracer/shared';
import type { PlanEditResult, PlannerPlan, PlannerWeights } from './planner-format';

export const CAPABILITIES_ENDPOINT = '/routing/capabilities';
export const JOBS_ENDPOINT = '/routing/jobs';
export const PLANS_ENDPOINT = '/route-plans';

export interface PlanListQuery {
  planDate?: string;
  direction?: TransportDirection | null;
  status?: RoutePlanStatus | null;
}

/** POST /route-plans/:id/assignments: one vehicle slot of the plan. */
export interface AddAssignmentRequest {
  expectedVersion: number;
  vehicleLabel: string;
  objectId: string;
  capacity: number | null;
}

/** POST /route-plans/:id/optimize with the explicit objective weights (P6). */
export type OptimizeWithWeights = OptimizePlanRequest & { weights: PlannerWeights };

export interface PlannerClient {
  capabilities(signal?: AbortSignal): Promise<RoutingCapabilities>;
  listPlans(q: PlanListQuery, signal?: AbortSignal): Promise<RoutePlanSummaryDto[]>;
  getPlan(id: string, signal?: AbortSignal): Promise<PlannerPlan>;
  history(id: string, signal?: AbortSignal): Promise<RoutePlanVersionDto[]>;
  createPlan(body: CreateRoutePlanRequest): Promise<PlannerPlan>;
  addAssignment(planId: string, body: AddAssignmentRequest): Promise<PlannerPlan>;
  optimize(planId: string, body: OptimizeWithWeights): Promise<RoutingJobDto>;
  getJob(id: string, signal?: AbortSignal): Promise<RoutingJobDto>;
  cancelJob(id: string): Promise<RoutingJobDto>;
  /** PUT /route-plans/:id/sequence (move a passenger, reorder). */
  resequence(planId: string, body: { expectedVersion: number; assignments: { assignmentId: string; stopIds: string[] }[] }): Promise<PlanEditResult>;
  /** PATCH /route-plans/:id/assignments/:assignmentId (change vehicle). */
  changeVehicle(planId: string, assignmentId: string, body: { expectedVersion: number; objectId: string; vehicleLabel: string; capacity: number | null }): Promise<PlanEditResult>;
  /** PATCH /route-plans/:id/stops/:stopId (pin / unpin). */
  pinStop(planId: string, stopId: string, body: { expectedVersion: number; pinned: boolean }): Promise<PlanEditResult>;
  publish(planId: string, body: PublishRoutePlanRequest): Promise<PublishRoutePlanResult>;
  /** POST /route-plans/:id/cancel: discard (status CANCELLED; history kept). */
  discard(planId: string, body: { expectedVersion: number }): Promise<PlannerPlan>;
}

/** The planner HTTP client over a transport: pure (no React / path aliases), checked by planner-contract.test.ts. */
import type { RoutePlanCompareDto, RoutePlanPublishResult, RoutePlanSummaryDto, RoutePlanVersionDto, RoutingCapabilities, RoutingJobDto } from '@veetracer/shared';
/** Query values (same shape as lib/api QueryParams; no path alias so node --test can load this file). */
export type QueryParams = Record<string, string | number | boolean | null | undefined>;
import { CAPABILITIES_ENDPOINT, JOBS_ENDPOINT, PLANS_ENDPOINT, type PlannerClient } from './planner-api.ts';
import { toEditResult, toList, type PlannerPlan } from './planner-format.ts';

/** The transport the HTTP client uses; tests pass a recorder to check the exact requests (planner-contract.test.ts). */
export interface PlannerTransport {
  get<T>(path: string, query?: QueryParams, signal?: AbortSignal): Promise<T>;
  send<T>(method: 'POST' | 'PUT' | 'PATCH', path: string, body: unknown, headers?: Record<string, string>): Promise<T>;
}

/** Builds the planner client over a transport. Every keyed call sends the key in the `Idempotency-Key` header. */
export function createHttpPlannerClient(tx: PlannerTransport): PlannerClient {
  const plan = (id: string) => `/transport/route-plans/${encodeURIComponent(id)}`;
  const keyed = <T>(path: string, body: unknown, key: string) => tx.send<T>('POST', path, body, { 'Idempotency-Key': key });
  return {
    capabilities: (signal) => tx.get<RoutingCapabilities>(CAPABILITIES_ENDPOINT, undefined, signal),
    listPlans: async (q, signal) => toList(await tx.get<RoutePlanSummaryDto[] | { items: RoutePlanSummaryDto[] }>(PLANS_ENDPOINT, q as QueryParams, signal)),
    getPlan: (id, signal) => tx.get<PlannerPlan>(plan(id), undefined, signal),
    history: async (id, signal) => toList(await tx.get<RoutePlanVersionDto[] | { items: RoutePlanVersionDto[] }>(`${plan(id)}/history`, undefined, signal)),
    compare: (ids, signal) => tx.get<RoutePlanCompareDto>(`${PLANS_ENDPOINT}/compare`, { ids: ids.join(',') }, signal),
    createPlan: (body, key) => keyed<PlannerPlan>(PLANS_ENDPOINT, body, key),
    optimize: (body, key) => keyed<RoutingJobDto>(`${JOBS_ENDPOINT}/optimize`, body, key),
    optimizePlan: (id, body, key) => keyed<RoutingJobDto>(`${plan(id)}/optimize`, body, key),
    getJob: (id, signal) => tx.get<RoutingJobDto>(`${JOBS_ENDPOINT}/${encodeURIComponent(id)}`, undefined, signal),
    cancelJob: (id) => tx.send<RoutingJobDto>('POST', `${JOBS_ENDPOINT}/${encodeURIComponent(id)}/cancel`, {}),
    movePassenger: async (id, body) => toEditResult(await tx.send<unknown>('POST', `${plan(id)}/move-passenger`, body)),
    resequence: async (id, body) => toEditResult(await tx.send<unknown>('PUT', `${plan(id)}/sequence`, body)),
    updateAssignment: async (id, aid, body) => toEditResult(await tx.send<unknown>('PATCH', `${plan(id)}/assignments/${encodeURIComponent(aid)}`, body)),
    updateStop: async (id, sid, body) => toEditResult(await tx.send<unknown>('PATCH', `${plan(id)}/stops/${encodeURIComponent(sid)}`, body)),
    publish: (id, body, key) => keyed<RoutePlanPublishResult>(`${plan(id)}/publish`, body, key),
    discard: (id, body) => tx.send<PlannerPlan>('POST', `${plan(id)}/discard`, body),
  };
}


import type { PublishRoutePlanResult, RoutePlanSummaryDto, RoutePlanVersionDto, RoutingCapabilities, RoutingJobDto } from '@veetracer/shared';
import { api, request, type QueryParams } from '@/lib/api';
import { CAPABILITIES_ENDPOINT, JOBS_ENDPOINT, PLANS_ENDPOINT, type PlannerClient } from './planner-api';
import { toEditResult, toList, type PlannerPlan } from './planner-format';

const plan = (id: string) => `${PLANS_ENDPOINT}/${encodeURIComponent(id)}`;

/** The real API (`/api/routing/*`, `/api/route-plans/*`). */
export const httpPlannerClient: PlannerClient = {
  capabilities: (signal) => api.get<RoutingCapabilities>(CAPABILITIES_ENDPOINT, undefined, signal),
  listPlans: async (q, signal) => toList(await api.get<RoutePlanSummaryDto[] | { items: RoutePlanSummaryDto[] }>(PLANS_ENDPOINT, q as QueryParams, signal)),
  getPlan: (id, signal) => api.get<PlannerPlan>(plan(id), undefined, signal),
  history: async (id, signal) => toList(await api.get<RoutePlanVersionDto[] | { items: RoutePlanVersionDto[] }>(`${plan(id)}/history`, undefined, signal)),
  createPlan: (body) => api.post<PlannerPlan>(PLANS_ENDPOINT, body),
  addAssignment: (id, body) => api.post<PlannerPlan>(`${plan(id)}/assignments`, body),
  optimize: (id, body) => api.post<RoutingJobDto>(`${plan(id)}/optimize`, body),
  getJob: (id, signal) => api.get<RoutingJobDto>(`${JOBS_ENDPOINT}/${encodeURIComponent(id)}`, undefined, signal),
  cancelJob: (id) => api.post<RoutingJobDto>(`${JOBS_ENDPOINT}/${encodeURIComponent(id)}/cancel`, {}),
  resequence: async (id, body) => toEditResult(await api.put<unknown>(`${plan(id)}/sequence`, body)),
  changeVehicle: async (id, aid, body) => toEditResult(await api.patch<unknown>(`${plan(id)}/assignments/${encodeURIComponent(aid)}`, body)),
  pinStop: async (id, sid, body) => toEditResult(await api.patch<unknown>(`${plan(id)}/stops/${encodeURIComponent(sid)}`, body)),
  // Idempotency-Key in the header as well as the body (E3 publish pattern).
  publish: (id, body) => request<PublishRoutePlanResult>(`${plan(id)}/publish`, { method: 'POST', body, headers: { 'Idempotency-Key': body.idempotencyKey } }),
  discard: (id, body) => api.post<PlannerPlan>(`${plan(id)}/cancel`, body),
};

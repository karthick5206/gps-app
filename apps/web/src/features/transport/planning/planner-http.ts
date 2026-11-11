import type { DispatchBoardDto, RoutePlanCompareDto, RoutePlanPublishResult, RoutePlanSummaryDto, RoutePlanVersionDto, RoutingCapabilities, RoutingJobDto } from '@veetracer/shared';
import { OSM_ATTRIBUTION, ROUTING_LIMITS } from '@veetracer/shared';
import { api, ApiError, request, type QueryParams } from '@/lib/api';
import { CAPABILITIES_ENDPOINT, JOBS_ENDPOINT, PLANS_ENDPOINT, type PlannerClient } from './planner-api';
import { toEditResult, toList, type PlannerPlan } from './planner-format';

const plan = (id: string) => `${PLANS_ENDPOINT}/${encodeURIComponent(id)}`;
const today = () => new Date().toISOString().slice(0, 10);

/**
 * Until `GET /routing/capabilities` exists: the plans API answers 404 unless ETMS + ETMS_ROUTING are on (enabled), and
 * the dispatch board's `routingAvailable` says whether GraphHopper answers. Optimiser / worker health is not exposed to
 * company users; a job reports it (OPTIMIZER_UNAVAILABLE, queued with no worker). Access is the caller's menu grants,
 * which the screens check with `can()`; the server enforces scope and precision (`precise` on the plan).
 */
async function derivedCapabilities(signal?: AbortSignal): Promise<RoutingCapabilities> {
  let enabled = true;
  try {
    await api.get<unknown>(PLANS_ENDPOINT, { planDate: today() }, signal);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) enabled = false;
    else throw e;
  }
  let engineReachable = true;
  if (enabled) {
    try {
      engineReachable = (await api.get<DispatchBoardDto>('/transport/dispatch/board', { serviceDate: today() }, signal)).routingAvailable;
    } catch {
      engineReachable = true; // unknown: the job will say "routing unavailable" if it is
    }
  }
  return {
    enabled,
    engine: enabled ? 'graphhopper' : null,
    engineReachable,
    engineVersion: null,
    graphVersion: null,
    optimizer: true,
    workers: 1,
    etaBands: { short_lt10km: 'uncalibrated', mid_10_40km: 'uncalibrated', long_gt40km: 'uncalibrated' },
    profiles: ['car'],
    limits: ROUTING_LIMITS,
    liveTraffic: false,
    attribution: OSM_ATTRIBUTION,
    access: { enabled, canView: enabled, canPlan: enabled, canEdit: enabled, canDelete: enabled, canPublish: enabled, scope: 'ASSIGNED', support: false },
  };
}

/** The real API. */
export const httpPlannerClient: PlannerClient = {
  capabilities: async (signal) => {
    try {
      return await api.get<RoutingCapabilities>(CAPABILITIES_ENDPOINT, undefined, signal);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 404 || e.status === 405)) return derivedCapabilities(signal);
      throw e;
    }
  },
  listPlans: async (q, signal) => toList(await api.get<RoutePlanSummaryDto[] | { items: RoutePlanSummaryDto[] }>(PLANS_ENDPOINT, q as QueryParams, signal)),
  getPlan: (id, signal) => api.get<PlannerPlan>(plan(id), undefined, signal),
  history: async (id, signal) => toList(await api.get<RoutePlanVersionDto[] | { items: RoutePlanVersionDto[] }>(`${plan(id)}/history`, undefined, signal)),
  compare: (ids, signal) => api.get<RoutePlanCompareDto>(`${PLANS_ENDPOINT}/compare`, { ids: ids.join(',') }, signal),
  createPlan: async (body) => {
    try {
      return await api.post<PlannerPlan>(PLANS_ENDPOINT, body);
    } catch (e) {
      // Not on the server yet: say so instead of a bare 404.
      if (e instanceof ApiError && (e.status === 404 || e.status === 405)) throw new ApiError(e.status, e.messages, 'PLAN_CREATE_UNAVAILABLE');
      throw e;
    }
  },
  optimize: (body, key) => request<RoutingJobDto>(`${JOBS_ENDPOINT}/optimize`, { method: 'POST', body, headers: { 'Idempotency-Key': key } }),
  getJob: (id, signal) => api.get<RoutingJobDto>(`${JOBS_ENDPOINT}/${encodeURIComponent(id)}`, undefined, signal),
  cancelJob: (id) => api.post<RoutingJobDto>(`${JOBS_ENDPOINT}/${encodeURIComponent(id)}/cancel`, {}),
  movePassenger: async (id, body) => toEditResult(await api.post<unknown>(`${plan(id)}/move-passenger`, body)),
  resequence: async (id, body) => toEditResult(await api.put<unknown>(`${plan(id)}/sequence`, body)),
  updateAssignment: async (id, aid, body) => toEditResult(await api.patch<unknown>(`${plan(id)}/assignments/${encodeURIComponent(aid)}`, body)),
  updateStop: async (id, sid, body) => toEditResult(await api.patch<unknown>(`${plan(id)}/stops/${encodeURIComponent(sid)}`, body)),
  // Idempotency-Key in the header (E3 change-set pattern); a replay answers the same result.
  publish: (id, body, key) => request<RoutePlanPublishResult>(`${plan(id)}/publish`, { method: 'POST', body, headers: { 'Idempotency-Key': key } }),
  discard: (id, body) => api.post<PlannerPlan>(`${plan(id)}/discard`, body),
};

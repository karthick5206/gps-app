import { api, request } from '@/lib/api';
import type { PlannerClient } from './planner-api';
import { createHttpPlannerClient } from './planner-http-client';

/** The real API (`/api/...` through lib/api: auth, company header, 401 refresh). */
export const httpPlannerClient: PlannerClient = createHttpPlannerClient({
  get: (path, query, signal) => api.get(path, query, signal),
  send: (method, path, body, headers) => request(path, { method, body: body ?? {}, ...(headers ? { headers } : {}) }),
});

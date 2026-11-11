import type { DispatchBoardDto, Paginated, RoutePlanRouteError, TransportShiftDto } from '@veetracer/shared';
import { keepPreviousData, useMutation, useQueries, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { api, ApiError, errorMessage } from '@/lib/api';
import { e3ErrorText } from '../dispatch/e3-format';
import { DISPATCH_ENDPOINT, invalidateDispatch, SHIFTS_ENDPOINT } from '../dispatch/use-e3';
import type { PlanListQuery } from './planner-api';
import { call, plannerClient, plannerKeys } from './planner-client';
import { publishPlan, reoptimise, startOptimise, type KeyStore, type OptimiseInput, type StartedPlan } from './planner-flow';
import {
  jobPollMs,
  newKey,
  plannerErrorKind,
  plannerErrorText,
  type PlanEditResult,
  type PlannerErrorKind,
  type PlannerPlan,
  type PlannerWeights,
} from './planner-format';

export function invalidatePlans(qc: QueryClient, id?: string) {
  void qc.invalidateQueries({ queryKey: plannerKeys.plans });
  void qc.invalidateQueries({ queryKey: plannerKeys.compare });
  if (id) {
    void qc.invalidateQueries({ queryKey: plannerKeys.plan(id) });
    void qc.invalidateQueries({ queryKey: plannerKeys.history(id) });
  }
}

// ───────────────────────────── errors (E3 pattern: code → friendly text + kind) ─────────────────────────────

function errorCode(err: unknown): { code: string | null; status: number | undefined; body: unknown } {
  if (err instanceof ApiError) return { code: err.code, status: err.status, body: err.body };
  const e = err as { code?: unknown; status?: unknown; body?: unknown } | null;
  return { code: typeof e?.code === 'string' ? e.code : null, status: typeof e?.status === 'number' ? e.status : undefined, body: e?.body ?? null };
}

export function plannerErrorOf(err: unknown): { kind: PlannerErrorKind; code: string | null } {
  const { code, status } = errorCode(err);
  return { kind: plannerErrorKind(code, status), code };
}

/** Per-route refusals of a publish (409 PLAN_NOT_PUBLISHABLE or the E3 error of the failing route). */
export function publishRouteErrors(err: unknown): RoutePlanRouteError[] {
  const body = errorCode(err).body as { routes?: unknown } | null;
  return Array.isArray(body?.routes) ? (body.routes as RoutePlanRouteError[]).filter((r) => r && typeof r.assignmentId === 'string') : [];
}

/** Friendly text for an API / job error code (planner codes, then the E3 ones), plus the server's detail. */
export function plannerErrorMessage(err: unknown, t: (k: string) => string): string {
  const { code } = errorCode(err);
  const friendly = plannerErrorText(code) ?? e3ErrorText(code);
  if (friendly) {
    const detail = err instanceof Error ? err.message : '';
    return detail && code !== 'PLAN_STALE' && code !== 'VERSION_CONFLICT' && !detail.startsWith('Request failed') ? `${t(friendly)} (${detail})` : t(friendly);
  }
  return errorMessage(err);
}

// ───────────────────────────── inputs from E3 (shifts, vehicles) ─────────────────────────────

export function useActiveShifts() {
  return useQuery({
    queryKey: ['planner-shifts'],
    queryFn: ({ signal }) => api.get<Paginated<TransportShiftDto>>(SHIFTS_ENDPOINT, { status: 'ACTIVE', pageSize: 200, sort: 'startMin', order: 'asc' }, signal),
    staleTime: 60_000,
    select: (p) => p.items,
  });
}

/** Vehicles with seats (the dispatch board's list for the day; busy windows come with it). */
export function usePlannerVehicles(serviceDate: string, direction: string) {
  return useQuery({
    queryKey: ['planner-vehicles', serviceDate, direction],
    queryFn: ({ signal }) => api.get<DispatchBoardDto>(`${DISPATCH_ENDPOINT}/board`, { serviceDate, direction }, signal),
    staleTime: 30_000,
    placeholderData: keepPreviousData,
    select: (b) => ({ vehicles: b.vehicles, timeZone: b.timeZone, routingAvailable: b.routingAvailable }),
  });
}

// ───────────────────────────── plans ─────────────────────────────

export function usePlans(q: PlanListQuery) {
  return useQuery({
    queryKey: [...plannerKeys.plans, q],
    queryFn: ({ signal }) => call((c) => c.listPlans(q, signal)),
    placeholderData: keepPreviousData,
  });
}

export function usePlan(id: string | null | undefined) {
  return useQuery({
    queryKey: plannerKeys.plan(id ?? ''),
    queryFn: ({ signal }) => call((c) => c.getPlan(id as string, signal)),
    enabled: !!id,
    retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
  });
}

/** Several plan details at once (ride times / ETA quality for compare). */
export function usePlansDetail(ids: readonly string[]) {
  return useQueries({
    queries: ids.map((id) => ({ queryKey: plannerKeys.plan(id), queryFn: ({ signal }: { signal: AbortSignal }) => call((c) => c.getPlan(id, signal)) })),
  });
}

/** GET /transport/route-plans/compare (metrics only). */
export function useCompare(ids: readonly string[]) {
  const key = [...ids].sort();
  return useQuery({
    queryKey: [...plannerKeys.compare, key],
    queryFn: ({ signal }) => call((c) => c.compare(key, signal)),
    enabled: key.length >= 2,
  });
}

export function usePlanHistory(id: string | null, enabled: boolean) {
  return useQuery({
    queryKey: plannerKeys.history(id ?? ''),
    queryFn: ({ signal }) => call((c) => c.history(id as string, signal)),
    enabled: !!id && enabled,
  });
}

// ───────────────────────────── jobs ─────────────────────────────

/** Polls a job until it finishes; refreshes plans when it does. */
export function useJob(id: string | null) {
  const qc = useQueryClient();
  return useQuery({
    queryKey: plannerKeys.job(id ?? ''),
    queryFn: async ({ signal }) => {
      const job = await call((c) => c.getJob(id as string, signal));
      if (job.state === 'succeeded' || job.state === 'failed' || job.state === 'cancelled') invalidatePlans(qc, job.planId ?? undefined);
      return job;
    },
    enabled: !!id,
    refetchInterval: (q) => jobPollMs(q.state.data),
    refetchIntervalInBackground: false,
    retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 3,
  });
}

/** Open jobs of a plan (after a reload the page has no job id of its own; the plan detail carries none). */
export function usePlanOpenJobs(planId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: [...plannerKeys.job(''), 'plan', planId ?? ''],
    queryFn: ({ signal }) => call((c) => c.planJobs(planId as string, signal)),
    enabled: !!planId && enabled,
    refetchInterval: enabled ? 3000 : false,
  });
}

export function useCancelJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (jobId: string) => call((c) => c.cancelJob(jobId)),
    onSuccess: (job) => qc.setQueryData(plannerKeys.job(job.jobId), job),
  });
}

export type { OptimiseInput, StartedPlan } from './planner-flow';

/**
 * Creates one plan per seed (shift) with the chosen vehicles and starts its optimise job (planner-flow). Keys come from
 * the screen's key store, so a retry of the same action replays on the server instead of creating twice.
 */
export function useStartOptimise(keys: KeyStore) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: OptimiseInput): Promise<StartedPlan[]> => {
      const out = await startOptimise(await plannerClient(), input, keys.keyFor);
      for (const r of out) if (r.job) qc.setQueryData(plannerKeys.job(r.job.jobId), r.job);
      return out;
    },
    onSettled: () => invalidatePlans(qc),
  });
}

/** Re-optimise a saved plan (pinned stops and locked routes stay as they are). */
export function useReoptimise(plan: PlannerPlan | undefined, keys: KeyStore) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { weights: PlannerWeights; timeLimitS: number }) => call((c) => reoptimise(c, plan as PlannerPlan, input, keys.keyFor)),
    onSuccess: (job) => qc.setQueryData(plannerKeys.job(job.jobId), job),
    onError: (err) => {
      const st = (err as { status?: number }).status;
      if (plan && typeof st === 'number' && st < 500) keys.forget(`reoptimize:${plan.id}`);
    },
    onSettled: () => plan && invalidatePlans(qc, plan.id),
  });
}

// ───────────────────────────── edits ─────────────────────────────

export type PlanEdit =
  | { kind: 'move'; bookingId: string; toAssignmentId: string | null }
  | { kind: 'sequence'; assignments: { assignmentId: string; stopIds: string[] }[] }
  | { kind: 'vehicle'; assignmentId: string; objectId: string }
  | { kind: 'lock'; assignmentId: string; locked: boolean }
  | { kind: 'pin'; stopId: string; pinned: boolean };

/** One explicit edit with the version the user saw; 409 PLAN_STALE reloads the plan (the caller tells the user). */
export function usePlanEdit(plan: PlannerPlan | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (e: PlanEdit): Promise<PlanEditResult> =>
      call((c) => {
        const p = plan as PlannerPlan;
        const expectedVersion = p.version;
        switch (e.kind) {
          case 'move':
            return c.movePassenger(p.id, { expectedVersion, bookingId: e.bookingId, toAssignmentId: e.toAssignmentId });
          case 'sequence':
            return c.resequence(p.id, { expectedVersion, assignments: e.assignments });
          case 'vehicle':
            return c.updateAssignment(p.id, e.assignmentId, { expectedVersion, objectId: e.objectId });
          case 'lock':
            return c.updateAssignment(p.id, e.assignmentId, { expectedVersion, locked: e.locked });
          case 'pin':
            return c.updateStop(p.id, e.stopId, { expectedVersion, pinned: e.pinned });
        }
      }),
    onSuccess: (r) => {
      qc.setQueryData(plannerKeys.plan(r.plan.id), (old: PlannerPlan | undefined) => ({ ...r.plan, weights: old?.weights, lastJobId: old?.lastJobId }));
      void qc.invalidateQueries({ queryKey: plannerKeys.plans });
      void qc.invalidateQueries({ queryKey: plannerKeys.compare });
      void qc.invalidateQueries({ queryKey: plannerKeys.history(r.plan.id) });
    },
    onError: (err) => {
      if (plan && plannerErrorOf(err).kind === 'conflict') invalidatePlans(qc, plan.id);
    },
  });
}

/** Publish with a key per (plan, version) attempt from the screen's key store; a refused publish (4xx) frees it. */
export function usePublishPlan(plan: PlannerPlan | undefined, keys: KeyStore) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => call((c) => publishPlan(c, plan as PlannerPlan, keys.keyFor)),
    onSuccess: () => plan && keys.forget(`publish:${plan.id}`),
    onError: (err) => {
      const st = (err as { status?: number }).status;
      if (plan && typeof st === 'number' && st < 500) keys.forget(`publish:${plan.id}`);
    },
    onSettled: () => {
      if (plan) invalidatePlans(qc, plan.id);
      invalidateDispatch(qc);
    },
  });
}

export function useDiscardPlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (p: { id: string; version: number }) => call((c) => c.discard(p.id, { expectedVersion: p.version })),
    onSettled: (_d, _e, p) => invalidatePlans(qc, p.id),
  });
}

export { newKey };
export { createKeyStore, type KeyStore } from './planner-flow';
export { PLANNING_MENU, PLANNING_PATH, planPath, plannerFlagOn, useCapabilities, usePlannerMenuHidden, plannerKeys } from './planner-client';

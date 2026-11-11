import type { CreateRoutePlanRequest, DispatchBoardDto, Paginated, RoutingJobDto, TransportShiftDto } from '@veetracer/shared';
import { keepPreviousData, useMutation, useQueries, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { api, ApiError, errorMessage } from '@/lib/api';
import { DISPATCH_ENDPOINT, invalidateDispatch, SHIFTS_ENDPOINT } from '../dispatch/use-e3';
import type { PlanListQuery } from './planner-api';
import { call, plannerClient, plannerKeys } from './planner-client';
import {
  jobPollMs,
  newKey,
  plannerErrorKind,
  plannerErrorText,
  solverObjective,
  type PlanEditResult,
  type PlannerErrorKind,
  type PlannerPlan,
  type PlannerWeights,
  type PlanSeed,
} from './planner-format';

export function invalidatePlans(qc: QueryClient, id?: string) {
  void qc.invalidateQueries({ queryKey: plannerKeys.plans });
  if (id) {
    void qc.invalidateQueries({ queryKey: plannerKeys.plan(id) });
    void qc.invalidateQueries({ queryKey: plannerKeys.history(id) });
  }
}

// ───────────────────────────── errors (E3 pattern: code → friendly text + kind) ─────────────────────────────

function errorCode(err: unknown): { code: string | null; status: number | undefined } {
  if (err instanceof ApiError) return { code: err.code, status: err.status };
  const e = err as { code?: unknown; status?: unknown } | null;
  return { code: typeof e?.code === 'string' ? e.code : null, status: typeof e?.status === 'number' ? e.status : undefined };
}

export function plannerErrorOf(err: unknown): { kind: PlannerErrorKind; code: string | null } {
  const { code, status } = errorCode(err);
  return { kind: plannerErrorKind(code, status), code };
}

/** Friendly text for an API / job error code, plus the server's detail when it adds something. */
export function plannerErrorMessage(err: unknown, t: (k: string) => string): string {
  const { code } = errorCode(err);
  const friendly = plannerErrorText(code);
  if (friendly) {
    const detail = err instanceof Error ? err.message : '';
    return detail && code !== 'PLAN_STALE' && code !== 'VERSION_CONFLICT' && !detail.startsWith('Request failed') ? `${t(friendly)} (${detail})` : t(friendly);
  }
  return err instanceof ApiError || !(err instanceof Error) ? errorMessage(err) : err.message;
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

/** Several plans at once (compare). */
export function usePlansDetail(ids: readonly string[]) {
  return useQueries({
    queries: ids.map((id) => ({ queryKey: plannerKeys.plan(id), queryFn: ({ signal }: { signal: AbortSignal }) => call((c) => c.getPlan(id, signal)) })),
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

/** Polls a job until it finishes; refreshes its plan when it succeeds. */
export function useJob(id: string | null) {
  return useQuery({
    queryKey: plannerKeys.job(id ?? ''),
    queryFn: ({ signal }) => call((c) => c.getJob(id as string, signal)),
    enabled: !!id,
    refetchInterval: (q) => jobPollMs(q.state.data),
    refetchIntervalInBackground: false,
    retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 3,
  });
}

export function useCancelJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (jobId: string) => call((c) => c.cancelJob(jobId)),
    onSuccess: (job) => qc.setQueryData(plannerKeys.job(job.jobId), job),
  });
}

export interface StartedPlan {
  seed: PlanSeed;
  planId: string | null;
  job: RoutingJobDto | null;
  error: unknown;
}

export interface OptimiseInput {
  planDate: string;
  direction: 'IN' | 'OUT';
  seeds: PlanSeed[];
  vehicles: { objectId: string; label: string; seats: number | null }[];
  weights: PlannerWeights;
  timeLimitS: number;
}

/**
 * Creates one plan per seed (shift), adds the chosen vehicles and starts its optimisation. Each seed reports on its
 * own; one failing does not stop the others (07 §5: never block the rest).
 */
export function useStartOptimise() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: OptimiseInput): Promise<StartedPlan[]> => {
      const c = await plannerClient();
      const out: StartedPlan[] = [];
      for (const seed of input.seeds) {
        let planId: string | null = null;
        try {
          const body: CreateRoutePlanRequest = { name: seed.name, planDate: input.planDate, direction: input.direction, shiftId: seed.shiftId, sitePoiId: seed.sitePoiId, ...(seed.planStartAt ? { planStartAt: seed.planStartAt } : {}) };
          let plan = await c.createPlan(body);
          planId = plan.id;
          for (const v of input.vehicles) plan = await c.addAssignment(plan.id, { expectedVersion: plan.version, vehicleLabel: v.label, objectId: v.objectId, capacity: v.seats });
          const job = await c.optimize(plan.id, { expectedVersion: plan.version, timeLimitS: input.timeLimitS, objective: solverObjective(input.weights), weights: input.weights });
          qc.setQueryData(plannerKeys.job(job.jobId), job);
          out.push({ seed, planId, job, error: null });
        } catch (error) {
          out.push({ seed, planId, job: null, error });
        }
      }
      return out;
    },
    onSettled: () => invalidatePlans(qc),
  });
}

/** Re-optimise a saved plan (pinned stops stay where they are). */
export function useReoptimise(plan: PlannerPlan | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { weights: PlannerWeights; timeLimitS: number }) =>
      call((c) => c.optimize((plan as PlannerPlan).id, { expectedVersion: (plan as PlannerPlan).version, timeLimitS: input.timeLimitS, objective: solverObjective(input.weights), weights: input.weights })),
    onSuccess: (job) => qc.setQueryData(plannerKeys.job(job.jobId), job),
    onSettled: () => plan && invalidatePlans(qc, plan.id),
  });
}

// ───────────────────────────── edits ─────────────────────────────

export type PlanEdit =
  | { kind: 'sequence'; assignments: { assignmentId: string; stopIds: string[] }[] }
  | { kind: 'vehicle'; assignmentId: string; objectId: string; vehicleLabel: string; capacity: number | null }
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
          case 'sequence':
            return c.resequence(p.id, { expectedVersion, assignments: e.assignments });
          case 'vehicle':
            return c.changeVehicle(p.id, e.assignmentId, { expectedVersion, objectId: e.objectId, vehicleLabel: e.vehicleLabel, capacity: e.capacity });
          case 'pin':
            return c.pinStop(p.id, e.stopId, { expectedVersion, pinned: e.pinned });
        }
      }),
    onSuccess: (r) => {
      qc.setQueryData(plannerKeys.plan(r.plan.id), r.plan);
      void qc.invalidateQueries({ queryKey: plannerKeys.plans });
      void qc.invalidateQueries({ queryKey: plannerKeys.history(r.plan.id) });
    },
    onError: (err) => {
      if (plan && plannerErrorOf(err).kind === 'conflict') invalidatePlans(qc, plan.id);
    },
  });
}

/** Publish with a stable Idempotency-Key per (plan, version) attempt; a refused publish (4xx) frees the key. */
export function usePublishPlan(plan: PlannerPlan | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (key: string) => call((c) => c.publish((plan as PlannerPlan).id, { expectedVersion: (plan as PlannerPlan).version, idempotencyKey: key })),
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
export { PLANNING_MENU, PLANNING_PATH, planPath, plannerFlagOn, useCapabilities, usePlannerMenuHidden, plannerKeys } from './planner-client';

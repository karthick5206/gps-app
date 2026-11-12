/**
 * The optimise flow as plain functions over a `PlannerClient` (no React / path aliases): the hooks call them, and the
 * contract tests run them over the real HTTP client with a recording transport, so the request shapes the screens
 * send are the ones checked (B1 / B2 of the E4 QA round).
 */
import type { MaxRideOverrideInput, RoutePlanCreateCounts, RoutePlanEmptyReason, RoutingJobDto, TransportDirection } from '@veetracer/shared';
import type { CreatePlanRequest, OptimizeOptions, PlannerClient } from './planner-api.ts';
import { solverObjective, type PlannerPlan, type PlannerWeights, type PlanSeed } from './planner-format.ts';

export interface OptimiseInput {
  planDate: string;
  direction: TransportDirection;
  seeds: PlanSeed[];
  objectIds: string[];
  weights: PlannerWeights;
  timeLimitS: number;
  /** T2-D5: the branch of the new plans (branch-scoped users; null / absent for a whole-company plan). */
  branchId?: string | null;
  /** Owner decision 1: per-plan max-ride override (authorised callers only), sent with each plan's optimise. */
  maxRideOverride?: MaxRideOverrideInput | null;
}

export interface StartedPlan {
  seed: PlanSeed;
  planId: string | null;
  job: RoutingJobDto | null;
  error: unknown;
  /** The plan was created without passengers (e.g. no booking for the shift): not optimised; the screen says why. */
  empty?: RoutePlanEmptyReason | null;
  /** Bookings the server left out of the plan (reason per booking) and the booking counts, shown with the plan. */
  skipped?: { bookingId: string; reason: string }[];
  counts?: RoutePlanCreateCounts | null;
}

/**
 * Idempotency-Key per user action and request: the same scope + body (a retry after a lost answer or an error) gets
 * the same key, so the server replays instead of creating a second plan / job; another body gets a new key.
 */
export type KeyFor = (scope: string, body: unknown) => string;

/** A plan needs a site (CreateRoutePlanDto.sitePoiId): a shift without one and no single chosen site cannot be planned. */
export class SeedError extends Error {
  readonly code = 'SITE_REQUIRED';
}

export function createRequest(seed: PlanSeed, input: Pick<OptimiseInput, 'planDate' | 'direction' | 'objectIds' | 'branchId'>): CreatePlanRequest {
  if (!seed.sitePoiId) throw new SeedError('The shift has no site');
  return {
    name: seed.name,
    planDate: input.planDate,
    direction: input.direction,
    shiftId: seed.shiftId,
    sitePoiId: seed.sitePoiId,
    objectIds: [...input.objectIds],
    ...(seed.planStartAt ? { planStartAt: seed.planStartAt } : {}),
    ...(input.branchId ? { branchId: input.branchId } : {}),
  };
}

export function optimizeOptions(plan: Pick<PlannerPlan, 'version'>, input: { weights: PlannerWeights; timeLimitS: number; maxRideOverride?: MaxRideOverrideInput | null }): OptimizeOptions {
  return {
    expectedVersion: plan.version,
    timeLimitS: input.timeLimitS,
    objective: solverObjective(input.weights),
    weights: { ...input.weights },
    // Owner decision 1: only when set or cleared on purpose; absent keeps the plan's override.
    ...(input.maxRideOverride !== undefined ? { maxRideOverride: input.maxRideOverride ? { ...input.maxRideOverride } : null } : {}),
  };
}

/**
 * One plan per seed (shift) with the chosen vehicles, then its optimise job. Each seed reports on its own; one failing
 * does not stop the others (07 §5).
 */
export async function startOptimise(c: PlannerClient, input: OptimiseInput, keyFor: KeyFor): Promise<StartedPlan[]> {
  const out: StartedPlan[] = [];
  for (const seed of input.seeds) {
    let planId: string | null = null;
    try {
      const body = createRequest(seed, input);
      const plan = await c.createPlan(body, keyFor(`create:${seed.shiftId}`, body));
      planId = plan.id;
      const left = { skipped: plan.skippedBookings ?? [], counts: plan.bookingCounts ?? null };
      if (plan.emptyReason) {
        out.push({ seed, planId, job: null, error: null, empty: plan.emptyReason, ...left });
        continue;
      }
      const opt = { planId: plan.id, ...optimizeOptions(plan, input) };
      const job = await c.optimize(opt, keyFor(`optimize:${plan.id}`, opt));
      out.push({ seed, planId, job, error: null, ...left });
    } catch (error) {
      out.push({ seed, planId, job: null, error });
    }
  }
  return out;
}

/** Re-optimise a saved plan through the alias `POST /transport/route-plans/:id/optimize`. */
export function reoptimise(c: PlannerClient, plan: Pick<PlannerPlan, 'id' | 'version'>, input: { weights: PlannerWeights; timeLimitS: number; maxRideOverride?: MaxRideOverrideInput | null }, keyFor: KeyFor): Promise<RoutingJobDto> {
  const body = optimizeOptions(plan, input);
  return c.optimizePlan(plan.id, body, keyFor(`reoptimize:${plan.id}`, body));
}

/** Publish of one plan version: body `{ expectedVersion }`, key per (plan, version) attempt. */
export function publishPlan(c: PlannerClient, plan: Pick<PlannerPlan, 'id' | 'version'>, keyFor: KeyFor) {
  const body = { expectedVersion: plan.version };
  return c.publish(plan.id, body, keyFor(`publish:${plan.id}`, body));
}

/** Stable JSON (sorted keys) for comparing request bodies. */
export function stableJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  return `{${Object.keys(v as Record<string, unknown>)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`)
    .join(',')}}`;
}

/**
 * A key store for one screen: a retry of the same scope and body reuses the key; `forget(scope)` after a refusal
 * (4xx: nothing was written) or a success the user may repeat on purpose.
 */
export function createKeyStore(gen: () => string) {
  const slots = new Map<string, { key: string; body: string }>();
  const keyFor: KeyFor = (scope, body) => {
    const s = stableJson(body);
    const prev = slots.get(scope);
    if (prev && prev.body === s) return prev.key;
    const next = { key: gen(), body: s };
    slots.set(scope, next);
    return next.key;
  };
  return {
    keyFor,
    forget: (scopePrefix: string) => {
      for (const k of [...slots.keys()]) if (k.startsWith(scopePrefix)) slots.delete(k);
    },
    clear: () => slots.clear(),
  };
}
export type KeyStore = ReturnType<typeof createKeyStore>;

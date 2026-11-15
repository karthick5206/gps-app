/**
 * E4 WP-W review & publish (pure; `node --test`): GET /route-plans/:id/review → what the confirmation screen may
 * publish, the publish body (assignmentIds + reviewHash + the decision 5 fields), and how a refused publish moves the
 * screen (PLAN_REVIEW_STALE and friends reload the review and need a fresh confirmation).
 *
 * The confirmation is stored as the reviewHash the user confirmed, so any reload with other content (another user's
 * edit, a refetch, a stale answer) clears it without extra bookkeeping (the D-L3 fingerprint pattern).
 */
import type { RoutePlanPublishRequest, RoutePlanReviewDto, RoutePlanRouteError } from '@veetracer/shared';
import { publishGate, publishGateState, unassignedReason, type PublishGate } from './planner-format.ts';

export type ReviewPublishBody = Omit<RoutePlanPublishRequest, 'idempotencyKey'> & { assignmentIds: string[]; reviewHash: string };

export interface ReviewGate extends PublishGate {
  /** Pre-check refusals and route errors (VEHICLE_BUSY, DRIVER_BUSY, …): never overridable. */
  routeErrors: RoutePlanRouteError[];
}

export function reviewGate(review: Pick<RoutePlanReviewDto, 'publishCheck' | 'errors'>): ReviewGate {
  const g = publishGate({ publishCheck: review.publishCheck, violations: [] });
  const seen = new Set<string>();
  const routeErrors: RoutePlanRouteError[] = [];
  for (const e of [...(review.errors ?? []), ...(review.publishCheck?.routeErrors ?? [])]) {
    const k = `${e.assignmentId}|${e.code}`;
    if (seen.has(k)) continue;
    seen.add(k);
    routeErrors.push(e);
  }
  return { ...g, routeErrors };
}

export interface ReviewInput {
  /** The reviewHash the user confirmed (null = not confirmed). */
  confirmedHash: string | null;
  acknowledged: boolean;
  overrideOn: boolean;
  reason: string;
}

/** Whether Publish is enabled and its body. */
export function reviewPublishState(review: RoutePlanReviewDto, input: ReviewInput): { allowed: boolean; confirmed: boolean; blocked: boolean; body: ReviewPublishBody | null } {
  const g = reviewGate(review);
  const decision = publishGateState(g, { acknowledged: input.acknowledged, overrideOn: input.overrideOn && g.canOverride, reason: input.reason });
  const confirmed = input.confirmedHash !== null && input.confirmedHash === review.reviewHash;
  const blocked = g.routeErrors.length > 0 || g.blocking.length > 0;
  const allowed = confirmed && !blocked && decision.allowed && review.routes.length > 0 && review.assignmentIds.length > 0;
  return {
    allowed,
    confirmed,
    blocked,
    body: allowed ? { expectedVersion: review.version, assignmentIds: [...review.assignmentIds], reviewHash: review.reviewHash, ...decision.body } : null,
  };
}

/** Error codes after which the review is reloaded and the user confirms again (the plan moved on). */
const RELOAD_CODES = new Set(['PLAN_REVIEW_STALE', 'PLAN_REVIEW_REQUIRED', 'PLAN_STALE', 'VERSION_CONFLICT', 'PLAN_WARNINGS_NOT_ACKNOWLEDGED', 'ROUTE_ALREADY_PUBLISHED']);

export function publishErrorAction(code: string | null | undefined): 'reload' | 'show' {
  return code && RELOAD_CODES.has(code) ? 'reload' : 'show';
}

// ───────────────────────────── screen state ─────────────────────────────

export interface ReviewFlow {
  phase: 'review' | 'publishing' | 'published';
  confirmedHash: string | null;
  /** Why the review was reloaded under the user (shown until they confirm again). */
  notice: 'stale' | null;
}

export type ReviewEvent =
  | { type: 'confirm'; hash: string; on: boolean }
  | { type: 'loaded'; hash: string }
  | { type: 'publish' }
  | { type: 'error'; code: string | null }
  | { type: 'success' }
  | { type: 'selection' };

export const initialReviewFlow: ReviewFlow = { phase: 'review', confirmedHash: null, notice: null };

export function reviewFlow(s: ReviewFlow, e: ReviewEvent): ReviewFlow {
  switch (e.type) {
    case 'confirm':
      return { ...s, confirmedHash: e.on ? e.hash : null, notice: e.on ? null : s.notice };
    case 'loaded':
      return s.confirmedHash !== null && s.confirmedHash !== e.hash ? { ...s, confirmedHash: null } : s;
    case 'selection':
      return { ...s, confirmedHash: null };
    case 'publish':
      return s.phase === 'review' && s.confirmedHash ? { ...s, phase: 'publishing' } : s;
    case 'error':
      return publishErrorAction(e.code) === 'reload' ? { phase: 'review', confirmedHash: null, notice: 'stale' } : { ...s, phase: 'review' };
    case 'success':
      return { phase: 'published', confirmedHash: null, notice: null };
  }
}

/** Unassigned reason of the review (`not_assigned`: left out by hand or never optimised). */
export function reviewUnassignedReason(code: string | null | undefined): string {
  return code === 'not_assigned' ? 'Left out by hand or not optimised yet' : unassignedReason(code);
}

/** Routes the user may select: not published, with stops. */
export function selectableRoutes<A extends { id: string; published?: boolean }>(plan: { assignments: readonly A[]; stops: readonly { assignmentId: string | null }[] }): A[] {
  return plan.assignments.filter((a) => !a.published && plan.stops.some((s) => s.assignmentId === a.id));
}

export const REVIEW_LOGIC_STRINGS = ['Left out by hand or not optimised yet'] as const;

import type { RoutePlanSkipReason, TransportDirection } from '@veetracer/shared';

/**
 * WP 3.9 (ad-hoc bookings in E4 drafts): which bookings of a plan's date / direction a new plan takes, and why the
 * others are left out. Pure: the caller loads the bookings (company, service date, direction, status in
 * PLAN_CANDIDATE_STATUSES, already filtered to the caller's visible branches — security delta D1) and the plan's shift
 * leg window, and gets either `null` (structurally plannable: location / consent are checked afterwards) or the
 * `ROUTE_PLAN_SKIP_REASONS` reason.
 *
 * Order of the checks (the first that applies is reported; the most structural reason first, so a REQUESTED booking at
 * another site says `other_site`, because approving it would not put it on this plan):
 *   point_to_point → other_site → other_shift / outside_shift_window → out_of_scope → needs_approval.
 * `needs_location` and `consent_required` follow in plan-create (they need the consent lookup).
 */

/** Statuses a plan create looks at: waiting for a seat, or waiting for approval (reported as needs_approval). */
export const PLAN_CANDIDATE_STATUSES = ['REQUESTED', 'WAITLISTED', 'PENDING_ASSIGNMENT'] as const;

export interface PlanScopeBooking {
  status: string;
  journey: 'COMMUTE' | 'POINT_TO_POINT';
  shiftId: string | null;
  pickupPoiId: string | null;
  dropPoiId: string | null;
  windowStart: Date;
  windowEnd: Date;
  /** The passenger profile's branch (null = company-wide). */
  branchId: string | null;
}

export interface PlanScope {
  direction: TransportDirection;
  sitePoiId: string;
  shiftId: string | null;
  /** The plan shift's leg window on the plan date (epoch ms; `legWindow` of service-dates); null without a shift. */
  shiftLeg: { start: number; end: number } | null;
  /** The plan's branch (null = whole company). */
  branchId: string | null;
}

/** True when [ws, we) and [start, end) share some time (touching ends do not count). */
export function windowsOverlap(ws: number, we: number, leg: { start: number; end: number }): boolean {
  return ws < leg.end && we > leg.start;
}

export function planSkipReason(b: PlanScopeBooking, p: PlanScope): RoutePlanSkipReason | null {
  if (b.journey === 'POINT_TO_POINT') return 'point_to_point';
  const officeEnd = p.direction === 'IN' ? b.dropPoiId : b.pickupPoiId;
  if (officeEnd !== p.sitePoiId) return 'other_site';
  if (p.shiftId) {
    if (b.shiftId && b.shiftId !== p.shiftId) return 'other_shift';
    if (!b.shiftId && (!p.shiftLeg || !windowsOverlap(b.windowStart.getTime(), b.windowEnd.getTime(), p.shiftLeg))) return 'outside_shift_window';
  }
  if (p.branchId && b.branchId && b.branchId !== p.branchId) return 'out_of_scope';
  if (b.status !== 'PENDING_ASSIGNMENT') return 'needs_approval';
  return null;
}

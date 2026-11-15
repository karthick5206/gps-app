import type { Prisma } from '@prisma/client';
import type { RoutePlanSkipReason, TransportDirection } from '@veetracer/shared';
import { PERSONAL_STOP_NAME } from '../dispatch/personal-points';
import { relS } from './plan-rules';

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
  /** Pooling: dispatcher hold and ride preference (absent = not held / shared). */
  holdFromPlanning?: boolean;
  ridePreference?: 'SHARED' | 'PRIVATE' | 'FLEXIBLE';
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
  // Pooling: a held booking is excluded from runs; a PRIVATE commute is never pooled by a site plan (P1).
  if (b.holdFromPlanning) return 'on_hold';
  if (b.ridePreference === 'PRIVATE') return 'private_ride';
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

/** The booking facts the plan stops of one booking are built from. */
export interface StopBooking {
  id: string;
  customerCompanyId: string;
  profileId: string;
  passengerCount: number;
  pickupPoiId: string | null;
  pickupLat: number | null;
  pickupLng: number | null;
  dropPoiId: string | null;
  dropLat: number | null;
  dropLng: number | null;
  windowStart: Date;
  windowEnd: Date;
}

/** The passenger's end of a booking (IN: pickup, OUT: drop): personal unless it is a company place. */
export function personalEnd(b: Pick<StopBooking, 'pickupPoiId' | 'pickupLat' | 'pickupLng' | 'dropPoiId' | 'dropLat' | 'dropLng'>, direction: TransportDirection): { poiId: string | null; lat: number | null; lng: number | null } {
  return direction === 'IN' ? { poiId: b.pickupPoiId, lat: b.pickupLat, lng: b.pickupLng } : { poiId: b.dropPoiId, lat: b.dropLat, lng: b.dropLng };
}

/**
 * Why a booking's passenger end cannot be planned (plan create and WP-B add-booking alike): no point (`needs_location`),
 * or a personal point without the passenger's active routing consent (`consent_required`); null when usable.
 */
export function endProblem(b: Parameters<typeof personalEnd>[0] & { profileId: string }, direction: TransportDirection, consents: ReadonlySet<string>): 'needs_location' | 'consent_required' | null {
  const end = personalEnd(b, direction);
  if (end.lat === null || end.lng === null) return 'needs_location';
  if (!end.poiId && !consents.has(b.profileId)) return 'consent_required';
  return null;
}

/**
 * The two unassigned plan stops of one booking (plan create, and WP-B add-booking): the passenger's end (the booking's
 * own point, consented at the source, or its company place; demand = seats; 60 s service) and the site end (the plan's
 * site, carrying the booking window in seconds after planStartAt). Refs `p-<booking>` / `d-<booking>`. `id` optional
 * (add-booking gives ids up front so the edit checks can see the new stops).
 */
export function bookingStopRows(
  b: StopBooking,
  plan: { id: string; companyId: string; direction: TransportDirection; startMs: number },
  site: { id: string; name: string; lat: number; lng: number },
  placeName: (poiId: string) => string | null,
  ids?: { passenger: string; site: string },
): [Prisma.RoutePlanStopCreateManyInput, Prisma.RoutePlanStopCreateManyInput] {
  const end = personalEnd(b, plan.direction);
  const IN = plan.direction === 'IN';
  // Unset columns spelled out (null), so every reader sees the same row as after a database round trip.
  const blank = { assignmentId: null, sequence: null, etaS: null, unassignedReason: null, snappedLat: null, snappedLng: null, snapDistanceM: null, snapGraphVersion: null };
  const passenger: Prisma.RoutePlanStopCreateManyInput = {
    ...blank,
    ...(ids ? { id: ids.passenger } : {}),
    planId: plan.id,
    companyId: plan.companyId,
    ref: `${IN ? 'p' : 'd'}-${b.id}`,
    name: end.poiId ? placeName(end.poiId) : PERSONAL_STOP_NAME[IN ? 'PICKUP' : 'DROP'],
    lat: end.lat!,
    lng: end.lng!,
    demand: b.passengerCount,
    serviceS: 60,
    stopKind: IN ? 'PICKUP' : 'DROP',
    customerCompanyId: b.customerCompanyId,
    bookingId: b.id,
    profileId: end.poiId ? null : b.profileId,
    poiId: end.poiId,
  };
  const atSite: Prisma.RoutePlanStopCreateManyInput = {
    ...blank,
    ...(ids ? { id: ids.site } : {}),
    planId: plan.id,
    companyId: plan.companyId,
    ref: `${IN ? 'd' : 'p'}-${b.id}`,
    name: site.name,
    lat: site.lat,
    lng: site.lng,
    demand: 0,
    serviceS: 0,
    timeWindows: [[relS(b.windowStart, plan.startMs), relS(b.windowEnd, plan.startMs)]],
    stopKind: IN ? 'DROP' : 'PICKUP',
    customerCompanyId: b.customerCompanyId,
    bookingId: b.id,
    profileId: null,
    poiId: site.id,
  };
  return [passenger, atSite];
}

// ───────────────────────────── Pooling C2: AREA plans (doc 20 §3.5) ─────────────────────────────

export interface AreaScope {
  windowStartMs: number;
  windowEndMs: number;
  /** The plan's branch (null = whole company). */
  branchId: string | null;
}

/**
 * Why an AREA plan leaves a booking out (POINT_TO_POINT and COMMUTE alike, PRIVATE included: the pickup-and-delivery
 * mode keeps a private ride alone on its trip): on_hold → outside_plan_window → out_of_scope → needs_approval.
 */
export function areaSkipReason(b: PlanScopeBooking, p: AreaScope): RoutePlanSkipReason | null {
  if (b.holdFromPlanning) return 'on_hold';
  if (!windowsOverlap(b.windowStart.getTime(), b.windowEnd.getTime(), { start: p.windowStartMs, end: p.windowEndMs })) return 'outside_plan_window';
  if (p.branchId && b.branchId && b.branchId !== p.branchId) return 'out_of_scope';
  if (b.status !== 'PENDING_ASSIGNMENT') return 'needs_approval';
  return null;
}

/** Both ends of an AREA booking must have a point, and a personal end needs the passenger's routing consent. */
export function areaEndsProblem(b: StopBooking, consents: ReadonlySet<string>): 'needs_location' | 'consent_required' | null {
  if (b.pickupLat === null || b.pickupLng === null || b.dropLat === null || b.dropLng === null) return 'needs_location';
  if ((!b.pickupPoiId || !b.dropPoiId) && !consents.has(b.profileId)) return 'consent_required';
  return null;
}

/**
 * The two plan stops of an AREA booking: pickup (demand = seats, the booking window as its time window) and drop, each
 * at the booking's own point (personal: owner + neutral name) or its company place. Refs `p-<booking>` / `d-<booking>`.
 */
export function areaStopRows(b: StopBooking, plan: { id: string; companyId: string; startMs: number }, placeName: (poiId: string) => string | null): [Prisma.RoutePlanStopCreateManyInput, Prisma.RoutePlanStopCreateManyInput] {
  const blank = { assignmentId: null, sequence: null, etaS: null, unassignedReason: null, snappedLat: null, snappedLng: null, snapDistanceM: null, snapGraphVersion: null, tripIndex: 0 };
  const row = (kind: 'PICKUP' | 'DROP'): Prisma.RoutePlanStopCreateManyInput => {
    const pickup = kind === 'PICKUP';
    const poiId = pickup ? b.pickupPoiId : b.dropPoiId;
    return {
      ...blank,
      planId: plan.id,
      companyId: plan.companyId,
      ref: `${pickup ? 'p' : 'd'}-${b.id}`,
      name: poiId ? placeName(poiId) : PERSONAL_STOP_NAME[kind],
      lat: (pickup ? b.pickupLat : b.dropLat)!,
      lng: (pickup ? b.pickupLng : b.dropLng)!,
      demand: pickup ? b.passengerCount : 0,
      serviceS: 60,
      ...(pickup ? { timeWindows: [[relS(b.windowStart, plan.startMs), relS(b.windowEnd, plan.startMs)]] } : {}),
      stopKind: kind,
      customerCompanyId: b.customerCompanyId,
      bookingId: b.id,
      profileId: poiId ? null : b.profileId,
      poiId,
    };
  };
  return [row('PICKUP'), row('DROP')];
}

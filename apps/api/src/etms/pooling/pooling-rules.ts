import {
  DEFAULT_SHARING_LIMITS,
  SHARING_LIMIT_BOUNDS,
  type BookingPoolingInput,
  type DispatchChangeOpKind,
  type PlannedTripStatus,
  type RidePreference,
  type RideService,
  type SharingLimits,
} from '@veetracer/shared';

/**
 * Pure pooling rules (doc 20 §3.1, §5.2; owner defaults P1–P5). No I/O: the booking service, the publish transaction
 * (DispatchService.apply), the planner and live dispatch all call these, so every path answers the same.
 */

// ───────────────────────────── ride-mode eligibility (P1) ─────────────────────────────

/** A booking may share its trip with others only when it is not PRIVATE. */
export function poolable(pref: RidePreference): boolean {
  return pref !== 'PRIVATE';
}

/**
 * Can a booking with `pref` join a trip whose active passengers have `onTrip` preferences? P1 (whole-trip exclusivity):
 * a trip carrying a PRIVATE passenger takes nobody else, and a PRIVATE booking only goes onto an empty trip.
 * Returns the refusal reason, or null.
 */
export function joinProblem(pref: RidePreference, onTrip: readonly RidePreference[]): 'PRIVATE_TRIP' | 'PRIVATE_NEEDS_EMPTY_VEHICLE' | null {
  if (onTrip.includes('PRIVATE')) return 'PRIVATE_TRIP';
  if (pref === 'PRIVATE' && onTrip.length > 0) return 'PRIVATE_NEEDS_EMPTY_VEHICLE';
  return null;
}

/**
 * The publish-time re-check of P1 over a trip's active passengers (one row per seat; several seats of one booking count
 * once): a PRIVATE booking's party must be alone on its trip. A party is the booking itself, or the group it was booked
 * with (`groupId`, WP 3.9 group booking: colleagues travelling together are one party). Returns the offending booking
 * id, or null.
 */
export function privateExclusivityProblem(passengers: readonly { bookingId: string; ridePreference: RidePreference; groupId?: string | null }[]): string | null {
  const parties = new Set(passengers.map((p) => p.groupId ?? p.bookingId));
  if (parties.size <= 1) return null;
  return passengers.find((p) => p.ridePreference === 'PRIVATE')?.bookingId ?? null;
}

/** Number of parties (bookings, a group counting once) among a trip's active passengers. */
export function partyCount(passengers: readonly { bookingId: string; groupId?: string | null }[]): number {
  return new Set(passengers.map((p) => p.groupId ?? p.bookingId)).size;
}

/** How a seated booking is served: PRIVATE when it asked for it or rides alone on its trip, else SHARED. */
export function servedAs(pref: RidePreference, bookingsOnTrip: number): RideService {
  return pref === 'PRIVATE' || bookingsOnTrip <= 1 ? 'PRIVATE' : 'SHARED';
}

/** P3 / API default when a request names no preference: commute rides are pooled, point-to-point rides private. */
export function defaultPreference(journey: 'COMMUTE' | 'POINT_TO_POINT'): RidePreference {
  return journey === 'COMMUTE' ? 'SHARED' : 'PRIVATE';
}

/** Does this preference need an accepted policy version? SHARED / FLEXIBLE point-to-point rides do (commute is pooled by definition). */
export function needsAcceptance(pref: RidePreference, journey: 'COMMUTE' | 'POINT_TO_POINT'): boolean {
  return journey === 'POINT_TO_POINT' && pref !== 'PRIVATE';
}

// ───────────────────────────── limits snapshot (B1, P2) ─────────────────────────────

export class LimitsError extends Error {
  constructor(
    readonly code: 'LIMITS_ABOVE_POLICY' | 'LIMITS_INVALID',
    message: string,
  ) {
    super(message);
  }
}

const between = (v: number, b: { min: number; max: number }) => Number.isFinite(v) && v >= b.min && v <= b.max;

/** Shape / bounds of a SharingLimits (policy or snapshot). Throws LIMITS_INVALID. */
export function validateLimits(l: SharingLimits, what = 'limits'): SharingLimits {
  if (!l || typeof l !== 'object') throw new LimitsError('LIMITS_INVALID', `${what} are missing`);
  if (!Number.isInteger(l.maxWaitS) || !between(l.maxWaitS, SHARING_LIMIT_BOUNDS.maxWaitS)) throw new LimitsError('LIMITS_INVALID', `${what}: maxWaitS must be ${SHARING_LIMIT_BOUNDS.maxWaitS.min}–${SHARING_LIMIT_BOUNDS.maxWaitS.max} s`);
  if (!l.maxDetour || !between(l.maxDetour.ratio, SHARING_LIMIT_BOUNDS.ratio)) throw new LimitsError('LIMITS_INVALID', `${what}: maxDetour.ratio must be ${SHARING_LIMIT_BOUNDS.ratio.min}–${SHARING_LIMIT_BOUNDS.ratio.max}`);
  if (!Number.isInteger(l.maxDetour.extraS) || !between(l.maxDetour.extraS, SHARING_LIMIT_BOUNDS.extraS)) throw new LimitsError('LIMITS_INVALID', `${what}: maxDetour.extraS must be ${SHARING_LIMIT_BOUNDS.extraS.min}–${SHARING_LIMIT_BOUNDS.extraS.max} s`);
  if (l.maxRideS !== null && (!Number.isInteger(l.maxRideS) || !between(l.maxRideS, SHARING_LIMIT_BOUNDS.maxRideS))) throw new LimitsError('LIMITS_INVALID', `${what}: maxRideS must be ${SHARING_LIMIT_BOUNDS.maxRideS.min}–${SHARING_LIMIT_BOUNDS.maxRideS.max} s or null`);
  return { maxWaitS: l.maxWaitS, maxDetour: { ratio: l.maxDetour.ratio, extraS: l.maxDetour.extraS }, maxRideS: l.maxRideS ?? null, ...(l.arriveByS !== undefined && l.arriveByS !== null ? { arriveByS: l.arriveByS } : {}) };
}

/** A PRIVATE ride has no detour (nobody else rides): its snapshot keeps the wait and ride limits only. */
const PRIVATE_DETOUR = { ratio: 1, extraS: 0 };

/**
 * The limits snapshot a booking takes at acceptance: the policy's limits for its preference (PRIVATE: the SHARED wait
 * and ride limits without a detour), capped by the company max ride, then tightened by what the passenger asked for.
 * A requested value looser than the policy is refused (LIMITS_ABOVE_POLICY), never silently clamped.
 */
export function limitsSnapshot(pref: RidePreference, policy: { SHARED: SharingLimits; FLEXIBLE: SharingLimits }, requested: BookingPoolingInput['limits'] | undefined, companyMaxRideS: number | null): SharingLimits {
  const base = pref === 'FLEXIBLE' ? policy.FLEXIBLE : policy.SHARED;
  const cap = (a: number | null, b: number | null) => (a === null ? b : b === null ? a : Math.min(a, b));
  let out: SharingLimits = {
    maxWaitS: base.maxWaitS,
    maxDetour: pref === 'PRIVATE' ? { ...PRIVATE_DETOUR } : { ...base.maxDetour },
    maxRideS: cap(base.maxRideS, companyMaxRideS),
  };
  if (requested) {
    const above = (what: string) => new LimitsError('LIMITS_ABOVE_POLICY', `The requested ${what} is above the sharing policy; it can only be tightened`);
    if (requested.maxWaitS !== undefined) {
      if (requested.maxWaitS > out.maxWaitS) throw above('maximum wait');
      out = { ...out, maxWaitS: requested.maxWaitS };
    }
    if (requested.maxRideS !== undefined && requested.maxRideS !== null) {
      if (out.maxRideS !== null && requested.maxRideS > out.maxRideS) throw above('maximum ride time');
      out = { ...out, maxRideS: requested.maxRideS };
    }
    if (requested.maxDetour && pref !== 'PRIVATE') {
      const d = { ...out.maxDetour };
      if (requested.maxDetour.ratio !== undefined) {
        if (requested.maxDetour.ratio > d.ratio) throw above('detour ratio');
        d.ratio = requested.maxDetour.ratio;
      }
      if (requested.maxDetour.extraS !== undefined) {
        if (requested.maxDetour.extraS > d.extraS) throw above('extra detour time');
        d.extraS = requested.maxDetour.extraS;
      }
      out = { ...out, maxDetour: d };
    }
  }
  return validateLimits(out);
}

/** Stored JSON → SharingLimits (null when absent / malformed: the company policy applies, as for pre-pooling rows). */
export function limitsOf(json: unknown): SharingLimits | null {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  try {
    return validateLimits(json as SharingLimits);
  } catch {
    return null;
  }
}

/** Two snapshots are the same (key order and float noise ignored). */
export function sameLimits(a: SharingLimits | null, b: SharingLimits | null): boolean {
  if (a === null || b === null) return a === b;
  return a.maxWaitS === b.maxWaitS && a.maxRideS === b.maxRideS && Math.abs(a.maxDetour.ratio - b.maxDetour.ratio) < 1e-9 && a.maxDetour.extraS === b.maxDetour.extraS && (a.arriveByS ?? null) === (b.arriveByS ?? null);
}

/**
 * The app-level immutability guard (the DB trigger TransportBooking_limits_immutable is the backstop): once a snapshot
 * exists on an active booking, its preference, limits and accepted version cannot change. Returns a message, or null.
 */
export function limitsChangeProblem(before: { limits: SharingLimits | null; ridePreference: RidePreference; sharingPolicyVersion: number | null; active: boolean }, after: { limits?: SharingLimits | null; ridePreference?: RidePreference; sharingPolicyVersion?: number | null }): string | null {
  if (!before.active || before.limits === null) return null;
  if (after.limits !== undefined && !sameLimits(before.limits, after.limits)) return 'The accepted sharing limits cannot change';
  if (after.ridePreference !== undefined && after.ridePreference !== before.ridePreference) return 'The ride preference cannot change after the sharing limits were accepted';
  if (after.sharingPolicyVersion !== undefined && after.sharingPolicyVersion !== before.sharingPolicyVersion) return 'The accepted policy version cannot change';
  return null;
}

/** Pickup window of a booking under its limits (epoch ms): [windowStart, min(windowEnd, windowStart + maxWait)]. */
export function pickupWindow(windowStartMs: number, windowEndMs: number, limits: SharingLimits | null): [number, number] {
  const wait = (limits ?? DEFAULT_SHARING_LIMITS).maxWaitS * 1000;
  return [windowStartMs, Math.max(windowStartMs, Math.min(windowEndMs, windowStartMs + wait))];
}

/** Longest ride allowed (s) for a direct ride of `directS`: min(own max ride, company max ride, max(direct × ratio, direct + extra)). */
export function maxRideFor(directS: number, limits: SharingLimits | null, companyMaxRideS: number | null): number {
  const l = limits ?? DEFAULT_SHARING_LIMITS;
  const detour = Math.max(directS * l.maxDetour.ratio, directS + l.maxDetour.extraS);
  return Math.floor(Math.min(detour, l.maxRideS ?? Infinity, companyMaxRideS ?? Infinity));
}

// ───────────────────────────── commitment protection per trip state (§5.2, P4, P5) ─────────────────────────────

/** Ops a live change may make to a started trip (P5: pending stops only). */
export const LIVE_ACTIVE_OPS: ReadonlySet<DispatchChangeOpKind> = new Set<DispatchChangeOpKind>(['ADD_PASSENGER', 'ADD_STOP', 'REMOVE_PASSENGER']);

export type TripChangeClass = 'FREE' | 'SCHEDULED' | 'ACTIVE' | 'CLOSED';

/** §5.2 rows: unpublished plan (FREE), published not started (SCHEDULED), started (ACTIVE), finished (CLOSED). */
export function tripChangeClass(status: PlannedTripStatus | 'UNPUBLISHED'): TripChangeClass {
  if (status === 'UNPUBLISHED') return 'FREE';
  if (status === 'SCHEDULED') return 'SCHEDULED';
  if (status === 'STARTED' || status === 'IN_PROGRESS') return 'ACTIVE';
  return 'CLOSED';
}

/**
 * May `op` change a trip in `status`, and may it be applied without a dispatcher (P4)? SCHEDULED: any op, automatic
 * within limits. ACTIVE: only LIVE_ACTIVE_OPS, and only through the dispatcher (proposal). CLOSED: never.
 */
export function liveChangeAllowed(status: PlannedTripStatus | 'UNPUBLISHED', op: DispatchChangeOpKind): { allowed: boolean; auto: boolean } {
  const c = tripChangeClass(status);
  if (c === 'FREE' || c === 'SCHEDULED') return { allowed: true, auto: true };
  if (c === 'ACTIVE') return { allowed: LIVE_ACTIVE_OPS.has(op), auto: false };
  return { allowed: false, auto: false };
}

/** Highest seq of a stop already visited (ARRIVED / DEPARTED / SKIPPED), -1 when none. Visited stops are immutable. */
export function lastVisitedSeq(stops: readonly { seq: number; status: string }[]): number {
  return stops.reduce((m, s) => (s.status !== 'PENDING' && s.seq > m ? s.seq : m), -1);
}

/**
 * P5 on a started trip: a stop may only be inserted after the last visited stop (`afterSeq` ≥ lastVisited), and a
 * passenger may only be seated at stops not yet visited. Returns a message, or null.
 */
export function activeEditProblem(stops: readonly { seq: number; status: string }[], change: { kind: 'ADD_STOP'; afterSeq: number } | { kind: 'ADD_PASSENGER'; pickupSeq: number; dropSeq: number }): string | null {
  const visited = lastVisitedSeq(stops);
  if (change.kind === 'ADD_STOP') return change.afterSeq < visited ? 'A stop can only be added after the stops the vehicle has already visited' : null;
  return change.pickupSeq <= visited ? 'The passenger can only be picked up at a stop the vehicle has not visited yet' : null;
}

/**
 * Re-check of a live change from the vehicle's position (P5): every pending stop keeps its planned arrival, so the
 * check is that the vehicle can still make the first pending stop in time when a stop is inserted right after its
 * position. `travelS` = road / estimated seconds from the live position to the first pending stop after the change.
 */
export function reachableFromPosition(nowMs: number, travelS: number, firstPendingArrivalMs: number, slackS = 0): boolean {
  return nowMs + travelS * 1000 <= firstPendingArrivalMs + slackS * 1000;
}

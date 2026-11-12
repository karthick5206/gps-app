/**
 * SOS context that must survive an offline cold start (r114, QA B4; doc 08 §6.1, doc 09 §7.3, doc 10 §6). Pure
 * TypeScript (`node --test`, sos-context.test.ts): the app stores it in SecureStore through sos-store.ts.
 *
 * - The "current trip" an SOS is attached to: worked out from the trip lists the screens already load, kept with an
 *   expiry so a stale trip is never attached the next day. A missing or wrong trip id never blocks an SOS (the server
 *   records it unlinked, `tripLinked: false`), so this is a best effort, never a condition.
 * - The desk / dispatcher phone for the call buttons, so they work with no network.
 * - The offline identity: which SOS sections the last signed-in user had (passenger / driver). With it, an offline cold
 *   start (refresh token kept, server unreachable) opens the offline SOS screen instead of the sign-in screen.
 *
 * No location is stored or sent: the app has no location module (expo-location needs a native build, not approved).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PHONE = /^[0-9+][0-9+ ()-]{2,24}$/;
const USER_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** A trip is "current" from this long before its start … */
export const SOS_TRIP_BEFORE_MS = 30 * 60_000;
/** … until this long after its planned end (late trips run over). */
export const SOS_TRIP_AFTER_MS = 60 * 60_000;

/** Running states (the vehicle is on the road). */
const RUNNING = ['EN_ROUTE', 'AT_STOP', 'IN_PROGRESS'];
/** Finished states: never attached. */
const FINISHED = ['COMPLETED', 'INCOMPLETE', 'CANCELLED', 'DETACHED'];

export interface SosContext {
  /** Trip to attach (TransportTrip id for the passenger route, PlannedTrip / trip id for the driver route). */
  tripId: string | null;
  /** Attach `tripId` only until this time (ms). */
  until: number | null;
  /** Desk (passenger) or dispatcher (driver) phone for the call buttons. */
  deskPhone: string | null;
}

export const EMPTY_SOS_CONTEXT: SosContext = { tripId: null, until: null, deskPhone: null };

interface TripLike {
  id: string;
  start: string | null | undefined;
  end: string | null | undefined;
  derivedState: string;
}

/** The trip to attach now: a running one first, else the one whose window (start − 30 min … end + 60 min) holds now. */
export function currentTrip(trips: readonly TripLike[], nowMs: number): { tripId: string; until: number } | null {
  const candidates = trips
    .filter((t) => UUID.test(t.id) && !FINISHED.includes(t.derivedState))
    .map((t) => {
      const start = t.start ? Date.parse(t.start) : NaN;
      const end = t.end ? Date.parse(t.end) : NaN;
      return { t, start, end };
    })
    .filter(({ t, start, end }) => {
      if (RUNNING.includes(t.derivedState)) return true;
      return Number.isFinite(start) && Number.isFinite(end) && nowMs >= start - SOS_TRIP_BEFORE_MS && nowMs <= end + SOS_TRIP_AFTER_MS;
    })
    .sort((a, b) => Number(RUNNING.includes(b.t.derivedState)) - Number(RUNNING.includes(a.t.derivedState)) || (a.start || 0) - (b.start || 0));
  const hit = candidates[0];
  if (!hit) return null;
  const until = Number.isFinite(hit.end) ? hit.end + SOS_TRIP_AFTER_MS : nowMs + SOS_TRIP_AFTER_MS;
  return { tripId: hit.t.id.toLowerCase(), until: Math.max(until, nowMs + 5 * 60_000) };
}

/** Passenger trips (MeTripDto shape). */
export function passengerCurrentTrip(trips: readonly { id: string; window: { start: string; end: string }; plannedStart?: string | null; plannedEnd?: string | null; derivedState: string }[], nowMs: number) {
  return currentTrip(
    trips.map((t) => ({ id: t.id, start: t.plannedStart ?? t.window.start, end: t.plannedEnd ?? t.window.end, derivedState: t.derivedState })),
    nowMs,
  );
}

/** Driver trips (DriverTripSummaryDto shape). */
export function driverCurrentTrip(trips: readonly { id: string; plannedStart: string; plannedEnd: string; derivedState: string }[], nowMs: number) {
  return currentTrip(
    trips.map((t) => ({ id: t.id, start: t.plannedStart, end: t.plannedEnd, derivedState: t.derivedState })),
    nowMs,
  );
}

/** The trip id to send with an SOS raised now, or null (unknown / expired). */
export function sosTripIdAt(ctx: Pick<SosContext, 'tripId' | 'until'> | null | undefined, nowMs: number): string | null {
  if (!ctx?.tripId || ctx.until === null || ctx.until === undefined) return null;
  return nowMs <= ctx.until ? ctx.tripId : null;
}

export function cleanPhone(raw: unknown): string | null {
  return typeof raw === 'string' && PHONE.test(raw.trim()) ? raw.trim() : null;
}

/** Validates a stored context (a damaged or tampered row is ignored, never trusted into an API body). */
export function parseSosContext(raw: string | null | undefined): SosContext {
  if (!raw) return EMPTY_SOS_CONTEXT;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    const tripId = typeof v.tripId === 'string' && UUID.test(v.tripId) ? v.tripId.toLowerCase() : null;
    const until = typeof v.until === 'number' && Number.isFinite(v.until) ? v.until : null;
    return { tripId: tripId && until !== null ? tripId : null, until: tripId ? until : null, deskPhone: cleanPhone(v.deskPhone) };
  } catch {
    return EMPTY_SOS_CONTEXT;
  }
}

/** Merges a partial update; returns null when nothing changes (no keystore write). */
export function mergeSosContext(prev: SosContext, patch: Partial<SosContext>): SosContext | null {
  const next: SosContext = {
    tripId: patch.tripId !== undefined ? patch.tripId : prev.tripId,
    until: patch.until !== undefined ? patch.until : prev.until,
    deskPhone: patch.deskPhone !== undefined ? cleanPhone(patch.deskPhone) : prev.deskPhone,
  };
  if (!next.tripId) next.until = null;
  return next.tripId === prev.tripId && next.until === prev.until && next.deskPhone === prev.deskPhone ? null : next;
}

// ───────────────────────────── Offline identity ─────────────────────────────

export interface OfflineIdentity {
  userId: string;
  passenger: boolean;
  driver: boolean;
}

export function parseOfflineIdentity(raw: string | null | undefined): OfflineIdentity | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (typeof v.userId !== 'string' || !USER_ID.test(v.userId)) return null;
    const passenger = v.passenger === true;
    const driver = v.driver === true;
    return passenger || driver ? { userId: v.userId, passenger, driver } : null;
  } catch {
    return null;
  }
}

/** Which identity to keep for an offline start (null = none: the user has no SOS section). */
export function offlineIdentityFor(userId: string | null | undefined, roles: { passenger: boolean; driver: boolean } | null | undefined): OfflineIdentity | null {
  if (!userId || !USER_ID.test(userId) || !roles || (!roles.passenger && !roles.driver)) return null;
  return { userId, passenger: roles.passenger, driver: roles.driver };
}

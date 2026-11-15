/**
 * AREA plans and several trips per vehicle (doc 20 §3.5–3.6, pure, `node --test`): the AREA create request, the
 * grouping of a vehicle route's stops into its trips (RoutePlanStop.tripIndex: the load returns to 0 between trips;
 * each trip is published as its own trip) and the trip split shown before publishing. No React, DOM or path aliases.
 */
import type { LatLng, RidePreference } from '@veetracer/shared';

/** The stop fields the grouping needs (RoutePlanStopViewDto has them; tripIndex is absent on SITE plans). */
export interface TripStop {
  id: string;
  assignmentId: string | null;
  tripIndex?: number;
  stopKind?: 'PICKUP' | 'DROP' | null;
  bookingId?: string | null;
  plannedArrival?: string | null;
}

export interface TripGroup<S extends TripStop> {
  /** 0-based trip slot of the vehicle route. */
  tripIndex: number;
  /** The stops of this trip with their index in the whole route (move up / down work on the route order). */
  stops: { stop: S; index: number }[];
  pickups: number;
  drops: number;
  firstArrival: string | null;
  lastArrival: string | null;
}

/**
 * The route's stops (already in route order) grouped by trip. A route without tripIndex (SITE plans, older servers) is
 * one group with index 0. Trip groups keep the route order; a stop without an index joins the trip before it.
 */
export function groupStopsByTrip<S extends TripStop>(stops: readonly S[]): TripGroup<S>[] {
  const out: TripGroup<S>[] = [];
  let current: TripGroup<S> | null = null;
  stops.forEach((stop, index) => {
    const ti = typeof stop.tripIndex === 'number' ? stop.tripIndex : (current?.tripIndex ?? 0);
    if (!current || current.tripIndex !== ti) {
      current = { tripIndex: ti, stops: [], pickups: 0, drops: 0, firstArrival: null, lastArrival: null };
      out.push(current);
    }
    current.stops.push({ stop, index });
    if (stop.stopKind === 'PICKUP') current.pickups++;
    if (stop.stopKind === 'DROP') current.drops++;
    if (stop.plannedArrival) {
      current.firstArrival ??= stop.plannedArrival;
      current.lastArrival = stop.plannedArrival;
    }
  });
  return out;
}

/** True when any route of the plan holds more than one trip (the screens then show the trip headers). */
export function hasTripSplit(stops: readonly TripStop[]): boolean {
  const per = new Map<string, Set<number>>();
  for (const s of stops) {
    if (!s.assignmentId || typeof s.tripIndex !== 'number') continue;
    const set = per.get(s.assignmentId) ?? new Set<number>();
    set.add(s.tripIndex);
    per.set(s.assignmentId, set);
  }
  return [...per.values()].some((s) => s.size > 1);
}

/** Trips each selected route becomes at publish (one per distinct trip index; a route with stops and no index = 1). */
export function tripSplit(stops: readonly TripStop[], assignmentIds: readonly string[]): { assignmentId: string; trips: number }[] {
  return assignmentIds.map((id) => {
    const mine = stops.filter((s) => s.assignmentId === id);
    if (!mine.length) return { assignmentId: id, trips: 0 };
    const idx = new Set(mine.map((s) => (typeof s.tripIndex === 'number' ? s.tripIndex : 0)));
    return { assignmentId: id, trips: idx.size };
  });
}

/**
 * Private rides of a plan: a booking id → its preference map from the bookings list (the plan stop view does not carry
 * the preference). Returns the booking ids of PRIVATE rides.
 */
export function privateBookingIds(prefs: ReadonlyMap<string, RidePreference | undefined>): Set<string> {
  const out = new Set<string>();
  for (const [id, p] of prefs) if (p === 'PRIVATE') out.add(id);
  return out;
}

// ───────────────────────────── AREA plan create ─────────────────────────────

export interface AreaPlanDraft {
  day: string;
  /** Wall times "HH:mm" in the company zone; an end before the start is the next day. */
  startTime: string;
  endTime: string;
  depot: { id: string; name: string; lat: number; lng: number } | null;
  vehicleIds: string[];
  name: string;
}

export interface AreaPlanRequest {
  name: string;
  planDate: string;
  scope: 'AREA';
  windowStart: string;
  windowEnd: string;
  depot: LatLng;
  objectIds: string[];
  branchId?: string;
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DAY_MS = 24 * 3600 * 1000;

/**
 * POST /transport/route-plans with scope AREA: window ≤ 24 h (an end at or before the start is the next day), a depot
 * (a company place: the server matches it to one and refuses other points), at least one vehicle with seats.
 * `fromWall` turns "YYYY-MM-DDTHH:mm" in the company zone into an instant.
 */
export function areaPlanRequest(d: AreaPlanDraft, fromWall: (wall: string) => number, branchId: string | null, t: (k: string, v?: Record<string, unknown>) => string = (k) => k): { ok: true; value: AreaPlanRequest } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.day)) errors.push(t('Choose the service date.'));
  if (!HHMM.test(d.startTime) || !HHMM.test(d.endTime)) errors.push(t('Enter the operating window (start and end).'));
  if (!d.depot) errors.push(t('Choose the depot (a company place): the vehicles start there.'));
  if (!d.vehicleIds.length) errors.push(t('Choose at least one vehicle.'));
  let ws = Number.NaN;
  let we = Number.NaN;
  if (!errors.length) {
    ws = fromWall(`${d.day}T${d.startTime}`);
    we = fromWall(`${d.day}T${d.endTime}`);
    if (!Number.isFinite(ws) || !Number.isFinite(we)) errors.push(t('Enter the operating window (start and end).'));
    else if (we <= ws) we += DAY_MS;
    if (we - ws > DAY_MS) errors.push(t('The operating window is at most 24 hours.'));
  }
  if (errors.length || !d.depot) return { ok: false, errors };
  return {
    ok: true,
    value: {
      name: d.name.trim() || t('Area plan {{day}} {{from}}–{{to}}', { day: d.day, from: d.startTime, to: d.endTime }),
      planDate: d.day,
      scope: 'AREA',
      windowStart: new Date(ws).toISOString(),
      windowEnd: new Date(we).toISOString(),
      depot: { lat: d.depot.lat, lng: d.depot.lng },
      objectIds: [...d.vehicleIds],
      ...(branchId ? { branchId } : {}),
    },
  };
}

/**
 * Seats a pickup-and-delivery route needs at its fullest (AREA plans): + seats at each pickup, − at each drop, the
 * maximum along the route order (a vehicle route of several trips never needs the sum of all its passengers).
 */
export function peakLoad(stops: readonly { stopKind?: 'PICKUP' | 'DROP' | null; seats?: number; demand?: number }[]): number {
  let load = 0;
  let peak = 0;
  for (const s of stops) {
    const n = Math.max(0, (s.seats ?? s.demand ?? 0) || 0);
    if (s.stopKind === 'PICKUP') load += n;
    else if (s.stopKind === 'DROP') load = Math.max(0, load - n);
    peak = Math.max(peak, load);
  }
  return peak;
}

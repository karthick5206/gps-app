import {
  publishWarningsFingerprint,
  ROUTE_LIMITS,
  ROUTE_PLAN_HARD_KINDS,
  ROUTE_PLAN_OVERRIDABLE_KINDS,
  TRANSPORT_E3_LIMITS,
  type DispatchChangeOp,
  type DispatchChangeSetInput,
  type DispatchStopInput,
  type RoutePlanMetricsDto,
  type RoutePlanPublishIssue,
  type RoutePlanRouteError,
  type RoutePlanStatus,
  type RoutePlanStopViolation,
  type TransportDirection,
} from '@veetracer/shared';

/**
 * Pure rules of the route plans API (doc 17 §7 P9): route checks (capacity, time windows, pickup-before-drop), re-timing
 * along road legs, compare metrics, and the plan → E3 change set mapping that publish hands to the E3 publish path.
 * No database, no engine: unit-tested in plan-rules.spec.ts.
 */

const MIN = 60_000;

export type Window = [number, number];

/** A plan stop as the rules need it (RoutePlanStop columns + the booking's seats). */
export interface RuleStop {
  id: string;
  ref: string;
  assignmentId: string | null;
  sequence: number | null;
  etaS: number | null;
  serviceS: number;
  demand: number;
  timeWindows: Window[] | null;
  stopKind: 'PICKUP' | 'DROP' | null;
  bookingId: string | null;
  profileId: string | null;
  poiId: string | null;
  lat: number;
  lng: number;
  name: string | null;
}

export const windowsOf = (json: unknown): Window[] | null => {
  if (!Array.isArray(json)) return null;
  const out = json.filter((w): w is Window => Array.isArray(w) && w.length === 2 && w.every((x) => typeof x === 'number' && Number.isFinite(x)));
  return out.length ? out : null;
};

/** Stops of one route in their order. */
export function routeStops<T extends Pick<RuleStop, 'assignmentId' | 'sequence' | 'ref'>>(stops: T[], assignmentId: string): T[] {
  return stops.filter((s) => s.assignmentId === assignmentId).sort((a, b) => (a.sequence ?? 1e9) - (b.sequence ?? 1e9) || a.ref.localeCompare(b.ref));
}

/** Seats a stop takes when boarded: the booking's passengerCount for a pickup, the demand for a generic stop, else 0. */
export function seatsOf(s: Pick<RuleStop, 'stopKind' | 'bookingId' | 'demand'>, passengerCount: (bookingId: string) => number | undefined): number {
  if (s.bookingId) return s.stopKind === 'PICKUP' ? (passengerCount(s.bookingId) ?? Math.max(1, s.demand)) : 0;
  return Math.max(0, s.demand);
}

/**
 * Time-window check of an ordered route against its ETAs (seconds after planStartAt): `late` when the ETA is after
 * every window, `early_wait` when the vehicle waits for a window to open, `unreachable` when the ETA could not be
 * computed after a re-time (`unreachable` is only reported when `nullIsUnreachable`).
 */
export function windowViolations(stops: Pick<RuleStop, 'id' | 'ref' | 'etaS' | 'timeWindows'>[], nullIsUnreachable = false): RoutePlanStopViolation[] {
  const out: RoutePlanStopViolation[] = [];
  for (const s of stops) {
    if (s.etaS === null) {
      if (nullIsUnreachable) out.push({ stopId: s.id, ref: s.ref, kind: 'unreachable', etaS: null, window: null });
      continue;
    }
    const wins = [...(s.timeWindows ?? [])].sort((a, b) => a[0] - b[0]);
    if (!wins.length) continue;
    const open = wins.find((w) => s.etaS! <= w[1]);
    if (!open) out.push({ stopId: s.id, ref: s.ref, kind: 'late', etaS: s.etaS, window: wins[wins.length - 1] });
    else if (s.etaS < open[0]) out.push({ stopId: s.id, ref: s.ref, kind: 'early_wait', etaS: s.etaS, window: open });
  }
  return out;
}

/**
 * Capacity check with the E3 publish rule: a trip's seats never free up (TransportTrip.occupiedSeats counts every seat
 * assigned), so the first pickup that takes the booked seats above the vehicle's seats is `over_capacity`.
 * `capacity` null = unknown / unlimited (no check here; publish refuses a vehicle without seats).
 */
export function capacityViolations(stops: Pick<RuleStop, 'id' | 'ref' | 'etaS' | 'stopKind' | 'bookingId' | 'demand'>[], capacity: number | null, passengerCount: (bookingId: string) => number | undefined): RoutePlanStopViolation[] {
  if (capacity === null) return [];
  let seats = 0;
  for (const s of stops) {
    seats += seatsOf(s, passengerCount);
    if (seats > capacity) return [{ stopId: s.id, ref: s.ref, kind: 'over_capacity', etaS: s.etaS, window: null }];
  }
  return [];
}

/** All checks of one route (in order). */
export function routeViolations(stops: RuleStop[], capacity: number | null, passengerCount: (bookingId: string) => number | undefined, nullIsUnreachable = false): RoutePlanStopViolation[] {
  return [...capacityViolations(stops, capacity, passengerCount), ...windowViolations(stops, nullIsUnreachable)];
}

/**
 * Structural rule of every edit: both ends of a booking on the same route (or both unassigned), pickup before drop.
 * Returns a message for the first broken booking, or null.
 */
export function pairProblem(stops: Pick<RuleStop, 'bookingId' | 'stopKind' | 'assignmentId' | 'sequence' | 'ref'>[]): string | null {
  const ends = new Map<string, { pickup?: (typeof stops)[number]; drop?: (typeof stops)[number] }>();
  for (const s of stops) {
    if (!s.bookingId || !s.stopKind) continue;
    const e = ends.get(s.bookingId) ?? {};
    if (s.stopKind === 'PICKUP') e.pickup = s;
    else e.drop = s;
    ends.set(s.bookingId, e);
  }
  for (const [bookingId, { pickup, drop }] of ends) {
    if (!pickup || !drop) continue;
    if ((pickup.assignmentId ?? null) !== (drop.assignmentId ?? null)) return `The pickup and drop of booking ${bookingId} must be on the same route`;
    if (pickup.assignmentId && (pickup.sequence ?? 0) >= (drop.sequence ?? 0)) return `The pickup of booking ${bookingId} must come before its drop`;
  }
  return null;
}

/**
 * ETAs along an ordered route from road legs (travel seconds) and service times, waiting for a window to open.
 * `legsS[i]` is the leg INTO stop i (legsS[0] from the route start); null = no road number → this and every later ETA
 * is null (never estimated). `endS` adds the last leg when given (return to the depot).
 */
export function retime(startS: number, legsS: (number | null)[], stops: Pick<RuleStop, 'serviceS' | 'timeWindows'>[], lastLegS: number | null | undefined = 0): { etas: (number | null)[]; endS: number | null } {
  const etas: (number | null)[] = [];
  let t: number | null = startS;
  stops.forEach((s, i) => {
    const leg = legsS[i];
    if (t === null || leg === null || leg === undefined) {
      t = null;
      etas.push(null);
      return;
    }
    let arrive: number = t + leg;
    const wins = [...(s.timeWindows ?? [])].sort((a, b) => a[0] - b[0]);
    const open = wins.find((w) => arrive <= w[1]);
    if (open && arrive < open[0]) arrive = open[0];
    etas.push(Math.round(arrive));
    t = arrive + s.serviceS;
  });
  const endS = t === null || lastLegS === null || lastLegS === undefined ? null : Math.round((t as number) + lastLegS);
  return { etas, endS };
}

// ───────────────────────────── compare ─────────────────────────────

export interface MetricsPlan {
  id: string;
  name: string;
  planDate: Date;
  status: RoutePlanStatus;
  version: number;
  graphVersion: string | null;
  assignments: { id: string; objectId: string | null; capacity: number | null; distanceM: number | null; durationS: number | null }[];
  stops: RuleStop[];
}

/** Compare metrics of one plan (no stop, point or passenger name: counts and sums only). */
export function planMetrics(p: MetricsPlan, passengerCount: (bookingId: string) => number | undefined): RoutePlanMetricsDto {
  const active = p.assignments.filter((a) => a.objectId && p.stops.some((s) => s.assignmentId === a.id));
  const bookings = new Set(p.stops.flatMap((s) => (s.bookingId ? [s.bookingId] : [])));
  const assigned = p.stops.filter((s) => s.assignmentId);
  const seats = assigned.reduce((n, s) => n + seatsOf(s, passengerCount), 0);
  const sum = (k: 'distanceM' | 'durationS') => (active.some((a) => a[k] === null) ? null : active.reduce((n, a) => n + (a[k] as number), 0));
  const capacity = active.some((a) => a.capacity === null) ? null : active.reduce((n, a) => n + (a.capacity as number), 0);
  const violations = active.reduce((n, a) => n + routeViolations(routeStops(p.stops, a.id), a.capacity, passengerCount).length, 0);
  return {
    planId: p.id,
    name: p.name,
    planDate: p.planDate.toISOString().slice(0, 10),
    status: p.status,
    version: p.version,
    routes: p.assignments.length,
    activeRoutes: active.length,
    stops: p.stops.length,
    passengers: bookings.size,
    seats,
    unassigned: p.stops.filter((s) => !s.assignmentId).length,
    distanceM: sum('distanceM'),
    durationS: sum('durationS'),
    seatUtilisation: capacity ? Math.round((seats / capacity) * 1000) / 1000 : null,
    violations,
    graphVersion: p.graphVersion,
  };
}

// ───────────────────────────── publish: plan → E3 change set ─────────────────────────────

export interface PublishPlan {
  id: string;
  name: string;
  planDate: Date;
  planStartAt: Date | null;
  direction: TransportDirection | null;
  shiftId: string | null;
  sitePoiId: string | null;
}

export interface PublishRoute {
  id: string;
  seq: number;
  vehicleLabel: string;
  objectId: string | null;
  driverId: string | null;
  startS: number | null;
  endS: number | null;
  /** Current seats of the vehicle (TransportVehicleProfile.seats); null = not set. */
  seats: number | null;
}

export interface PublishBooking {
  id: string;
  status: string;
  serviceDate: Date;
  direction: TransportDirection;
  passengerCount: number;
  profileId: string;
  pickupLat: number | null;
  pickupLng: number | null;
  pickupPoiId: string | null;
  pickupLabel: string | null;
  dropLat: number | null;
  dropLng: number | null;
  dropPoiId: string | null;
  dropLabel: string | null;
}

export interface PublishPlace {
  id: string;
  name: string;
  lat: number;
  lng: number;
}

export interface PlanChangeSet {
  input: DispatchChangeSetInput;
  /** Change number (1-based, as E3 errors name it) → route (null for none). */
  opRoute: (string | null)[];
  /** route id → tempId of its CREATE_TRIP. */
  tempIds: Map<string, string>;
  errors: RoutePlanRouteError[];
  warnings: string[];
}

interface TripStop {
  lat: number;
  lng: number;
  label: string | null;
  poiId: string | null;
  arrivalMs: number;
  departureMs: number;
}

const tempIdOf = (i: number) => `route-${i + 1}`;
const dayKey = (d: Date) => d.toISOString().slice(0, 10);

/**
 * The E3 change set of a plan: per route with stops, one CREATE_TRIP (door-to-door stops in the route's order, planned
 * arrival = planStartAt + etaS, wait = service time; consecutive stops at the same company place merged) and one
 * ADD_PASSENGER per booking (pickup / drop seqs of its two stops). Personal stops take the booking's own point (the E3
 * publish links them to the consenting passenger: M2), place stops the place's point. A booking end the plan has no
 * stop for is added at its company place (site) before the first / after the last stop; a missing personal end is an
 * error. Pre-checks name the route (409 PLAN_NOT_PUBLISHABLE before anything is written); the E3 publish re-checks all
 * of them under its locks.
 */
export function buildPlanChangeSet(
  plan: PublishPlan,
  routes: PublishRoute[],
  stops: RuleStop[],
  bookings: Map<string, PublishBooking>,
  places: Map<string, PublishPlace>,
  consents: Set<string>,
): PlanChangeSet {
  const errors: RoutePlanRouteError[] = [];
  const warnings: string[] = [];
  const changes: DispatchChangeOp[] = [];
  const opRoute: (string | null)[] = [null];
  const tempIds = new Map<string, string>();
  const serviceDate = dayKey(plan.planDate);
  const plan0 = plan.planStartAt?.getTime() ?? null;
  if (!plan.direction) errors.push({ assignmentId: '', vehicleLabel: '', code: 'PLAN_NOT_PUBLISHABLE', message: 'The plan has no direction (login / logout)' });
  if (plan0 === null) errors.push({ assignmentId: '', vehicleLabel: '', code: 'ROUTE_NOT_TIMED', message: 'The plan has no start time; optimise or recalculate it first' });

  // Bookings split over two routes are refused for every route they touch.
  const routeOfEnd = new Map<string, Set<string | null>>();
  for (const s of stops) if (s.bookingId) routeOfEnd.set(s.bookingId, (routeOfEnd.get(s.bookingId) ?? new Set()).add(s.assignmentId));

  const ordered = [...routes].sort((a, b) => a.seq - b.seq);
  for (const [i, r] of ordered.entries()) {
    const list = routeStops(stops, r.id);
    if (!list.length) {
      if (r.objectId) warnings.push(`Route ${r.vehicleLabel} has no stops and is not published`);
      continue;
    }
    const fail = (code: string, message: string) => errors.push({ assignmentId: r.id, vehicleLabel: r.vehicleLabel, code, message });
    const before = errors.length;
    if (!r.objectId) fail('NO_VEHICLE', `Route ${r.vehicleLabel} has no vehicle`);
    else if (r.seats === null) fail('NO_SEATS_SET', `Set the passenger seats of the vehicle of route ${r.vehicleLabel} first`);
    if (plan0 === null || !plan.direction) continue;

    const bookingIds = [...new Set(list.flatMap((s) => (s.bookingId ? [s.bookingId] : [])))];
    let seats = 0;
    for (const id of bookingIds) {
      const b = bookings.get(id);
      if (!b) {
        fail('BOOKING_NOT_FOUND', `A booking on route ${r.vehicleLabel} no longer exists`);
        continue;
      }
      seats += b.passengerCount;
      if (b.status !== 'PENDING_ASSIGNMENT') fail('INVALID_STATE', `Booking ${id} on route ${r.vehicleLabel} is ${b.status}, not waiting for a seat`);
      if (dayKey(b.serviceDate) !== serviceDate || b.direction !== plan.direction) fail('INVALID_STATE', `Booking ${id} on route ${r.vehicleLabel} is for another date or direction`);
      if ((routeOfEnd.get(id)?.size ?? 0) > 1) fail('SPLIT_BOOKING', `The pickup and drop of booking ${id} are not on the same route`);
      const personal = (b.pickupLat !== null && !b.pickupPoiId) || (b.dropLat !== null && !b.dropPoiId);
      if (personal && !consents.has(b.profileId)) fail('CONSENT_REQUIRED', `A passenger on route ${r.vehicleLabel} has no active routing consent`);
      if (b.pickupLat === null || b.dropLat === null) fail('NEEDS_LOCATION', `Booking ${id} on route ${r.vehicleLabel} has no pickup or drop point`);
    }
    if (r.seats !== null && seats > r.seats) fail('CAPACITY_EXCEEDED', `Route ${r.vehicleLabel} carries ${seats} passengers on ${r.seats} seats`);
    for (const s of list) {
      if (s.etaS === null) {
        fail('ROUTE_NOT_TIMED', `Route ${r.vehicleLabel} is not timed; recalculate it first`);
        break;
      }
    }
    for (const s of list) {
      if (!s.bookingId && !s.poiId) {
        fail('STOP_NOT_PUBLISHABLE', `Stop ${s.ref} of route ${r.vehicleLabel} is neither a company place nor a passenger's pickup / drop`);
        break;
      }
      if (s.poiId && !places.has(s.poiId)) {
        fail('STOP_NOT_PUBLISHABLE', `Stop ${s.ref} of route ${r.vehicleLabel} names a place that no longer exists`);
        break;
      }
    }
    if (errors.length > before) continue;

    // Trip stops in order; seats per booking end.
    const trip: TripStop[] = [];
    const endSeq = new Map<string, { pickup?: TripStop; drop?: TripStop }>();
    const mark = (bookingId: string, end: 'PICKUP' | 'DROP', t: TripStop) => {
      const e = endSeq.get(bookingId) ?? {};
      if (end === 'PICKUP') e.pickup = t;
      else e.drop = t;
      endSeq.set(bookingId, e);
    };
    for (const s of list) {
      const arrivalMs = plan0 + (s.etaS as number) * 1000;
      const b = s.bookingId ? bookings.get(s.bookingId)! : null;
      const end = s.stopKind ?? 'PICKUP';
      const poiId = b ? (end === 'PICKUP' ? b.pickupPoiId : b.dropPoiId) : s.poiId;
      const place = poiId ? places.get(poiId) : undefined;
      const point = b && !poiId ? { lat: (end === 'PICKUP' ? b.pickupLat : b.dropLat) as number, lng: (end === 'PICKUP' ? b.pickupLng : b.dropLng) as number } : place ? { lat: place.lat, lng: place.lng } : { lat: s.lat, lng: s.lng };
      const prev = trip[trip.length - 1];
      let t: TripStop;
      if (prev && poiId && prev.poiId === poiId) {
        t = prev;
        t.departureMs = Math.max(t.departureMs, arrivalMs + s.serviceS * 1000);
      } else {
        t = { ...point, label: poiId ? (place?.name ?? s.name ?? null) : null, poiId: poiId ?? null, arrivalMs, departureMs: arrivalMs + s.serviceS * 1000 };
        trip.push(t);
      }
      if (b) mark(b.id, end, t);
    }
    // Booking ends the plan has no stop for: at their company place, before the first / after the last stop.
    for (const id of bookingIds) {
      const b = bookings.get(id)!;
      const e = endSeq.get(id) ?? {};
      for (const end of ['PICKUP', 'DROP'] as const) {
        if (end === 'PICKUP' ? e.pickup : e.drop) continue;
        const poiId = end === 'PICKUP' ? b.pickupPoiId : b.dropPoiId;
        const place = poiId ? places.get(poiId) : undefined;
        if (!poiId || !place) {
          fail('STOP_NOT_PUBLISHABLE', `Route ${r.vehicleLabel} has no ${end === 'PICKUP' ? 'pickup' : 'drop'} stop for booking ${id}`);
          continue;
        }
        if (end === 'PICKUP') {
          const first = trip[0];
          if (first.poiId === poiId) mark(id, end, first);
          else {
            const t: TripStop = { lat: place.lat, lng: place.lng, label: place.name, poiId, arrivalMs: first.arrivalMs, departureMs: first.arrivalMs };
            trip.unshift(t);
            mark(id, end, t);
          }
        } else {
          const last = trip[trip.length - 1];
          if (last.poiId === poiId) mark(id, end, last);
          else {
            const at = r.endS !== null && plan0 + r.endS * 1000 >= last.departureMs ? plan0 + r.endS * 1000 : last.departureMs;
            const t: TripStop = { lat: place.lat, lng: place.lng, label: place.name, poiId, arrivalMs: at, departureMs: at };
            trip.push(t);
            mark(id, end, t);
          }
        }
      }
    }
    if (errors.length > before) continue;
    if (trip.length < ROUTE_LIMITS.minStops) {
      fail('STOP_NOT_PUBLISHABLE', `Route ${r.vehicleLabel} needs at least ${ROUTE_LIMITS.minStops} stops`);
      continue;
    }
    if (trip.length > TRANSPORT_E3_LIMITS.maxStops) {
      fail('STOP_NOT_PUBLISHABLE', `Route ${r.vehicleLabel} has ${trip.length} stops (at most ${TRANSPORT_E3_LIMITS.maxStops})`);
      continue;
    }
    if (trip.some((t, k) => k > 0 && t.arrivalMs < trip[k - 1].arrivalMs)) {
      fail('ROUTE_NOT_TIMED', `The times of route ${r.vehicleLabel} go back; recalculate it first`);
      continue;
    }
    const seqOf = (t: TripStop) => trip.indexOf(t);
    for (const id of bookingIds) {
      const e = endSeq.get(id)!;
      if (seqOf(e.pickup!) >= seqOf(e.drop!)) fail('STOP_NOT_PUBLISHABLE', `On route ${r.vehicleLabel} the pickup of booking ${id} is not before its drop`);
    }
    if (errors.length > before) continue;

    const tempId = tempIdOf(i);
    tempIds.set(r.id, tempId);
    const firstMs = trip[0].arrivalMs;
    const wanted = r.startS !== null ? plan0 + r.startS * 1000 : firstMs;
    const plannedStart = Math.min(firstMs, Math.max(wanted, firstMs - 60 * MIN));
    const tripStops: DispatchStopInput[] = trip.map((t, k) => ({
      seq: k,
      point: { lat: t.lat, lng: t.lng, label: t.label, poiId: t.poiId },
      plannedArrival: new Date(t.arrivalMs).toISOString(),
      waitMin: Math.min(ROUTE_LIMITS.maxWaitMin, Math.max(0, Math.round((t.departureMs - t.arrivalMs) / MIN))),
    }));
    changes.push({
      op: 'CREATE_TRIP',
      tempId,
      objectId: r.objectId!,
      driverId: r.driverId,
      plannedStart: new Date(plannedStart).toISOString(),
      routeId: null,
      stops: tripStops,
      shiftId: plan.shiftId,
      sitePoiId: plan.sitePoiId,
      name: `${plan.name} · ${r.vehicleLabel}`.slice(0, 120),
    });
    opRoute.push(r.id);
    const seated = bookingIds.map((id) => ({ id, e: endSeq.get(id)! })).sort((a, b) => seqOf(a.e.pickup!) - seqOf(b.e.pickup!) || a.id.localeCompare(b.id));
    for (const { id, e } of seated) {
      changes.push({ op: 'ADD_PASSENGER', tripId: tempId, bookingId: id, pickupSeq: seqOf(e.pickup!), dropSeq: seqOf(e.drop!) });
      opRoute.push(r.id);
    }
  }
  if (!errors.length && !changes.length) errors.push({ assignmentId: '', vehicleLabel: '', code: 'PLAN_NOT_PUBLISHABLE', message: 'No route of the plan has stops to publish' });
  if (changes.length > TRANSPORT_E3_LIMITS.maxChanges) errors.push({ assignmentId: '', vehicleLabel: '', code: 'PLAN_NOT_PUBLISHABLE', message: `The plan makes ${changes.length} changes (at most ${TRANSPORT_E3_LIMITS.maxChanges} per publish)` });
  return {
    input: { serviceDate, direction: plan.direction ?? 'IN', changes, expectedVersions: {}, reason: `Route plan ${plan.id}` },
    opRoute,
    tempIds,
    errors,
    warnings,
  };
}

// ───────────────────────────── publish gate (owner decision 5) ─────────────────────────────

const HARD_KINDS = new Set<string>(ROUTE_PLAN_HARD_KINDS);
const OVERRIDABLE_KINDS = new Set<string>(ROUTE_PLAN_OVERRIDABLE_KINDS);

/**
 * Publish classification of a plan, recomputed from the stored stops (never from the client): per route with stops,
 * the route checks with a null ETA reported as `unreachable` (no engine time = the window cannot be proven: hard).
 * HARD: `late` (IN: site arrival after the booking's arrival window; OUT: the site pickup — departure, site stops have
 * no service time — after the departure window; a pickup that carries a window likewise), `unreachable`,
 * `over_capacity`. SOFT: everything else (`early_wait`, `max_ride_exceeded`). Only `late` is overridable.
 */
export function publishIssues(
  routes: { id: string; vehicleLabel: string; capacity: number | null }[],
  stops: RuleStop[],
  passengerCount: (bookingId: string) => number | undefined,
): { hard: RoutePlanPublishIssue[]; soft: RoutePlanPublishIssue[]; fingerprint: string | null } {
  const hard: RoutePlanPublishIssue[] = [];
  const soft: RoutePlanPublishIssue[] = [];
  for (const r of routes) {
    const list = routeStops(stops, r.id);
    if (!list.length) continue;
    for (const v of routeViolations(list, r.capacity, passengerCount, true)) {
      const issue: RoutePlanPublishIssue = { assignmentId: r.id, vehicleLabel: r.vehicleLabel, stopId: v.stopId, ref: v.ref, kind: v.kind, etaS: v.etaS, window: v.window };
      if (HARD_KINDS.has(v.kind)) hard.push({ ...issue, overridable: OVERRIDABLE_KINDS.has(v.kind) });
      else soft.push(issue);
    }
  }
  return { hard, soft, fingerprint: publishWarningsFingerprint(soft) };
}

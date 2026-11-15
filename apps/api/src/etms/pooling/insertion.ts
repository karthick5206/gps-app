import type { DispatchChangeOp, RidePreference, SharingLimits } from '@veetracer/shared';
import { haversineMeters } from '../../tracking/geo';
import { joinProblem, maxRideFor, pickupWindow, reachableFromPosition } from './pooling-rules';

/**
 * In-process cheapest feasible insertion (doc 20 §5.1 step 2 fallback, when the optimiser's `insertOnly` is not
 * available). Pure. The model keeps every existing stop at its planned time: a new pickup / drop is only placed in the
 * slack between two stops (travel there + service + travel on ≤ the next stop's planned arrival), at a company place
 * stop the trip already makes (reuse), before the first stop or after the last one. So no committed pickup window,
 * onboard drop or accepted limit of anyone already on the trip can get worse — the E3 ADD_STOP rule ("between its
 * neighbours") enforces the same at apply time.
 */

export interface LatLng {
  lat: number;
  lng: number;
}

/** Seconds from a to b. */
export type TravelFn = (a: LatLng, b: LatLng) => number;

/** Synthetic estimate when no road engine answers: straight line × 1.35 at 25 km/h + 30 s per leg (doc 20 §4.3 prototype city). */
export const fallbackTravel: TravelFn = (a, b) => Math.round((haversineMeters(a.lat, a.lng, b.lat, b.lng) * 1.35) / (25_000 / 3600) + 30);

/** Dwell at an inserted stop (whole minutes: the E3 ADD_STOP `waitMin`). */
export const INSERT_SERVICE_S = 60;

export interface InsertionStop {
  seq: number;
  lat: number;
  lng: number;
  poiId: string | null;
  arrivalMs: number;
  departureMs: number;
  /** ARRIVED / DEPARTED / SKIPPED: nothing may be inserted before it. */
  visited: boolean;
}

export interface InsertionTrip {
  tripId: string;
  objectId: string;
  status: string;
  seatCapacity: number;
  occupied: number;
  stops: InsertionStop[];
  /** Preferences of the bookings already seated (P1 checks). */
  onTrip: RidePreference[];
  /** Neighbouring trips of the vehicle (turnaround): end of the previous one, start of the next one (ms), or null. */
  prevEndMs: number | null;
  nextStartMs: number | null;
  turnaroundS: number;
  /** Started trip: the vehicle's live position and when (the first pending stop must still be reachable). */
  live?: { pos: LatLng; atMs: number } | null;
  /**
   * Review fix 1: the trip's live delay (ms, PlannedTrip.delaySec). Pending stops really happen this much later than
   * planned: feasibility (windows, now, reachability) is judged on delayed times, the ops carry planned times.
   */
  delayMs?: number;
}

export interface InsertionRequest {
  bookingId: string;
  seats: number;
  preference: RidePreference;
  pickup: LatLng & { poiId: string | null };
  drop: LatLng & { poiId: string | null };
  windowStartMs: number;
  windowEndMs: number;
  limits: SharingLimits | null;
  companyMaxRideS: number | null;
}

export type InsertionReason = 'CAPACITY' | 'PICKUP_WINDOW' | 'MAX_RIDE' | 'PRIVATE_TRIP' | 'PRIVATE_NEEDS_EMPTY_VEHICLE' | 'TRIP_STARTED' | 'VEHICLE_BUSY' | 'COMMITMENT';

/** Where the two ends go. `pickupAfter` / `dropAfter` are ORIGINAL stop indexes (-1 = before the first); `reuse*` = an existing stop index. */
export interface Insertion {
  feasible: true;
  pickupAfter: number | null;
  reusePickup: number | null;
  dropAfter: number | null;
  reuseDrop: number | null;
  /** Planned frame (what ADD_STOP writes, between the neighbours' planned times). */
  pickupArrivalMs: number;
  dropArrivalMs: number;
  /** Expected times (planned + the trip's live delay). */
  pickupEtaMs: number;
  dropEtaMs: number;
  /** Extra vehicle seconds (detour) the insertion costs. */
  addedS: number;
  rideS: number;
}

export type InsertionOutcome = Insertion | { feasible: false; reasons: InsertionReason[] };

/**
 * Cheapest feasible insertion of `req` into `trip`, or the reasons why none exists. O(n²) candidate pairs; n ≤ 60
 * stops (TRANSPORT_E3_LIMITS.maxStops).
 */
export function cheapestInsertion(trip: InsertionTrip, req: InsertionRequest, travel: TravelFn = fallbackTravel, nowMs = Date.now()): InsertionOutcome {
  const reasons = new Set<InsertionReason>();
  const share = joinProblem(req.preference, trip.onTrip);
  if (share) return { feasible: false, reasons: [share] };
  if (trip.occupied + req.seats > trip.seatCapacity) return { feasible: false, reasons: ['CAPACITY'] };
  // Review fix 1: judged on expected times — pending stops shifted by the live delay (gaps between them unchanged).
  const delay = Math.max(0, trip.delayMs ?? 0);
  const stops = [...trip.stops].sort((a, b) => a.seq - b.seq).map((x) => (x.visited || !delay ? x : { ...x, arrivalMs: x.arrivalMs + delay, departureMs: x.departureMs + delay }));
  const n = stops.length;
  const firstOpen = stops.findIndex((s) => !s.visited); // inserting after a visited stop is fine; before it is not
  const lastVisited = firstOpen < 0 ? n - 1 : firstOpen - 1;
  if (trip.status !== 'SCHEDULED' && firstOpen < 0) return { feasible: false, reasons: ['TRIP_STARTED'] };
  // A started trip that can no longer make its first pending stop (even with its delay) takes nobody else.
  if (trip.status !== 'SCHEDULED' && trip.live && firstOpen >= 0 && !reachableFromPosition(nowMs, travel(trip.live.pos, stops[firstOpen]), stops[firstOpen].arrivalMs)) return { feasible: false, reasons: ['COMMITMENT'] };
  const [pwStart, pwEnd] = pickupWindow(req.windowStartMs, req.windowEndMs, req.limits);
  const directS = travel(req.pickup, req.drop);
  const maxRideS = maxRideFor(directS, req.limits, req.companyMaxRideS);
  const svc = INSERT_SERVICE_S * 1000;
  const turn = trip.turnaroundS * 1000;
  let best: Insertion | null = null;
  const consider = (raw: Omit<Insertion, 'pickupEtaMs' | 'dropEtaMs'>) => {
    const c: Insertion = { ...raw, pickupEtaMs: raw.pickupArrivalMs, dropEtaMs: raw.dropArrivalMs, pickupArrivalMs: raw.pickupArrivalMs - delay, dropArrivalMs: raw.dropArrivalMs - delay };
    if (!best || c.addedS < best.addedS || (c.addedS === best.addedS && c.pickupArrivalMs < best.pickupArrivalMs)) best = c;
  };

  // Pickup placements: reuse a pending company-place stop, or insert after index i (i ≥ lastVisited; -1 only if nothing visited).
  type Place = { after: number | null; reuse: number | null; arr: number; dep: number; cost: number };
  const pickups: Place[] = [];
  for (let k = lastVisited + 1; k < n; k++) {
    const s = stops[k];
    if (req.pickup.poiId && s.poiId === req.pickup.poiId && s.arrivalMs >= nowMs) pickups.push({ after: null, reuse: k, arr: s.arrivalMs, dep: s.departureMs, cost: 0 });
  }
  for (let i = Math.max(-1, lastVisited); i < n; i++) {
    const prev = i >= 0 ? stops[i] : null;
    const next = i + 1 < n ? stops[i + 1] : null;
    let arr: number;
    if (prev) {
      const from = trip.live && i === lastVisited && trip.status !== 'SCHEDULED' ? Math.max(prev.departureMs, trip.live.atMs, nowMs) : prev.departureMs;
      const origin = trip.live && i === lastVisited && trip.status !== 'SCHEDULED' ? trip.live.pos : prev;
      // Review fix 1: never before now (and from the live position when right after the vehicle's last visited stop).
      arr = Math.max(pwStart, nowMs, from + travel(origin, req.pickup) * 1000);
    } else {
      // Before the first stop: the vehicle arrives just in time for the old first stop (latest pickup that keeps it).
      arr = Math.min(pwEnd, next!.arrivalMs - svc - travel(req.pickup, next!) * 1000);
      if (arr < pwStart || arr < nowMs) {
        reasons.add('PICKUP_WINDOW');
        continue;
      }
      if (trip.status !== 'SCHEDULED') continue;
      if (trip.prevEndMs !== null && arr < trip.prevEndMs + turn) {
        reasons.add('VEHICLE_BUSY');
        continue;
      }
    }
    if (arr > pwEnd) {
      reasons.add('PICKUP_WINDOW');
      continue;
    }
    const dep = arr + svc;
    const cost = prev && next ? travel(prev, req.pickup) + INSERT_SERVICE_S + travel(req.pickup, next) - travel(prev, next) : prev ? travel(prev, req.pickup) + INSERT_SERVICE_S : travel(req.pickup, next!) + INSERT_SERVICE_S;
    pickups.push({ after: i, reuse: null, arr, dep, cost });
  }
  if (!pickups.length) reasons.add('PICKUP_WINDOW');

  for (const p of pickups) {
    if (p.arr < pwStart || p.arr > pwEnd) {
      reasons.add('PICKUP_WINDOW');
      continue;
    }
    const pIdx = p.reuse ?? p.after!; // the original index the pickup sits at / after
    // The new pickup must still let the vehicle make the next original stop on time (insert case).
    if (p.after !== null) {
      const next = p.after + 1 < n ? stops[p.after + 1] : null;
      // Drop right after the pickup, before that next stop.
      const dArr = p.dep + directS * 1000;
      const dDep = dArr + svc;
      const fitsDirect = !next || dDep + travel(req.drop, next) * 1000 <= next.arrivalMs;
      if (fitsDirect) {
        const ride = Math.round((dArr - p.dep) / 1000);
        const endOk = next || trip.nextStartMs === null || dDep + turn <= trip.nextStartMs;
        if (ride > maxRideS) reasons.add('MAX_RIDE');
        else if (!endOk) reasons.add('VEHICLE_BUSY');
        else {
          const prevStop = p.after >= 0 ? stops[p.after] : null;
          const added = (prevStop ? travel(prevStop, req.pickup) : 0) + INSERT_SERVICE_S + directS + INSERT_SERVICE_S + (next ? travel(req.drop, next) : 0) - (prevStop && next ? travel(prevStop, next) : 0);
          consider({ feasible: true, pickupAfter: p.after, reusePickup: null, dropAfter: null, reuseDrop: null, pickupArrivalMs: p.arr, dropArrivalMs: dArr, addedS: Math.max(0, Math.round(added)), rideS: ride });
        }
      } else reasons.add('COMMITMENT');
      if (next && p.dep + travel(req.pickup, next) * 1000 > next.arrivalMs) {
        reasons.add('COMMITMENT');
        continue; // the pickup itself does not fit before the next stop: only "drop right after" could have worked
      }
    }
    // Drop later: reuse a company-place stop after the pickup, or insert after an original stop j ≥ pIdx (+1 when inserted).
    for (let k = pIdx + 1; k < n; k++) {
      const s = stops[k];
      if (!(req.drop.poiId && s.poiId === req.drop.poiId)) continue;
      const ride = Math.round((s.arrivalMs - p.dep) / 1000);
      if (ride > maxRideS) {
        reasons.add('MAX_RIDE');
        continue;
      }
      consider({ feasible: true, pickupAfter: p.after, reusePickup: p.reuse, dropAfter: null, reuseDrop: k, pickupArrivalMs: p.arr, dropArrivalMs: s.arrivalMs, addedS: Math.round(p.cost), rideS: ride });
    }
    const jStart = p.after !== null ? p.after + 1 : p.reuse!;
    for (let j = jStart; j < n; j++) {
      const prev = stops[j];
      const next = j + 1 < n ? stops[j + 1] : null;
      const dArr = prev.departureMs + travel(prev, req.drop) * 1000;
      const dDep = dArr + svc;
      if (next && dDep + travel(req.drop, next) * 1000 > next.arrivalMs) {
        reasons.add('COMMITMENT');
        continue;
      }
      if (!next && trip.nextStartMs !== null && dDep + turn > trip.nextStartMs) {
        reasons.add('VEHICLE_BUSY');
        continue;
      }
      const ride = Math.round((dArr - p.dep) / 1000);
      if (ride > maxRideS) {
        reasons.add('MAX_RIDE');
        continue;
      }
      const dropCost = next ? travel(prev, req.drop) + INSERT_SERVICE_S + travel(req.drop, next) - travel(prev, next) : travel(prev, req.drop) + INSERT_SERVICE_S;
      consider({ feasible: true, pickupAfter: p.after, reusePickup: p.reuse, dropAfter: j, reuseDrop: null, pickupArrivalMs: p.arr, dropArrivalMs: dArr, addedS: Math.max(0, Math.round(p.cost + dropCost)), rideS: ride });
    }
  }
  if (best) return best;
  return { feasible: false, reasons: reasons.size ? [...reasons] : ['COMMITMENT'] };
}

/**
 * The E3 change ops of an insertion (applied by DispatchService.apply): ADD_STOP for each inserted end (pickup first;
 * the drop's afterSeq is in the coordinates after the pickup insert), then ADD_PASSENGER with the final seqs.
 */
export function insertionOps(tripId: string, bookingId: string, ins: Insertion): DispatchChangeOp[] {
  const ops: DispatchChangeOp[] = [];
  let pickupSeq: number;
  let shift = 0;
  if (ins.reusePickup !== null) pickupSeq = ins.reusePickup;
  else {
    ops.push({ op: 'ADD_STOP', tripId, bookingId, end: 'PICKUP', afterSeq: ins.pickupAfter!, plannedArrival: new Date(ins.pickupArrivalMs).toISOString(), waitMin: INSERT_SERVICE_S / 60 });
    pickupSeq = ins.pickupAfter! + 1;
    shift = 1;
  }
  let dropSeq: number;
  if (ins.reuseDrop !== null) dropSeq = ins.reuseDrop + shift;
  else if (ins.dropAfter === null) {
    // Directly after the (inserted) pickup.
    ops.push({ op: 'ADD_STOP', tripId, bookingId, end: 'DROP', afterSeq: pickupSeq, plannedArrival: new Date(ins.dropArrivalMs).toISOString(), waitMin: INSERT_SERVICE_S / 60 });
    dropSeq = pickupSeq + 1;
  } else {
    const after = ins.dropAfter + shift;
    ops.push({ op: 'ADD_STOP', tripId, bookingId, end: 'DROP', afterSeq: after, plannedArrival: new Date(ins.dropArrivalMs).toISOString(), waitMin: INSERT_SERVICE_S / 60 });
    dropSeq = after + 1;
  }
  ops.push({ op: 'ADD_PASSENGER', tripId, bookingId, pickupSeq, dropSeq });
  return ops;
}

/**
 * A new trip for an idle vehicle: pickup at the earliest moment the vehicle can be there (approach from its position,
 * else `approachS` default 15 min from now) inside the pickup window, drop after the direct ride. Null when the window
 * cannot be met or the vehicle is not free (busy / turnaround).
 */
export function newTripTiming(req: InsertionRequest, vehicle: { pos: LatLng | null; busy: { start: number; end: number }[]; turnaroundS: number }, travel: TravelFn = fallbackTravel, nowMs = Date.now(), approachS = 900): { pickupMs: number; dropMs: number; startMs: number; endMs: number } | null {
  const [pwStart, pwEnd] = pickupWindow(req.windowStartMs, req.windowEndMs, req.limits);
  const approach = vehicle.pos ? travel(vehicle.pos, req.pickup) : approachS;
  const pickupMs = Math.max(pwStart, nowMs + approach * 1000);
  if (pickupMs > pwEnd) return null;
  const dropMs = pickupMs + INSERT_SERVICE_S * 1000 + travel(req.pickup, req.drop) * 1000;
  const startMs = pickupMs;
  const endMs = dropMs;
  const turn = vehicle.turnaroundS * 1000;
  if (vehicle.busy.some((b) => b.start < endMs + turn && b.end + turn > startMs)) return null;
  return { pickupMs, dropMs, startMs, endMs };
}

import { DEFAULT_RIDE_PRIORITY, DEFAULT_SHARING_LIMITS, type OptimizeUnassignedReason, type RidePreference, type SharingLimits } from '@veetracer/shared';
import { JobError } from './job-worker';
import type { PdpProblem, PdpRequestItem, PdpResult, PdpStopKind, PdpVehicle } from './pdp-contract';

/**
 * Pure mapping between pooling inputs (bookings with their accepted limits, vehicles with availability) and the
 * optimiser's pickup-and-delivery mode (contract v3, pdp-contract.ts), plus the independent checker of its answer
 * (doc 06 §4.5 "optimiser output is never trusted"; doc 20 §4.2). No I/O.
 */

/** Pooling strategy weights (doc 20 §4.4), keyed by the shared ROUTING_STRATEGIES names. */
export const PDP_STRATEGY_WEIGHTS: Record<string, PdpProblem['options']['weights']> = {
  BALANCED: { vehicle: 3600, time: 1, distance: 0, wait: 1, rideTime: 1 },
  FEWER_VEHICLES: { vehicle: 20000, time: 1, distance: 0, wait: 0, rideTime: 0 },
  SHORTEST_DISTANCE: { vehicle: 2000, time: 0, distance: 1, wait: 0, rideTime: 0 },
  FASTEST: { vehicle: 1800, time: 1, distance: 0, wait: 3, rideTime: 0 },
  COMFORT: { vehicle: 1800, time: 1, distance: 0, wait: 0, rideTime: 2 },
};

export const PDP_DEFAULT_SERVICE_S = 60;

export interface PdpBuildRequest {
  bookingId: string;
  pickupIndex: number;
  dropIndex: number;
  passengers: number;
  preference: RidePreference;
  /** The booking window, seconds after the plan start. */
  windowStartS: number;
  windowEndS: number;
  limits: SharingLimits | null;
  companyMaxRideS: number | null;
  wheelchair?: number;
  committed?: PdpRequestItem['committed'];
  allowedVehicleIds?: string[] | null;
}

export interface PdpBuildInput {
  durationsS: (number | null)[][];
  distancesM: (number | null)[][];
  horizonS: number;
  vehicles: PdpVehicle[];
  requests: PdpBuildRequest[];
  priority?: Partial<Record<RidePreference, number>>;
  strategy?: string;
  timeLimitS: number;
  insertOnly?: boolean;
  warmStart?: Record<string, string[]>;
  deterministic?: boolean;
}

/** The v3 request item of one booking: pickup window and ride bounds from its limits snapshot (else the defaults). */
export function pdpRequestItem(r: PdpBuildRequest, priority: Record<RidePreference, number>): PdpRequestItem {
  const l = r.limits ?? DEFAULT_SHARING_LIMITS;
  const start = Math.max(0, Math.round(r.windowStartS));
  const end = Math.max(start, Math.min(Math.round(r.windowEndS), start + l.maxWaitS));
  const caps = [l.maxRideS, r.companyMaxRideS].filter((x): x is number => typeof x === 'number');
  return {
    id: r.bookingId,
    pickupIndex: r.pickupIndex,
    dropIndex: r.dropIndex,
    passengers: r.passengers,
    preference: r.preference,
    pickupWindow: [start, end],
    arriveByS: l.arriveByS ?? null,
    maxRideS: caps.length ? Math.min(...caps) : null,
    detour: r.preference === 'PRIVATE' ? { ratio: 1, extraS: 0 } : { ratio: l.maxDetour.ratio, extraS: l.maxDetour.extraS },
    priority: (priority[r.preference] ?? 1) * (r.committed ? 1000 : 1),
    wheelchair: r.wheelchair ?? 0,
    allowedVehicleIds: r.allowedVehicleIds ?? null,
    committed: r.committed ?? null,
    serviceS: PDP_DEFAULT_SERVICE_S,
  };
}

export function buildPdpProblem(inp: PdpBuildInput): PdpProblem {
  const priority = { ...DEFAULT_RIDE_PRIORITY, ...(inp.priority ?? {}) } as Record<RidePreference, number>;
  const strategy = inp.strategy && PDP_STRATEGY_WEIGHTS[inp.strategy] ? inp.strategy : 'BALANCED';
  return {
    schemaVersion: 3,
    mode: 'pdp',
    matrix: { durationsS: inp.durationsS, distancesM: inp.distancesM },
    horizonS: inp.horizonS,
    vehicles: inp.vehicles,
    requests: inp.requests.map((r) => pdpRequestItem(r, priority)),
    options: {
      strategy,
      weights: { ...PDP_STRATEGY_WEIGHTS[strategy] },
      timeLimitS: inp.timeLimitS,
      insertOnly: !!inp.insertOnly,
      ...(inp.warmStart ? { warmStart: inp.warmStart } : {}),
      ...(inp.deterministic ? { deterministic: true } : {}),
    },
  };
}

const kindOf = (k: string): PdpStopKind | null => (k === 'PICKUP' || k === 'P' ? 'PICKUP' : k === 'DROP' || k === 'D' ? 'DROP' : null);

/**
 * Independent checker of a v3 answer (never trust the optimiser): shape, every served request on ONE trip of ONE
 * vehicle with its pickup before its drop, seats never above capacity (recomputed), load back to 0 at every trip end,
 * pickup inside its hard window, ride within its bounds (max ride; detour from the matrix's direct time), P1 whole-trip
 * exclusivity (a trip with a PRIVATE request carries nothing else), committed requests on their vehicle and window,
 * turnaround between trips, and an empty commitmentViolations. Throws SOLVER_RESULT_INVALID naming the first breach.
 */
export function verifyPdp(problem: PdpProblem, res: PdpResult): void {
  const bad = (msg: string) => new JobError('SOLVER_RESULT_INVALID', `Optimiser answer rejected: ${msg}`);
  if (!res || !Array.isArray(res.vehicles) || !Array.isArray(res.unserved)) throw bad('not a pickup-and-delivery result');
  if (Array.isArray(res.commitmentViolations) && res.commitmentViolations.length) throw bad(`${res.commitmentViolations.length} commitment violation(s) reported`);
  const vehicles = new Map(problem.vehicles.map((v) => [v.id, v]));
  const requests = new Map(problem.requests.map((r) => [r.id, r]));
  const seen = new Map<string, { vehicle: string; trip: number; pickup?: number; drop?: number; pickupStart?: number; dropArrival?: number }>();
  for (const v of res.vehicles) {
    const veh = vehicles.get(v.id);
    if (!veh) throw bad(`unknown vehicle ${String(v.id).slice(0, 40)}`);
    let prevEnd: number | null = null;
    const trips = [...(v.trips ?? [])].sort((a, b) => a.index - b.index);
    const onboard = new Map((veh.onboard ?? []).map((o) => [o.requestId, o]));
    for (const [ti, t] of trips.entries()) {
      // Live: passengers already on board (one seat each, unknown to `requests`) leave on the first trip.
      let load = ti === 0 ? onboard.size : 0;
      const onTrip = new Set<string>();
      const stops = t.stops ?? [];
      if (!stops.length) continue;
      const first = Math.min(...stops.map((s) => s.arrivalS));
      if (prevEnd !== null && first < prevEnd + veh.turnaroundS) throw bad(`trip ${t.index} of ${v.id} starts before the turnaround after the previous trip`);
      for (const [pos, s] of stops.entries()) {
        const kind = kindOf(String(s.kind));
        const ob = onboard.get(s.requestId);
        if (ob && kind === 'DROP' && !requests.has(s.requestId)) {
          if (s.arrivalS > ob.dropByS) throw bad(`onboard passenger ${ob.requestId} dropped after its committed time`);
          load -= 1;
          continue;
        }
        const r = requests.get(s.requestId);
        if (!kind || !r) throw bad(`unknown stop ${String(s.requestId).slice(0, 40)}`);
        const e = seen.get(r.id) ?? { vehicle: v.id, trip: t.index };
        if (e.vehicle !== v.id || e.trip !== t.index) throw bad(`request ${r.id} split across trips / vehicles`);
        onTrip.add(r.id);
        if (kind === 'PICKUP') {
          if (e.pickup !== undefined) throw bad(`request ${r.id} picked up twice`);
          e.pickup = pos;
          e.pickupStart = s.startS;
          if (s.startS < r.pickupWindow[0] || s.startS > r.pickupWindow[1]) throw bad(`request ${r.id} picked up outside its window`);
          if (r.committed && (r.committed.vehicleId !== v.id || s.startS < r.committed.pickupWindow[0] || s.startS > r.committed.pickupWindow[1])) throw bad(`committed request ${r.id} moved`);
          load += r.passengers;
          if (load > veh.capacity) throw bad(`vehicle ${v.id} over capacity`);
        } else {
          if (e.pickup === undefined) throw bad(`request ${r.id} dropped before its pickup`);
          e.drop = pos;
          e.dropArrival = s.arrivalS;
          load -= r.passengers;
          const ride = s.arrivalS - ((e.pickupStart as number) + (r.serviceS ?? PDP_DEFAULT_SERVICE_S));
          const direct = problem.matrix.durationsS[r.pickupIndex]?.[r.dropIndex];
          if (r.maxRideS !== null && ride > r.maxRideS) throw bad(`request ${r.id} rides longer than its maximum`);
          if (typeof direct === 'number' && ride > Math.max(direct * r.detour.ratio, direct + r.detour.extraS) + 1) throw bad(`request ${r.id} exceeds its detour limit`);
          if (r.arriveByS !== null && s.arrivalS > r.arriveByS) throw bad(`request ${r.id} arrives after its arrive-by time`);
        }
        seen.set(r.id, e);
      }
      if (load !== 0) throw bad(`trip ${t.index} of ${v.id} does not end empty`);
      const ids = [...onTrip];
      if (ids.length > 1 && ids.some((id) => requests.get(id)!.preference === 'PRIVATE')) throw bad(`a private request shares trip ${t.index} of ${v.id}`);
      prevEnd = Math.max(...stops.map((s) => s.startS + (requests.get(s.requestId)?.serviceS ?? PDP_DEFAULT_SERVICE_S)));
    }
  }
  for (const [id, e] of seen) if (e.drop === undefined) throw bad(`request ${id} picked up but never dropped`);
  for (const r of problem.requests) if (r.committed && !seen.has(r.id)) throw bad(`committed request ${r.id} dropped`);
}

/** Solver unserved code → the plan stop's unassigned reason (shared OPTIMIZE_UNASSIGNED_REASONS). */
export function unservedReason(code: string): OptimizeUnassignedReason {
  switch (code) {
    case 'PICKUP_WINDOW':
      return 'time_window_unreachable';
    case 'MAX_RIDE':
      return 'max_ride_unachievable';
    case 'CAPACITY':
      return 'demand_exceeds_vehicle_capacity';
    case 'NO_COMPATIBLE_VEHICLE':
      return 'no_compatible_vehicle';
    case 'DRIVER_HOURS':
      return 'exceeds_max_route_duration';
    case 'PRIVATE_NEEDS_EMPTY_VEHICLE':
      return 'no_vehicle_available';
    default:
      return 'not_scheduled_capacity_or_time';
  }
}

export interface PdpVisit {
  stopId: string;
  sequence: number;
  etaS: number;
  tripIndex: number;
}

/**
 * A verified answer → per vehicle the ordered plan stops (sequence across the whole route, tripIndex per trip, ETA =
 * service start) and per unserved request its two stops with the reason. `stopOf(bookingId, kind)` names the plan stop.
 */
export function mapPdpResult(res: PdpResult, stopOf: (bookingId: string, kind: PdpStopKind) => string | null): { routes: { vehicleId: string; visits: PdpVisit[]; startS: number | null; endS: number | null; durationS: number | null; distanceM: number | null }[]; unassigned: { stopId: string; reason: OptimizeUnassignedReason; code: string }[] } {
  const routes = res.vehicles.map((v) => {
    const visits: PdpVisit[] = [];
    let distance = 0;
    let hasDistance = false;
    for (const t of [...(v.trips ?? [])].sort((a, b) => a.index - b.index)) {
      if (typeof t.distanceM === 'number') {
        distance += t.distanceM;
        hasDistance = true;
      }
      for (const s of t.stops ?? []) {
        const kind = kindOf(String(s.kind));
        const stopId = kind ? stopOf(s.requestId, kind) : null;
        if (stopId) visits.push({ stopId, sequence: visits.length, etaS: Math.round(s.startS), tripIndex: t.index });
      }
    }
    const startS = visits.length ? visits[0].etaS : null;
    const endS = visits.length ? visits[visits.length - 1].etaS : null;
    return { vehicleId: v.id, visits, startS, endS, durationS: startS !== null && endS !== null ? endS - startS : null, distanceM: hasDistance ? Math.round(distance) : null };
  });
  const unassigned = res.unserved.flatMap((u) =>
    (['PICKUP', 'DROP'] as const).flatMap((k) => {
      const stopId = stopOf(u.requestId, k);
      return stopId ? [{ stopId, reason: unservedReason(String(u.code)), code: String(u.code).slice(0, 40) }] : [];
    }),
  );
  return { routes, unassigned };
}

/** An optimiser that answers a v3 problem with a v1 / v2 refusal (schemaVersion / mode unknown) does not offer pdp yet. */
export function isPdpUnsupported(message: string): boolean {
  return /schemaVersion|\bmode\b|unknown mode|unsupported/i.test(message);
}

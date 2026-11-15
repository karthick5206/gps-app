import type { RidePreference, RideService } from '@veetracer/shared';

/**
 * Optimiser contract v3, `mode: "pdp"` (pickup and delivery; doc 20 §4.1). The API builds the request from bookings and
 * their accepted limits (pdp-problem.ts) and maps / verifies the answer; `services/routing-optimizer` implements the
 * solver (WS P-B2, separate branch). Times are integer seconds after the plan start (`planStartAt`), matrix cells are the
 * engine's numbers. No names, no addresses and no coordinates are sent: points are matrix indexes, people are booking ids.
 */

export interface PdpBreak {
  earliestS: number;
  latestS: number;
  durationS: number;
}

export interface PdpVehicle {
  /** RouteAssignment id (batch) or `obj:<objectId>` / `trip:<tripId>` (live). */
  id: string;
  /** Matrix index the vehicle starts from (depot, or its live position). */
  startIndex: number;
  /** Vehicle free from (s): max(now, current trip's last drop ETA + turnaround). */
  availableFromS: number;
  shiftEndS: number;
  /** Driver span bound (s); absent = none. */
  maxSpanS?: number;
  capacity: number;
  wheelchairSpaces?: number;
  type?: string | null;
  /** Seconds added at every trip boundary (exact turnaround). */
  turnaroundS: number;
  breaks?: PdpBreak[];
  /** Passengers already on board (live): their drop must stay before dropByS. */
  onboard?: { requestId: string; dropIndex: number; dropByS: number }[];
}

export interface PdpRequestItem {
  /** Booking id. */
  id: string;
  pickupIndex: number;
  dropIndex: number;
  passengers: number;
  preference: RidePreference;
  /** Hard: [requested, requested + maxWaitS] from the booking's limits snapshot. */
  pickupWindow: [number, number];
  arriveByS: number | null;
  /** Hard ride bound (s) (min of the booking's own max ride and the company max ride); null = detour rule only. */
  maxRideS: number | null;
  /** Hard: ride ≤ max(direct × ratio, direct + extraS). */
  detour: { ratio: number; extraS: number };
  /** Drop penalty multiplier (P6: PRIVATE 3, FLEXIBLE 1.5, SHARED 1; committed × 1000). */
  priority: number;
  wheelchair: number;
  allowedVehicleIds: string[] | null;
  /** Already promised to a vehicle and window (live): must stay there, never dropped. */
  committed: { vehicleId: string; pickupWindow: [number, number] } | null;
  /** Dwell at pickup / drop (s); default 60. */
  serviceS?: number;
}

export interface PdpProblem {
  schemaVersion: 3;
  mode: 'pdp';
  matrix: { durationsS: (number | null)[][]; distancesM: (number | null)[][] };
  horizonS: number;
  vehicles: PdpVehicle[];
  requests: PdpRequestItem[];
  options: {
    strategy: string;
    weights: { vehicle: number; time: number; distance: number; wait: number; rideTime: number };
    timeLimitS: number;
    /** Current routes as ["P:<requestId>", "D:<requestId>", …] per vehicle (live re-optimisation). */
    warmStart?: Record<string, string[]>;
    /** Cheapest feasible insertion only: committed stops are never re-sequenced. */
    insertOnly: boolean;
    deterministic?: boolean;
  };
}

export type PdpStopKind = 'PICKUP' | 'DROP';

export interface PdpStopResult {
  requestId: string;
  /** PICKUP / DROP ("P" / "D" accepted). */
  kind: PdpStopKind | 'P' | 'D';
  arrivalS: number;
  startS: number;
  load: number;
  onboard?: string[];
}

export interface PdpTripResult {
  /** 0-based trip slot of the vehicle (the load returns to 0 at its end). */
  index: number;
  stops: PdpStopResult[];
  startS?: number;
  endS?: number;
  distanceM?: number | null;
  durationS?: number | null;
}

export interface PdpVehicleResult {
  id: string;
  trips: PdpTripResult[];
}

export const PDP_UNSERVED_CODES = ['PICKUP_WINDOW', 'VEHICLE_TIME', 'MAX_RIDE', 'CAPACITY', 'PRIVATE_NEEDS_EMPTY_VEHICLE', 'DRIVER_HOURS', 'NO_COMPATIBLE_VEHICLE', 'NOT_SELECTED'] as const;
export type PdpUnservedCode = (typeof PDP_UNSERVED_CODES)[number];

export interface PdpResult {
  schemaVersion: 3;
  status: 'OPTIMAL' | 'FEASIBLE' | 'NO_SOLUTION' | 'INVALID_INPUT' | string;
  vehicles: PdpVehicleResult[];
  requests?: { id: string; waitS?: number; rideS?: number; detourS?: number; servedAs?: RideService }[];
  unserved: { requestId: string; code: PdpUnservedCode | string }[];
  /** Must be empty; anything here fails the job (never written). */
  commitmentViolations: unknown[];
}

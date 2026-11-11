/**
 * Routes & planned trips (module RTE, docs/routes-trips/SPEC.md). A route is a reusable plan (ordered stops + road
 * path + corridor); schedules generate planned trips; a planned trip holds a snapshot of its route.
 * Not to be confused with the automatic `Trip` / `Stop` of the summarizer.
 */

export const PLANNED_TRIP_STATUSES = ['SCHEDULED', 'STARTED', 'IN_PROGRESS', 'COMPLETED', 'INCOMPLETE', 'CANCELLED'] as const;
export type PlannedTripStatus = (typeof PLANNED_TRIP_STATUSES)[number];

/** Trips the processor tracks (a vehicle has at most one). */
export const ACTIVE_PLANNED_TRIP_STATUSES: readonly PlannedTripStatus[] = ['STARTED', 'IN_PROGRESS'];
/** Trips that can still be cancelled. */
export const CANCELLABLE_PLANNED_TRIP_STATUSES: readonly PlannedTripStatus[] = ['SCHEDULED', 'STARTED', 'IN_PROGRESS'];

export const PLANNED_STOP_STATUSES = ['PENDING', 'ARRIVED', 'DEPARTED', 'SKIPPED'] as const;
export type PlannedStopStatus = (typeof PLANNED_STOP_STATUSES)[number];

export const PLANNED_TRIP_EVENT_KINDS = ['UNSCHEDULED_STOP', 'DEVIATION'] as const;
export type PlannedTripEventKind = (typeof PLANNED_TRIP_EVENT_KINDS)[number];

export type PlannedTripClosedBy = 'AUTO' | 'MANUAL' | 'TIMEOUT';

/** Limits of the route editor (validated by the API). */
export const ROUTE_LIMITS = {
  minStops: 2,
  maxStops: 100,
  corridorMinM: 50,
  corridorMaxM: 2000,
  corridorDefaultM: 200,
  radiusMinM: 20,
  radiusMaxM: 2000,
  radiusDefaultM: 100,
  /** Arrival offset / wait upper bound (minutes): 7 days. */
  maxOffsetMin: 10_080,
  maxWaitMin: 1_440,
} as const;

/** Timings of the tracker / sweeper (minutes). */
export const PLANNED_TRIP_TIMING = {
  /** A SCHEDULED trip is a start candidate from plannedStart − this. */
  candidateBeforeMin: 60,
  /** … until plannedEnd + this; also the INCOMPLETE timeout. */
  incompleteAfterMin: 120,
  /** No start by plannedStart + this → "not started". */
  notStartedGraceMin: 30,
  /** The generator creates trips whose planned start falls in the next … hours. */
  generateAheadHours: 24,
} as const;

/** Road path: [[lng, lat], ...] (GeoJSON order). */
export type RoutePath = [number, number][];

export interface RouteStopInput {
  name: string;
  lat: number;
  lng: number;
  radiusM?: number;
  /** Planned arrival, minutes after the trip's planned start (start stop: 0; non-decreasing). */
  offsetMin?: number;
  /** Planned dwell in minutes. */
  waitMin?: number;
  geofenceId?: string | null;
}

export interface RouteStopDto {
  id: string;
  seq: number;
  name: string;
  lat: number;
  lng: number;
  radiusM: number;
  offsetMin: number;
  waitMin: number;
  geofenceId: string | null;
}

export interface RouteScheduleDto {
  id: string;
  routeId: string;
  /** 0 = Sunday … 6 = Saturday (company timezone). */
  days: number[];
  /** Local minutes after midnight. */
  startMin: number;
  objectId: string | null;
  objectName: string | null;
  driverId: string | null;
  driverName: string | null;
  /** YYYY-MM-DD (company timezone) or null. */
  validFrom: string | null;
  validTo: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface RouteScheduleInput {
  days: number[];
  startMin: number;
  objectId?: string | null;
  driverId?: string | null;
  validFrom?: string | null;
  validTo?: string | null;
  isActive?: boolean;
}

/** Route list row (no path, to keep lists small). */
export interface RouteSummaryDto {
  id: string;
  name: string;
  code: string | null;
  description: string | null;
  branchId: string | null;
  branchName: string | null;
  corridorM: number;
  distanceM: number | null;
  durationSec: number | null;
  stopCount: number;
  scheduleCount: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface RouteDto extends RouteSummaryDto {
  path: RoutePath | null;
  stops: RouteStopDto[];
  schedules: RouteScheduleDto[];
}

export interface RouteInput {
  name: string;
  code?: string | null;
  description?: string | null;
  branchId?: string | null;
  corridorM?: number;
  stops: RouteStopInput[];
  isActive?: boolean;
}

export interface RoutePathLeg {
  distanceM: number;
  durationSec: number;
}

/** `POST /routes/preview-path` answer; `path` null when the routing engine is off or found no route. */
export interface RoutePathPreview {
  enabled: boolean;
  path: RoutePath | null;
  distanceM: number | null;
  durationSec: number | null;
  /** One per consecutive stop pair ("Suggest times"); empty without a road path. */
  legs: RoutePathLeg[];
}

export interface PlannedTripStopDto {
  id: string;
  seq: number;
  name: string;
  lat: number;
  lng: number;
  radiusM: number;
  plannedArrival: string;
  plannedDeparture: string;
  actualArrival: string | null;
  actualDeparture: string | null;
  status: PlannedStopStatus;
  /** actualArrival − plannedArrival (s, + late). */
  delaySec: number | null;
}

export interface PlannedTripEventDto {
  id: string;
  kind: PlannedTripEventKind;
  startAt: string;
  endAt: string | null;
  lat: number;
  lng: number;
  /** DEVIATION: { maxM }, UNSCHEDULED_STOP: { durationSec } */
  data: Record<string, unknown> | null;
}

export interface PlannedTripSummaryDto {
  id: string;
  routeId: string;
  scheduleId: string | null;
  routeName: string;
  objectId: string;
  objectName: string | null;
  driverId: string | null;
  driverName: string | null;
  branchId: string | null;
  corridorM: number;
  plannedStart: string;
  plannedEnd: string;
  status: PlannedTripStatus;
  actualStart: string | null;
  actualEnd: string | null;
  closedBy: PlannedTripClosedBy | null;
  cancelReason: string | null;
  notes: string | null;
  distanceKm: number | null;
  deviationCount: number;
  maxDeviationM: number | null;
  nextStopSeq: number | null;
  etaNextStop: string | null;
  delaySec: number | null;
  stopCount: number;
  /** Stops marked SKIPPED (passed, or closed by hand / timeout / cancel before they were reached). */
  skippedStops: number;
  createdAt: string;
  updatedAt: string;
}

export interface PlannedTripDto extends PlannedTripSummaryDto {
  path: RoutePath | null;
  stops: PlannedTripStopDto[];
  events: PlannedTripEventDto[];
}

export interface PlannedTripCreateInput {
  routeId: string;
  objectId: string;
  driverId?: string | null;
  /** ISO instant. */
  plannedStart: string;
  notes?: string | null;
}

export interface PlannedTripUpdateInput {
  objectId?: string;
  driverId?: string | null;
  plannedStart?: string;
  notes?: string | null;
}

export interface PlannedTripListQuery {
  /** ISO instants: trips whose planned start is in [from, to). */
  from?: string;
  to?: string;
  routeId?: string;
  objectId?: string;
  driverId?: string;
  tripStatus?: PlannedTripStatus;
}

/** @deprecated Stage 1 placeholder; the live push is `PLANNED_TRIP_SOCKET_EVENT` with a `PlannedTripLiveUpdate`. */
export interface PlannedTripUpdateEvent {
  companyId: string;
  trip: PlannedTripSummaryDto;
}

/**
 * Socket.io event (namespace `/live`) emitted to the company's sockets with `plannedTrips:view` (and the vehicle in
 * scope) when a tracked trip's status, next stop, ETA, delay or stop actuals change. Payload: `PlannedTripLiveUpdate`.
 */
export const PLANNED_TRIP_SOCKET_EVENT = 'plannedTrip.update';

/** Stop actuals in a live update (all stops of the trip, sent whenever any stop changed). */
export interface PlannedTripLiveStop {
  seq: number;
  status: PlannedStopStatus;
  actualArrival: string | null;
  actualDeparture: string | null;
  delaySec: number | null;
}

/** Payload of `PLANNED_TRIP_SOCKET_EVENT`: the live fields of `PlannedTripSummaryDto` (merge into the row by `id`). */
export interface PlannedTripLiveUpdate
  extends Pick<PlannedTripSummaryDto, 'id' | 'status' | 'nextStopSeq' | 'etaNextStop' | 'delaySec' | 'actualStart' | 'actualEnd' | 'deviationCount' | 'maxDeviationM'> {
  /** Present when stop actuals changed. */
  stops?: PlannedTripLiveStop[];
}

/** Reason sent with RedisKeys.rulesInvalidate after a write that changes trips. */
export const PLANNED_TRIPS_INVALIDATE_REASON = 'planned-trips';

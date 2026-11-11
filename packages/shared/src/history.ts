/** History, trips, geofences and reports shapes. */
import type { AlertDto, TimeWindow } from './alerts';
import type { LatLng } from './geo';

/** Compact track point for playback: [epochMs, lat, lng, speedKph, course, ignition (1/0/-1 unknown), status code]. */
export type TrackPoint = [number, number, number, number, number, number, number];

/** Index into this array = status code in TrackPoint[6]. */
export const TRACK_STATUS_CODES = ['RUNNING', 'IDLE', 'OFF', 'OVERSPEED'] as const;

export interface TripDto {
  id: string; objectId: string; objectName: string;
  startTime: string; endTime: string; durationSec: number; idleSec: number;
  startLat: number; startLng: number; endLat: number; endLng: number;
  startAddress: string | null; endAddress: string | null;
  distanceKm: number; maxSpeedKph: number; avgSpeedKph: number;
}

export interface StopDto {
  id: string; objectId: string; objectName: string;
  startTime: string; endTime: string; durationSec: number;
  lat: number; lng: number; address: string | null;
  /** true = engine running while stopped (idle stop); false = parked. */
  ignitionOn: boolean;
  /** Nearest point of interest within its radius (stop reports only). */
  poiName?: string | null;
}

/** A data gap in a track: the last point before it, the first after it, and the time between them. */
export interface GapEstimateSegment {
  fromLat: number;
  fromLng: number;
  toLat: number;
  toLng: number;
  seconds: number;
}

/** `POST /routing/estimate-gaps`: at most this many segments per call. */
export const MAX_GAP_ESTIMATES = 30;

export interface GapEstimateResponse {
  /** False when no routing engine is configured (nothing is estimated). */
  enabled: boolean;
  /** Per requested segment, in order: the likely road as [lng, lat] pairs, or null when there is no believable one. */
  routes: ([number, number][] | null)[];
}

export interface HistoryResponse {
  objectId: string;
  from: string;
  to: string;
  points: TrackPoint[];
  trips: TripDto[];
  stops: StopDto[];
  alerts: AlertDto[];
  summary: { distanceKm: number; runningSec: number; idleSec: number; stopSec: number; maxSpeedKph: number; avgSpeedKph: number };
  truncated: boolean; // true when the range exceeded the point cap and was simplified
  /** Fuel level over time [epochMs, litres] when the vehicle has a fuel sensor (downsampled). */
  fuel?: [number, number][];
}

export interface DailySummaryDto {
  objectId: string; objectName: string; plateNumber: string | null; branchName: string | null;
  day: string; // YYYY-MM-DD in company timezone
  distanceKm: number; runningSec: number; idleSec: number; stopSec: number; offlineSec: number;
  overspeedSec: number; overspeedCount: number; tripCount: number;
  maxSpeedKph: number; avgSpeedKph: number; engineSec: number;
  firstStart: string | null; lastStop: string | null;
}

export type GeofenceType = 'CIRCLE' | 'POLYGON' | 'RECTANGLE';
export type GeofenceMode = 'NORMAL' | 'NO_GO' | 'KEEP_IN';

export type GeofenceGeometry =
  | { type: 'CIRCLE'; center: LatLng; radiusM: number }
  | { type: 'POLYGON' | 'RECTANGLE'; points: LatLng[] };

export interface GeofenceDto {
  id: string;
  name: string;
  category: string; // GEOFENCE_CATEGORY lookup code
  geometry: GeofenceGeometry;
  color: string;
  address: string | null;
  description: string | null;
  branchId: string | null; branchName: string | null; // owner branch; null = company-wide
  mode: GeofenceMode;
  notifyEnter: boolean; notifyExit: boolean;
  maxStayMin: number | null;
  speedLimitKph: number | null;
  timeWindows: TimeWindow[]; // empty = always active
  appliesTo: { all: boolean; branchIds: string[]; groupIds: string[]; objectIds: string[] };
  isActive: boolean;
  createdAt: string; updatedAt: string;
}

export const REPORT_TYPES = [
  'SUMMARY',
  'CONSOLIDATED',
  'DISTANCE',
  'ENGINE_HOURS',
  'TRIPS',
  'STOPS',
  'IDLE',
  'HALT',
  'CONTINUOUS_DRIVING',
  'OVERSPEED',
  'IGNITION',
  'POSITIONS',
  'ALERTS',
  'EVENT_SUMMARY',
  'GEOFENCE_VISITS',
  'GEOFENCE_SUMMARY',
  'GEOFENCE_DISTANCE',
  'DEVICE_STATUS',
  'DRIVERS',
  'DOCUMENTS',
  'POI_VISITS',
  'FUEL',
  'FUEL_EVENTS',
  'MILEAGE',
  'AC_DOOR',
  'AC_DOOR_DAILY',
  'ATTENDANCE_DAILY',
  'ATTENDANCE_SUMMARY',
  'ATTENDANCE_PAYROLL',
  'ATTENDANCE_OUTINGS',
  'ATTENDANCE_CORRECTIONS',
  'TRIP_PERFORMANCE',
  'PLANNED_TRIPS',
] as const;
export type ReportType = (typeof REPORT_TYPES)[number];

/** Routes & planned trips reports: shown and run only with the `plannedTrips` view permission. */
export const PLANNED_TRIP_REPORT_TYPES: readonly ReportType[] = ['TRIP_PERFORMANCE', 'PLANNED_TRIPS'];

/** TRIP_PERFORMANCE: one row per route, per driver or per vehicle. */
export const TRIP_PERFORMANCE_GROUP_BY = ['ROUTE', 'DRIVER', 'VEHICLE'] as const;
export type TripPerformanceGroupBy = (typeof TRIP_PERFORMANCE_GROUP_BY)[number];
/** A stop counts as on time when its arrival is within this many seconds of the plan (early or late). */
export const ON_TIME_TOLERANCE_SEC = 300;

/** Report types that use `period` (rows grouped by day / ISO week / month). */
export const PERIOD_REPORT_TYPES: readonly ReportType[] = ['SUMMARY', 'DISTANCE', 'ENGINE_HOURS'];
/** Report types limited to one vehicle (raw position data). */
export const SINGLE_OBJECT_REPORT_TYPES: readonly ReportType[] = ['POSITIONS'];
/** Longest range for raw-position reports (days). */
export const POSITIONS_REPORT_MAX_DAYS = 7;

/** Per-report options; every field is optional with a sensible default. */
export interface ReportOptions {
  /** HALT: minimum parked duration (default 30 min). STOPS / IDLE: optional minimum duration. */
  minDurationMin?: number;
  /** ALERTS / EVENT_SUMMARY: only these alert types (empty = all). */
  alertTypes?: string[];
  /** CONTINUOUS_DRIVING: report stretches at least this long (default 240 min = 4 h). */
  drivingMin?: number;
  /** CONTINUOUS_DRIVING: a stop at least this long resets the stretch (default 15 min). */
  breakMin?: number;
  /** OVERSPEED: ignore episodes shorter than this (default 10 s). */
  minOverspeedSec?: number;
  /** DEVICE_STATUS: no data for this long = inactive (default 1440 min = 24 h). */
  inactiveAfterMin?: number;
  /** TRIP_PERFORMANCE: one row per route, driver or vehicle (default ROUTE). */
  groupBy?: TripPerformanceGroupBy;
}
/** The options each report type accepts (the API ignores the rest). */
export const REPORT_OPTION_KEYS: Partial<Record<ReportType, readonly (keyof ReportOptions)[]>> = {
  HALT: ['minDurationMin'],
  STOPS: ['minDurationMin'],
  IDLE: ['minDurationMin'],
  ALERTS: ['alertTypes'],
  EVENT_SUMMARY: ['alertTypes'],
  CONTINUOUS_DRIVING: ['drivingMin', 'breakMin'],
  OVERSPEED: ['minOverspeedSec'],
  DEVICE_STATUS: ['inactiveAfterMin'],
  TRIP_PERFORMANCE: ['groupBy'],
};
/** Report options saved with a schedule, per report type. {} = the API defaults. */
export type ScheduleReportOptions = Partial<Record<ReportType, ReportOptions>>;
export type ReportPeriod = 'DAY' | 'WEEK' | 'MONTH';
export type ReportFormat = 'XLSX' | 'PDF' | 'CSV';

/** Vehicles to include: union of branches, groups and objects, always intersected with the caller's data scope. Empty = all in scope. */
export interface ReportScope { branchIds: string[]; groupIds: string[]; objectIds: string[] }

export interface ReportRequest {
  type: ReportType;
  scope: ReportScope;
  from: string; // YYYY-MM-DD (company timezone, inclusive)
  to: string; // YYYY-MM-DD inclusive
  period?: ReportPeriod; // PERIOD_REPORT_TYPES only
  options?: ReportOptions;
}

/** CONSOLIDATED: one row per vehicle for the whole range. */
export interface ConsolidatedReportRow {
  objectId: string; objectName: string; plateNumber: string | null; branchName: string | null;
  days: number; activeDays: number;
  distanceKm: number; runningSec: number; idleSec: number; stopSec: number; offlineSec: number; engineSec: number;
  tripCount: number; maxSpeedKph: number; avgSpeedKph: number; overspeedCount: number;
  alertCount: number; criticalAlertCount: number; geofenceVisits: number;
  firstStart: string | null; lastStop: string | null;
}

/** DISTANCE: distance per vehicle per period. */
export interface DistanceReportRow {
  objectId: string; objectName: string; plateNumber: string | null; branchName: string | null; period: string;
  distanceKm: number; tripCount: number; runningSec: number; offlineSec: number;
}

/** ENGINE_HOURS: engine use per vehicle per period. */
export interface EngineHoursReportRow {
  objectId: string; objectName: string; plateNumber: string | null; branchName: string | null; period: string;
  engineSec: number; runningSec: number; idleSec: number; idlePct: number; distanceKm: number;
}

/** POSITIONS: raw points of one vehicle. */
export interface PositionReportRow {
  objectId: string; objectName: string; fixTime: string; serverTime: string;
  lat: number; lng: number; speedKph: number; course: number; altitude: number | null; satellites: number | null;
  valid: boolean; ignition: boolean | null; flags: string;
  extVoltage: number | null; batteryLevel: number | null; gsmSignal: number | null; alarm: string | null; odometerKm: number | null;
  /** Reverse-geocoded address (null = not resolved yet; show the coordinates). */
  address: string | null;
}

/** OVERSPEED: one row per speeding episode. */
export interface OverspeedReportRow {
  objectId: string; objectName: string; plateNumber: string | null;
  startTime: string; endTime: string; durationSec: number;
  limitKph: number; maxSpeedKph: number; avgSpeedKph: number; points: number;
  lat: number; lng: number;
  /** Address of the peak-speed point. */
  address: string | null;
}

/** IGNITION: one row per ignition state change. */
export interface IgnitionReportRow {
  objectId: string; objectName: string; plateNumber: string | null;
  time: string; state: 'ON' | 'OFF';
  /** How long the previous state lasted (null for the first change in range). */
  previousStateSec: number | null;
  lat: number; lng: number;
  address: string | null;
}

/** CONTINUOUS_DRIVING: a driving stretch without a long enough break. */
export interface ContinuousDrivingReportRow {
  objectId: string; objectName: string; plateNumber: string | null;
  startTime: string; endTime: string; drivingSec: number; spanSec: number; distanceKm: number; trips: number; longestBreakSec: number;
  startAddress: string | null; endAddress: string | null;
  startLat: number | null; startLng: number | null; endLat: number | null; endLng: number | null;
}

/** EVENT_SUMMARY: alert counts per vehicle and type. */
export interface EventSummaryReportRow {
  objectId: string; objectName: string; plateNumber: string | null;
  type: string; count: number; criticalCount: number; firstAt: string; lastAt: string;
}

/** GEOFENCE_SUMMARY: visits per vehicle and geofence. */
export interface GeofenceSummaryReportRow {
  objectId: string; objectName: string; geofenceId: string; geofenceName: string;
  visits: number; insideSec: number; avgVisitSec: number; firstEnter: string; lastExit: string | null;
}

/** DEVICE_STATUS: current state of each vehicle's device (range is ignored). */
export interface DeviceStatusReportRow {
  objectId: string; objectName: string; plateNumber: string | null; branchName: string | null;
  uniqueId: string | null; model: string | null; simNumber: string | null;
  status: 'ACTIVE' | 'INACTIVE' | 'NO_GPS' | 'NEVER_CONNECTED' | 'NO_DEVICE';
  lastSeenAt: string | null; lastFixTime: string | null; inactiveSec: number | null;
  lat: number | null; lng: number | null; batteryLevel: number | null; extVoltage: number | null; gsmSignal: number | null;
  /** Address of the last GPS fix. */
  address: string | null;
}

export interface SummaryReportRow {
  objectId: string; objectName: string; plateNumber: string | null; branchName: string | null;
  period: string; // '2026-10-18' | '2026-W42' | '2026-10'
  distanceKm: number; runningSec: number; idleSec: number; stopSec: number; offlineSec: number;
  tripCount: number; maxSpeedKph: number; avgSpeedKph: number; overspeedCount: number; engineSec: number;
  firstStart: string | null; lastStop: string | null;
}

/**
 * Utilisation: share of the tracked time the vehicle was moving, as a whole percent (running / running + idle +
 * stopped + offline). Null when there is no tracked time. Same figure on screen and in the downloaded reports.
 */
export function utilisationPct(r: { runningSec?: number; idleSec?: number; stopSec?: number; offlineSec?: number }): number | null {
  const run = r.runningSec ?? 0;
  const all = run + (r.idleSec ?? 0) + (r.stopSec ?? 0) + (r.offlineSec ?? 0);
  return all > 0 ? Math.round((run / all) * 100) : null;
}

export interface GeofenceVisitDto {
  objectId: string; objectName: string; geofenceId: string; geofenceName: string;
  enterTime: string; exitTime: string | null; durationSec: number | null;
}

/** GEOFENCE_DISTANCE: one trip, from a geofence's out time to the next geofence's in time. */
export interface GeofenceDistanceReportRow {
  objectId: string; objectName: string; plateNumber: string | null;
  fromGeofenceName: string; outTime: string;
  /** Null while the vehicle hasn't entered another geofence. */
  toGeofenceName: string | null; inTime: string | null;
  /** End of the measured stretch: the in time, else now or the end of the period. */
  untilTime: string;
  travelSec: number; distanceKm: number;
}

/**
 * TRIP_PERFORMANCE: planned trips (by planned start, company days) of one route / driver / vehicle. Stop figures count
 * stops with a recorded arrival; skipped stops are counted apart and left out of the on-time share. Planned vs actual
 * km cover finished trips (completed + incomplete) only.
 */
export interface TripPerformanceReportRow {
  groupBy: TripPerformanceGroupBy;
  /** Route / driver / vehicle id; null = trips without a driver. */
  groupId: string | null;
  groupName: string;
  trips: number; completed: number; incomplete: number; cancelled: number;
  /** Stops with a recorded arrival (not skipped): the on-time denominator. */
  ratedStops: number; onTimeStops: number;
  /** onTimeStops / ratedStops, percent with one decimal; null when no stop was reached. */
  onTimePct: number | null;
  skippedStops: number;
  /** Mean of actualStart − plannedStart over started trips (minutes, one decimal, + late / − early). */
  avgStartDelayMin: number | null;
  /** Mean arrival delay over rated stops (minutes, one decimal, + late / − early). */
  avgStopDelayMin: number | null;
  plannedKm: number; actualKm: number;
  deviations: number;
}

/** PLANNED_TRIPS: one row per planned trip. */
export interface PlannedTripReportRow {
  tripId: string;
  /** Null for ETMS door-to-door trips. */
  routeId: string | null; routeName: string;
  objectId: string; objectName: string; plateNumber: string | null;
  driverId: string | null; driverName: string | null;
  status: string;
  /** AUTO | MANUAL | TIMEOUT once closed. */
  closedBy: string | null;
  plannedStart: string; plannedEnd: string;
  actualStart: string | null; actualEnd: string | null;
  /** actualStart − plannedStart (minutes, one decimal); null before the start. */
  startDelayMin: number | null;
  /** Latest known delay vs plan (minutes, one decimal, + late / − early). */
  delayMin: number | null;
  stopsDone: number; stopCount: number; skippedStops: number; onTimeStops: number;
  deviationCount: number;
  /** Route snapshot path length, else straight legs between the stops. */
  plannedKm: number;
  /** Actual distance start → end (null until measured). */
  distanceKm: number | null;
}

export interface ReportResponse<T = unknown> {
  type: ReportType; from: string; to: string; period?: ReportPeriod;
  /** TRIP_PERFORMANCE: the grouping the rows use. */
  groupBy?: TripPerformanceGroupBy;
  rows: T[];
  totals?: Record<string, number>;
}

export interface ReportScheduleDto {
  id: string; name: string; ownerId: string; ownerName: string;
  reportTypes: ReportType[]; scope: ReportScope; period: ReportPeriod;
  frequency: 'DAILY' | 'WEEKLY' | 'MONTHLY';
  dayOfWeek: number | null; // 1–7 Monday–Sunday (WEEKLY)
  dayOfMonth: number | null; // 1–28 (MONTHLY)
  timeOfDay: string; // HH:mm company timezone
  format: ReportFormat; recipients: string[];
  /** Report options per report type (alert types, halt minutes...); {} = defaults. */
  options: ScheduleReportOptions;
  isActive: boolean; lastRunAt: string | null; nextRunAt: string | null;
  createdAt: string; updatedAt: string;
}

export interface ReportRunDto {
  id: string; scheduleId: string | null; scheduleName: string | null;
  reportTypes: ReportType[]; status: 'RUNNING' | 'SUCCEEDED' | 'FAILED';
  fileName: string | null; error: string | null; startedAt: string; finishedAt: string | null;
}

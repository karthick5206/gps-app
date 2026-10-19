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
  'DEVICE_STATUS',
  'DRIVERS',
  'DOCUMENTS',
  'POI_VISITS',
] as const;
export type ReportType = (typeof REPORT_TYPES)[number];

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
}
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
}

/** OVERSPEED: one row per speeding episode. */
export interface OverspeedReportRow {
  objectId: string; objectName: string; plateNumber: string | null;
  startTime: string; endTime: string; durationSec: number;
  limitKph: number; maxSpeedKph: number; avgSpeedKph: number; points: number;
  lat: number; lng: number;
}

/** IGNITION: one row per ignition state change. */
export interface IgnitionReportRow {
  objectId: string; objectName: string; plateNumber: string | null;
  time: string; state: 'ON' | 'OFF';
  /** How long the previous state lasted (null for the first change in range). */
  previousStateSec: number | null;
  lat: number; lng: number;
}

/** CONTINUOUS_DRIVING: a driving stretch without a long enough break. */
export interface ContinuousDrivingReportRow {
  objectId: string; objectName: string; plateNumber: string | null;
  startTime: string; endTime: string; drivingSec: number; spanSec: number; distanceKm: number; trips: number; longestBreakSec: number;
  startAddress: string | null; endAddress: string | null;
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
}

export interface SummaryReportRow {
  objectId: string; objectName: string; plateNumber: string | null; branchName: string | null;
  period: string; // '2026-10-18' | '2026-W42' | '2026-10'
  distanceKm: number; runningSec: number; idleSec: number; stopSec: number; offlineSec: number;
  tripCount: number; maxSpeedKph: number; avgSpeedKph: number; overspeedCount: number; engineSec: number;
  firstStart: string | null; lastStop: string | null;
}

export interface GeofenceVisitDto {
  objectId: string; objectName: string; geofenceId: string; geofenceName: string;
  enterTime: string; exitTime: string | null; durationSec: number | null;
}

export interface ReportResponse<T = unknown> {
  type: ReportType; from: string; to: string; period?: ReportPeriod;
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
  isActive: boolean; lastRunAt: string | null; nextRunAt: string | null;
  createdAt: string; updatedAt: string;
}

export interface ReportRunDto {
  id: string; scheduleId: string | null; scheduleName: string | null;
  reportTypes: ReportType[]; status: 'RUNNING' | 'SUCCEEDED' | 'FAILED';
  fileName: string | null; error: string | null; startedAt: string; finishedAt: string | null;
}

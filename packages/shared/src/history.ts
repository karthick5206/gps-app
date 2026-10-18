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

export const REPORT_TYPES = ['SUMMARY', 'TRIPS', 'STOPS', 'IDLE', 'ALERTS', 'GEOFENCE_VISITS'] as const;
export type ReportType = (typeof REPORT_TYPES)[number];
export type ReportPeriod = 'DAY' | 'WEEK' | 'MONTH';
export type ReportFormat = 'XLSX' | 'PDF' | 'CSV';

/** Vehicles to include: union of branches, groups and objects, always intersected with the caller's data scope. Empty = all in scope. */
export interface ReportScope { branchIds: string[]; groupIds: string[]; objectIds: string[] }

export interface ReportRequest {
  type: ReportType;
  scope: ReportScope;
  from: string; // YYYY-MM-DD (company timezone, inclusive)
  to: string; // YYYY-MM-DD inclusive
  period?: ReportPeriod; // SUMMARY only
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

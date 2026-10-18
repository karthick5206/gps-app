import type { ConsolidatedReportRow } from './history';

/** GET /dashboard/overview: fleet KPIs for "today" in the company timezone. */
export interface DashboardOverview {
  generatedAt: string;
  day: string; // YYYY-MM-DD (company timezone)
  total: number;
  byStatus: Record<string, number>;
  devicesOnline: number;
  todayDistanceKm: number;
  /** Distance recorded by Veetrax plus each vehicle's odometer offset. */
  totalOdometerKm: number;
  todayTrips: number;
  todayAlerts: { total: number; critical: number; byType: { type: string; count: number }[] };
  /** Vehicles currently inside each geofence (open visits). */
  geofences: { geofenceId: string; name: string; color: string | null; vehicles: number }[];
  vehiclesInsideGeofences: number;
  top: DashboardVehicleDistance[];
  bottom: DashboardVehicleDistance[];
}

export interface DashboardVehicleDistance {
  objectId: string;
  name: string;
  plateNumber: string | null;
  distanceKm: number;
  runningSec: number;
}

/** Health classification used by the criticality board (same rules as the Device status report). */
export type VehicleHealthStatus = 'ACTIVE' | 'INACTIVE' | 'NO_GPS' | 'NEVER_CONNECTED' | 'NO_DEVICE';

export interface VehicleRemarkDto {
  id: string;
  objectId: string;
  note: string;
  createdByName: string | null;
  createdAt: string;
}

/** GET /dashboard/health: one row per vehicle; the web derives the criticality and device-health tabs. */
export interface VehicleHealthRow {
  objectId: string;
  name: string;
  plateNumber: string | null;
  branchName: string | null;
  uniqueId: string | null;
  model: string | null;
  simNumber: string | null;
  status: VehicleHealthStatus;
  lastSeenAt: string | null;
  lastFixTime: string | null;
  inactiveSec: number | null;
  /** Device clock − server clock on the latest live packet (seconds); |value| > 15 min = wrong time zone/clock. */
  clockSkewSec: number | null;
  todayDistanceKm: number;
  batteryLevel: number | null;
  extVoltage: number | null;
  gsmSignal: number | null;
  lat: number | null;
  lng: number | null;
  remark: VehicleRemarkDto | null;
  maintenanceSince: string | null;
  maintenanceNote: string | null;
}

export interface DashboardHealth {
  generatedAt: string;
  inactiveAfterMin: number;
  rows: VehicleHealthRow[];
}

/** Device clock off by more than this is reported as "wrong time zone / clock". */
export const CLOCK_SKEW_LIMIT_SEC = 15 * 60;

/** GET /dashboard/compare: consolidated figures for a date range. */
export interface DashboardCompare {
  from: string;
  to: string;
  rows: ConsolidatedReportRow[];
  totals: Record<string, number>;
}

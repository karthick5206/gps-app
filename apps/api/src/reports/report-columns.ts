import {
  ALERT_TYPE_MAP,
  AlertDto,
  AlertTypeCode,
  GeofenceVisitDto,
  ReportType,
  StopDto,
  SummaryReportRow,
  TripDto,
} from '@veetracer/shared';
import { hhmmss, localTime } from './format';

export type Cell = string | number;

export interface ReportColumn {
  header: string;
  /** Approximate width in characters (XLSX) / relative weight (PDF). */
  width: number;
  numeric?: boolean;
  value: (row: never, tz: string) => Cell;
  total?: (totals: Record<string, number>) => Cell;
}

export const REPORT_TITLES: Record<ReportType, string> = {
  SUMMARY: 'Summary report',
  TRIPS: 'Trips report',
  STOPS: 'Stops report',
  IDLE: 'Idle report',
  ALERTS: 'Alerts report',
  GEOFENCE_VISITS: 'Geofence visits report',
};

const col = <T>(c: Omit<ReportColumn, 'value'> & { value: (row: T, tz: string) => Cell }): ReportColumn => c as ReportColumn;
const loc = (lat: number | null, lng: number | null) => (lat === null || lng === null ? '' : `${lat.toFixed(5)}, ${lng.toFixed(5)}`);
const num = (v: number, digits: number) => Number(v.toFixed(digits));

const SUMMARY: ReportColumn[] = [
  col<SummaryReportRow>({ header: 'Vehicle', width: 22, value: (r) => r.objectName, total: () => 'Total' }),
  col<SummaryReportRow>({ header: 'Plate', width: 14, value: (r) => r.plateNumber ?? '' }),
  col<SummaryReportRow>({ header: 'Branch', width: 14, value: (r) => r.branchName ?? '' }),
  col<SummaryReportRow>({ header: 'Period', width: 11, value: (r) => r.period, total: (t) => `${t.vehicles ?? 0} vehicles` }),
  col<SummaryReportRow>({ header: 'Distance (km)', width: 12, numeric: true, value: (r) => num(r.distanceKm, 2), total: (t) => num(t.distanceKm ?? 0, 2) }),
  col<SummaryReportRow>({ header: 'Running', width: 10, value: (r) => hhmmss(r.runningSec), total: (t) => hhmmss(t.runningSec) }),
  col<SummaryReportRow>({ header: 'Idle', width: 10, value: (r) => hhmmss(r.idleSec), total: (t) => hhmmss(t.idleSec) }),
  col<SummaryReportRow>({ header: 'Stopped', width: 10, value: (r) => hhmmss(r.stopSec), total: (t) => hhmmss(t.stopSec) }),
  col<SummaryReportRow>({ header: 'Offline', width: 10, value: (r) => hhmmss(r.offlineSec), total: (t) => hhmmss(t.offlineSec) }),
  col<SummaryReportRow>({ header: 'Engine on', width: 10, value: (r) => hhmmss(r.engineSec), total: (t) => hhmmss(t.engineSec) }),
  col<SummaryReportRow>({ header: 'Trips', width: 7, numeric: true, value: (r) => r.tripCount, total: (t) => t.tripCount ?? 0 }),
  col<SummaryReportRow>({ header: 'Max km/h', width: 9, numeric: true, value: (r) => num(r.maxSpeedKph, 1), total: (t) => num(t.maxSpeedKph ?? 0, 1) }),
  col<SummaryReportRow>({ header: 'Avg km/h', width: 9, numeric: true, value: (r) => num(r.avgSpeedKph, 1), total: (t) => num(t.avgSpeedKph ?? 0, 1) }),
  col<SummaryReportRow>({ header: 'Overspeed', width: 9, numeric: true, value: (r) => r.overspeedCount, total: (t) => t.overspeedCount ?? 0 }),
  col<SummaryReportRow>({ header: 'First start', width: 19, value: (r, tz) => localTime(r.firstStart, tz) }),
  col<SummaryReportRow>({ header: 'Last stop', width: 19, value: (r, tz) => localTime(r.lastStop, tz) }),
];

const TRIPS: ReportColumn[] = [
  col<TripDto>({ header: 'Vehicle', width: 22, value: (r) => r.objectName, total: (t) => `Total (${t.count ?? 0} trips)` }),
  col<TripDto>({ header: 'Start', width: 19, value: (r, tz) => localTime(r.startTime, tz) }),
  col<TripDto>({ header: 'End', width: 19, value: (r, tz) => localTime(r.endTime, tz) }),
  col<TripDto>({ header: 'Duration', width: 10, value: (r) => hhmmss(r.durationSec), total: (t) => hhmmss(t.durationSec) }),
  col<TripDto>({ header: 'Idle', width: 10, value: (r) => hhmmss(r.idleSec), total: (t) => hhmmss(t.idleSec) }),
  col<TripDto>({ header: 'Distance (km)', width: 12, numeric: true, value: (r) => num(r.distanceKm, 2), total: (t) => num(t.distanceKm ?? 0, 2) }),
  col<TripDto>({ header: 'Max km/h', width: 9, numeric: true, value: (r) => num(r.maxSpeedKph, 1), total: (t) => num(t.maxSpeedKph ?? 0, 1) }),
  col<TripDto>({ header: 'Avg km/h', width: 9, numeric: true, value: (r) => num(r.avgSpeedKph, 1) }),
  col<TripDto>({ header: 'From', width: 36, value: (r) => r.startAddress ?? loc(r.startLat, r.startLng) }),
  col<TripDto>({ header: 'To', width: 36, value: (r) => r.endAddress ?? loc(r.endLat, r.endLng) }),
];

const stopColumns = (label: string): ReportColumn[] => [
  col<StopDto>({ header: 'Vehicle', width: 22, value: (r) => r.objectName, total: (t) => `Total (${t.count ?? 0} ${label})` }),
  col<StopDto>({ header: 'Start', width: 19, value: (r, tz) => localTime(r.startTime, tz) }),
  col<StopDto>({ header: 'End', width: 19, value: (r, tz) => localTime(r.endTime, tz) }),
  col<StopDto>({ header: 'Duration', width: 10, value: (r) => hhmmss(r.durationSec), total: (t) => hhmmss(t.durationSec) }),
  col<StopDto>({ header: 'Type', width: 14, value: (r) => (r.ignitionOn ? 'Idle (engine on)' : 'Parked') }),
  col<StopDto>({ header: 'Location', width: 44, value: (r) => r.address ?? loc(r.lat, r.lng) }),
];

const ALERTS: ReportColumn[] = [
  col<AlertDto>({ header: 'Time', width: 19, value: (r, tz) => localTime(r.occurredAt, tz), total: (t) => `Total ${t.count ?? 0}` }),
  col<AlertDto>({ header: 'Vehicle', width: 22, value: (r) => r.objectName }),
  col<AlertDto>({ header: 'Plate', width: 14, value: (r) => r.plateNumber ?? '' }),
  col<AlertDto>({ header: 'Type', width: 22, value: (r) => ALERT_TYPE_MAP[r.type as AlertTypeCode]?.label ?? r.type }),
  col<AlertDto>({
    header: 'Severity',
    width: 10,
    value: (r) => r.severity,
    total: (t) => `C ${t.CRITICAL ?? 0} / W ${t.WARNING ?? 0} / I ${t.INFO ?? 0}`,
  }),
  col<AlertDto>({ header: 'Message', width: 40, value: (r) => r.message }),
  col<AlertDto>({ header: 'Location', width: 36, value: (r) => r.address ?? loc(r.lat, r.lng) }),
  col<AlertDto>({ header: 'Status', width: 13, value: (r) => r.status }),
  col<AlertDto>({ header: 'Acknowledged by', width: 18, value: (r) => r.ackByName ?? '' }),
];

const GEOFENCE_VISITS: ReportColumn[] = [
  col<GeofenceVisitDto>({ header: 'Vehicle', width: 22, value: (r) => r.objectName, total: (t) => `Total (${t.count ?? 0} visits)` }),
  col<GeofenceVisitDto>({ header: 'Geofence', width: 24, value: (r) => r.geofenceName }),
  col<GeofenceVisitDto>({ header: 'Entered', width: 19, value: (r, tz) => localTime(r.enterTime, tz) }),
  col<GeofenceVisitDto>({ header: 'Exited', width: 19, value: (r, tz) => (r.exitTime ? localTime(r.exitTime, tz) : 'Inside') }),
  col<GeofenceVisitDto>({ header: 'Duration', width: 10, value: (r) => hhmmss(r.durationSec), total: (t) => hhmmss(t.durationSec) }),
];

export function columnsFor(type: ReportType): ReportColumn[] {
  switch (type) {
    case 'SUMMARY':
      return SUMMARY;
    case 'TRIPS':
      return TRIPS;
    case 'STOPS':
      return stopColumns('stops');
    case 'IDLE':
      return stopColumns('idle stops');
    case 'ALERTS':
      return ALERTS;
    case 'GEOFENCE_VISITS':
      return GEOFENCE_VISITS;
  }
}


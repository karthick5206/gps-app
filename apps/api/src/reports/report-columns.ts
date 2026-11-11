import {
  ALERT_TYPE_MAP,
  AlertDto,
  AlertTypeCode,
  ConsolidatedReportRow,
  ContinuousDrivingReportRow,
  DeviceStatusReportRow,
  DriverReportRow,
  DocumentsReportRow,
  DistanceReportRow,
  EngineHoursReportRow,
  EventSummaryReportRow,
  GeofenceSummaryReportRow,
  GeofenceDistanceReportRow,
  GeofenceVisitDto,
  IgnitionReportRow,
  OverspeedReportRow,
  PoiVisitReportRow,
  FuelEventDto,
  FuelReportRow,
  MileageReportRow,
  IoDailyReportRow,
  IoSessionReportRow,
  PositionReportRow,
  PlannedTripReportRow,
  ReportType,
  StopDto,
  SummaryReportRow,
  TripDto,
  TripPerformanceGroupBy,
  TripPerformanceReportRow,
  utilisationPct,
} from '@veetracer/shared';
import type { AttendanceCorrectionRow, AttendanceDailyRow, AttendanceOutingRow, AttendanceSummaryRow, AttendancePayrollRow } from './attendance-reports';
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
  CONSOLIDATED: 'Consolidated summary report',
  DISTANCE: 'Distance report',
  ENGINE_HOURS: 'Engine hours report',
  TRIPS: 'Trips report',
  STOPS: 'Stops report',
  IDLE: 'Idle report',
  HALT: 'Halt / long stoppage report',
  CONTINUOUS_DRIVING: 'Continuous driving report',
  OVERSPEED: 'Over-speed report',
  IGNITION: 'Ignition on/off report',
  POSITIONS: 'Positions report',
  ALERTS: 'Alerts report',
  EVENT_SUMMARY: 'Event summary report',
  GEOFENCE_VISITS: 'Geofence visits report',
  GEOFENCE_SUMMARY: 'Geofence summary report',
  GEOFENCE_DISTANCE: 'Geofence out-to-in distance report',
  DEVICE_STATUS: 'Device status report',
  DRIVERS: 'Driver activity report',
  DOCUMENTS: 'Documents & services report',
  POI_VISITS: 'POI visits report',
  FUEL: 'Fuel report',
  FUEL_EVENTS: 'Fuel refills & drains report',
  MILEAGE: 'Mileage report (manual fuel entries)',
  AC_DOOR: 'AC / Door report',
  AC_DOOR_DAILY: 'AC / Door daily totals report',
  ATTENDANCE_DAILY: 'Daily attendance report',
  ATTENDANCE_SUMMARY: 'Attendance summary report',
  ATTENDANCE_PAYROLL: 'Attendance payroll report',
  ATTENDANCE_OUTINGS: 'Time outside report',
  ATTENDANCE_CORRECTIONS: 'Attendance corrections report',
  TRIP_PERFORMANCE: 'Trip performance report',
  PLANNED_TRIPS: 'Planned trips report',
};

const col = <T>(c: Omit<ReportColumn, 'value'> & { value: (row: T, tz: string) => Cell }): ReportColumn => c as ReportColumn;
const loc = (lat: number | null | undefined, lng: number | null | undefined) =>
  lat === null || lat === undefined || lng === null || lng === undefined ? '' : `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
/** Address, else "lat, lng" (addresses are filled when the report is generated, as far as the lookup budget allows). */
const place = (address: string | null | undefined, lat: number | null | undefined, lng: number | null | undefined) => address || loc(lat, lng);
const num = (v: number, digits: number) => Number(v.toFixed(digits));

/** Hours with two decimals, which payroll sheets can add up. */
const hours = (min: number) => num(min / 60, 2);
const words = (code: string) => code.charAt(0) + code.slice(1).toLowerCase().replace(/_/g, ' ');

const ATTENDANCE_DAILY: ReportColumn[] = [
  col<AttendanceDailyRow>({ header: 'Date', width: 11, value: (r) => r.day, total: (t) => `Total (${t.count ?? 0} days)` }),
  col<AttendanceDailyRow>({ header: 'Staff', width: 20, value: (r) => r.name }),
  col<AttendanceDailyRow>({ header: 'Staff ID', width: 12, value: (r) => r.employeeId ?? '' }),
  col<AttendanceDailyRow>({ header: 'Branch', width: 14, value: (r) => r.branch ?? '' }),
  col<AttendanceDailyRow>({ header: 'Shift', width: 12, value: (r) => r.shift }),
  col<AttendanceDailyRow>({ header: 'Status', width: 11, value: (r) => words(r.status) }),
  col<AttendanceDailyRow>({ header: 'First in', width: 19, value: (r, tz) => localTime(r.firstIn, tz) }),
  col<AttendanceDailyRow>({ header: 'Last out', width: 19, value: (r, tz) => localTime(r.lastOut, tz) }),
  col<AttendanceDailyRow>({ header: 'Hours worked', width: 9, numeric: true, value: (r) => hours(r.workedMin), total: (t) => hours(t.workedMin ?? 0) }),
  col<AttendanceDailyRow>({ header: 'Hours on site', width: 9, numeric: true, value: (r) => hours(r.onSiteMin), total: (t) => hours(t.onSiteMin ?? 0) }),
  col<AttendanceDailyRow>({ header: 'Official duty (h)', width: 9, numeric: true, value: (r) => hours(r.officialMin), total: (t) => hours(t.officialMin ?? 0) }),
  col<AttendanceDailyRow>({ header: 'Personal (h)', width: 9, numeric: true, value: (r) => hours(r.personalMin), total: (t) => hours(t.personalMin ?? 0) }),
  col<AttendanceDailyRow>({ header: 'Unexplained (h)', width: 9, numeric: true, value: (r) => hours(r.unexplainedMin), total: (t) => hours(t.unexplainedMin ?? 0) }),
  col<AttendanceDailyRow>({ header: 'No signal (h)', width: 9, numeric: true, value: (r) => hours(r.noSignalMin), total: (t) => hours(t.noSignalMin ?? 0) }),
  col<AttendanceDailyRow>({ header: 'Late (min)', width: 8, numeric: true, value: (r) => r.lateMin, total: (t) => t.lateMin ?? 0 }),
  col<AttendanceDailyRow>({ header: 'Early exit (min)', width: 8, numeric: true, value: (r) => r.earlyMin, total: (t) => t.earlyMin ?? 0 }),
  col<AttendanceDailyRow>({ header: 'Overtime (min)', width: 8, numeric: true, value: (r) => r.overtimeMin, total: (t) => t.overtimeMin ?? 0 }),
  col<AttendanceDailyRow>({ header: 'Site', width: 16, value: (r) => r.site ?? '' }),
  col<AttendanceDailyRow>({ header: 'First in location', width: 22, value: (r) => r.inLocation ?? '' }),
  col<AttendanceDailyRow>({ header: 'Last out location', width: 22, value: (r) => r.outLocation ?? '' }),
  col<AttendanceDailyRow>({ header: 'Selfie', width: 8, value: (r) => r.selfie }),
  col<AttendanceDailyRow>({ header: 'Selfie location', width: 22, value: (r) => r.selfieLocation ?? '' }),
  col<AttendanceDailyRow>({ header: 'Video', width: 9, value: (r) => r.video }),
  col<AttendanceDailyRow>({ header: 'Corrected', width: 18, value: (r) => r.corrected }),
];

const ATTENDANCE_PAYROLL: ReportColumn[] = [
  col<AttendancePayrollRow>({ header: 'Staff ID', width: 12, value: (r) => r.employeeId ?? '', total: () => 'Total' }),
  col<AttendancePayrollRow>({ header: 'Staff', width: 20, value: (r) => r.name, total: (t) => `${t.count ?? 0} staff` }),
  col<AttendancePayrollRow>({ header: 'Branch', width: 14, value: (r) => r.branch ?? '' }),
  col<AttendancePayrollRow>({ header: 'From', width: 11, value: (r) => r.from }),
  col<AttendancePayrollRow>({ header: 'To', width: 11, value: (r) => r.to }),
  col<AttendancePayrollRow>({ header: 'Working days', width: 8, numeric: true, value: (r) => r.workingDays, total: (t) => t.workingDays ?? 0 }),
  col<AttendancePayrollRow>({ header: 'Present days', width: 8, numeric: true, value: (r) => r.presentDays, total: (t) => t.presentDays ?? 0 }),
  col<AttendancePayrollRow>({ header: 'Half days', width: 7, numeric: true, value: (r) => r.halfDays, total: (t) => t.halfDays ?? 0 }),
  col<AttendancePayrollRow>({ header: 'Absent days', width: 7, numeric: true, value: (r) => r.absentDays, total: (t) => t.absentDays ?? 0 }),
  col<AttendancePayrollRow>({ header: 'Weekly offs', width: 7, numeric: true, value: (r) => r.weeklyOffs, total: (t) => t.weeklyOffs ?? 0 }),
  col<AttendancePayrollRow>({ header: 'Payable days', width: 8, numeric: true, value: (r) => r.payableDays, total: (t) => t.payableDays ?? 0 }),
  col<AttendancePayrollRow>({ header: 'LOP days', width: 7, numeric: true, value: (r) => r.lopDays, total: (t) => t.lopDays ?? 0 }),
  col<AttendancePayrollRow>({ header: 'Late days', width: 7, numeric: true, value: (r) => r.lateDays, total: (t) => t.lateDays ?? 0 }),
  col<AttendancePayrollRow>({ header: 'Late (min)', width: 8, numeric: true, value: (r) => r.lateMinutes, total: (t) => t.lateMinutes ?? 0 }),
  col<AttendancePayrollRow>({ header: 'Early leave days', width: 8, numeric: true, value: (r) => r.earlyLeaveDays, total: (t) => t.earlyLeaveDays ?? 0 }),
  col<AttendancePayrollRow>({ header: 'Early leave (min)', width: 8, numeric: true, value: (r) => r.earlyLeaveMinutes, total: (t) => t.earlyLeaveMinutes ?? 0 }),
  col<AttendancePayrollRow>({ header: 'Worked (h)', width: 9, numeric: true, value: (r) => r.workedHours, total: (t) => t.workedHours ?? 0 }),
  col<AttendancePayrollRow>({ header: 'Overtime (h)', width: 9, numeric: true, value: (r) => r.overtimeHours, total: (t) => t.overtimeHours ?? 0 }),
  col<AttendancePayrollRow>({ header: 'Official duty (h)', width: 9, numeric: true, value: (r) => r.officialDutyHours, total: (t) => t.officialDutyHours ?? 0 }),
  col<AttendancePayrollRow>({ header: 'Unexplained (h)', width: 9, numeric: true, value: (r) => r.unexplainedHours, total: (t) => t.unexplainedHours ?? 0 }),
  col<AttendancePayrollRow>({ header: 'Corrected days', width: 8, numeric: true, value: (r) => r.correctedDays, total: (t) => t.correctedDays ?? 0 }),
];

const ATTENDANCE_SUMMARY: ReportColumn[] = [
  col<AttendanceSummaryRow>({ header: 'Staff', width: 20, value: (r) => r.name, total: (t) => `Total (${t.count ?? 0} staff)` }),
  col<AttendanceSummaryRow>({ header: 'Staff ID', width: 12, value: (r) => r.employeeId ?? '' }),
  col<AttendanceSummaryRow>({ header: 'Branch', width: 14, value: (r) => r.branch ?? '' }),
  col<AttendanceSummaryRow>({ header: 'Working days', width: 8, numeric: true, value: (r) => r.workingDays, total: (t) => t.workingDays ?? 0 }),
  col<AttendanceSummaryRow>({ header: 'Present', width: 8, numeric: true, value: (r) => r.presentDays, total: (t) => t.presentDays ?? 0 }),
  col<AttendanceSummaryRow>({ header: 'Late', width: 7, numeric: true, value: (r) => r.lateDays, total: (t) => t.lateDays ?? 0 }),
  col<AttendanceSummaryRow>({ header: 'Half days', width: 7, numeric: true, value: (r) => r.halfDays, total: (t) => t.halfDays ?? 0 }),
  col<AttendanceSummaryRow>({ header: 'Absent', width: 7, numeric: true, value: (r) => r.absentDays, total: (t) => t.absentDays ?? 0 }),
  col<AttendanceSummaryRow>({ header: 'Days off', width: 7, numeric: true, value: (r) => r.daysOff, total: (t) => t.daysOff ?? 0 }),
  col<AttendanceSummaryRow>({ header: 'Attendance %', width: 9, numeric: true, value: (r) => r.attendancePct }),
  col<AttendanceSummaryRow>({ header: 'Hours worked', width: 9, numeric: true, value: (r) => hours(r.workedMin), total: (t) => hours(t.workedMin ?? 0) }),
  col<AttendanceSummaryRow>({ header: 'Avg hours / day', width: 9, numeric: true, value: (r) => hours(r.avgWorkedMin) }),
  col<AttendanceSummaryRow>({ header: 'Official duty (h)', width: 9, numeric: true, value: (r) => hours(r.officialMin), total: (t) => hours(t.officialMin ?? 0) }),
  col<AttendanceSummaryRow>({ header: 'Personal (h)', width: 9, numeric: true, value: (r) => hours(r.personalMin), total: (t) => hours(t.personalMin ?? 0) }),
  col<AttendanceSummaryRow>({ header: 'Unexplained (h)', width: 9, numeric: true, value: (r) => hours(r.unexplainedMin), total: (t) => hours(t.unexplainedMin ?? 0) }),
  col<AttendanceSummaryRow>({ header: 'No signal (h)', width: 9, numeric: true, value: (r) => hours(r.noSignalMin), total: (t) => hours(t.noSignalMin ?? 0) }),
  col<AttendanceSummaryRow>({ header: 'Late (min)', width: 8, numeric: true, value: (r) => r.lateMin, total: (t) => t.lateMin ?? 0 }),
  col<AttendanceSummaryRow>({ header: 'Early exit (min)', width: 8, numeric: true, value: (r) => r.earlyMin, total: (t) => t.earlyMin ?? 0 }),
  col<AttendanceSummaryRow>({ header: 'Overtime (min)', width: 8, numeric: true, value: (r) => r.overtimeMin, total: (t) => t.overtimeMin ?? 0 }),
  col<AttendanceSummaryRow>({ header: 'Selfies taken', width: 8, numeric: true, value: (r) => r.selfiesTaken, total: (t) => t.selfiesTaken ?? 0 }),
  col<AttendanceSummaryRow>({ header: 'Selfies missing', width: 8, numeric: true, value: (r) => r.selfiesMissing, total: (t) => t.selfiesMissing ?? 0 }),
  col<AttendanceSummaryRow>({ header: 'Corrected days', width: 8, numeric: true, value: (r) => r.correctedDays, total: (t) => t.correctedDays ?? 0 }),
];

const ATTENDANCE_OUTINGS: ReportColumn[] = [
  col<AttendanceOutingRow>({ header: 'Date', width: 11, value: (r) => r.day, total: (t) => `Total (${t.count ?? 0})` }),
  col<AttendanceOutingRow>({ header: 'Staff', width: 20, value: (r) => r.name }),
  col<AttendanceOutingRow>({ header: 'Staff ID', width: 12, value: (r) => r.employeeId ?? '' }),
  col<AttendanceOutingRow>({ header: 'Branch', width: 14, value: (r) => r.branch ?? '' }),
  col<AttendanceOutingRow>({ header: 'Site', width: 16, value: (r) => r.site ?? '' }),
  col<AttendanceOutingRow>({ header: 'Left', width: 19, value: (r, tz) => localTime(r.leftAt, tz) }),
  col<AttendanceOutingRow>({ header: 'Returned', width: 19, value: (r, tz) => localTime(r.returnedAt, tz) }),
  col<AttendanceOutingRow>({ header: 'Minutes', width: 8, numeric: true, value: (r) => r.minutes, total: (t) => t.minutes ?? 0 }),
  col<AttendanceOutingRow>({ header: 'Counts as', width: 12, value: (r) => words(r.kind) }),
  col<AttendanceOutingRow>({ header: 'Employee said', width: 12, value: (r) => (r.employeeSaid ? words(r.employeeSaid) : '') }),
  col<AttendanceOutingRow>({ header: 'Employee note', width: 22, value: (r) => r.employeeNote ?? '' }),
  col<AttendanceOutingRow>({ header: 'Decided by', width: 16, value: (r) => r.decidedBy ?? '' }),
  col<AttendanceOutingRow>({ header: 'Note', width: 22, value: (r) => r.note ?? '' }),
  col<AttendanceOutingRow>({ header: 'Location', width: 22, value: (r) => r.location ?? '' }),
];

const ATTENDANCE_CORRECTIONS: ReportColumn[] = [
  col<AttendanceCorrectionRow>({ header: 'Date', width: 11, value: (r) => r.day, total: (t) => `Total (${t.count ?? 0})` }),
  col<AttendanceCorrectionRow>({ header: 'Staff', width: 20, value: (r) => r.name }),
  col<AttendanceCorrectionRow>({ header: 'Staff ID', width: 12, value: (r) => r.employeeId ?? '' }),
  col<AttendanceCorrectionRow>({ header: 'Branch', width: 14, value: (r) => r.branch ?? '' }),
  col<AttendanceCorrectionRow>({ header: 'Calculated', width: 12, value: (r) => (r.calculated ? words(r.calculated) : '') }),
  col<AttendanceCorrectionRow>({ header: 'Corrected to', width: 12, value: (r) => words(r.correctedTo) }),
  col<AttendanceCorrectionRow>({ header: 'Reason', width: 28, value: (r) => r.note ?? '' }),
  col<AttendanceCorrectionRow>({ header: 'Corrected by', width: 18, value: (r) => r.correctedBy ?? '' }),
  col<AttendanceCorrectionRow>({ header: 'Corrected at', width: 19, value: (r, tz) => localTime(r.correctedAt, tz) }),
];

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
  col<SummaryReportRow>({ header: 'Utilisation %', width: 12, numeric: true, value: (r) => utilisationPct(r) ?? '', total: (t) => utilisationPct(t) ?? '' }),
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
  col<TripDto>({ header: 'From', width: 36, value: (r) => place(r.startAddress, r.startLat, r.startLng) }),
  col<TripDto>({ header: 'To', width: 36, value: (r) => place(r.endAddress, r.endLat, r.endLng) }),
];

const stopColumns = (label: string): ReportColumn[] => [
  col<StopDto>({ header: 'Vehicle', width: 22, value: (r) => r.objectName, total: (t) => `Total (${t.count ?? 0} ${label})` }),
  col<StopDto>({ header: 'Start', width: 19, value: (r, tz) => localTime(r.startTime, tz) }),
  col<StopDto>({ header: 'End', width: 19, value: (r, tz) => localTime(r.endTime, tz) }),
  col<StopDto>({ header: 'Duration', width: 10, value: (r) => hhmmss(r.durationSec), total: (t) => hhmmss(t.durationSec) }),
  col<StopDto>({ header: 'Type', width: 14, value: (r) => (r.ignitionOn ? 'Idle (engine on)' : 'Parked') }),
  col<StopDto>({ header: 'POI', width: 20, value: (r) => r.poiName ?? '' }),
  col<StopDto>({ header: 'Location', width: 40, value: (r) => place(r.address, r.lat, r.lng) }),
];

const litres = (v: number | null) => (v === null ? '' : Math.round(v * 10) / 10);

const FUEL: ReportColumn[] = [
  col<FuelReportRow>({ header: 'Vehicle', width: 22, value: (r) => r.objectName, total: (t) => `Total (${t.vehicles ?? 0} vehicles)` }),
  col<FuelReportRow>({ header: 'Day', width: 11, value: (r) => r.day }),
  col<FuelReportRow>({ header: 'Start (L)', width: 9, numeric: true, value: (r) => litres(r.startL) }),
  col<FuelReportRow>({ header: 'End (L)', width: 9, numeric: true, value: (r) => litres(r.endL) }),
  col<FuelReportRow>({ header: 'Refills', width: 8, numeric: true, value: (r) => r.refills, total: (t) => t.refills ?? 0 }),
  col<FuelReportRow>({ header: 'Refilled (L)', width: 11, numeric: true, value: (r) => r.refillL, total: (t) => t.refillL ?? 0 }),
  col<FuelReportRow>({ header: 'Drains', width: 8, numeric: true, value: (r) => r.drains, total: (t) => t.drains ?? 0 }),
  col<FuelReportRow>({ header: 'Drained (L)', width: 11, numeric: true, value: (r) => r.drainL, total: (t) => t.drainL ?? 0 }),
  col<FuelReportRow>({ header: 'Consumed (L)', width: 12, numeric: true, value: (r) => litres(r.consumptionL), total: (t) => t.consumptionL ?? 0 }),
  col<FuelReportRow>({ header: 'Distance (km)', width: 12, numeric: true, value: (r) => r.distanceKm, total: (t) => t.distanceKm ?? 0 }),
  col<FuelReportRow>({ header: 'km/L', width: 8, numeric: true, value: (r) => r.kmPerL ?? '', total: (t) => t.kmPerL || '' }),
  col<FuelReportRow>({ header: 'L/100 km', width: 9, numeric: true, value: (r) => r.lPer100Km ?? '' }),
];

const FUEL_EVENTS: ReportColumn[] = [
  col<FuelEventDto>({ header: 'Vehicle', width: 22, value: (r) => r.objectName, total: (t) => `Total (${t.refills ?? 0} refills, ${t.drains ?? 0} drains)` }),
  col<FuelEventDto>({ header: 'Plate', width: 14, value: (r) => r.plateNumber ?? '' }),
  col<FuelEventDto>({ header: 'Event', width: 12, value: (r) => (r.type === 'REFILL' ? 'Refill' : 'Drain') }),
  col<FuelEventDto>({ header: 'Start', width: 19, value: (r, tz) => localTime(r.startTime, tz) }),
  col<FuelEventDto>({ header: 'End', width: 19, value: (r, tz) => localTime(r.endTime, tz) }),
  col<FuelEventDto>({ header: 'Before (L)', width: 10, numeric: true, value: (r) => r.litresBefore }),
  col<FuelEventDto>({ header: 'After (L)', width: 10, numeric: true, value: (r) => r.litresAfter }),
  col<FuelEventDto>({ header: 'Change (L)', width: 10, numeric: true, value: (r) => (r.type === 'REFILL' ? r.deltaL : -r.deltaL) }),
  col<FuelEventDto>({ header: 'Location', width: 36, value: (r) => place(r.address, r.lat, r.lng) }),
];

const rupees = (v: number | null) => (v === null ? '' : Math.round(v * 100) / 100);
const MILEAGE: ReportColumn[] = [
  col<MileageReportRow>({ header: 'Vehicle', width: 22, value: (r) => r.objectName, total: (t) => `Total (${t.runs ?? 0} full-tank runs)` }),
  col<MileageReportRow>({ header: 'Plate', width: 14, value: (r) => r.plateNumber ?? '' }),
  col<MileageReportRow>({ header: 'From (full tank)', width: 19, value: (r, tz) => localTime(r.fromAt, tz) }),
  col<MileageReportRow>({ header: 'To (full tank)', width: 19, value: (r, tz) => localTime(r.toAt, tz) }),
  col<MileageReportRow>({ header: 'Fill-ups', width: 8, numeric: true, value: (r) => r.fillUps, total: (t) => t.fillUps ?? 0 }),
  col<MileageReportRow>({ header: 'Litres', width: 9, numeric: true, value: (r) => r.litres, total: (t) => t.litres ?? 0 }),
  col<MileageReportRow>({ header: 'Fuel cost (Rs)', width: 12, numeric: true, value: (r) => rupees(r.fuelCost), total: (t) => t.fuelCost ?? 0 }),
  col<MileageReportRow>({ header: 'Distance (km)', width: 12, numeric: true, value: (r) => r.distanceKm, total: (t) => t.distanceKm ?? 0 }),
  col<MileageReportRow>({ header: 'Mileage (km/L)', width: 11, numeric: true, value: (r) => r.kmPerL ?? '', total: (t) => t.kmPerL || '' }),
  col<MileageReportRow>({ header: 'Fuel cost / km (Rs)', width: 12, numeric: true, value: (r) => rupees(r.costPerKm), total: (t) => t.costPerKm || '' }),
];

const ioStatus = (r: IoSessionReportRow) => (r.kind === 'AC' ? (r.on ? 'On' : 'Off') : r.on ? 'Open' : 'Closed');

const AC_DOOR: ReportColumn[] = [
  col<IoSessionReportRow>({ header: 'Vehicle', width: 22, value: (r) => r.objectName, total: (t) => `Total (${t.count ?? 0} periods)` }),
  col<IoSessionReportRow>({ header: 'Plate', width: 14, value: (r) => r.plateNumber ?? '' }),
  col<IoSessionReportRow>({ header: 'Sensor', width: 8, value: (r) => (r.kind === 'AC' ? 'AC' : 'Door') }),
  col<IoSessionReportRow>({ header: 'Status', width: 8, value: (r) => ioStatus(r) }),
  col<IoSessionReportRow>({ header: 'Start', width: 19, value: (r, tz) => localTime(r.startTime, tz) }),
  col<IoSessionReportRow>({ header: 'End', width: 19, value: (r, tz) => (r.endTime ? localTime(r.endTime, tz) : 'Ongoing') }),
  col<IoSessionReportRow>({ header: 'Duration', width: 10, value: (r) => hhmmss(r.durationSec), total: (t) => `AC on ${hhmmss(t.acOnSec ?? 0)}` }),
  col<IoSessionReportRow>({ header: 'Engine off', width: 10, value: (r) => hhmmss(r.engineOffSec), total: (t) => hhmmss(t.acOnEngineOffSec ?? 0) }),
  col<IoSessionReportRow>({ header: 'Distance (km)', width: 12, numeric: true, value: (r) => num(r.distanceKm, 2) }),
  col<IoSessionReportRow>({ header: 'Start address', width: 36, value: (r) => place(r.startAddress, r.startLat, r.startLng) }),
  col<IoSessionReportRow>({
    header: 'End address', width: 36, value: (r) => place(r.endAddress, r.endLat, r.endLng),
    total: (t) => `Door opened ${t.doorOpenCount ?? 0} times, ${hhmmss(t.doorOpenSec ?? 0)}`,
  }),
];

const AC_DOOR_DAILY: ReportColumn[] = [
  col<IoDailyReportRow>({ header: 'Vehicle', width: 22, value: (r) => r.objectName, total: (t) => `Total (${t.vehicles ?? 0} vehicles)` }),
  col<IoDailyReportRow>({ header: 'Plate', width: 14, value: (r) => r.plateNumber ?? '' }),
  col<IoDailyReportRow>({ header: 'Day', width: 11, value: (r) => r.day }),
  col<IoDailyReportRow>({ header: 'AC on', width: 10, value: (r) => hhmmss(r.acOnSec), total: (t) => hhmmss(t.acOnSec ?? 0) }),
  col<IoDailyReportRow>({ header: 'AC on, engine off', width: 14, value: (r) => hhmmss(r.acOnEngineOffSec), total: (t) => hhmmss(t.acOnEngineOffSec ?? 0) }),
  col<IoDailyReportRow>({ header: 'AC switch-ons', width: 11, numeric: true, value: (r) => r.acOnCount, total: (t) => t.acOnCount ?? 0 }),
  col<IoDailyReportRow>({ header: 'Km with AC on', width: 11, numeric: true, value: (r) => num(r.acDistanceKm, 2), total: (t) => num(t.acDistanceKm ?? 0, 2) }),
  col<IoDailyReportRow>({ header: 'Door opened', width: 10, numeric: true, value: (r) => r.doorOpenCount, total: (t) => t.doorOpenCount ?? 0 }),
  col<IoDailyReportRow>({ header: 'Door open time', width: 12, value: (r) => hhmmss(r.doorOpenSec), total: (t) => hhmmss(t.doorOpenSec ?? 0) }),
];

const POI_VISITS: ReportColumn[] = [
  col<PoiVisitReportRow>({ header: 'Vehicle', width: 22, value: (r) => r.objectName, total: (t) => `Total (${t.count ?? 0} visits, ${t.pois ?? 0} POIs)` }),
  col<PoiVisitReportRow>({ header: 'POI', width: 24, value: (r) => r.poiName }),
  col<PoiVisitReportRow>({ header: 'Category', width: 14, value: (r) => r.category }),
  col<PoiVisitReportRow>({ header: 'Arrival', width: 19, value: (r, tz) => localTime(r.arrival, tz) }),
  col<PoiVisitReportRow>({ header: 'Departure', width: 19, value: (r, tz) => localTime(r.departure, tz) }),
  col<PoiVisitReportRow>({ header: 'Duration', width: 10, value: (r) => hhmmss(r.durationSec), total: (t) => hhmmss(t.durationSec) }),
  col<PoiVisitReportRow>({ header: 'Distance (m)', width: 10, numeric: true, value: (r) => r.distanceM }),
  col<PoiVisitReportRow>({ header: 'Engine', width: 10, value: (r) => (r.ignitionOn ? 'On' : 'Off') }),
  col<PoiVisitReportRow>({ header: 'Location', width: 36, value: (r) => place(r.address, r.lat, r.lng) }),
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
  col<AlertDto>({ header: 'Location', width: 36, value: (r) => place(r.address, r.lat, r.lng) }),
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

const vehicleCols = <T extends { objectName: string; plateNumber: string | null }>(totalLabel: (t: Record<string, number>) => string): ReportColumn[] => [
  col<T>({ header: 'Vehicle', width: 22, value: (r) => r.objectName, total: totalLabel }),
  col<T>({ header: 'Plate', width: 14, value: (r) => r.plateNumber ?? '' }),
];
const yesNo = (v: boolean | null) => (v === null ? '' : v ? 'On' : 'Off');

const CONSOLIDATED: ReportColumn[] = [
  ...vehicleCols<ConsolidatedReportRow>((t) => `Total (${t.vehicles ?? 0} vehicles)`),
  col<ConsolidatedReportRow>({ header: 'Branch', width: 14, value: (r) => r.branchName ?? '' }),
  col<ConsolidatedReportRow>({ header: 'Active days', width: 9, numeric: true, value: (r) => r.activeDays, total: (t) => t.activeDays ?? 0 }),
  col<ConsolidatedReportRow>({ header: 'Distance (km)', width: 12, numeric: true, value: (r) => num(r.distanceKm, 2), total: (t) => num(t.distanceKm ?? 0, 2) }),
  col<ConsolidatedReportRow>({ header: 'Running', width: 10, value: (r) => hhmmss(r.runningSec), total: (t) => hhmmss(t.runningSec) }),
  col<ConsolidatedReportRow>({ header: 'Idle', width: 10, value: (r) => hhmmss(r.idleSec), total: (t) => hhmmss(t.idleSec) }),
  col<ConsolidatedReportRow>({ header: 'Stopped', width: 10, value: (r) => hhmmss(r.stopSec), total: (t) => hhmmss(t.stopSec) }),
  col<ConsolidatedReportRow>({ header: 'Engine on', width: 10, value: (r) => hhmmss(r.engineSec), total: (t) => hhmmss(t.engineSec) }),
  col<ConsolidatedReportRow>({ header: 'Trips', width: 7, numeric: true, value: (r) => r.tripCount, total: (t) => t.tripCount ?? 0 }),
  col<ConsolidatedReportRow>({ header: 'Max km/h', width: 9, numeric: true, value: (r) => num(r.maxSpeedKph, 1), total: (t) => num(t.maxSpeedKph ?? 0, 1) }),
  col<ConsolidatedReportRow>({ header: 'Avg km/h', width: 9, numeric: true, value: (r) => num(r.avgSpeedKph, 1) }),
  col<ConsolidatedReportRow>({ header: 'Overspeed', width: 9, numeric: true, value: (r) => r.overspeedCount, total: (t) => t.overspeedCount ?? 0 }),
  col<ConsolidatedReportRow>({ header: 'Alerts', width: 8, numeric: true, value: (r) => r.alertCount, total: (t) => t.alertCount ?? 0 }),
  col<ConsolidatedReportRow>({ header: 'Critical', width: 8, numeric: true, value: (r) => r.criticalAlertCount, total: (t) => t.criticalAlertCount ?? 0 }),
  col<ConsolidatedReportRow>({ header: 'Geofence visits', width: 10, numeric: true, value: (r) => r.geofenceVisits, total: (t) => t.geofenceVisits ?? 0 }),
  col<ConsolidatedReportRow>({ header: 'First start', width: 19, value: (r, tz) => localTime(r.firstStart, tz) }),
  col<ConsolidatedReportRow>({ header: 'Last stop', width: 19, value: (r, tz) => localTime(r.lastStop, tz) }),
];

const DISTANCE: ReportColumn[] = [
  ...vehicleCols<DistanceReportRow>((t) => `Total (${t.vehicles ?? 0} vehicles)`),
  col<DistanceReportRow>({ header: 'Branch', width: 14, value: (r) => r.branchName ?? '' }),
  col<DistanceReportRow>({ header: 'Period', width: 11, value: (r) => r.period }),
  col<DistanceReportRow>({ header: 'Distance (km)', width: 12, numeric: true, value: (r) => num(r.distanceKm, 2), total: (t) => num(t.distanceKm ?? 0, 2) }),
  col<DistanceReportRow>({ header: 'Trips', width: 7, numeric: true, value: (r) => r.tripCount, total: (t) => t.tripCount ?? 0 }),
  col<DistanceReportRow>({ header: 'Running', width: 10, value: (r) => hhmmss(r.runningSec), total: (t) => hhmmss(t.runningSec) }),
  col<DistanceReportRow>({ header: 'Offline', width: 10, value: (r) => hhmmss(r.offlineSec), total: (t) => hhmmss(t.offlineSec) }),
];

const ENGINE_HOURS: ReportColumn[] = [
  ...vehicleCols<EngineHoursReportRow>((t) => `Total (${t.vehicles ?? 0} vehicles)`),
  col<EngineHoursReportRow>({ header: 'Period', width: 11, value: (r) => r.period }),
  col<EngineHoursReportRow>({ header: 'Engine on', width: 10, value: (r) => hhmmss(r.engineSec), total: (t) => hhmmss(t.engineSec) }),
  col<EngineHoursReportRow>({ header: 'Running', width: 10, value: (r) => hhmmss(r.runningSec), total: (t) => hhmmss(t.runningSec) }),
  col<EngineHoursReportRow>({ header: 'Idle', width: 10, value: (r) => hhmmss(r.idleSec), total: (t) => hhmmss(t.idleSec) }),
  col<EngineHoursReportRow>({ header: 'Idle %', width: 8, numeric: true, value: (r) => r.idlePct, total: (t) => t.idlePct ?? 0 }),
  col<EngineHoursReportRow>({ header: 'Distance (km)', width: 12, numeric: true, value: (r) => num(r.distanceKm, 2), total: (t) => num(t.distanceKm ?? 0, 2) }),
];

const POSITIONS: ReportColumn[] = [
  col<PositionReportRow>({ header: 'GPS time', width: 19, value: (r, tz) => localTime(r.fixTime, tz), total: (t) => `${t.count ?? 0} points` }),
  col<PositionReportRow>({ header: 'Server time', width: 19, value: (r, tz) => localTime(r.serverTime, tz) }),
  col<PositionReportRow>({ header: 'Latitude', width: 10, numeric: true, value: (r) => num(r.lat, 6) }),
  col<PositionReportRow>({ header: 'Longitude', width: 10, numeric: true, value: (r) => num(r.lng, 6) }),
  col<PositionReportRow>({ header: 'Address', width: 36, value: (r) => r.address ?? '' }),
  col<PositionReportRow>({ header: 'km/h', width: 7, numeric: true, value: (r) => r.speedKph, total: (t) => `max ${t.maxSpeedKph ?? 0}` }),
  col<PositionReportRow>({ header: 'Course', width: 7, numeric: true, value: (r) => r.course }),
  col<PositionReportRow>({ header: 'Sats', width: 6, numeric: true, value: (r) => r.satellites ?? '' }),
  col<PositionReportRow>({ header: 'Valid', width: 6, value: (r) => (r.valid ? 'Yes' : 'No') }),
  col<PositionReportRow>({ header: 'Ignition', width: 8, value: (r) => yesNo(r.ignition) }),
  col<PositionReportRow>({ header: 'Ext. V', width: 7, numeric: true, value: (r) => r.extVoltage ?? '' }),
  col<PositionReportRow>({ header: 'Battery %', width: 8, numeric: true, value: (r) => r.batteryLevel ?? '' }),
  col<PositionReportRow>({ header: 'GSM', width: 5, numeric: true, value: (r) => r.gsmSignal ?? '' }),
  col<PositionReportRow>({ header: 'Odometer (km)', width: 11, numeric: true, value: (r) => r.odometerKm ?? '' }),
  col<PositionReportRow>({ header: 'Alarm', width: 12, value: (r) => r.alarm ?? '' }),
  col<PositionReportRow>({ header: 'Flags', width: 14, value: (r) => r.flags }),
];

const OVERSPEED: ReportColumn[] = [
  ...vehicleCols<OverspeedReportRow>((t) => `Total (${t.count ?? 0} episodes)`),
  col<OverspeedReportRow>({ header: 'Start', width: 19, value: (r, tz) => localTime(r.startTime, tz) }),
  col<OverspeedReportRow>({ header: 'End', width: 19, value: (r, tz) => localTime(r.endTime, tz) }),
  col<OverspeedReportRow>({ header: 'Duration', width: 10, value: (r) => hhmmss(r.durationSec), total: (t) => hhmmss(t.durationSec) }),
  col<OverspeedReportRow>({ header: 'Limit km/h', width: 9, numeric: true, value: (r) => r.limitKph }),
  col<OverspeedReportRow>({ header: 'Max km/h', width: 9, numeric: true, value: (r) => r.maxSpeedKph, total: (t) => t.maxSpeedKph ?? 0 }),
  col<OverspeedReportRow>({ header: 'Avg km/h', width: 9, numeric: true, value: (r) => r.avgSpeedKph }),
  col<OverspeedReportRow>({ header: 'Location (peak)', width: 36, value: (r) => place(r.address, r.lat, r.lng) }),
];

const IGNITION: ReportColumn[] = [
  ...vehicleCols<IgnitionReportRow>((t) => `Total ${t.count ?? 0} (on ${t.ON ?? 0} / off ${t.OFF ?? 0})`),
  col<IgnitionReportRow>({ header: 'Time', width: 19, value: (r, tz) => localTime(r.time, tz) }),
  col<IgnitionReportRow>({ header: 'Ignition', width: 9, value: (r) => r.state }),
  col<IgnitionReportRow>({ header: 'Previous state for', width: 14, value: (r) => hhmmss(r.previousStateSec) }),
  col<IgnitionReportRow>({ header: 'Location', width: 36, value: (r) => place(r.address, r.lat, r.lng) }),
];

const CONTINUOUS_DRIVING: ReportColumn[] = [
  ...vehicleCols<ContinuousDrivingReportRow>((t) => `Total (${t.count ?? 0} stretches)`),
  col<ContinuousDrivingReportRow>({ header: 'Start', width: 19, value: (r, tz) => localTime(r.startTime, tz) }),
  col<ContinuousDrivingReportRow>({ header: 'End', width: 19, value: (r, tz) => localTime(r.endTime, tz) }),
  col<ContinuousDrivingReportRow>({ header: 'Driving', width: 10, value: (r) => hhmmss(r.drivingSec), total: (t) => hhmmss(t.drivingSec) }),
  col<ContinuousDrivingReportRow>({ header: 'Span', width: 10, value: (r) => hhmmss(r.spanSec) }),
  col<ContinuousDrivingReportRow>({ header: 'Longest break', width: 11, value: (r) => hhmmss(r.longestBreakSec) }),
  col<ContinuousDrivingReportRow>({ header: 'Trips', width: 7, numeric: true, value: (r) => r.trips }),
  col<ContinuousDrivingReportRow>({ header: 'Distance (km)', width: 12, numeric: true, value: (r) => num(r.distanceKm, 2), total: (t) => num(t.distanceKm ?? 0, 2) }),
  col<ContinuousDrivingReportRow>({ header: 'From', width: 32, value: (r) => place(r.startAddress, r.startLat, r.startLng) }),
  col<ContinuousDrivingReportRow>({ header: 'To', width: 32, value: (r) => place(r.endAddress, r.endLat, r.endLng) }),
];

const EVENT_SUMMARY: ReportColumn[] = [
  ...vehicleCols<EventSummaryReportRow>((t) => `Total ${t.count ?? 0} events`),
  col<EventSummaryReportRow>({ header: 'Event', width: 22, value: (r) => ALERT_TYPE_MAP[r.type as AlertTypeCode]?.label ?? r.type }),
  col<EventSummaryReportRow>({ header: 'Count', width: 8, numeric: true, value: (r) => r.count, total: (t) => t.count ?? 0 }),
  col<EventSummaryReportRow>({ header: 'Critical', width: 8, numeric: true, value: (r) => r.criticalCount, total: (t) => t.criticalCount ?? 0 }),
  col<EventSummaryReportRow>({ header: 'First', width: 19, value: (r, tz) => localTime(r.firstAt, tz) }),
  col<EventSummaryReportRow>({ header: 'Last', width: 19, value: (r, tz) => localTime(r.lastAt, tz) }),
];

const GEOFENCE_DISTANCE: ReportColumn[] = [
  col<GeofenceDistanceReportRow>({ header: 'Vehicle', width: 22, value: (r) => r.objectName, total: (t) => `Total (${t.count ?? 0} trips)` }),
  col<GeofenceDistanceReportRow>({ header: 'Plate', width: 14, value: (r) => r.plateNumber ?? '' }),
  col<GeofenceDistanceReportRow>({ header: 'From geofence', width: 24, value: (r) => r.fromGeofenceName }),
  col<GeofenceDistanceReportRow>({ header: 'Out time', width: 19, value: (r, tz) => localTime(r.outTime, tz) }),
  col<GeofenceDistanceReportRow>({ header: 'To geofence', width: 24, value: (r) => r.toGeofenceName ?? '' }),
  col<GeofenceDistanceReportRow>({ header: 'In time', width: 19, value: (r, tz) => (r.inTime ? localTime(r.inTime, tz) : 'Not yet') }),
  col<GeofenceDistanceReportRow>({ header: 'Travel time', width: 11, value: (r) => hhmmss(r.travelSec), total: (t) => hhmmss(t.travelSec) }),
  col<GeofenceDistanceReportRow>({ header: 'Distance (km)', width: 12, numeric: true, value: (r) => num(r.distanceKm, 2), total: (t) => num(t.distanceKm ?? 0, 2) }),
];

const GEOFENCE_SUMMARY: ReportColumn[] = [
  col<GeofenceSummaryReportRow>({ header: 'Vehicle', width: 22, value: (r) => r.objectName, total: (t) => `Total (${t.visits ?? 0} visits)` }),
  col<GeofenceSummaryReportRow>({ header: 'Geofence', width: 24, value: (r) => r.geofenceName }),
  col<GeofenceSummaryReportRow>({ header: 'Visits', width: 7, numeric: true, value: (r) => r.visits, total: (t) => t.visits ?? 0 }),
  col<GeofenceSummaryReportRow>({ header: 'Time inside', width: 11, value: (r) => hhmmss(r.insideSec), total: (t) => hhmmss(t.insideSec) }),
  col<GeofenceSummaryReportRow>({ header: 'Avg visit', width: 10, value: (r) => hhmmss(r.avgVisitSec) }),
  col<GeofenceSummaryReportRow>({ header: 'First entry', width: 19, value: (r, tz) => localTime(r.firstEnter, tz) }),
  col<GeofenceSummaryReportRow>({ header: 'Last exit', width: 19, value: (r, tz) => (r.lastExit ? localTime(r.lastExit, tz) : 'Inside') }),
];

const STATUS_LABELS: Record<DeviceStatusReportRow['status'], string> = {
  ACTIVE: 'Active',
  INACTIVE: 'Inactive',
  NO_GPS: 'No GPS fix',
  NEVER_CONNECTED: 'Never connected',
  NO_DEVICE: 'No device',
};

const DEVICE_STATUS: ReportColumn[] = [
  ...vehicleCols<DeviceStatusReportRow>((t) => `${t.count ?? 0} vehicles · active ${t.ACTIVE ?? 0} · inactive ${t.INACTIVE ?? 0} · no GPS ${t.NO_GPS ?? 0}`),
  col<DeviceStatusReportRow>({ header: 'Branch', width: 14, value: (r) => r.branchName ?? '' }),
  col<DeviceStatusReportRow>({ header: 'Status', width: 14, value: (r) => STATUS_LABELS[r.status] }),
  col<DeviceStatusReportRow>({ header: 'IMEI', width: 17, value: (r) => r.uniqueId ?? '' }),
  col<DeviceStatusReportRow>({ header: 'Model', width: 16, value: (r) => r.model ?? '' }),
  col<DeviceStatusReportRow>({ header: 'SIM', width: 14, value: (r) => r.simNumber ?? '' }),
  col<DeviceStatusReportRow>({ header: 'Last data', width: 19, value: (r, tz) => localTime(r.lastSeenAt, tz) }),
  col<DeviceStatusReportRow>({ header: 'Last GPS fix', width: 19, value: (r, tz) => localTime(r.lastFixTime, tz) }),
  col<DeviceStatusReportRow>({ header: 'No data for', width: 11, value: (r) => hhmmss(r.inactiveSec) }),
  col<DeviceStatusReportRow>({ header: 'Battery %', width: 8, numeric: true, value: (r) => r.batteryLevel ?? '' }),
  col<DeviceStatusReportRow>({ header: 'Ext. V', width: 7, numeric: true, value: (r) => r.extVoltage ?? '' }),
  col<DeviceStatusReportRow>({ header: 'Last location', width: 32, value: (r) => place(r.address, r.lat, r.lng) }),
];

const DRIVERS: ReportColumn[] = [
  col<DriverReportRow>({ header: 'Driver', width: 22, value: (r) => r.driverName, total: (t) => `${t.drivers ?? 0} drivers` }),
  col<DriverReportRow>({ header: 'Employee ID', width: 12, value: (r) => r.employeeId ?? '' }),
  col<DriverReportRow>({ header: 'Vehicles', width: 24, value: (r) => r.vehicles }),
  col<DriverReportRow>({ header: 'Sessions', width: 9, numeric: true, value: (r) => r.sessions, total: (t) => t.sessions ?? 0 }),
  col<DriverReportRow>({ header: 'Trips', width: 7, numeric: true, value: (r) => r.tripCount, total: (t) => t.tripCount ?? 0 }),
  col<DriverReportRow>({ header: 'Distance (km)', width: 12, numeric: true, value: (r) => num(r.distanceKm, 1), total: (t) => num(t.distanceKm ?? 0, 1) }),
  col<DriverReportRow>({ header: 'Driving', width: 10, value: (r) => hhmmss(r.drivingSec), total: (t) => hhmmss(t.drivingSec ?? 0) }),
  col<DriverReportRow>({ header: 'Max (km/h)', width: 10, numeric: true, value: (r) => r.maxSpeedKph, total: (t) => t.maxSpeedKph ?? 0 }),
  col<DriverReportRow>({ header: 'Overspeed', width: 10, numeric: true, value: (r) => r.overspeedCount, total: (t) => t.overspeedCount ?? 0 }),
  col<DriverReportRow>({ header: 'First start', width: 19, value: (r, tz) => localTime(r.firstStart, tz) }),
  col<DriverReportRow>({ header: 'Last end', width: 19, value: (r, tz) => (r.lastEnd ? localTime(r.lastEnd, tz) : 'Driving now') }),
];

const DOCUMENT_STATUS_LABELS: Record<DocumentsReportRow['status'], string> = {
  VALID: 'Valid',
  EXPIRING: 'Expiring soon',
  EXPIRED: 'Expired',
  NO_EXPIRY: 'No expiry',
  OK: 'OK',
  DUE_SOON: 'Due soon',
  OVERDUE: 'Overdue',
};

const DOCUMENTS: ReportColumn[] = [
  col<DocumentsReportRow>({ header: 'Vehicle', width: 20, value: (r) => r.vehicle ?? '', total: (t) => `${t.count ?? 0} items · ${t.expired ?? 0} expired / overdue · ${t.dueSoon ?? 0} due soon` }),
  col<DocumentsReportRow>({ header: 'Driver', width: 18, value: (r) => r.driver ?? '' }),
  col<DocumentsReportRow>({ header: 'Type', width: 10, value: (r) => (r.kind === 'SERVICE' ? 'Service' : 'Document') }),
  col<DocumentsReportRow>({ header: 'Item', width: 24, value: (r) => r.item }),
  col<DocumentsReportRow>({ header: 'Number', width: 16, value: (r) => r.number ?? '' }),
  col<DocumentsReportRow>({ header: 'Expires / due on', width: 14, value: (r) => r.dueOn ?? '' }),
  col<DocumentsReportRow>({ header: 'Due at (km)', width: 11, numeric: true, value: (r) => r.dueOdometerKm ?? '' }),
  col<DocumentsReportRow>({ header: 'Days left', width: 9, numeric: true, value: (r) => r.daysLeft ?? '' }),
  col<DocumentsReportRow>({ header: 'Km left', width: 9, numeric: true, value: (r) => r.kmLeft ?? '' }),
  col<DocumentsReportRow>({ header: 'Status', width: 13, value: (r) => DOCUMENT_STATUS_LABELS[r.status] }),
];

/** Blank (not 0) when there is nothing to average or no value yet. */
const opt = (v: number | null | undefined): Cell => (v === null || v === undefined ? '' : v);
const pct = (v: number | null | undefined): Cell => (v === null || v === undefined ? '' : `${v}%`);
const GROUP_HEADER: Record<TripPerformanceGroupBy, string> = { ROUTE: 'Route', DRIVER: 'Driver', VEHICLE: 'Vehicle' };
const GROUP_PLURAL: Record<TripPerformanceGroupBy, string> = { ROUTE: 'routes', DRIVER: 'drivers', VEHICLE: 'vehicles' };

function tripPerformanceColumns(groupBy: TripPerformanceGroupBy): ReportColumn[] {
  return [
    col<TripPerformanceReportRow>({ header: GROUP_HEADER[groupBy], width: 24, value: (r) => r.groupName, total: (t) => `Total (${t.groups ?? 0} ${GROUP_PLURAL[groupBy]})` }),
    col<TripPerformanceReportRow>({ header: 'Trips', width: 7, numeric: true, value: (r) => r.trips, total: (t) => t.trips ?? 0 }),
    col<TripPerformanceReportRow>({ header: 'Completed', width: 9, numeric: true, value: (r) => r.completed, total: (t) => t.completed ?? 0 }),
    col<TripPerformanceReportRow>({ header: 'Incomplete', width: 9, numeric: true, value: (r) => r.incomplete, total: (t) => t.incomplete ?? 0 }),
    col<TripPerformanceReportRow>({ header: 'Cancelled', width: 9, numeric: true, value: (r) => r.cancelled, total: (t) => t.cancelled ?? 0 }),
    col<TripPerformanceReportRow>({ header: 'On time %', width: 9, numeric: true, value: (r) => pct(r.onTimePct), total: (t) => pct(t.onTimePct) }),
    col<TripPerformanceReportRow>({ header: 'Stops on time', width: 9, numeric: true, value: (r) => `${r.onTimeStops} / ${r.ratedStops}`, total: (t) => `${t.onTimeStops ?? 0} / ${t.ratedStops ?? 0}` }),
    col<TripPerformanceReportRow>({ header: 'Avg start delay (min)', width: 11, numeric: true, value: (r) => opt(r.avgStartDelayMin), total: (t) => opt(t.avgStartDelayMin) }),
    col<TripPerformanceReportRow>({ header: 'Avg stop delay (min)', width: 11, numeric: true, value: (r) => opt(r.avgStopDelayMin), total: (t) => opt(t.avgStopDelayMin) }),
    col<TripPerformanceReportRow>({ header: 'Skipped stops', width: 9, numeric: true, value: (r) => r.skippedStops, total: (t) => t.skippedStops ?? 0 }),
    col<TripPerformanceReportRow>({ header: 'Planned km', width: 10, numeric: true, value: (r) => r.plannedKm, total: (t) => t.plannedKm ?? 0 }),
    col<TripPerformanceReportRow>({ header: 'Actual km', width: 10, numeric: true, value: (r) => r.actualKm, total: (t) => t.actualKm ?? 0 }),
    col<TripPerformanceReportRow>({ header: 'Deviations', width: 9, numeric: true, value: (r) => r.deviations, total: (t) => t.deviations ?? 0 }),
  ];
}

const PLANNED_TRIPS: ReportColumn[] = [
  col<PlannedTripReportRow>({ header: 'Route', width: 22, value: (r) => r.routeName, total: (t) => `Total (${t.count ?? 0} trips)` }),
  col<PlannedTripReportRow>({ header: 'Vehicle', width: 20, value: (r) => r.objectName }),
  col<PlannedTripReportRow>({ header: 'Plate', width: 13, value: (r) => r.plateNumber ?? '' }),
  col<PlannedTripReportRow>({ header: 'Driver', width: 18, value: (r) => r.driverName ?? '' }),
  col<PlannedTripReportRow>({ header: 'Status', width: 11, value: (r) => words(r.status), total: (t) => `${t.completed ?? 0} completed` }),
  col<PlannedTripReportRow>({ header: 'Planned start', width: 19, value: (r, tz) => localTime(r.plannedStart, tz) }),
  col<PlannedTripReportRow>({ header: 'Actual start', width: 19, value: (r, tz) => localTime(r.actualStart, tz) }),
  col<PlannedTripReportRow>({ header: 'Planned end', width: 19, value: (r, tz) => localTime(r.plannedEnd, tz) }),
  col<PlannedTripReportRow>({ header: 'Actual end', width: 19, value: (r, tz) => localTime(r.actualEnd, tz) }),
  col<PlannedTripReportRow>({ header: 'Start delay (min)', width: 10, numeric: true, value: (r) => opt(r.startDelayMin) }),
  col<PlannedTripReportRow>({ header: 'Delay (min)', width: 9, numeric: true, value: (r) => opt(r.delayMin) }),
  col<PlannedTripReportRow>({ header: 'Stops done', width: 9, numeric: true, value: (r) => `${r.stopsDone} / ${r.stopCount}`, total: (t) => `${t.stopsDone ?? 0} / ${t.stopCount ?? 0}` }),
  col<PlannedTripReportRow>({ header: 'Skipped', width: 8, numeric: true, value: (r) => r.skippedStops, total: (t) => t.skippedStops ?? 0 }),
  col<PlannedTripReportRow>({ header: 'Deviations', width: 9, numeric: true, value: (r) => r.deviationCount, total: (t) => t.deviationCount ?? 0 }),
  col<PlannedTripReportRow>({ header: 'Planned km', width: 10, numeric: true, value: (r) => r.plannedKm, total: (t) => t.plannedKm ?? 0 }),
  col<PlannedTripReportRow>({ header: 'Distance (km)', width: 11, numeric: true, value: (r) => (r.distanceKm === null ? '' : num(r.distanceKm, 2)), total: (t) => num(t.distanceKm ?? 0, 2) }),
];

/** Columns of a report type; TRIP_PERFORMANCE names its first column after the grouping (default route). */
export function columnsFor(type: ReportType, groupBy?: TripPerformanceGroupBy): ReportColumn[] {
  switch (type) {
    case 'TRIP_PERFORMANCE':
      return tripPerformanceColumns(groupBy ?? 'ROUTE');
    case 'PLANNED_TRIPS':
      return PLANNED_TRIPS;
    case 'SUMMARY':
      return SUMMARY;
    case 'CONSOLIDATED':
      return CONSOLIDATED;
    case 'DISTANCE':
      return DISTANCE;
    case 'ENGINE_HOURS':
      return ENGINE_HOURS;
    case 'TRIPS':
      return TRIPS;
    case 'STOPS':
      return stopColumns('stops');
    case 'IDLE':
      return stopColumns('idle stops');
    case 'HALT':
      return stopColumns('halts');
    case 'CONTINUOUS_DRIVING':
      return CONTINUOUS_DRIVING;
    case 'OVERSPEED':
      return OVERSPEED;
    case 'IGNITION':
      return IGNITION;
    case 'POSITIONS':
      return POSITIONS;
    case 'ALERTS':
      return ALERTS;
    case 'EVENT_SUMMARY':
      return EVENT_SUMMARY;
    case 'GEOFENCE_VISITS':
      return GEOFENCE_VISITS;
    case 'GEOFENCE_SUMMARY':
      return GEOFENCE_SUMMARY;
    case 'GEOFENCE_DISTANCE':
      return GEOFENCE_DISTANCE;
    case 'DEVICE_STATUS':
      return DEVICE_STATUS;
    case 'DRIVERS':
      return DRIVERS;
    case 'DOCUMENTS':
      return DOCUMENTS;
    case 'POI_VISITS':
      return POI_VISITS;
    case 'FUEL':
      return FUEL;
    case 'FUEL_EVENTS':
      return FUEL_EVENTS;
    case 'MILEAGE':
      return MILEAGE;
    case 'AC_DOOR':
      return AC_DOOR;
    case 'AC_DOOR_DAILY':
      return AC_DOOR_DAILY;
    case 'ATTENDANCE_DAILY':
      return ATTENDANCE_DAILY;
    case 'ATTENDANCE_SUMMARY':
      return ATTENDANCE_SUMMARY;
    case 'ATTENDANCE_PAYROLL':
      return ATTENDANCE_PAYROLL;
    case 'ATTENDANCE_OUTINGS':
      return ATTENDANCE_OUTINGS;
    case 'ATTENDANCE_CORRECTIONS':
      return ATTENDANCE_CORRECTIONS;
  }
}


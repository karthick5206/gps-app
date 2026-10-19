import {
  ALERT_TYPE_MAP,
  type AlertDto,
  type GeofenceVisitDto,
  type ReportType,
  type StopDto,
  type SummaryReportRow,
  type TripDto,
} from '@veetracer/shared';
import type { LucideIcon } from 'lucide-react-native';
import {
  ActivityIcon,
  FileCheck2Icon,
  BellIcon,
  CirclePauseIcon,
  ClockIcon,
  CoffeeIcon,
  GaugeIcon,
  HexagonIcon,
  IdCardIcon,
  LayersIcon,
  ListChecksIcon,
  MapPinIcon,
  DropletOffIcon,
  FuelIcon,
  MapPinnedIcon,
  ParkingSquareIcon,
  PowerIcon,
  RouteIcon,
  RulerIcon,
  ShapesIcon,
  SigmaIcon,
  TimerIcon,
} from 'lucide-react-native';
import { formatDateTime, humanize } from '@/lib/format';
import { i18n } from '@/lib/i18n';
import { poiCategoryLabel } from '@/features/pois/categories';
import { formatHm, periodLabel } from './report-format';

export type Row = Record<string, unknown>;
type Total = 'sum' | 'max';

export interface ReportColumn {
  id: string;
  header: string;
  /** Sort key (and CSV-like raw value). */
  value: (row: Row) => string | number | null;
  /** Display text when it differs from `value` (labels, badges on the web). */
  display?: (row: Row) => string | null;
  /** `time`: epoch ms value shown as date-time. */
  kind?: 'time';
  numeric?: boolean;
  /** How the totals row is filled when the API doesn't return `totals[id]`. */
  total?: Total;
  /** Formats numeric values (cells and totals). */
  format?: (v: number) => string;
  className?: string;
}

export interface ReportTypeDef {
  type: ReportType;
  category: ReportCategory;
  label: string;
  description: string;
  icon: LucideIcon;
  columns: ReportColumn[];
}

const km = (v: number) => v.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const int = (v: number) => Math.round(v).toLocaleString();
const str = (k: string) => (r: Row) => (r[k] as string | null | undefined) ?? null;
const num = (k: string) => (r: Row) => (typeof r[k] === 'number' ? (r[k] as number) : null);
const time = (k: string) => (r: Row) => {
  const v = r[k] as string | null | undefined;
  return v ? Date.parse(v) : null;
};

/** Address, else "lat, lng" (addresses are filled when the report runs, as far as the lookup budget allows). */
const place = (addr: string, lat: string, lng: string) => (r: Row) => {
  const a = r[addr] as string | null | undefined;
  if (a) return a;
  return typeof r[lat] === 'number' && typeof r[lng] === 'number' ? `${(r[lat] as number).toFixed(5)}, ${(r[lng] as number).toFixed(5)}` : null;
};

const duration = (id: string, header: string, total: Total | undefined = 'sum'): ReportColumn => ({
  id,
  header,
  value: num(id),
  numeric: true,
  total,
  format: formatHm,
});

const vehicle: ReportColumn = {
  id: 'objectName',
  header: 'Vehicle',
  value: str('objectName'),
};

const SUMMARY: ReportColumn[] = [
  vehicle,
  { id: 'plateNumber', header: 'Plate', value: str('plateNumber') },
  { id: 'branchName', header: 'Branch', value: str('branchName') },
  { id: 'period', header: 'Period', value: str('period'), display: (r) => periodLabel(r.period as string) },
  { id: 'distanceKm', header: 'Distance (km)', value: num('distanceKm'), numeric: true, total: 'sum', format: km },
  duration('runningSec', 'Running'),
  duration('idleSec', 'Idle'),
  duration('stopSec', 'Stopped'),
  duration('offlineSec', 'Offline'),
  duration('engineSec', 'Engine'),
  { id: 'tripCount', header: 'Trips', value: num('tripCount'), numeric: true, total: 'sum', format: int },
  { id: 'maxSpeedKph', header: 'Max (km/h)', value: num('maxSpeedKph'), numeric: true, total: 'max', format: int },
  { id: 'avgSpeedKph', header: 'Avg (km/h)', value: num('avgSpeedKph'), numeric: true, format: int },
  { id: 'overspeedCount', header: 'Overspeed', value: num('overspeedCount'), numeric: true, total: 'sum', format: int },
  { id: 'firstStart', header: 'First start', value: time('firstStart'), kind: 'time' },
  { id: 'lastStop', header: 'Last stop', value: time('lastStop'), kind: 'time' },
];

const TRIPS: ReportColumn[] = [
  vehicle,
  { id: 'startTime', header: 'Start', value: time('startTime'), kind: 'time' },
  { id: 'endTime', header: 'End', value: time('endTime'), kind: 'time' },
  duration('durationSec', 'Duration'),
  duration('idleSec', 'Idle'),
  { id: 'startAddress', header: 'From', value: place('startAddress', 'startLat', 'startLng') },
  { id: 'endAddress', header: 'To', value: place('endAddress', 'endLat', 'endLng') },
  { id: 'distanceKm', header: 'Distance (km)', value: num('distanceKm'), numeric: true, total: 'sum', format: km },
  { id: 'maxSpeedKph', header: 'Max (km/h)', value: num('maxSpeedKph'), numeric: true, total: 'max', format: int },
  { id: 'avgSpeedKph', header: 'Avg (km/h)', value: num('avgSpeedKph'), numeric: true, format: int },
];

const STOPS: ReportColumn[] = [
  vehicle,
  { id: 'startTime', header: 'Start', value: time('startTime'), kind: 'time' },
  { id: 'endTime', header: 'End', value: time('endTime'), kind: 'time' },
  duration('durationSec', 'Duration'),
  {
    id: 'ignitionOn',
    header: 'Type',
    value: (r) => (r.ignitionOn ? 'Idle' : 'Parked'),
    display: (r) => (r.ignitionOn ? i18n.t('Idle') : i18n.t('Parked')),
  },
  { id: 'address', header: 'Location', value: place('address', 'lat', 'lng') },
  { id: 'poiName', header: 'POI', value: str('poiName') },
];

const onOff = (on: boolean | null) => (on === null ? null : on ? i18n.t('On') : i18n.t('Off'));

const ALERTS: ReportColumn[] = [
  { id: 'occurredAt', header: 'Time', value: time('occurredAt'), kind: 'time' },
  vehicle,
  { id: 'type', header: 'Type', value: (r) => ALERT_TYPE_MAP[r.type as AlertDto['type']]?.label ?? (r.type as string), display: (r) => i18n.t(ALERT_TYPE_MAP[r.type as AlertDto['type']]?.label ?? (r.type as string)) },
  {
    id: 'severity',
    header: 'Severity',
    value: (r) => ['INFO', 'WARNING', 'CRITICAL'].indexOf(r.severity as string),
    display: (r) => i18n.t(humanize(r.severity as string)),
  },
  { id: 'message', header: 'Message', value: str('message') },
  { id: 'address', header: 'Location', value: place('address', 'lat', 'lng') },
  { id: 'status', header: 'Status', value: str('status'), display: (r) => i18n.t(humanize(r.status as string)) },
];

const GEOFENCE_VISITS: ReportColumn[] = [
  vehicle,
  { id: 'geofenceName', header: 'Geofence', value: str('geofenceName') },
  { id: 'enterTime', header: 'Entered', value: time('enterTime'), kind: 'time' },
  { id: 'exitTime', header: 'Exited', value: time('exitTime'), kind: 'time', display: (r) => (r.exitTime ? null : i18n.t('Inside')) },
  duration('durationSec', 'Duration'),
];

const POI_VISITS: ReportColumn[] = [
  vehicle,
  { id: 'poiName', header: 'POI', value: str('poiName') },
  { id: 'category', header: 'Category', value: str('category'), display: (r) => (r.category ? poiCategoryLabel(r.category as string) : null) },
  { id: 'arrival', header: 'Arrival', value: time('arrival'), kind: 'time' },
  { id: 'departure', header: 'Departure', value: time('departure'), kind: 'time' },
  duration('durationSec', 'Duration'),
  { id: 'distanceM', header: 'Distance (m)', value: num('distanceM'), numeric: true, format: (v) => Math.round(v).toLocaleString() },
  { id: 'ignitionOn', header: 'Engine', value: (r) => (r.ignitionOn ? 1 : 0), display: (r) => onOff(r.ignitionOn as boolean) },
  { id: 'address', header: 'Location', value: place('address', 'lat', 'lng') },
];

const plate: ReportColumn = { id: 'plateNumber', header: 'Plate', value: str('plateNumber') };
const branch: ReportColumn = { id: 'branchName', header: 'Branch', value: str('branchName') };
const periodCol: ReportColumn = { id: 'period', header: 'Period', value: str('period'), display: (r) => periodLabel(r.period as string) };
const kmCol = (id = 'distanceKm', total: Total | undefined = 'sum'): ReportColumn => ({ id, header: 'Distance (km)', value: num(id), numeric: true, total, format: km });
const count = (id: string, header: string, total: Total | undefined = 'sum'): ReportColumn => ({ id, header, value: num(id), numeric: true, total, format: int });
const coordValue = (lat: string, lng: string) => (r: Row) => (typeof r[lat] === 'number' ? `${r[lat]},${r[lng]}` : null);
const optNum = (id: string, header: string, digits = 1): ReportColumn => ({
  id,
  header,
  value: num(id),
  numeric: true,
  format: (v) => v.toLocaleString(undefined, { maximumFractionDigits: digits }),
});

const CONSOLIDATED: ReportColumn[] = [
  vehicle,
  plate,
  branch,
  count('activeDays', 'Active days'),
  kmCol(),
  duration('runningSec', 'Running'),
  duration('idleSec', 'Idle'),
  duration('stopSec', 'Stopped'),
  duration('engineSec', 'Engine'),
  count('tripCount', 'Trips'),
  count('maxSpeedKph', 'Max (km/h)', 'max'),
  count('avgSpeedKph', 'Avg (km/h)', undefined),
  count('overspeedCount', 'Overspeed'),
  count('alertCount', 'Alerts'),
  count('criticalAlertCount', 'Critical'),
  count('geofenceVisits', 'Geofence visits'),
  { id: 'firstStart', header: 'First start', value: time('firstStart'), kind: 'time' },
  { id: 'lastStop', header: 'Last stop', value: time('lastStop'), kind: 'time' },
];

const DISTANCE: ReportColumn[] = [vehicle, plate, branch, periodCol, kmCol(), count('tripCount', 'Trips'), duration('runningSec', 'Running'), duration('offlineSec', 'Offline')];

const ENGINE_HOURS: ReportColumn[] = [
  vehicle,
  plate,
  periodCol,
  duration('engineSec', 'Engine on'),
  duration('runningSec', 'Running'),
  duration('idleSec', 'Idle'),
  { id: 'idlePct', header: 'Idle %', value: num('idlePct'), numeric: true, format: (v) => `${v.toFixed(1)}%` },
  kmCol(),
];


const POSITIONS: ReportColumn[] = [
  { id: 'fixTime', header: 'GPS time', value: time('fixTime'), kind: 'time' },
  { id: 'serverTime', header: 'Received', value: time('serverTime'), kind: 'time' },
  { id: 'lat', header: 'Location', value: coordValue('lat', 'lng') },
  { id: 'address', header: 'Address', value: str('address') },
  { id: 'speedKph', header: 'km/h', value: num('speedKph'), numeric: true, total: 'max', format: int },
  count('course', 'Course', undefined),
  count('satellites', 'Sats', undefined),
  { id: 'valid', header: 'Fix', value: (r) => (r.valid ? 1 : 0), display: (r) => (r.valid ? i18n.t('Valid') : i18n.t('No fix')) },
  { id: 'ignition', header: 'Ignition', value: (r) => (r.ignition === null ? null : r.ignition ? 1 : 0), display: (r) => onOff(r.ignition as boolean | null) },
  optNum('extVoltage', 'Ext. V', 2),
  optNum('batteryLevel', 'Battery %', 0),
  optNum('gsmSignal', 'GSM', 0),
  optNum('odometerKm', 'Odometer (km)', 1),
  { id: 'alarm', header: 'Alarm', value: str('alarm'), display: (r) => (r.alarm ? i18n.t(humanize(r.alarm as string)) : null) },
  { id: 'flags', header: 'Flags', value: str('flags') },
];

const OVERSPEED: ReportColumn[] = [
  vehicle,
  plate,
  { id: 'startTime', header: 'Start', value: time('startTime'), kind: 'time' },
  { id: 'endTime', header: 'End', value: time('endTime'), kind: 'time' },
  duration('durationSec', 'Duration'),
  count('limitKph', 'Limit (km/h)', undefined),
  {
    id: 'maxSpeedKph',
    header: 'Max (km/h)',
    value: num('maxSpeedKph'),
    numeric: true,
    total: 'max',
    format: int,
  },
  count('avgSpeedKph', 'Avg (km/h)', undefined),
  { id: 'address', header: 'Peak at', value: place('address', 'lat', 'lng') },
];

const IGNITION: ReportColumn[] = [
  vehicle,
  plate,
  { id: 'time', header: 'Time', value: time('time'), kind: 'time' },
  { id: 'state', header: 'Ignition', value: str('state'), display: (r) => onOff(r.state === 'ON') },
  duration('previousStateSec', 'Previous state for', undefined),
  { id: 'address', header: 'Location', value: place('address', 'lat', 'lng') },
];

const CONTINUOUS_DRIVING: ReportColumn[] = [
  vehicle,
  plate,
  { id: 'startTime', header: 'Start', value: time('startTime'), kind: 'time' },
  { id: 'endTime', header: 'End', value: time('endTime'), kind: 'time' },
  duration('drivingSec', 'Driving'),
  duration('spanSec', 'Span', undefined),
  duration('longestBreakSec', 'Longest break', undefined),
  count('trips', 'Trips', undefined),
  kmCol(),
  { id: 'startAddress', header: 'From', value: place('startAddress', 'startLat', 'startLng') },
  { id: 'endAddress', header: 'To', value: place('endAddress', 'endLat', 'endLng') },
];

const EVENT_SUMMARY: ReportColumn[] = [
  vehicle,
  plate,
  { id: 'type', header: 'Event', value: (r) => ALERT_TYPE_MAP[r.type as AlertDto['type']]?.label ?? (r.type as string), display: (r) => i18n.t(ALERT_TYPE_MAP[r.type as AlertDto['type']]?.label ?? (r.type as string)) },
  count('count', 'Count'),
  count('criticalCount', 'Critical'),
  { id: 'firstAt', header: 'First', value: time('firstAt'), kind: 'time' },
  { id: 'lastAt', header: 'Last', value: time('lastAt'), kind: 'time' },
];

const DRIVERS: ReportColumn[] = [
  { id: 'driverName', header: 'Driver', value: str('driverName') },
  { id: 'employeeId', header: 'Employee ID', value: str('employeeId') },
  { id: 'vehicles', header: 'Vehicles', value: str('vehicles') },
  count('tripCount', 'Trips'),
  kmCol(),
  duration('drivingSec', 'Driving'),
  count('overspeedCount', 'Overspeed'),
  count('sessions', 'Sessions'),
  count('maxSpeedKph', 'Max (km/h)', 'max'),
  { id: 'firstStart', header: 'First start', value: time('firstStart'), kind: 'time' },
  { id: 'lastEnd', header: 'Last end', value: time('lastEnd'), kind: 'time', display: (r) => (r.lastEnd ? null : i18n.t('Driving now')) },
];

const GEOFENCE_SUMMARY: ReportColumn[] = [
  vehicle,
  { id: 'geofenceName', header: 'Geofence', value: str('geofenceName') },
  count('visits', 'Visits'),
  duration('insideSec', 'Time inside'),
  duration('avgVisitSec', 'Avg visit', undefined),
  { id: 'firstEnter', header: 'First entry', value: time('firstEnter'), kind: 'time' },
  { id: 'lastExit', header: 'Last exit', value: time('lastExit'), kind: 'time', display: (r) => (r.lastExit ? null : i18n.t('Inside')) },
];

export const DEVICE_STATUS_META: Record<string, { label: string; variant: 'success' | 'warning' | 'destructive' | 'muted' | 'secondary' }> = {
  ACTIVE: { label: 'Active', variant: 'success' },
  NO_GPS: { label: 'No GPS fix', variant: 'warning' },
  INACTIVE: { label: 'Inactive', variant: 'destructive' },
  NEVER_CONNECTED: { label: 'Never connected', variant: 'muted' },
  NO_DEVICE: { label: 'No device', variant: 'secondary' },
};

const DEVICE_STATUS: ReportColumn[] = [
  vehicle,
  plate,
  branch,
  {
    id: 'status',
    header: 'Status',
    value: str('status'),
    display: (r) => i18n.t(DEVICE_STATUS_META[r.status as string]?.label ?? (r.status as string)),
  },
  { id: 'uniqueId', header: 'IMEI', value: str('uniqueId') },
  { id: 'model', header: 'Model', value: str('model') },
  { id: 'lastSeenAt', header: 'Last data', value: time('lastSeenAt'), kind: 'time' },
  { id: 'lastFixTime', header: 'Last GPS fix', value: time('lastFixTime'), kind: 'time' },
  duration('inactiveSec', 'No data for', undefined),
  optNum('batteryLevel', 'Battery %', 0),
  optNum('extVoltage', 'Ext. V', 2),
  { id: 'address', header: 'Last location', value: place('address', 'lat', 'lng') },
];

export const DOCUMENT_REPORT_STATUS_LABELS: Record<string, string> = {
  VALID: 'Valid',
  EXPIRING: 'Expiring soon',
  EXPIRED: 'Expired',
  NO_EXPIRY: 'No expiry date',
  OK: 'OK',
  DUE_SOON: 'Due soon',
  OVERDUE: 'Overdue',
};

const DOCUMENTS: ReportColumn[] = [
  { id: 'vehicle', header: 'Vehicle', value: str('vehicle') },
  { id: 'driver', header: 'Driver', value: str('driver') },
  { id: 'kind', header: 'Type', value: str('kind'), display: (r) => (r.kind === 'SERVICE' ? i18n.t('Service') : i18n.t('Document')) },
  { id: 'item', header: 'Item', value: str('item'), display: (r) => (r.kind === 'SERVICE' ? (r.item as string) : i18n.t(r.item as string)) },
  { id: 'number', header: 'Number', value: str('number') },
  { id: 'dueOn', header: 'Expires / due on', value: str('dueOn') },
  { id: 'dueOdometerKm', header: 'Due at (km)', value: num('dueOdometerKm'), numeric: true, format: int },
  { id: 'daysLeft', header: 'Days left', value: num('daysLeft'), numeric: true, format: int },
  { id: 'kmLeft', header: 'Km left', value: num('kmLeft'), numeric: true, format: int },
  { id: 'status', header: 'Status', value: str('status'), display: (r) => i18n.t(DOCUMENT_REPORT_STATUS_LABELS[r.status as string] ?? (r.status as string)) },
];

const litres = (v: number) => v.toLocaleString(undefined, { maximumFractionDigits: 1 });
const litresCol = (id: string, header: string, total?: Total): ReportColumn => ({ id, header, value: num(id), numeric: true, total, format: litres });

const FUEL: ReportColumn[] = [
  vehicle,
  { id: 'day', header: 'Day', value: str('day') },
  litresCol('startL', 'Start (L)'),
  litresCol('endL', 'End (L)'),
  count('refills', 'Refills'),
  litresCol('refillL', 'Refilled (L)', 'sum'),
  count('drains', 'Drains'),
  litresCol('drainL', 'Drained (L)', 'sum'),
  litresCol('consumptionL', 'Consumed (L)', 'sum'),
  kmCol(),
  { id: 'kmPerL', header: 'km/L', value: num('kmPerL'), numeric: true, format: (v) => v.toFixed(2) },
  { id: 'lPer100Km', header: 'L/100 km', value: num('lPer100Km'), numeric: true, format: (v) => v.toFixed(1) },
];

const FUEL_EVENTS: ReportColumn[] = [
  vehicle,
  { id: 'type', header: 'Event', value: str('type'), display: (r) => (r.type === 'REFILL' ? i18n.t('Refill') : i18n.t('Drain')) },
  { id: 'startTime', header: 'Start', value: time('startTime'), kind: 'time' },
  { id: 'endTime', header: 'End', value: time('endTime'), kind: 'time' },
  litresCol('litresBefore', 'Before (L)'),
  litresCol('litresAfter', 'After (L)'),
  { id: 'deltaL', header: 'Change (L)', value: (r) => (r.type === 'REFILL' ? (r.deltaL as number) : -(r.deltaL as number)), numeric: true, format: (v) => (v > 0 ? `+${litres(v)}` : litres(v)) },
  { id: 'address', header: 'Location', value: place('address', 'lat', 'lng') },
];

export type ReportCategory = 'Activity' | 'Driving' | 'Events' | 'Geofences' | 'Fuel' | 'Devices' | 'Compliance';
export const REPORT_CATEGORIES: ReportCategory[] = ['Activity', 'Driving', 'Events', 'Geofences', 'Fuel', 'Devices', 'Compliance'];

export const REPORT_DEFS: ReportTypeDef[] = [
  { type: 'SUMMARY', category: 'Activity', label: 'Summary', description: 'Distance, running/idle/stop time and trips per vehicle by day, week or month.', icon: SigmaIcon, columns: SUMMARY },
  { type: 'CONSOLIDATED', category: 'Activity', label: 'Consolidated', description: 'One line per vehicle for the whole period, with alerts and geofence visits.', icon: LayersIcon, columns: CONSOLIDATED },
  { type: 'DISTANCE', category: 'Activity', label: 'Distance', description: 'Kilometres per vehicle by day, week or month, with offline time.', icon: RulerIcon, columns: DISTANCE },
  { type: 'ENGINE_HOURS', category: 'Activity', label: 'Engine hours', description: 'Engine-on, running and idle hours with idle percentage.', icon: TimerIcon, columns: ENGINE_HOURS },
  { type: 'TRIPS', category: 'Activity', label: 'Trips', description: 'Every trip with start/end, duration, distance and speeds.', icon: RouteIcon, columns: TRIPS },
  { type: 'STOPS', category: 'Activity', label: 'Stops', description: 'Parked and idle stops with location and duration.', icon: ParkingSquareIcon, columns: STOPS },
  { type: 'HALT', category: 'Activity', label: 'Halts', description: 'Long stoppages with the engine off (default 30 min or more).', icon: CirclePauseIcon, columns: STOPS },
  { type: 'POSITIONS', category: 'Activity', label: 'Positions', description: 'Raw GPS points of one vehicle (up to 7 days): speed, ignition, power.', icon: MapPinnedIcon, columns: POSITIONS },
  { type: 'IDLE', category: 'Driving', label: 'Idling', description: 'Stops with the engine running — fuel wasted while stationary.', icon: ClockIcon, columns: STOPS },
  { type: 'OVERSPEED', category: 'Driving', label: 'Over-speed', description: "Speeding episodes above each vehicle's limit with peak speed and duration.", icon: GaugeIcon, columns: OVERSPEED },
  { type: 'CONTINUOUS_DRIVING', category: 'Driving', label: 'Continuous driving', description: 'Driving stretches without a proper break (default 4 h / 15 min rule).', icon: CoffeeIcon, columns: CONTINUOUS_DRIVING },
  { type: 'DRIVERS', category: 'Driving', label: 'Driver activity', description: 'Per driver: vehicles driven, trips, distance, driving time and overspeeding.', icon: IdCardIcon, columns: DRIVERS },
  { type: 'IGNITION', category: 'Driving', label: 'Ignition on/off', description: 'Every ignition change with how long the previous state lasted.', icon: PowerIcon, columns: IGNITION },
  { type: 'ALERTS', category: 'Events', label: 'Alerts', description: 'Alerts raised in the period with severity and status; filter by type.', icon: BellIcon, columns: ALERTS },
  { type: 'EVENT_SUMMARY', category: 'Events', label: 'Event summary', description: 'How many of each alert type per vehicle, with first and last time.', icon: ListChecksIcon, columns: EVENT_SUMMARY },
  { type: 'GEOFENCE_VISITS', category: 'Geofences', label: 'Geofence visits', description: 'Entries and exits of geofences with time spent inside.', icon: HexagonIcon, columns: GEOFENCE_VISITS },
  { type: 'GEOFENCE_SUMMARY', category: 'Geofences', label: 'Geofence summary', description: 'Visits and total time inside per vehicle and geofence.', icon: ShapesIcon, columns: GEOFENCE_SUMMARY },
  { type: 'POI_VISITS', category: 'Geofences', label: 'POI visits', description: "Arrivals and departures at points of interest (stops within a POI's radius).", icon: MapPinIcon, columns: POI_VISITS },
  { type: 'FUEL', category: 'Fuel', label: 'Fuel', description: 'Per vehicle per day: start and end level, refills, drains, consumption and km/L (vehicles with a fuel sensor).', icon: FuelIcon, columns: FUEL },
  { type: 'FUEL_EVENTS', category: 'Fuel', label: 'Fuel refills & drains', description: 'Every detected refill and drain (possible fuel theft) with the level before and after.', icon: DropletOffIcon, columns: FUEL_EVENTS },
  { type: 'DEVICE_STATUS', category: 'Devices', label: 'Device status', description: 'Active, inactive, no-GPS and never-connected devices right now.', icon: ActivityIcon, columns: DEVICE_STATUS },
  { type: 'DOCUMENTS', category: 'Compliance', label: 'Documents & services', description: 'Document expiry and service status of every vehicle as of today.', icon: FileCheck2Icon, columns: DOCUMENTS },
];

export const REPORT_DEF_MAP = Object.fromEntries(REPORT_DEFS.map((d) => [d.type, d])) as Record<ReportType, ReportTypeDef>;

/** Totals row values: API `totals[id]` first, else computed client-side per the column's `total`. */
export function computeTotals(columns: ReportColumn[], rows: Row[], apiTotals?: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of columns) {
    if (apiTotals && typeof apiTotals[c.id] === 'number') {
      out[c.id] = apiTotals[c.id];
      continue;
    }
    if (!c.total) continue;
    let acc = c.total === 'max' ? -Infinity : 0;
    let any = false;
    for (const r of rows) {
      const v = c.value(r);
      if (typeof v !== 'number') continue;
      any = true;
      acc = c.total === 'max' ? Math.max(acc, v) : acc + v;
    }
    if (any) out[c.id] = acc;
  }
  return out;
}

// Keep imported DTO names referenced for documentation of row shapes per type.
export type ReportRowTypes = { SUMMARY: SummaryReportRow; TRIPS: TripDto; STOPS: StopDto; IDLE: StopDto; ALERTS: AlertDto; GEOFENCE_VISITS: GeofenceVisitDto };

/** Text shown for a cell (mobile renders reports as cards of label/value pairs). */
export function cellText(c: ReportColumn, r: Row): string {
  const shown = c.display?.(r);
  if (shown !== undefined && shown !== null) return shown;
  const v = c.value(r);
  if (v === null || v === undefined || v === '') return '—';
  if (c.kind === 'time' && typeof v === 'number') return formatDateTime(new Date(v).toISOString());
  if (typeof v === 'number') return c.format ? c.format(v) : v.toLocaleString();
  return String(v);
}

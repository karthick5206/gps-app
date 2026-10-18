import {
  ALERT_TYPE_MAP,
  type AlertDto,
  type GeofenceVisitDto,
  type ReportType,
  type StopDto,
  type SummaryReportRow,
  type TripDto,
} from '@veetracer/shared';
import type { LucideIcon } from 'lucide-react';
import {
  ActivityIcon,
  BellIcon,
  CirclePauseIcon,
  ClockIcon,
  CoffeeIcon,
  GaugeIcon,
  HexagonIcon,
  LayersIcon,
  ListChecksIcon,
  MapPinnedIcon,
  ParkingSquareIcon,
  PowerIcon,
  RouteIcon,
  RulerIcon,
  ShapesIcon,
  SigmaIcon,
  TimerIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { formatDateTime, humanize } from '@/lib/format';
import { formatHm, periodLabel } from './report-format';

export type Row = Record<string, unknown>;
type Total = 'sum' | 'max';

export interface ReportColumn {
  id: string;
  header: string;
  /** Sort key (and CSV-like raw value). */
  value: (row: Row) => string | number | null;
  render?: (row: Row) => ReactNode;
  numeric?: boolean;
  /** How the totals row is filled when the API doesn't return `totals[id]`. */
  total?: Total;
  /** Formats numeric values (cells and totals). */
  format?: (v: number) => string;
  className?: string;
}

export interface ReportTypeDef {
  type: ReportType;
  category: 'Activity' | 'Driving' | 'Events' | 'Geofences' | 'Devices';
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
const timeCell = (k: string) => (r: Row) => <span className="tabular-nums">{formatDateTime(r[k] as string | null)}</span>;
const text = (k: string, cls = 'block max-w-72 truncate') => (r: Row) => {
  const v = r[k] as string | null | undefined;
  return v ? (
    <span className={cls} title={v}>
      {v}
    </span>
  ) : (
    <span className="text-muted-foreground">—</span>
  );
};

/** Address, else "lat, lng" (addresses are filled asynchronously by the summarizer). */
const place = (addr: string, lat: string, lng: string) => (r: Row) => {
  const a = r[addr] as string | null | undefined;
  if (a) return a;
  return typeof r[lat] === 'number' && typeof r[lng] === 'number' ? `${(r[lat] as number).toFixed(5)}, ${(r[lng] as number).toFixed(5)}` : null;
};
const placeCell = (addr: string, lat: string, lng: string) => (r: Row) => {
  const v = place(addr, lat, lng)(r);
  if (!v) return <span className="text-muted-foreground">—</span>;
  return r[addr] ? (
    <span className="block max-w-72 truncate" title={v}>
      {v}
    </span>
  ) : (
    <span className="font-mono text-xs text-muted-foreground">{v}</span>
  );
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
  render: (r) => <span className="font-medium">{r.objectName as string}</span>,
};

const SUMMARY: ReportColumn[] = [
  vehicle,
  { id: 'plateNumber', header: 'Plate', value: str('plateNumber'), render: text('plateNumber') },
  { id: 'branchName', header: 'Branch', value: str('branchName'), render: text('branchName') },
  { id: 'period', header: 'Period', value: str('period'), render: (r) => <span className="tabular-nums">{periodLabel(r.period as string)}</span> },
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
  { id: 'firstStart', header: 'First start', value: time('firstStart'), render: timeCell('firstStart') },
  { id: 'lastStop', header: 'Last stop', value: time('lastStop'), render: timeCell('lastStop') },
];

const TRIPS: ReportColumn[] = [
  vehicle,
  { id: 'startTime', header: 'Start', value: time('startTime'), render: timeCell('startTime') },
  { id: 'endTime', header: 'End', value: time('endTime'), render: timeCell('endTime') },
  duration('durationSec', 'Duration'),
  duration('idleSec', 'Idle'),
  { id: 'startAddress', header: 'From', value: place('startAddress', 'startLat', 'startLng'), render: placeCell('startAddress', 'startLat', 'startLng') },
  { id: 'endAddress', header: 'To', value: place('endAddress', 'endLat', 'endLng'), render: placeCell('endAddress', 'endLat', 'endLng') },
  { id: 'distanceKm', header: 'Distance (km)', value: num('distanceKm'), numeric: true, total: 'sum', format: km },
  { id: 'maxSpeedKph', header: 'Max (km/h)', value: num('maxSpeedKph'), numeric: true, total: 'max', format: int },
  { id: 'avgSpeedKph', header: 'Avg (km/h)', value: num('avgSpeedKph'), numeric: true, format: int },
];

const STOPS: ReportColumn[] = [
  vehicle,
  { id: 'startTime', header: 'Start', value: time('startTime'), render: timeCell('startTime') },
  { id: 'endTime', header: 'End', value: time('endTime'), render: timeCell('endTime') },
  duration('durationSec', 'Duration'),
  {
    id: 'ignitionOn',
    header: 'Type',
    value: (r) => (r.ignitionOn ? 'Idle' : 'Parked'),
    render: (r) => <Badge variant={r.ignitionOn ? 'warning' : 'secondary'}>{r.ignitionOn ? 'Idle' : 'Parked'}</Badge>,
  },
  { id: 'address', header: 'Location', value: place('address', 'lat', 'lng'), render: placeCell('address', 'lat', 'lng') },
];

const SEVERITY_VARIANT = { INFO: 'secondary', WARNING: 'warning', CRITICAL: 'destructive' } as const;

const ALERTS: ReportColumn[] = [
  { id: 'occurredAt', header: 'Time', value: time('occurredAt'), render: timeCell('occurredAt') },
  vehicle,
  { id: 'type', header: 'Type', value: (r) => ALERT_TYPE_MAP[r.type as AlertDto['type']]?.label ?? (r.type as string) },
  {
    id: 'severity',
    header: 'Severity',
    value: (r) => ['INFO', 'WARNING', 'CRITICAL'].indexOf(r.severity as string),
    render: (r) => <Badge variant={SEVERITY_VARIANT[r.severity as AlertDto['severity']] ?? 'secondary'}>{humanize(r.severity as string)}</Badge>,
  },
  { id: 'message', header: 'Message', value: str('message'), render: text('message', 'block max-w-96 truncate') },
  { id: 'address', header: 'Location', value: str('address'), render: text('address') },
  { id: 'status', header: 'Status', value: str('status'), render: (r) => humanize(r.status as string) },
];

const GEOFENCE_VISITS: ReportColumn[] = [
  vehicle,
  { id: 'geofenceName', header: 'Geofence', value: str('geofenceName') },
  { id: 'enterTime', header: 'Entered', value: time('enterTime'), render: timeCell('enterTime') },
  { id: 'exitTime', header: 'Exited', value: time('exitTime'), render: (r) => (r.exitTime ? timeCell('exitTime')(r) : <Badge variant="default">Inside</Badge>) },
  duration('durationSec', 'Duration'),
];

const plate: ReportColumn = { id: 'plateNumber', header: 'Plate', value: str('plateNumber'), render: text('plateNumber') };
const branch: ReportColumn = { id: 'branchName', header: 'Branch', value: str('branchName'), render: text('branchName') };
const periodCol: ReportColumn = { id: 'period', header: 'Period', value: str('period'), render: (r) => <span className="tabular-nums">{periodLabel(r.period as string)}</span> };
const kmCol = (id = 'distanceKm', total: Total | undefined = 'sum'): ReportColumn => ({ id, header: 'Distance (km)', value: num(id), numeric: true, total, format: km });
const count = (id: string, header: string, total: Total | undefined = 'sum'): ReportColumn => ({ id, header, value: num(id), numeric: true, total, format: int });
const coords = (lat: string, lng: string) => (r: Row) =>
  typeof r[lat] === 'number' && typeof r[lng] === 'number' ? (
    <span className="font-mono text-xs text-muted-foreground">
      {(r[lat] as number).toFixed(5)}, {(r[lng] as number).toFixed(5)}
    </span>
  ) : (
    <span className="text-muted-foreground">—</span>
  );
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
  { id: 'firstStart', header: 'First start', value: time('firstStart'), render: timeCell('firstStart') },
  { id: 'lastStop', header: 'Last stop', value: time('lastStop'), render: timeCell('lastStop') },
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

const STATE_BADGE = (on: boolean | null) =>
  on === null ? <span className="text-muted-foreground">—</span> : <Badge variant={on ? 'success' : 'muted'}>{on ? 'On' : 'Off'}</Badge>;

const POSITIONS: ReportColumn[] = [
  { id: 'fixTime', header: 'GPS time', value: time('fixTime'), render: timeCell('fixTime') },
  { id: 'serverTime', header: 'Received', value: time('serverTime'), render: timeCell('serverTime') },
  { id: 'lat', header: 'Location', value: coordValue('lat', 'lng'), render: coords('lat', 'lng') },
  { id: 'speedKph', header: 'km/h', value: num('speedKph'), numeric: true, total: 'max', format: int },
  count('course', 'Course', undefined),
  count('satellites', 'Sats', undefined),
  { id: 'valid', header: 'Fix', value: (r) => (r.valid ? 1 : 0), render: (r) => <Badge variant={r.valid ? 'success' : 'warning'}>{r.valid ? 'Valid' : 'No fix'}</Badge> },
  { id: 'ignition', header: 'Ignition', value: (r) => (r.ignition === null ? null : r.ignition ? 1 : 0), render: (r) => STATE_BADGE(r.ignition as boolean | null) },
  optNum('extVoltage', 'Ext. V', 2),
  optNum('batteryLevel', 'Battery %', 0),
  optNum('gsmSignal', 'GSM', 0),
  optNum('odometerKm', 'Odometer (km)', 1),
  { id: 'alarm', header: 'Alarm', value: str('alarm'), render: (r) => (r.alarm ? <Badge variant="destructive">{humanize(r.alarm as string)}</Badge> : <span className="text-muted-foreground">—</span>) },
  { id: 'flags', header: 'Flags', value: str('flags'), render: text('flags') },
];

const OVERSPEED: ReportColumn[] = [
  vehicle,
  plate,
  { id: 'startTime', header: 'Start', value: time('startTime'), render: timeCell('startTime') },
  { id: 'endTime', header: 'End', value: time('endTime'), render: timeCell('endTime') },
  duration('durationSec', 'Duration'),
  count('limitKph', 'Limit (km/h)', undefined),
  {
    id: 'maxSpeedKph',
    header: 'Max (km/h)',
    value: num('maxSpeedKph'),
    numeric: true,
    total: 'max',
    format: int,
    render: (r) => <span className="font-semibold text-destructive tabular-nums">{int(r.maxSpeedKph as number)}</span>,
  },
  count('avgSpeedKph', 'Avg (km/h)', undefined),
  { id: 'lat', header: 'Peak at', value: coordValue('lat', 'lng'), render: coords('lat', 'lng') },
];

const IGNITION: ReportColumn[] = [
  vehicle,
  plate,
  { id: 'time', header: 'Time', value: time('time'), render: timeCell('time') },
  { id: 'state', header: 'Ignition', value: str('state'), render: (r) => STATE_BADGE(r.state === 'ON') },
  duration('previousStateSec', 'Previous state for', undefined),
  { id: 'lat', header: 'Location', value: coordValue('lat', 'lng'), render: coords('lat', 'lng') },
];

const CONTINUOUS_DRIVING: ReportColumn[] = [
  vehicle,
  plate,
  { id: 'startTime', header: 'Start', value: time('startTime'), render: timeCell('startTime') },
  { id: 'endTime', header: 'End', value: time('endTime'), render: timeCell('endTime') },
  duration('drivingSec', 'Driving'),
  duration('spanSec', 'Span', undefined),
  duration('longestBreakSec', 'Longest break', undefined),
  count('trips', 'Trips', undefined),
  kmCol(),
  { id: 'startAddress', header: 'From', value: str('startAddress'), render: text('startAddress') },
  { id: 'endAddress', header: 'To', value: str('endAddress'), render: text('endAddress') },
];

const EVENT_SUMMARY: ReportColumn[] = [
  vehicle,
  plate,
  { id: 'type', header: 'Event', value: (r) => ALERT_TYPE_MAP[r.type as AlertDto['type']]?.label ?? (r.type as string) },
  count('count', 'Count'),
  count('criticalCount', 'Critical'),
  { id: 'firstAt', header: 'First', value: time('firstAt'), render: timeCell('firstAt') },
  { id: 'lastAt', header: 'Last', value: time('lastAt'), render: timeCell('lastAt') },
];

const GEOFENCE_SUMMARY: ReportColumn[] = [
  vehicle,
  { id: 'geofenceName', header: 'Geofence', value: str('geofenceName') },
  count('visits', 'Visits'),
  duration('insideSec', 'Time inside'),
  duration('avgVisitSec', 'Avg visit', undefined),
  { id: 'firstEnter', header: 'First entry', value: time('firstEnter'), render: timeCell('firstEnter') },
  { id: 'lastExit', header: 'Last exit', value: time('lastExit'), render: (r) => (r.lastExit ? timeCell('lastExit')(r) : <Badge variant="default">Inside</Badge>) },
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
    render: (r) => {
      const m = DEVICE_STATUS_META[r.status as string];
      return <Badge variant={m?.variant ?? 'secondary'}>{m?.label ?? (r.status as string)}</Badge>;
    },
  },
  { id: 'uniqueId', header: 'IMEI', value: str('uniqueId'), render: (r) => <span className="font-mono text-xs">{(r.uniqueId as string) ?? '—'}</span> },
  { id: 'model', header: 'Model', value: str('model'), render: text('model') },
  { id: 'lastSeenAt', header: 'Last data', value: time('lastSeenAt'), render: timeCell('lastSeenAt') },
  { id: 'lastFixTime', header: 'Last GPS fix', value: time('lastFixTime'), render: timeCell('lastFixTime') },
  duration('inactiveSec', 'No data for', undefined),
  optNum('batteryLevel', 'Battery %', 0),
  optNum('extVoltage', 'Ext. V', 2),
];

export type ReportCategory = 'Activity' | 'Driving' | 'Events' | 'Geofences' | 'Devices';
export const REPORT_CATEGORIES: ReportCategory[] = ['Activity', 'Driving', 'Events', 'Geofences', 'Devices'];

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
  { type: 'IGNITION', category: 'Driving', label: 'Ignition on/off', description: 'Every ignition change with how long the previous state lasted.', icon: PowerIcon, columns: IGNITION },
  { type: 'ALERTS', category: 'Events', label: 'Alerts', description: 'Alerts raised in the period with severity and status; filter by type.', icon: BellIcon, columns: ALERTS },
  { type: 'EVENT_SUMMARY', category: 'Events', label: 'Event summary', description: 'How many of each alert type per vehicle, with first and last time.', icon: ListChecksIcon, columns: EVENT_SUMMARY },
  { type: 'GEOFENCE_VISITS', category: 'Geofences', label: 'Geofence visits', description: 'Entries and exits of geofences with time spent inside.', icon: HexagonIcon, columns: GEOFENCE_VISITS },
  { type: 'GEOFENCE_SUMMARY', category: 'Geofences', label: 'Geofence summary', description: 'Visits and total time inside per vehicle and geofence.', icon: ShapesIcon, columns: GEOFENCE_SUMMARY },
  { type: 'DEVICE_STATUS', category: 'Devices', label: 'Device status', description: 'Active, inactive, no-GPS and never-connected devices right now.', icon: ActivityIcon, columns: DEVICE_STATUS },
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

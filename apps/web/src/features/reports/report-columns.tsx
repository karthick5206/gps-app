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
import { BellIcon, ClockIcon, HexagonIcon, ParkingSquareIcon, RouteIcon, SigmaIcon } from 'lucide-react';
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

export const REPORT_DEFS: ReportTypeDef[] = [
  { type: 'SUMMARY', label: 'Summary', description: 'Distance, running/idle/stop time and trips per vehicle by day, week or month.', icon: SigmaIcon, columns: SUMMARY },
  { type: 'TRIPS', label: 'Trips', description: 'Every trip with start/end, duration, distance and speeds.', icon: RouteIcon, columns: TRIPS },
  { type: 'STOPS', label: 'Stops', description: 'Parked and idle stops with location and duration.', icon: ParkingSquareIcon, columns: STOPS },
  { type: 'IDLE', label: 'Idling', description: 'Stops with the engine running — fuel wasted while stationary.', icon: ClockIcon, columns: STOPS },
  { type: 'ALERTS', label: 'Alerts', description: 'Alerts raised in the period with severity and status.', icon: BellIcon, columns: ALERTS },
  { type: 'GEOFENCE_VISITS', label: 'Geofence visits', description: 'Entries and exits of geofences with time spent inside.', icon: HexagonIcon, columns: GEOFENCE_VISITS },
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

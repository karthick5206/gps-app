/**
 * Super Admin "Import old history": positions exported from the previous tracking platform ("Summary + Position"
 * Excel: per day a summary row, then a Positions table) are loaded into VeeTrax for one vehicle, before VeeTrax's own
 * first fix. VeeTrax then recomputes trips, stops and daily km itself (its own addresses), and the odometer base is
 * moved so the current odometer stays as set. A per-company migration hold keeps the imported days visible for the
 * normal retention period counted from the day the customer moved to VeeTrax.
 */

const DAY_MS = 86_400_000;

/** Points per upload request (compact rows; well under the API's JSON body limit). */
export const HISTORY_IMPORT_CHUNK = 1500;
/** Largest file accepted (points). */
export const HISTORY_IMPORT_MAX_POINTS = 500_000;

/** One imported point as uploaded: [local time "YYYY-MM-DD HH:mm:ss", lat, lng, speed km/h, ignition 1/0/null]. */
export type HistoryImportRow = [string, number, number, number, 0 | 1 | null];

export interface ParsedOldHistory {
  /** Vehicle names in the file's summary rows ("Device Name"). */
  deviceNames: string[];
  /** Valid points in time order (duplicates removed), local time of the export. */
  rows: HistoryImportRow[];
  /** Rows dropped while reading (bad time / coordinates / speed). */
  skipped: number;
  /** Sum of the summary rows' "Distance (Kms)" (the old platform's km), when present. */
  oldKm: number | null;
}

const key = (h: unknown) =>
  String(h ?? '')
    .toLowerCase()
    .replace(/[^a-z]/g, '');

const LOCAL_TIME = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/;

/**
 * Reads the sheet as an array of rows (SheetJS `header: 1`, `raw: false`). Columns are found by their header names,
 * so column order and extra columns do not matter. Accepts one or many "Positions" tables (one per day).
 */
export function parseOldPlatformSheet(aoa: unknown[][]): ParsedOldHistory {
  const deviceNames = new Set<string>();
  const seen = new Set<string>();
  const rows: HistoryImportRow[] = [];
  let skipped = 0;
  let oldKm: number | null = null;
  let cols: { time: number; coords: number; lat: number; lng: number; speed: number; ignition: number } | null = null;
  for (let i = 0; i < aoa.length; i++) {
    const r = aoa[i] ?? [];
    const keys = r.map(key);
    if (keys[0] === 'devicename') {
      const values = aoa[i + 1] ?? [];
      const name = String(values[0] ?? '').trim();
      if (name) deviceNames.add(name);
      const kmIdx = keys.findIndex((k) => k.startsWith('distance'));
      const km = kmIdx >= 0 ? Number(values[kmIdx]) : NaN;
      if (Number.isFinite(km)) oldKm = (oldKm ?? 0) + km;
      cols = null;
      i++;
      continue;
    }
    const timeIdx = keys.findIndex((k) => k === 'gpstime' || k === 'fixtime' || k === 'time' || k === 'datetime');
    if (timeIdx >= 0 && keys.some((k) => k.startsWith('speed'))) {
      cols = {
        time: timeIdx,
        coords: keys.findIndex((k) => k === 'coords' || k === 'coordinates' || k === 'latlng' || k === 'location'),
        lat: keys.findIndex((k) => k === 'lat' || k === 'latitude'),
        lng: keys.findIndex((k) => k === 'lng' || k === 'lon' || k === 'long' || k === 'longitude'),
        speed: keys.findIndex((k) => k.startsWith('speed')),
        ignition: keys.findIndex((k) => k === 'ignition' || k === 'acc'),
      };
      continue;
    }
    if (!cols) continue;
    const time = String(r[cols.time] ?? '').trim();
    if (!time) continue;
    const m = LOCAL_TIME.exec(time);
    let lat = NaN;
    let lng = NaN;
    if (cols.coords >= 0) [lat, lng] = String(r[cols.coords] ?? '').split(/[,\s]+/).filter(Boolean).map(Number);
    else if (cols.lat >= 0 && cols.lng >= 0) [lat, lng] = [Number(r[cols.lat]), Number(r[cols.lng])];
    const speed = cols.speed >= 0 ? Number(r[cols.speed] || 0) : 0;
    if (!m || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180 || (Math.abs(lat) < 0.5 && Math.abs(lng) < 0.5) || !Number.isFinite(speed) || speed < 0 || speed > 300) {
      skipped++;
      continue;
    }
    const t = `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6] ?? '00'}`;
    if (seen.has(t)) continue;
    seen.add(t);
    const ign = cols.ignition >= 0 ? String(r[cols.ignition] ?? '').trim().toUpperCase() : '';
    rows.push([t, Math.round(lat * 1e6) / 1e6, Math.round(lng * 1e6) / 1e6, Math.round(speed * 10) / 10, ign === 'ON' || ign === '1' || ign === 'TRUE' ? 1 : ign === 'OFF' || ign === '0' || ign === 'FALSE' ? 0 : null]);
  }
  rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return { deviceNames: [...deviceNames], rows, skipped, oldKm: oldKm === null ? null : Math.round(oldKm * 10) / 10 };
}

/** Straight-line km along the points (an estimate: VeeTrax recomputes the real figure from its trips). */
export function straightLineKm(rows: Pick<HistoryImportRow, 1 | 2>[] | HistoryImportRow[]): number {
  let m = 0;
  for (let i = 1; i < rows.length; i++) {
    const [la1, lo1] = [rows[i - 1][1] as number, rows[i - 1][2] as number];
    const [la2, lo2] = [rows[i][1] as number, rows[i][2] as number];
    const rad = Math.PI / 180;
    const a = Math.sin(((la2 - la1) * rad) / 2) ** 2 + Math.cos(la1 * rad) * Math.cos(la2 * rad) * Math.sin(((lo2 - lo1) * rad) / 2) ** 2;
    const d = 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(a)));
    if (d < 50_000) m += d; // a jump of more than 50 km between two points is a gap, not driving
  }
  return Math.round(m / 100) / 10;
}

// ───────────── migration hold ─────────────

/** Company.settings key. `from` / `until`: YYYY-MM-DD (company local days). */
export const HISTORY_HOLD_SETTING = 'historyHold';

export interface HistoryHold {
  /** Oldest day kept while the hold lasts (the first imported day). */
  from: string;
  /** Last day of the hold (the move to VeeTrax + the retention days); after it the normal retention applies. */
  until: string;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function historyHoldOf(settings: unknown): HistoryHold | null {
  const raw = settings && typeof settings === 'object' ? (settings as Record<string, unknown>)[HISTORY_HOLD_SETTING] : undefined;
  if (!raw || typeof raw !== 'object') return null;
  const { from, until } = raw as Record<string, unknown>;
  return typeof from === 'string' && typeof until === 'string' && DAY.test(from) && DAY.test(until) && from <= until ? { from, until } : null;
}

/**
 * Retention days to apply now: the company's own, stretched while a migration hold lasts so that history back to
 * `hold.from` is kept and visible (+1 day margin for time zones). After `hold.until` it is the company's own again.
 */
export function heldRetentionDays(retentionDays: number, settings: unknown, now = Date.now()): number {
  const hold = historyHoldOf(settings);
  if (!hold) return retentionDays;
  if (now > Date.parse(`${hold.until}T00:00:00Z`) + 2 * DAY_MS) return retentionDays;
  const need = Math.ceil((now - Date.parse(`${hold.from}T00:00:00Z`)) / DAY_MS) + 1;
  return Math.max(retentionDays, need);
}

/** "2026-11-17" + 90 days. */
export function addDaysToDay(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

// ───────────── API shapes ─────────────

export type HistoryImportStatus = 'UPLOADING' | 'MATCHING' | 'SUMMARIZING' | 'DONE' | 'REMOVING' | 'REMOVED' | 'FAILED';

export interface HistoryImportPreviewRequest {
  /** Vehicle chosen in the dialog; empty = match `deviceName`. */
  objectId?: string | null;
  deviceName?: string | null;
}

export interface HistoryImportVehicle {
  objectId: string;
  name: string;
  plateNumber: string | null;
  companyId: string;
  companyName: string;
  /** Company time zone (the export's local times are read in it). */
  timezone: string;
  deviceUniqueId: string | null;
}

export interface HistoryImportPreview {
  /** The matched vehicle (null = choose one). */
  vehicle: HistoryImportVehicle | null;
  /** Other vehicles with a similar name (to choose from). */
  candidates: HistoryImportVehicle[];
  /** VeeTrax's own first fix for the vehicle (imported points must be before it); null = none yet. */
  ownDataFrom: string | null;
  /** Odometer now (km). */
  odometerKm: number | null;
  /** Company retention and the migration hold the import will set / extend. */
  retentionDays: number;
  hold: HistoryHold | null;
  holdAfterImport: HistoryHold;
  /** Earlier imports for this vehicle. */
  imports: HistoryImportDto[];
}

export interface HistoryImportStartRequest {
  objectId: string;
  fileName: string;
  /** First / last imported point, local time "YYYY-MM-DD HH:mm:ss". */
  firstLocal: string;
  lastLocal: string;
  points: number;
  oldKm?: number | null;
  /** Odometer to keep after the import (default: the current one). */
  odometerKm?: number | null;
}

export interface HistoryImportDto {
  id: string;
  objectId: string;
  objectName: string;
  fileName: string;
  from: string | null;
  to: string | null;
  points: number;
  inserted: number;
  oldKm: number | null;
  /** VeeTrax km of the imported days once recomputed. */
  importedKm: number | null;
  odometerKm: number | null;
  status: HistoryImportStatus;
  /** Points added along the roads between the imported ones (road snapping). */
  snappedPoints: number;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

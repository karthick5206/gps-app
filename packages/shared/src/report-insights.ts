/**
 * Report insights (RP-2): KPI tiles and charts per report type, computed only from the rows and totals a report run
 * returned. No new numbers are invented: KPI values come from `totals` (which cover every matching row) where the API
 * provides them; anything derived from rows is flagged `fromRows` so callers can say so when the 10,000-row cap
 * truncated the result.
 *
 * Shared by the web page (KPI strip + charts) and the API exports (PDF cover, XLSX Summary sheet), so a file shows the
 * same figures as the screen. Pure (Intl only, no imports) so node --test and jest can run it.
 */

export type InsightRow = Record<string, unknown>;
/** `min`: signed minutes with one decimal (a delay: + late, − early). */
export type ValueFormat = 'int' | 'km' | 'hm' | 'pct' | 'kph' | 'sec' | 'hours' | 'litres' | 'kmpl' | 'min';

export interface Kpi {
  id: string;
  label: string;
  value: number | null;
  format: ValueFormat;
  /** Short context line under the value (English; translated by the page). */
  hint?: { text: string; vars?: Record<string, string | number> };
  tone?: 'default' | 'warning' | 'danger';
  /** Derived from the returned rows (not API totals): partial when the result was truncated. */
  fromRows?: boolean;
}

export interface Segment {
  key: string;
  label: string;
  /** Colour token name the page maps to a CSS variable (and the PDF to a hex colour). */
  tone: 'primary' | 'running' | 'idle' | 'stopped' | 'critical' | 'warning' | 'info' | 'muted';
}

export interface BarDatum {
  key: string; // day (YYYY-MM-DD) or report period key
  values: Record<string, number>;
  /** Extra lines for the tooltip (e.g. km on a trips-per-day bar). */
  extra?: { label: string; value: number; format: ValueFormat }[];
}

export interface RankedItem {
  key: string;
  label: string;
  sub?: string | null;
  value: number;
}

export interface HistogramBin {
  key: string;
  /** "<5 min", "5–15 min", … "8 h+" */
  label: string;
  /** Lower bound (inclusive) and upper bound (exclusive, null = open), seconds. */
  min: number;
  max: number | null;
  values: Record<string, number>;
}

/** What a chart click selects; the table then shows only matching rows. */
export type InsightFilter =
  | { kind: 'day'; value: string }
  | { kind: 'period'; value: string }
  | { kind: 'vehicle'; value: string; label: string }
  | { kind: 'alertType'; value: string; label: string }
  | { kind: 'cell'; objectId: string; type: string; label: string }
  /** Rows whose `field` equals `value` (geofence, driver, place …). */
  | { kind: 'field'; field: string; value: string; label: string; prefix?: string }
  /** Geofence out-to-in pair. */
  | { kind: 'pair'; from: string; to: string; label: string }
  /** Duration bucket of a histogram: min <= row[field] < max (seconds). */
  | { kind: 'bucket'; field: string; min: number; max: number | null; label: string };

export type InsightChart =
  | { kind: 'bars'; title: string; segments: Segment[]; data: BarDatum[]; format: ValueFormat; select: 'day' | 'period' }
  | {
      kind: 'ranked';
      title: string;
      items: RankedItem[];
      format: ValueFormat;
      /** What a click on an item selects: a vehicle / alert type, or rows whose `field` equals the item key. */
      select: 'vehicle' | 'alertType' | 'pair' | { field: string; prefix: string };
      total: number;
    }
  | {
      kind: 'heatmap';
      title: string;
      rows: { key: string; label: string; sub?: string | null; total: number }[];
      cols: { key: string; label: string; total: number }[];
      cells: Record<string, { count: number; critical: number }>;
      max: number;
      hiddenRows: number;
      hiddenCols: number;
    }
  | {
      kind: 'histogram';
      title: string;
      /** Row field holding the duration in seconds (the bucket filter tests it). */
      field: string;
      segments: Segment[];
      bins: HistogramBin[];
      /** Rows left out because the duration is unknown (e.g. still inside a geofence). */
      skipped: number;
    };

export interface Insight {
  kpis: Kpi[];
  charts: InsightChart[];
  /** True when at least one chart is built from rows (affected by truncation). */
  chartsFromRows: boolean;
}

export interface InsightInput {
  type: string;
  rows: InsightRow[];
  totals?: Record<string, number>;
  from: string;
  to: string;
  tz?: string;
  /** Alert type code → label (ALERT_TYPE_MAP), passed in so this module stays dependency-free. */
  alertLabel?: (code: string) => string;
}

/** Report types with an insight panel: batch 1 (first 7) and batch 2. */
export const INSIGHT_TYPES = [
  'SUMMARY',
  'CONSOLIDATED',
  'TRIPS',
  'OVERSPEED',
  'ALERTS',
  'EVENT_SUMMARY',
  'ENGINE_HOURS',
  'STOPS',
  'HALT',
  'IDLE',
  'GEOFENCE_VISITS',
  'GEOFENCE_SUMMARY',
  'GEOFENCE_DISTANCE',
  'FUEL',
  'FUEL_EVENTS',
  'DRIVERS',
  'TRIP_PERFORMANCE',
  'PLANNED_TRIPS',
] as const;

const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const s = (v: unknown): string => (typeof v === 'string' ? v : '');
const tot = (totals: Record<string, number> | undefined, k: string): number | null => (totals && typeof totals[k] === 'number' ? totals[k] : null);
const round1 = (v: number) => Math.round(v * 10) / 10;

/** Calendar day (YYYY-MM-DD) of an instant in `tz` (undefined = the runtime's zone). */
export function dayKeyIn(iso: string | number | Date, tz?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', ...(tz ? { timeZone: tz } : {}) }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Same formula as the Engine hours report (report-data.service.ts): idle / engine, one decimal. */
export function idlePct(idleSec: number, engineSec: number): number {
  return engineSec ? Math.round((idleSec / engineSec) * 1000) / 10 : 0;
}

/** Same formula as shared utilisationPct: running / (running + idle + stopped + offline), whole percent. */
export function utilisation(t: { runningSec?: number; idleSec?: number; stopSec?: number; offlineSec?: number }): number | null {
  const run = t.runningSec ?? 0;
  const all = run + (t.idleSec ?? 0) + (t.stopSec ?? 0) + (t.offlineSec ?? 0);
  return all > 0 ? Math.round((run / all) * 100) : null;
}

/** Same rule as the FUEL report totals (fuel-report.ts): km/L only from >= 0.5 L over >= 1 km, two decimals. */
export function fuelKmPerL(distanceKm: number, consumptionL: number): number | null {
  return consumptionL >= 0.5 && distanceKm >= 1 ? Math.round((distanceKm / consumptionL) * 100) / 100 : null;
}

/** Every day from `from` to `to` inclusive (YYYY-MM-DD), capped at 400. */
export function insightDays(from: string, to: string): string[] {
  const out: string[] = [];
  let t = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(t) || !Number.isFinite(end)) return out;
  while (t <= end && out.length < 400) {
    out.push(new Date(t).toISOString().slice(0, 10));
    t += 86_400_000;
  }
  return out;
}

/** Row field giving a row's day, per report type (FUEL rows already carry the company day). */
export const DAY_FIELD: Record<string, string> = {
  ALERTS: 'occurredAt',
  GEOFENCE_VISITS: 'enterTime',
  FUEL: 'day',
  PLANNED_TRIPS: 'plannedStart',
};

function rowDay(type: string, row: InsightRow, tz: string | undefined): string {
  const field = DAY_FIELD[type] ?? 'startTime';
  const v = s(row[field]);
  if (!v) return '';
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : dayKeyIn(v, tz);
}

function perDay(type: string, rows: InsightRow[], from: string, to: string, tz: string | undefined, values: (r: InsightRow) => Record<string, number>, keys: string[]): Map<string, Record<string, number>> {
  const map = new Map<string, Record<string, number>>();
  for (const d of insightDays(from, to)) map.set(d, Object.fromEntries(keys.map((k) => [k, 0])));
  for (const r of rows) {
    const day = rowDay(type, r, tz);
    if (!day) continue;
    const acc = map.get(day) ?? Object.fromEntries(keys.map((k) => [k, 0]));
    const v = values(r);
    for (const k of keys) acc[k] += v[k] ?? 0;
    map.set(day, acc);
  }
  return new Map([...map.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

function perPeriod(rows: InsightRow[], keys: string[], value: (r: InsightRow, k: string) => number): BarDatum[] {
  const map = new Map<string, Record<string, number>>();
  for (const r of rows) {
    const p = s(r.period);
    const acc = map.get(p) ?? Object.fromEntries(keys.map((k) => [k, 0]));
    for (const k of keys) acc[k] += value(r, k);
    map.set(p, acc);
  }
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, values]) => ({ key, values }));
}

/** Items summed by `key(row)`, largest first, top `limit` (items with value 0 are dropped). */
function rankBy(rows: InsightRow[], key: (r: InsightRow) => { key: string; label: string; sub?: string | null } | null, value: (r: InsightRow) => number, limit = 10): { items: RankedItem[]; total: number } {
  const map = new Map<string, RankedItem>();
  for (const r of rows) {
    const k = key(r);
    if (!k || !k.key) continue;
    const it = map.get(k.key) ?? { key: k.key, label: k.label || k.key, sub: k.sub ?? null, value: 0 };
    it.value += value(r);
    map.set(k.key, it);
  }
  const all = [...map.values()].filter((i) => i.value > 0).sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
  return { items: all.slice(0, limit).map((i) => ({ ...i, value: Math.round(i.value * 100) / 100 })), total: all.length };
}

const vehicleKey = (r: InsightRow) => {
  const id = s(r.objectId) || s(r.objectName);
  return { key: id, label: s(r.objectName) || id, sub: (r.plateNumber as string | null) ?? null };
};
const rankVehicles = (rows: InsightRow[], value: (r: InsightRow) => number, limit = 10) => rankBy(rows, vehicleKey, value, limit);

const distinct = (rows: InsightRow[], k: string) => new Set(rows.map((r) => s(r[k])).filter(Boolean)).size;

// ---------------------------------------------------------------- duration histograms

const MIN = 60;
const HOUR = 3600;
/** Bucket edges (seconds) for stop / visit / trip durations. */
export const DURATION_EDGES = [0, 5 * MIN, 15 * MIN, 30 * MIN, HOUR, 2 * HOUR, 4 * HOUR, 8 * HOUR];

/** "<5 min", "5–15 min", "30–60 min", "1–2 h", "8 h+" for [min, max) in seconds. */
export function durationBinLabel(min: number, max: number | null): string {
  const unit = (v: number) => (v < HOUR || v % HOUR ? { v: v / MIN, u: 'min' } : { v: v / HOUR, u: 'h' });
  if (max === null) {
    const a = unit(min);
    return `${a.v} ${a.u}+`;
  }
  const b = unit(max);
  if (min === 0) return `<${b.v} ${b.u}`;
  const a = unit(min);
  // "30–60 min": keep minutes on both sides when the upper bound is the first whole hour.
  if (a.u === 'min' && b.u === 'h') return `${a.v}–${b.v * 60} min`;
  return `${a.v}–${b.v} ${b.u}`;
}

/**
 * Rows counted per duration bucket (`field` in seconds), split by `segment(row)` when given. Rows with a missing
 * duration are counted in `skipped`; empty buckets before the first and after the last used one are dropped.
 */
export function durationHistogram(
  rows: InsightRow[],
  field: string,
  segments: Segment[],
  segment: (r: InsightRow) => string = () => segments[0].key,
  edges: number[] = DURATION_EDGES,
): { bins: HistogramBin[]; skipped: number } {
  const bins: HistogramBin[] = edges.map((min, i) => {
    const max = i + 1 < edges.length ? edges[i + 1] : null;
    return { key: `b${i}`, label: durationBinLabel(min, max), min, max, values: Object.fromEntries(segments.map((sg) => [sg.key, 0])) };
  });
  let skipped = 0;
  for (const r of rows) {
    const v = r[field];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      skipped++;
      continue;
    }
    const bin = bins.find((b) => v >= b.min && (b.max === null || v < b.max));
    if (!bin) continue;
    const k = segment(r);
    bin.values[k] = (bin.values[k] ?? 0) + 1;
  }
  const used = bins.map((b) => Object.values(b.values).some((x) => x > 0));
  const first = used.indexOf(true);
  const last = used.lastIndexOf(true);
  return { bins: first < 0 ? [] : bins.slice(first, last + 1), skipped };
}

const vehicleSelect = 'vehicle' as const;

export function buildInsight(input: InsightInput): Insight | null {
  const { type, rows, totals, from, to, tz } = input;
  const label = input.alertLabel ?? ((c: string) => c);
  switch (type) {
    case 'SUMMARY': {
      const t = {
        runningSec: tot(totals, 'runningSec') ?? 0,
        idleSec: tot(totals, 'idleSec') ?? 0,
        stopSec: tot(totals, 'stopSec') ?? 0,
        offlineSec: tot(totals, 'offlineSec') ?? 0,
      };
      const top = rankVehicles(rows, (r) => n(r.distanceKm));
      return {
        kpis: [
          { id: 'distance', label: 'Distance', value: tot(totals, 'distanceKm'), format: 'km' },
          { id: 'running', label: 'Running time', value: tot(totals, 'runningSec'), format: 'hm' },
          { id: 'idle', label: 'Idle time', value: tot(totals, 'idleSec'), format: 'hm', tone: 'warning' },
          { id: 'trips', label: 'Trips', value: tot(totals, 'tripCount'), format: 'int' },
          { id: 'utilisation', label: 'Utilisation', value: utilisation(t), format: 'pct', hint: { text: 'Moving share of tracked time' } },
          { id: 'vehicles', label: 'Vehicles', value: tot(totals, 'vehicles'), format: 'int', hint: { text: 'Overspeed {{n}}', vars: { n: tot(totals, 'overspeedCount') ?? 0 } } },
        ],
        // The period bar charts are SummaryCharts on the page; the ranked list adds the per-vehicle view.
        charts: [{ kind: 'ranked', title: 'Distance by vehicle (km)', items: top.items, total: top.total, format: 'km', select: vehicleSelect }],
        chartsFromRows: true,
      };
    }

    case 'CONSOLIDATED': {
      const active = rows.filter((r) => n(r.activeDays) > 0).length;
      const km = rankVehicles(rows, (r) => n(r.distanceKm));
      const alerts = rankVehicles(rows, (r) => n(r.alertCount));
      const engine = tot(totals, 'engineSec') ?? 0;
      return {
        kpis: [
          { id: 'vehicles', label: 'Vehicles', value: tot(totals, 'vehicles'), format: 'int', hint: { text: '{{n}} active', vars: { n: active } }, fromRows: false },
          { id: 'distance', label: 'Distance', value: tot(totals, 'distanceKm'), format: 'km' },
          { id: 'running', label: 'Running time', value: tot(totals, 'runningSec'), format: 'hm' },
          { id: 'idlePct', label: 'Idle % of engine time', value: totals ? idlePct(tot(totals, 'idleSec') ?? 0, engine) : null, format: 'pct', tone: 'warning' },
          { id: 'alerts', label: 'Alerts', value: tot(totals, 'alertCount'), format: 'int', hint: { text: '{{n}} critical', vars: { n: tot(totals, 'criticalAlertCount') ?? 0 } }, tone: (tot(totals, 'criticalAlertCount') ?? 0) > 0 ? 'danger' : 'default' },
          { id: 'overspeed', label: 'Overspeed', value: tot(totals, 'overspeedCount'), format: 'int' },
        ],
        charts: [
          { kind: 'ranked', title: 'Distance by vehicle (km)', items: km.items, total: km.total, format: 'km', select: vehicleSelect },
          { kind: 'ranked', title: 'Alerts by vehicle', items: alerts.items, total: alerts.total, format: 'int', select: vehicleSelect },
        ],
        chartsFromRows: true,
      };
    }

    case 'TRIPS': {
      const count = tot(totals, 'count');
      const km = tot(totals, 'distanceKm');
      const longest = rows.reduce((m, r) => Math.max(m, n(r.distanceKm)), 0);
      const days = perDay(type, rows, from, to, tz, (r) => ({ trips: 1, km: n(r.distanceKm) }), ['trips', 'km']);
      const top = rankVehicles(rows, (r) => n(r.distanceKm));
      const segs: Segment[] = [{ key: 'trips', label: 'Trips', tone: 'primary' }];
      const hist = durationHistogram(rows, 'durationSec', segs);
      return {
        kpis: [
          { id: 'trips', label: 'Trips', value: count, format: 'int' },
          { id: 'distance', label: 'Distance', value: km, format: 'km' },
          { id: 'driving', label: 'Driving time', value: tot(totals, 'durationSec'), format: 'hm' },
          { id: 'avg', label: 'Average trip', value: count ? round1((km ?? 0) / count) : null, format: 'km' },
          { id: 'longest', label: 'Longest trip', value: rows.length ? longest : null, format: 'km', fromRows: true },
          { id: 'top', label: 'Top speed', value: tot(totals, 'maxSpeedKph'), format: 'kph' },
        ],
        charts: [
          {
            kind: 'bars',
            title: 'Trips per day',
            segments: segs,
            data: [...days.entries()].map(([key, v]) => ({ key, values: { trips: v.trips }, extra: [{ label: 'Distance', value: v.km, format: 'km' }] })),
            format: 'int',
            select: 'day',
          },
          { kind: 'ranked', title: 'Distance by vehicle (km)', items: top.items, total: top.total, format: 'km', select: vehicleSelect },
          { kind: 'histogram', title: 'Trips by duration', field: 'durationSec', segments: segs, bins: hist.bins, skipped: hist.skipped },
        ],
        chartsFromRows: true,
      };
    }

    case 'OVERSPEED': {
      const count = tot(totals, 'count');
      const dur = tot(totals, 'durationSec');
      const days = perDay(type, rows, from, to, tz, () => ({ episodes: 1 }), ['episodes']);
      const top = rankVehicles(rows, (r) => n(r.durationSec));
      return {
        kpis: [
          { id: 'episodes', label: 'Episodes', value: count, format: 'int', tone: count ? 'danger' : 'default' },
          { id: 'time', label: 'Time over limit', value: dur, format: 'hm' },
          { id: 'peak', label: 'Peak speed', value: tot(totals, 'maxSpeedKph'), format: 'kph', tone: 'danger' },
          { id: 'avg', label: 'Average episode', value: count ? Math.round((dur ?? 0) / count) : null, format: 'sec' },
          { id: 'vehicles', label: 'Vehicles involved', value: distinct(rows, 'objectId'), format: 'int', fromRows: true },
        ],
        charts: [
          { kind: 'bars', title: 'Over-speed episodes per day', segments: [{ key: 'episodes', label: 'Episodes', tone: 'critical' }], data: [...days.entries()].map(([key, values]) => ({ key, values })), format: 'int', select: 'day' },
          { kind: 'ranked', title: 'Time over the limit by vehicle', items: top.items, total: top.total, format: 'hm', select: vehicleSelect },
        ],
        chartsFromRows: true,
      };
    }

    case 'ALERTS': {
      const days = perDay(
        type,
        rows,
        from,
        to,
        tz,
        (r) => ({ CRITICAL: r.severity === 'CRITICAL' ? 1 : 0, WARNING: r.severity === 'WARNING' ? 1 : 0, INFO: r.severity === 'INFO' ? 1 : 0 }),
        ['CRITICAL', 'WARNING', 'INFO'],
      );
      const byType = new Map<string, RankedItem>();
      for (const r of rows) {
        const code = s(r.type);
        const it = byType.get(code) ?? { key: code, label: label(code), value: 0 };
        it.value++;
        byType.set(code, it);
      }
      const types = [...byType.values()].sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
      return {
        kpis: [
          { id: 'alerts', label: 'Alerts', value: tot(totals, 'count'), format: 'int' },
          { id: 'critical', label: 'Critical', value: tot(totals, 'CRITICAL'), format: 'int', tone: (tot(totals, 'CRITICAL') ?? 0) > 0 ? 'danger' : 'default' },
          { id: 'warning', label: 'Warning', value: tot(totals, 'WARNING'), format: 'int', tone: 'warning' },
          { id: 'info', label: 'Info', value: tot(totals, 'INFO'), format: 'int' },
          { id: 'vehicles', label: 'Vehicles', value: distinct(rows, 'objectId'), format: 'int', fromRows: true },
        ],
        charts: [
          {
            kind: 'bars',
            title: 'Alerts per day by severity',
            segments: [
              { key: 'CRITICAL', label: 'Critical', tone: 'critical' },
              { key: 'WARNING', label: 'Warning', tone: 'warning' },
              { key: 'INFO', label: 'Info', tone: 'info' },
            ],
            data: [...days.entries()].map(([key, values]) => ({ key, values })),
            format: 'int',
            select: 'day',
          },
          { kind: 'ranked', title: 'Alerts by type', items: types.slice(0, 10), total: types.length, format: 'int', select: 'alertType' },
        ],
        chartsFromRows: true,
      };
    }

    case 'EVENT_SUMMARY': {
      const MAX_ROWS = 25;
      const MAX_COLS = 12;
      const vehicles = new Map<string, { key: string; label: string; sub: string | null; total: number }>();
      const cols = new Map<string, { key: string; label: string; total: number }>();
      const cells: Record<string, { count: number; critical: number }> = {};
      for (const r of rows) {
        const v = s(r.objectId);
        const code = s(r.type);
        const c = n(r.count);
        const vr = vehicles.get(v) ?? { key: v, label: s(r.objectName) || v, sub: (r.plateNumber as string | null) ?? null, total: 0 };
        vr.total += c;
        vehicles.set(v, vr);
        const col = cols.get(code) ?? { key: code, label: label(code), total: 0 };
        col.total += c;
        cols.set(code, col);
        const cell = (cells[`${v}|${code}`] ??= { count: 0, critical: 0 });
        cell.count += c;
        cell.critical += n(r.criticalCount);
      }
      const rowList = [...vehicles.values()].sort((a, b) => b.total - a.total || a.label.localeCompare(b.label));
      const colList = [...cols.values()].sort((a, b) => b.total - a.total || a.label.localeCompare(b.label));
      const shownRows = rowList.slice(0, MAX_ROWS);
      const shownCols = colList.slice(0, MAX_COLS);
      let max = 0;
      for (const r of shownRows) for (const c of shownCols) max = Math.max(max, cells[`${r.key}|${c.key}`]?.count ?? 0);
      return {
        kpis: [
          { id: 'events', label: 'Events', value: tot(totals, 'count'), format: 'int' },
          { id: 'critical', label: 'Critical', value: tot(totals, 'criticalCount'), format: 'int', tone: (tot(totals, 'criticalCount') ?? 0) > 0 ? 'danger' : 'default' },
          { id: 'vehicles', label: 'Vehicles', value: vehicles.size, format: 'int', fromRows: true },
          { id: 'types', label: 'Event types', value: cols.size, format: 'int', fromRows: true },
        ],
        charts: [{ kind: 'heatmap', title: 'Events by vehicle and type', rows: shownRows, cols: shownCols, cells, max, hiddenRows: rowList.length - shownRows.length, hiddenCols: colList.length - shownCols.length }],
        chartsFromRows: true,
      };
    }

    case 'ENGINE_HOURS': {
      const data = perPeriod(rows, ['running', 'idle'], (r, k) => (k === 'running' ? n(r.runningSec) : n(r.idleSec)) / 3600);
      const top = rankVehicles(rows, (r) => n(r.idleSec));
      return {
        kpis: [
          { id: 'engine', label: 'Engine on', value: tot(totals, 'engineSec'), format: 'hm' },
          { id: 'running', label: 'Running', value: tot(totals, 'runningSec'), format: 'hm' },
          { id: 'idle', label: 'Idle', value: tot(totals, 'idleSec'), format: 'hm', tone: 'warning' },
          { id: 'idlePct', label: 'Idle %', value: tot(totals, 'idlePct'), format: 'pct', tone: (tot(totals, 'idlePct') ?? 0) >= 20 ? 'warning' : 'default' },
          { id: 'vehicles', label: 'Vehicles', value: tot(totals, 'vehicles'), format: 'int' },
        ],
        charts: [
          {
            kind: 'bars',
            title: 'Engine hours: running and idle',
            segments: [
              { key: 'running', label: 'Running', tone: 'running' },
              { key: 'idle', label: 'Idle', tone: 'idle' },
            ],
            data,
            format: 'hours',
            select: 'period',
          },
          { kind: 'ranked', title: 'Idle time by vehicle', items: top.items, total: top.total, format: 'hm', select: vehicleSelect },
        ],
        chartsFromRows: true,
      };
    }

    // ------------------------------------------------------------ batch 2

    case 'STOPS':
    case 'HALT':
    case 'IDLE': {
      // Totals (every matching row): count, durationSec. Same Stop rows for the three types (report-data.service.ts).
      const count = tot(totals, 'count');
      const dur = tot(totals, 'durationSec');
      const longest = rows.reduce((m, r) => Math.max(m, n(r.durationSec)), 0);
      const idleStops = rows.filter((r) => r.ignitionOn === true).length;
      const segs: Segment[] =
        type === 'STOPS'
          ? [
              { key: 'parked', label: 'Parked', tone: 'primary' },
              { key: 'idle', label: 'Idle', tone: 'idle' },
            ]
          : type === 'IDLE'
            ? [{ key: 'idle', label: 'Idle', tone: 'idle' }]
            : [{ key: 'parked', label: 'Parked', tone: 'primary' }];
      const hist = durationHistogram(rows, 'durationSec', segs, (r) => (type === 'STOPS' ? (r.ignitionOn ? 'idle' : 'parked') : segs[0].key));
      const byVehicle = rankVehicles(rows, (r) => n(r.durationSec));
      // Places: the POI the stop is in, else its address. Rows with only coordinates are not grouped.
      const places = rankBy(
        rows,
        (r) => {
          const poi = s(r.poiName);
          if (poi) return { key: `poi:${poi}`, label: poi };
          const a = s(r.address);
          return a ? { key: `addr:${a}`, label: a } : null;
        },
        (r) => n(r.durationSec),
      );
      const what = type === 'IDLE' ? 'Idling' : type === 'HALT' ? 'Halt' : 'Stopped';
      const kpis: Kpi[] = [
        { id: 'count', label: type === 'IDLE' ? 'Idle stops' : type === 'HALT' ? 'Halts' : 'Stops', value: count, format: 'int' },
        { id: 'time', label: `${what} time`, value: dur, format: 'hm', tone: type === 'IDLE' ? 'warning' : 'default' },
        { id: 'avg', label: type === 'HALT' ? 'Average halt' : 'Average stop', value: count ? Math.round((dur ?? 0) / count) : null, format: 'sec' },
        { id: 'longest', label: type === 'HALT' ? 'Longest halt' : 'Longest stop', value: rows.length ? longest : null, format: 'hm', fromRows: true },
        { id: 'vehicles', label: 'Vehicles', value: distinct(rows, 'objectId'), format: 'int', fromRows: true },
      ];
      if (type === 'STOPS') kpis.push({ id: 'idleStops', label: 'Idle stops', value: idleStops, format: 'int', tone: 'warning', fromRows: true, hint: { text: 'Engine running while stopped' } });
      const charts: InsightChart[] = [
        { kind: 'histogram', title: type === 'HALT' ? 'Halts by duration' : 'Stops by duration', field: 'durationSec', segments: segs, bins: hist.bins, skipped: hist.skipped },
        { kind: 'ranked', title: `${what} time by vehicle`, items: byVehicle.items, total: byVehicle.total, format: 'hm', select: vehicleSelect },
      ];
      if (places.items.length) charts.push({ kind: 'ranked', title: `Top places by ${what.toLowerCase()} time`, items: places.items, total: places.total, format: 'hm', select: { field: 'place', prefix: 'Place' } });
      return { kpis, charts, chartsFromRows: true };
    }

    case 'GEOFENCE_VISITS': {
      // Totals: count, durationSec (open visits have no duration and add nothing).
      const count = tot(totals, 'count');
      const dur = tot(totals, 'durationSec');
      const closed = rows.filter((r) => typeof r.durationSec === 'number');
      const closedSec = closed.reduce((a, r) => a + n(r.durationSec), 0);
      const inside = rows.filter((r) => !r.exitTime).length;
      const segs: Segment[] = [{ key: 'visits', label: 'Visits', tone: 'primary' }];
      const hist = durationHistogram(rows, 'durationSec', segs);
      const days = perDay(type, rows, from, to, tz, () => ({ visits: 1 }), ['visits']);
      const byFence = rankBy(rows, (r) => ({ key: s(r.geofenceId) || s(r.geofenceName), label: s(r.geofenceName) }), () => 1);
      return {
        kpis: [
          { id: 'visits', label: 'Visits', value: count, format: 'int' },
          { id: 'inside', label: 'Time inside', value: dur, format: 'hm' },
          { id: 'avg', label: 'Average visit', value: closed.length ? Math.round(closedSec / closed.length) : null, format: 'sec', fromRows: true, hint: { text: 'Completed visits' } },
          { id: 'open', label: 'Still inside', value: inside, format: 'int', fromRows: true },
          { id: 'geofences', label: 'Geofences', value: distinct(rows, 'geofenceId'), format: 'int', fromRows: true },
          { id: 'vehicles', label: 'Vehicles', value: distinct(rows, 'objectId'), format: 'int', fromRows: true },
        ],
        charts: [
          { kind: 'ranked', title: 'Visits by geofence', items: byFence.items, total: byFence.total, format: 'int', select: { field: 'geofenceId', prefix: 'Geofence' } },
          { kind: 'histogram', title: 'Visits by time inside', field: 'durationSec', segments: segs, bins: hist.bins, skipped: hist.skipped },
          { kind: 'bars', title: 'Entries per day', segments: segs, data: [...days.entries()].map(([key, values]) => ({ key, values })), format: 'int', select: 'day' },
        ],
        chartsFromRows: true,
      };
    }

    case 'GEOFENCE_SUMMARY': {
      // Totals: visits, insideSec (open visits counted up to now, as the report does).
      const visits = tot(totals, 'visits');
      const inside = tot(totals, 'insideSec');
      const byFence = rankBy(rows, (r) => ({ key: s(r.geofenceId) || s(r.geofenceName), label: s(r.geofenceName) }), (r) => n(r.insideSec));
      const byVehicle = rankVehicles(rows, (r) => n(r.visits));
      return {
        kpis: [
          { id: 'visits', label: 'Visits', value: visits, format: 'int' },
          { id: 'inside', label: 'Time inside', value: inside, format: 'hm' },
          { id: 'avg', label: 'Average visit', value: visits && inside !== null ? Math.round(inside / visits) : null, format: 'sec' },
          { id: 'geofences', label: 'Geofences', value: distinct(rows, 'geofenceId'), format: 'int', fromRows: true },
          { id: 'vehicles', label: 'Vehicles', value: distinct(rows, 'objectId'), format: 'int', fromRows: true },
          { id: 'open', label: 'Still inside', value: rows.filter((r) => !r.lastExit).length, format: 'int', fromRows: true, hint: { text: 'Vehicle–geofence pairs' } },
        ],
        charts: [
          { kind: 'ranked', title: 'Time inside by geofence', items: byFence.items, total: byFence.total, format: 'hm', select: { field: 'geofenceId', prefix: 'Geofence' } },
          { kind: 'ranked', title: 'Visits by vehicle', items: byVehicle.items, total: byVehicle.total, format: 'int', select: vehicleSelect },
        ],
        chartsFromRows: true,
      };
    }

    case 'GEOFENCE_DISTANCE': {
      // Totals: count, travelSec, distanceKm (every out-to-in stretch, incl. ones not yet arrived).
      const count = tot(totals, 'count');
      const km = tot(totals, 'distanceKm');
      const arrived = rows.filter((r) => !!r.inTime);
      const segs: Segment[] = [{ key: 'trips', label: 'Stretches', tone: 'primary' }];
      const hist = durationHistogram(arrived, 'travelSec', segs);
      const pairs = rankBy(
        rows,
        (r) => (r.toGeofenceName ? { key: `${s(r.fromGeofenceName)}→${s(r.toGeofenceName)}`, label: `${s(r.fromGeofenceName)} → ${s(r.toGeofenceName)}` } : null),
        (r) => n(r.distanceKm),
      );
      return {
        kpis: [
          { id: 'count', label: 'Out-to-in stretches', value: count, format: 'int' },
          { id: 'distance', label: 'Distance', value: km, format: 'km' },
          { id: 'travel', label: 'Travel time', value: tot(totals, 'travelSec'), format: 'hm' },
          { id: 'avg', label: 'Average distance', value: count ? round1((km ?? 0) / count) : null, format: 'km' },
          { id: 'pending', label: 'Not arrived yet', value: rows.length - arrived.length, format: 'int', fromRows: true },
        ],
        charts: [
          { kind: 'ranked', title: 'Distance by geofence pair (km)', items: pairs.items, total: pairs.total, format: 'km', select: 'pair' },
          { kind: 'histogram', title: 'Travel time between geofences', field: 'travelSec', segments: segs, bins: hist.bins, skipped: rows.length - arrived.length },
        ],
        chartsFromRows: true,
      };
    }

    case 'FUEL': {
      // Totals: vehicles, refills, refillL, drains, drainL, consumptionL, distanceKm, kmPerL (0 = not enough data).
      const kmPerL = tot(totals, 'kmPerL');
      const days = perDay(type, rows, from, to, tz, (r) => ({ consumed: n(r.consumptionL), refilled: n(r.refillL), drained: n(r.drainL) }), ['consumed', 'refilled', 'drained']);
      const consumed = rankVehicles(rows, (r) => n(r.consumptionL));
      const drained = rankVehicles(rows, (r) => n(r.drainL));
      return {
        kpis: [
          { id: 'consumed', label: 'Fuel consumed', value: tot(totals, 'consumptionL'), format: 'litres' },
          { id: 'distance', label: 'Distance', value: tot(totals, 'distanceKm'), format: 'km' },
          { id: 'kmPerL', label: 'Fleet km/L', value: kmPerL ? kmPerL : null, format: 'kmpl', hint: { text: 'Days with consumption data' } },
          { id: 'refilled', label: 'Refilled', value: tot(totals, 'refillL'), format: 'litres', hint: { text: '{{n}} refills', vars: { n: tot(totals, 'refills') ?? 0 } } },
          { id: 'drained', label: 'Drained', value: tot(totals, 'drainL'), format: 'litres', tone: (tot(totals, 'drainL') ?? 0) > 0 ? 'danger' : 'default', hint: { text: '{{n}} drains', vars: { n: tot(totals, 'drains') ?? 0 } } },
          { id: 'vehicles', label: 'Vehicles', value: tot(totals, 'vehicles'), format: 'int' },
        ],
        charts: [
          {
            kind: 'bars',
            title: 'Fuel consumed per day (L)',
            segments: [{ key: 'consumed', label: 'Consumed', tone: 'primary' }],
            data: [...days.entries()].map(([key, v]) => ({
              key,
              values: { consumed: round1(v.consumed) },
              extra: [
                { label: 'Refilled', value: round1(v.refilled), format: 'litres' },
                { label: 'Drained', value: round1(v.drained), format: 'litres' },
              ],
            })),
            format: 'litres',
            select: 'day',
          },
          { kind: 'ranked', title: 'Fuel consumed by vehicle (L)', items: consumed.items, total: consumed.total, format: 'litres', select: vehicleSelect },
          ...(drained.items.length ? [{ kind: 'ranked', title: 'Fuel drained by vehicle (L)', items: drained.items, total: drained.total, format: 'litres', select: vehicleSelect } as InsightChart] : []),
        ],
        chartsFromRows: true,
      };
    }

    case 'FUEL_EVENTS': {
      // Totals: count, refills, refillL, drains, drainL.
      const days = perDay(type, rows, from, to, tz, (r) => ({ REFILL: r.type === 'REFILL' ? 1 : 0, DRAIN: r.type === 'DRAIN' ? 1 : 0 }), ['REFILL', 'DRAIN']);
      const drained = rankVehicles(rows, (r) => (r.type === 'DRAIN' ? n(r.deltaL) : 0));
      const drains = tot(totals, 'drains') ?? 0;
      return {
        kpis: [
          { id: 'events', label: 'Events', value: tot(totals, 'count'), format: 'int' },
          { id: 'refills', label: 'Refills', value: tot(totals, 'refills'), format: 'int', hint: { text: '{{n}} L', vars: { n: tot(totals, 'refillL') ?? 0 } } },
          { id: 'refillL', label: 'Refilled', value: tot(totals, 'refillL'), format: 'litres' },
          { id: 'drains', label: 'Drains', value: drains, format: 'int', tone: drains > 0 ? 'danger' : 'default' },
          { id: 'drainL', label: 'Drained', value: tot(totals, 'drainL'), format: 'litres', tone: drains > 0 ? 'danger' : 'default' },
          { id: 'vehicles', label: 'Vehicles', value: distinct(rows, 'objectId'), format: 'int', fromRows: true },
        ],
        charts: [
          {
            kind: 'bars',
            title: 'Refills and drains per day',
            segments: [
              { key: 'REFILL', label: 'Refills', tone: 'running' },
              { key: 'DRAIN', label: 'Drains', tone: 'critical' },
            ],
            data: [...days.entries()].map(([key, values]) => ({ key, values })),
            format: 'int',
            select: 'day',
          },
          { kind: 'ranked', title: 'Fuel drained by vehicle (L)', items: drained.items, total: drained.total, format: 'litres', select: vehicleSelect },
        ],
        chartsFromRows: true,
      };
    }

    case 'DRIVERS': {
      // Totals: drivers, sessions, tripCount, distanceKm, drivingSec, maxSpeedKph, overspeedCount.
      const driver = (r: InsightRow) => ({ key: s(r.driverId) || s(r.driverName), label: s(r.driverName), sub: (r.employeeId as string | null) ?? null });
      const km = rankBy(rows, driver, (r) => n(r.distanceKm));
      const driving = rankBy(rows, driver, (r) => n(r.drivingSec));
      const overspeed = rankBy(rows, driver, (r) => n(r.overspeedCount));
      const os = tot(totals, 'overspeedCount') ?? 0;
      const charts: InsightChart[] = [
        { kind: 'ranked', title: 'Distance by driver (km)', items: km.items, total: km.total, format: 'km', select: { field: 'driverId', prefix: 'Driver' } },
        { kind: 'ranked', title: 'Driving time by driver', items: driving.items, total: driving.total, format: 'hm', select: { field: 'driverId', prefix: 'Driver' } },
      ];
      if (overspeed.items.length) charts.push({ kind: 'ranked', title: 'Overspeed alerts by driver', items: overspeed.items, total: overspeed.total, format: 'int', select: { field: 'driverId', prefix: 'Driver' } });
      return {
        kpis: [
          { id: 'drivers', label: 'Drivers', value: tot(totals, 'drivers'), format: 'int' },
          { id: 'distance', label: 'Distance', value: tot(totals, 'distanceKm'), format: 'km' },
          { id: 'driving', label: 'Driving time', value: tot(totals, 'drivingSec'), format: 'hm' },
          { id: 'trips', label: 'Trips', value: tot(totals, 'tripCount'), format: 'int', hint: { text: '{{n}} sessions', vars: { n: tot(totals, 'sessions') ?? 0 } } },
          { id: 'overspeed', label: 'Overspeed', value: os, format: 'int', tone: os > 0 ? 'danger' : 'default' },
          { id: 'top', label: 'Top speed', value: tot(totals, 'maxSpeedKph'), format: 'kph' },
        ],
        charts,
        chartsFromRows: true,
      };
    }

    case 'TRIP_PERFORMANCE': {
      // Totals: groups, trips, completed, incomplete, cancelled, ratedStops, onTimeStops, onTimePct, skippedStops,
      // avgStartDelayMin, avgStopDelayMin, plannedKm, actualKm, deviations (averages left out when nothing to average).
      const by = s(rows[0]?.groupBy) || 'ROUTE';
      const noun = by === 'DRIVER' ? 'driver' : by === 'VEHICLE' ? 'vehicle' : 'route';
      const group = (r: InsightRow) => ({ key: s(r.groupName), label: s(r.groupName) });
      const select = { field: 'groupName', prefix: noun === 'driver' ? 'Driver' : noun === 'vehicle' ? 'Vehicle' : 'Route' };
      const onTime = rankBy(rows, group, (r) => n(r.onTimePct));
      const skipped = rankBy(rows, group, (r) => n(r.skippedStops));
      const skippedAll = tot(totals, 'skippedStops') ?? 0;
      const deviations = tot(totals, 'deviations') ?? 0;
      const charts: InsightChart[] = [{ kind: 'ranked', title: `On-time % by ${noun}`, items: onTime.items, total: onTime.total, format: 'pct', select }];
      if (skipped.items.length) charts.push({ kind: 'ranked', title: `Skipped stops by ${noun}`, items: skipped.items, total: skipped.total, format: 'int', select });
      return {
        kpis: [
          { id: 'trips', label: 'Trips', value: tot(totals, 'trips'), format: 'int', hint: { text: '{{n}} completed', vars: { n: tot(totals, 'completed') ?? 0 } } },
          { id: 'onTime', label: 'On time', value: tot(totals, 'onTimePct'), format: 'pct', hint: { text: '{{n}} of {{m}} stops', vars: { n: tot(totals, 'onTimeStops') ?? 0, m: tot(totals, 'ratedStops') ?? 0 } } },
          { id: 'startDelay', label: 'Average start delay', value: tot(totals, 'avgStartDelayMin'), format: 'min' },
          { id: 'stopDelay', label: 'Average stop delay', value: tot(totals, 'avgStopDelayMin'), format: 'min' },
          { id: 'skipped', label: 'Skipped stops', value: skippedAll, format: 'int', tone: skippedAll > 0 ? 'warning' : 'default' },
          { id: 'deviations', label: 'Deviations', value: deviations, format: 'int', tone: deviations > 0 ? 'danger' : 'default', hint: { text: 'Planned {{p}} km, actual {{a}} km', vars: { p: tot(totals, 'plannedKm') ?? 0, a: tot(totals, 'actualKm') ?? 0 } } },
        ],
        charts,
        chartsFromRows: true,
      };
    }

    case 'PLANNED_TRIPS': {
      // Totals: count, completed, incomplete, cancelled, stopsDone, stopCount, skippedStops, onTimeStops, deviationCount, plannedKm, distanceKm.
      const keys = ['COMPLETED', 'INCOMPLETE', 'CANCELLED', 'OTHER'];
      const days = perDay(type, rows, from, to, tz, (r) => {
        const st = s(r.status);
        return { [keys.includes(st) ? st : 'OTHER']: 1 };
      }, keys);
      const route = rankBy(rows, (r) => ({ key: s(r.routeName), label: s(r.routeName) }), () => 1);
      const incomplete = tot(totals, 'incomplete') ?? 0;
      const skipped = tot(totals, 'skippedStops') ?? 0;
      const deviations = tot(totals, 'deviationCount') ?? 0;
      return {
        kpis: [
          { id: 'trips', label: 'Trips', value: tot(totals, 'count'), format: 'int' },
          { id: 'completed', label: 'Completed', value: tot(totals, 'completed'), format: 'int' },
          { id: 'incomplete', label: 'Incomplete', value: incomplete, format: 'int', tone: incomplete > 0 ? 'warning' : 'default' },
          { id: 'cancelled', label: 'Cancelled', value: tot(totals, 'cancelled'), format: 'int' },
          { id: 'skipped', label: 'Skipped stops', value: skipped, format: 'int', tone: skipped > 0 ? 'warning' : 'default', hint: { text: '{{n}} of {{m}} stops done', vars: { n: tot(totals, 'stopsDone') ?? 0, m: tot(totals, 'stopCount') ?? 0 } } },
          { id: 'deviations', label: 'Deviations', value: deviations, format: 'int', tone: deviations > 0 ? 'danger' : 'default' },
        ],
        charts: [
          {
            kind: 'bars',
            title: 'Planned trips per day',
            segments: [
              { key: 'COMPLETED', label: 'Completed', tone: 'running' },
              { key: 'INCOMPLETE', label: 'Incomplete', tone: 'warning' },
              { key: 'CANCELLED', label: 'Cancelled', tone: 'muted' },
              { key: 'OTHER', label: 'Scheduled / running', tone: 'info' },
            ],
            data: [...days.entries()].map(([key, values]) => ({ key, values })),
            format: 'int',
            select: 'day',
          },
          { kind: 'ranked', title: 'Trips by route', items: route.items, total: route.total, format: 'int', select: { field: 'routeName', prefix: 'Route' } },
        ],
        chartsFromRows: true,
      };
    }

    default:
      return null;
  }
}

/** Value used by a `field` filter: `place` is the stop's POI name, else its address (as in the places chart). */
function fieldValue(row: InsightRow, field: string): string {
  if (field === 'place') {
    const poi = s(row.poiName);
    if (poi) return `poi:${poi}`;
    const a = s(row.address);
    return a ? `addr:${a}` : '';
  }
  if (field === 'geofenceId') return s(row.geofenceId) || s(row.geofenceName);
  if (field === 'driverId') return s(row.driverId) || s(row.driverName);
  return s(row[field]);
}

/** Does a row match a chart selection? */
export function rowMatches(type: string, row: InsightRow, f: InsightFilter, tz?: string): boolean {
  switch (f.kind) {
    case 'vehicle':
      return (s(row.objectId) || s(row.objectName)) === f.value;
    case 'period':
      return s(row.period) === f.value;
    case 'alertType':
      return s(row.type) === f.value;
    case 'cell':
      return s(row.objectId) === f.objectId && s(row.type) === f.type;
    case 'field':
      return fieldValue(row, f.field) === f.value;
    case 'pair':
      return s(row.fromGeofenceName) === f.from && s(row.toGeofenceName) === f.to;
    case 'bucket': {
      const v = row[f.field];
      return typeof v === 'number' && v >= f.min && (f.max === null || v < f.max);
    }
    case 'day':
      return rowDay(type, row, tz) === f.value;
  }
}

/** The filter a click on a ranked item selects. */
export function rankedFilter(select: Extract<InsightChart, { kind: 'ranked' }>['select'], item: RankedItem): InsightFilter {
  if (select === 'vehicle') return { kind: 'vehicle', value: item.key, label: item.label };
  if (select === 'alertType') return { kind: 'alertType', value: item.key, label: item.label };
  if (select === 'pair') {
    const [from, to] = item.key.split('→');
    return { kind: 'pair', from, to, label: item.label };
  }
  return { kind: 'field', field: select.field, value: item.key, label: item.label, prefix: select.prefix };
}

// ---------------------------------------------------------------- value formatting (exports)

/** Seconds → "hh:mm" (hours may exceed 24). */
export function formatHoursMinutes(totalSeconds: number): string {
  const mins = Math.max(0, Math.round(totalSeconds / 60));
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
}

/** A KPI / chart value as text, the same way the page shows it ("1,234.5 km", "12:05", "42%"). */
export function formatInsightValue(v: number | null | undefined, f: ValueFormat, locale?: string): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const fixed = (d: number) => v.toLocaleString(locale, { minimumFractionDigits: d, maximumFractionDigits: d });
  switch (f) {
    case 'km':
      return `${fixed(1)} km`;
    case 'hm':
      return formatHoursMinutes(v);
    case 'hours':
      return formatHoursMinutes(v * 3600);
    case 'pct':
      return `${Number.isInteger(v) ? v : v.toFixed(1)}%`;
    case 'kph':
      return `${Math.round(v)} km/h`;
    case 'sec':
      return v < 120 ? `${Math.round(v)} s` : formatHoursMinutes(v);
    case 'litres':
      return `${v.toLocaleString(locale, { maximumFractionDigits: 1 })} L`;
    case 'kmpl':
      return `${fixed(2)} km/L`;
    case 'min':
      return `${fixed(1)} min`;
    default:
      return Math.round(v).toLocaleString(locale);
  }
}

/** "{{n}} critical" + {n: 3} → "3 critical". */
export function interpolate(text: string, vars?: Record<string, string | number>): string {
  return vars ? text.replace(/\{\{(\w+)\}\}/g, (_, k: string) => (vars[k] === undefined ? '' : String(vars[k]))) : text;
}

// ---------------------------------------------------------------- row keys ("Export filtered view")

/** Fields left out of a row key: addresses are filled best-effort per run, so they can differ between two runs. */
const VOLATILE = /address$/i;

/**
 * Short, stable fingerprint of a report row (8 base-36 characters, cyrb53 of the row's JSON without address fields).
 * The page sends the keys of the rows it shows; the export re-runs the report and keeps only rows whose key matches,
 * so a filtered file can only contain rows the server itself produced.
 */
export function reportRowKey(row: InsightRow): string {
  const json = JSON.stringify(row, (k, v) => (k && VOLATILE.test(k) ? undefined : v));
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < json.length; i++) {
    const ch = json.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const v = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return (v % 2821109907456).toString(36).padStart(8, '0'); // 36^8
}

export const ROW_KEY_LENGTH = 8;
/** Most rows a filtered-view export can name (the on-screen result is capped at 10,000 rows). */
export const VIEW_MAX_ROWS = 10_000;

/** Splits the concatenated keys of `view.rows` into keys. */
export function splitRowKeys(joined: string): string[] {
  const out: string[] = [];
  for (let i = 0; i + ROW_KEY_LENGTH <= joined.length; i += ROW_KEY_LENGTH) out.push(joined.slice(i, i + ROW_KEY_LENGTH));
  return out;
}

/**
 * Rows of `rows` named by `keys`, in the order of `keys` (the order the page showed them). Duplicate rows are matched
 * one for one. Returns the rows and how many keys found no row (the data changed since the page ran the report).
 */
export function pickRowsByKey<T extends InsightRow>(rows: readonly T[], keys: readonly string[]): { rows: T[]; missing: number } {
  const byKey = new Map<string, T[]>();
  for (const r of rows) {
    const k = reportRowKey(r);
    const list = byKey.get(k);
    if (list) list.push(r);
    else byKey.set(k, [r]);
  }
  const out: T[] = [];
  let missing = 0;
  for (const k of keys) {
    const r = byKey.get(k)?.shift();
    if (r) out.push(r);
    else missing++;
  }
  return { rows: out, missing };
}

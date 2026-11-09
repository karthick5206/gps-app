/**
 * Report insights (RP-2): KPI tiles and one primary chart per report type, computed only from the rows and totals the
 * API returned for the run. No new numbers are invented: KPI values come from `totals` (which cover every matching row)
 * where the API provides them; anything derived from rows is flagged `fromRows` so the page can say so when the
 * on-screen 10,000-row cap truncated the result. Pure (no React / DOM) so node --test can run it.
 */
import { dayKeyInZone } from './report-time.ts';

export type Row = Record<string, unknown>;
export type ValueFormat = 'int' | 'km' | 'hm' | 'pct' | 'kph' | 'sec' | 'hours';

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
  /** Colour token name the page maps to a CSS variable. */
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

/** What a chart click selects; the table then shows only matching rows. */
export type InsightFilter =
  | { kind: 'day'; value: string }
  | { kind: 'period'; value: string }
  | { kind: 'vehicle'; value: string; label: string }
  | { kind: 'alertType'; value: string; label: string }
  | { kind: 'cell'; objectId: string; type: string; label: string };

export type InsightChart =
  | { kind: 'bars'; title: string; segments: Segment[]; data: BarDatum[]; format: ValueFormat; select: 'day' | 'period' }
  | { kind: 'ranked'; title: string; items: RankedItem[]; format: ValueFormat; select: 'vehicle' | 'alertType'; total: number }
  | {
      kind: 'heatmap';
      title: string;
      rows: { key: string; label: string; sub?: string | null; total: number }[];
      cols: { key: string; label: string; total: number }[];
      cells: Record<string, { count: number; critical: number }>;
      max: number;
      hiddenRows: number;
      hiddenCols: number;
    };

export interface Insight {
  kpis: Kpi[];
  charts: InsightChart[];
  /** True when at least one chart is built from rows (affected by truncation). */
  chartsFromRows: boolean;
}

export interface InsightInput {
  type: string;
  rows: Row[];
  totals?: Record<string, number>;
  from: string;
  to: string;
  tz?: string;
  /** Alert type code → label (ALERT_TYPE_MAP), passed in so this module stays dependency-free. */
  alertLabel?: (code: string) => string;
}

/** Report types with an insight panel (batch 1). */
export const INSIGHT_TYPES = ['SUMMARY', 'CONSOLIDATED', 'TRIPS', 'OVERSPEED', 'ALERTS', 'EVENT_SUMMARY', 'ENGINE_HOURS'] as const;

const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const s = (v: unknown): string => (typeof v === 'string' ? v : '');
const tot = (totals: Record<string, number> | undefined, k: string): number | null => (totals && typeof totals[k] === 'number' ? totals[k] : null);
const round1 = (v: number) => Math.round(v * 10) / 10;

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

/** Every day from `from` to `to` inclusive (YYYY-MM-DD), capped at 400. */
export function daysBetween(from: string, to: string): string[] {
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

function perDay(rows: Row[], timeKey: string, from: string, to: string, tz: string | undefined, values: (r: Row) => Record<string, number>, keys: string[]): Map<string, Record<string, number>> {
  const map = new Map<string, Record<string, number>>();
  for (const d of daysBetween(from, to)) map.set(d, Object.fromEntries(keys.map((k) => [k, 0])));
  for (const r of rows) {
    const t = s(r[timeKey]);
    if (!t) continue;
    const day = dayKeyInZone(t, tz);
    const acc = map.get(day) ?? Object.fromEntries(keys.map((k) => [k, 0]));
    const v = values(r);
    for (const k of keys) acc[k] += v[k] ?? 0;
    map.set(day, acc);
  }
  return new Map([...map.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

function perPeriod(rows: Row[], keys: string[], value: (r: Row, k: string) => number): BarDatum[] {
  const map = new Map<string, Record<string, number>>();
  for (const r of rows) {
    const p = s(r.period);
    const acc = map.get(p) ?? Object.fromEntries(keys.map((k) => [k, 0]));
    for (const k of keys) acc[k] += value(r, k);
    map.set(p, acc);
  }
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, values]) => ({ key, values }));
}

function rankVehicles(rows: Row[], value: (r: Row) => number, limit = 10): { items: RankedItem[]; total: number } {
  const map = new Map<string, RankedItem>();
  for (const r of rows) {
    const id = s(r.objectId) || s(r.objectName);
    const it = map.get(id) ?? { key: id, label: s(r.objectName) || id, sub: (r.plateNumber as string | null) ?? null, value: 0 };
    it.value += value(r);
    map.set(id, it);
  }
  const all = [...map.values()].filter((i) => i.value > 0).sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
  return { items: all.slice(0, limit), total: all.length };
}

const distinct = (rows: Row[], k: string) => new Set(rows.map((r) => s(r[k])).filter(Boolean)).size;

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
        // The period bar charts are SummaryCharts (existing); the ranked list adds the per-vehicle view.
        charts: [{ kind: 'ranked', title: 'Distance by vehicle (km)', items: top.items, total: top.total, format: 'km', select: 'vehicle' }],
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
          { kind: 'ranked', title: 'Distance by vehicle (km)', items: km.items, total: km.total, format: 'km', select: 'vehicle' },
          { kind: 'ranked', title: 'Alerts by vehicle', items: alerts.items, total: alerts.total, format: 'int', select: 'vehicle' },
        ],
        chartsFromRows: true,
      };
    }

    case 'TRIPS': {
      const count = tot(totals, 'count');
      const km = tot(totals, 'distanceKm');
      const longest = rows.reduce((m, r) => Math.max(m, n(r.distanceKm)), 0);
      const days = perDay(rows, 'startTime', from, to, tz, (r) => ({ trips: 1, km: n(r.distanceKm) }), ['trips', 'km']);
      const top = rankVehicles(rows, (r) => n(r.distanceKm));
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
            segments: [{ key: 'trips', label: 'Trips', tone: 'primary' }],
            data: [...days.entries()].map(([key, v]) => ({ key, values: { trips: v.trips }, extra: [{ label: 'Distance', value: v.km, format: 'km' }] })),
            format: 'int',
            select: 'day',
          },
          { kind: 'ranked', title: 'Distance by vehicle (km)', items: top.items, total: top.total, format: 'km', select: 'vehicle' },
        ],
        chartsFromRows: true,
      };
    }

    case 'OVERSPEED': {
      const count = tot(totals, 'count');
      const dur = tot(totals, 'durationSec');
      const days = perDay(rows, 'startTime', from, to, tz, () => ({ episodes: 1 }), ['episodes']);
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
          { kind: 'ranked', title: 'Time over the limit by vehicle', items: top.items, total: top.total, format: 'hm', select: 'vehicle' },
        ],
        chartsFromRows: true,
      };
    }

    case 'ALERTS': {
      const days = perDay(
        rows,
        'occurredAt',
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
          { kind: 'ranked', title: 'Idle time by vehicle', items: top.items, total: top.total, format: 'hm', select: 'vehicle' },
        ],
        chartsFromRows: true,
      };
    }

    default:
      return null;
  }
}

/** Does a row match a chart selection? (`timeKey` = the row timestamp used for days.) */
export function rowMatches(type: string, row: Row, f: InsightFilter, tz?: string): boolean {
  switch (f.kind) {
    case 'vehicle':
      return (s(row.objectId) || s(row.objectName)) === f.value;
    case 'period':
      return s(row.period) === f.value;
    case 'alertType':
      return s(row.type) === f.value;
    case 'cell':
      return s(row.objectId) === f.objectId && s(row.type) === f.type;
    case 'day': {
      const key = type === 'ALERTS' ? 'occurredAt' : 'startTime';
      const t = s(row[key]);
      return !!t && dayKeyInZone(t, tz) === f.value;
    }
  }
}

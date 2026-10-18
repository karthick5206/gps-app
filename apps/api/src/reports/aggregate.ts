import { DailySummaryDto, ReportPeriod, ReportScope, SummaryReportRow } from '@veetracer/shared';
import { isoWeekKey, monthKey } from '../summarizer/tz';

/** '2026-10-18' (DAY) | '2026-W42' (WEEK, ISO, Monday start) | '2026-10' (MONTH). */
export function periodKey(day: string, period: ReportPeriod): string {
  if (period === 'WEEK') return isoWeekKey(day);
  if (period === 'MONTH') return monthKey(day);
  return day;
}

const minIso = (a: string | null, b: string | null) => (a === null ? b : b === null ? a : a < b ? a : b);
const maxIso = (a: string | null, b: string | null) => (a === null ? b : b === null ? a : a > b ? a : b);
const r1 = (v: number) => Math.round(v * 10) / 10;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** Daily summaries → one row per vehicle and period (sums; max of max; running-time-weighted average speed). */
export function aggregateSummaries(days: DailySummaryDto[], period: ReportPeriod): SummaryReportRow[] {
  const groups = new Map<string, SummaryReportRow & { _speedTime: number }>();
  for (const d of days) {
    const key = `${d.objectId}|${periodKey(d.day, period)}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        objectId: d.objectId,
        objectName: d.objectName,
        plateNumber: d.plateNumber,
        branchName: d.branchName,
        period: periodKey(d.day, period),
        distanceKm: 0,
        runningSec: 0,
        idleSec: 0,
        stopSec: 0,
        offlineSec: 0,
        tripCount: 0,
        maxSpeedKph: 0,
        avgSpeedKph: 0,
        overspeedCount: 0,
        engineSec: 0,
        firstStart: null,
        lastStop: null,
        _speedTime: 0,
      };
      groups.set(key, g);
    }
    g.distanceKm += d.distanceKm;
    g.runningSec += d.runningSec;
    g.idleSec += d.idleSec;
    g.stopSec += d.stopSec;
    g.offlineSec += d.offlineSec;
    g.tripCount += d.tripCount;
    g.overspeedCount += d.overspeedCount;
    g.engineSec += d.engineSec;
    g.maxSpeedKph = Math.max(g.maxSpeedKph, d.maxSpeedKph);
    g._speedTime += d.avgSpeedKph * d.runningSec;
    g.firstStart = minIso(g.firstStart, d.firstStart);
    g.lastStop = maxIso(g.lastStop, d.lastStop);
  }
  const rows = [...groups.values()].map(({ _speedTime, ...row }) => ({
    ...row,
    distanceKm: r3(row.distanceKm),
    avgSpeedKph: row.runningSec > 0 ? r1(_speedTime / row.runningSec) : 0,
  }));
  rows.sort((a, b) => a.objectName.localeCompare(b.objectName) || a.objectId.localeCompare(b.objectId) || a.period.localeCompare(b.period));
  return rows;
}

export function summaryTotals(rows: SummaryReportRow[]): Record<string, number> {
  const t = { vehicles: new Set(rows.map((r) => r.objectId)).size, distanceKm: 0, runningSec: 0, idleSec: 0, stopSec: 0, offlineSec: 0, tripCount: 0, overspeedCount: 0, engineSec: 0, maxSpeedKph: 0, avgSpeedKph: 0 };
  let speedTime = 0;
  for (const r of rows) {
    t.distanceKm += r.distanceKm;
    t.runningSec += r.runningSec;
    t.idleSec += r.idleSec;
    t.stopSec += r.stopSec;
    t.offlineSec += r.offlineSec;
    t.tripCount += r.tripCount;
    t.overspeedCount += r.overspeedCount;
    t.engineSec += r.engineSec;
    t.maxSpeedKph = Math.max(t.maxSpeedKph, r.maxSpeedKph);
    speedTime += r.avgSpeedKph * r.runningSec;
  }
  t.distanceKm = r3(t.distanceKm);
  t.avgSpeedKph = t.runningSec > 0 ? r1(speedTime / t.runningSec) : 0;
  return t;
}

export interface ScopeObject {
  id: string;
  branchId: string | null;
  groupIds: string[];
}

/**
 * Vehicles a report covers: the caller's visible objects, narrowed to the union of the requested branches, groups
 * and objects (an empty scope = everything visible). Requested ids outside the caller's scope are ignored.
 */
export function intersectScope(visible: ScopeObject[], scope: ReportScope): string[] {
  const branches = new Set(scope.branchIds ?? []);
  const groups = new Set(scope.groupIds ?? []);
  const objects = new Set(scope.objectIds ?? []);
  if (!branches.size && !groups.size && !objects.size) return visible.map((o) => o.id);
  return visible
    .filter(
      (o) => objects.has(o.id) || (o.branchId !== null && branches.has(o.branchId)) || o.groupIds.some((g) => groups.has(g)),
    )
    .map((o) => o.id);
}

import { GeofenceDistanceReportRow, MAX_PLAUSIBLE_SPEED_KPH } from '@veetracer/shared';
import { fetchPositions, PosRow, toSegPoint } from '../summarizer/positions';
import { pointDistanceM, SegConfig, SegPoint } from '../summarizer/segmenter';
import { companyThresholds } from '../tracking/thresholds';
import { QueryCtx, QueryResult } from './report-queries';

/** Longest period of one report: it reads every position of the vehicles, not the daily summaries. Same as History. */
export const GEOFENCE_DISTANCE_MAX_DAYS = 31;

const PAGE = 20_000;
const CONCURRENT_VEHICLES = 3;
const round3 = (v: number) => Math.round(v * 1000) / 1000;

export interface DistanceInterval {
  from: number;
  to: number;
  metres: number;
}

/**
 * Adds up the distance driven in each interval, with the same point rules as trips and daily summaries.
 * A step that crosses an interval's edge counts by the share of its time inside. Intervals may overlap (nested geofences).
 * Feed the points in time order, in as many calls as needed. `intervals` must be sorted by `from`.
 */
export class IntervalDistance {
  private first = 0;
  private last: SegPoint | null = null;

  constructor(
    private readonly intervals: DistanceInterval[],
    private readonly cfg: Pick<SegConfig, 'runningSpeedKph' | 'maxPlausibleKph'>,
  ) {}

  add(rows: PosRow[]): void {
    for (const row of rows) {
      const p = toSegPoint(row, this.last);
      if (this.last) this.step(this.last, p);
      this.last = p;
    }
  }

  private step(a: SegPoint, b: SegPoint): void {
    const dt = b.t - a.t;
    if (dt <= 0) return;
    const d = pointDistanceM(a, b, this.cfg);
    if (d <= 0) return;
    while (this.first < this.intervals.length && this.intervals[this.first].to <= a.t) this.first++;
    for (let i = this.first; i < this.intervals.length && this.intervals[i].from < b.t; i++) {
      const v = this.intervals[i];
      const overlap = Math.min(v.to, b.t) - Math.max(v.from, a.t);
      if (overlap > 0) v.metres += (d * overlap) / dt;
    }
  }
}

interface VisitInput {
  geofenceId: string;
  enterTime: Date;
  exitTime: Date | null;
}

/** "From previous" of each visit (sorted by entry): since the latest exit, or null if none yet or still inside another geofence. */
export function previousVisits<V extends VisitInput>(visits: V[]): (V | null)[] {
  let latest: V | null = null;
  return visits.map((v) => {
    const prev: V | null = latest;
    const stillInside = prev !== null && (prev.exitTime === null || prev.exitTime > v.enterTime);
    // The visit that ends last stays "latest": a short visit nested in a long one does not replace it.
    if (!prev || (prev.exitTime !== null && (v.exitTime === null || v.exitTime > prev.exitTime))) latest = v;
    return stillInside ? null : prev;
  });
}

/** GEOFENCE_DISTANCE: per visit, the km driven inside the geofence and the km from the previous geofence's exit. */
export async function geofenceDistanceReport(q: QueryCtx, skipFlags: number, now: number): Promise<QueryResult<GeofenceDistanceReportRow>> {
  const none = { count: 0, durationSec: 0, insideKm: 0, fromPreviousKm: 0 };
  if (!q.ids.length) return { rows: [], totals: none, totalRows: 0 };
  const where = { companyId: q.companyId, objectId: { in: q.ids }, enterTime: q.range };
  const [visits, totalRows, company] = await Promise.all([
    q.prisma.geofenceVisit.findMany({ where, orderBy: { enterTime: 'asc' }, take: q.maxRows }),
    q.prisma.geofenceVisit.count({ where }),
    q.prisma.company.findUnique({ where: { id: q.companyId }, select: { settings: true } }),
  ]);
  if (!visits.length) return { rows: [], totals: none, totalRows: 0 };

  const names = await q.prisma.geofence.findMany({ where: { id: { in: [...new Set(visits.map((v) => v.geofenceId))] } }, select: { id: true, name: true } });
  const gName = new Map(names.map((g) => [g.id, g.name]));
  const geofenceName = (id: string) => gName.get(id) ?? 'Deleted geofence';
  const runningSpeedKph = companyThresholds(company?.settings).runningSpeedKph;

  const byObject = new Map<string, typeof visits>();
  for (const v of visits) byObject.set(v.objectId, [...(byObject.get(v.objectId) ?? []), v]);

  const rows: GeofenceDistanceReportRow[] = [];
  const queue = [...byObject];
  const worker = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const [objectId, list] = next;
      const info = q.objects.get(objectId);
      const previous = previousVisits(list);
      const inside = list.map((v) => ({ from: v.enterTime.getTime(), to: v.exitTime?.getTime() ?? now, metres: 0 }));
      const between = list.map((v, i) => ({ from: previous[i]?.exitTime?.getTime() ?? 0, to: previous[i] ? v.enterTime.getTime() : 0, metres: 0 }));
      const intervals = [...inside, ...between.filter((b) => b.to > b.from)].sort((a, b) => a.from - b.from);
      const counter = new IntervalDistance(intervals, { runningSpeedKph, maxPlausibleKph: info ? MAX_PLAUSIBLE_SPEED_KPH[info.type] : Infinity });
      const end = Math.max(...intervals.map((v) => v.to));
      let after = intervals[0].from - 1;
      for (;;) {
        const page = await fetchPositions(q.prisma, objectId, after, end, PAGE, skipFlags);
        if (page.length) counter.add(page);
        const lastT = page[page.length - 1]?.t ?? after;
        if (page.length < PAGE || lastT <= after) break;
        after = lastT;
      }
      list.forEach((v, i) => {
        const prev = previous[i];
        rows.push({
          objectId,
          objectName: info?.name ?? 'Unknown object',
          plateNumber: info?.plateNumber ?? null,
          geofenceId: v.geofenceId,
          geofenceName: geofenceName(v.geofenceId),
          enterTime: v.enterTime.toISOString(),
          exitTime: v.exitTime?.toISOString() ?? null,
          durationSec: v.durationSec ?? Math.round(((v.exitTime?.getTime() ?? now) - v.enterTime.getTime()) / 1000),
          insideKm: round3(inside[i].metres / 1000),
          previousGeofenceName: prev ? geofenceName(prev.geofenceId) : null,
          previousExitTime: prev?.exitTime?.toISOString() ?? null,
          fromPreviousKm: prev ? round3(between[i].metres / 1000) : null,
        });
      });
    }
  };
  await Promise.all(Array.from({ length: CONCURRENT_VEHICLES }, worker));

  rows.sort((a, b) => a.objectName.localeCompare(b.objectName) || a.enterTime.localeCompare(b.enterTime));
  const sum = (f: (r: GeofenceDistanceReportRow) => number) => rows.reduce((s, r) => s + f(r), 0);
  return {
    rows,
    totals: { count: rows.length, durationSec: sum((r) => r.durationSec), insideKm: round3(sum((r) => r.insideKm)), fromPreviousKm: round3(sum((r) => r.fromPreviousKm ?? 0)) },
    totalRows,
  };
}

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
  enterTime: Date;
  exitTime: Date | null;
}

/**
 * The trips between geofences of one vehicle (visits sorted by entry): from an exit to the next entry. A trip with no
 * next entry (`to` null) means the vehicle hasn't entered one since. No trip starts while the vehicle is still inside
 * another geofence, so leaving a small geofence nested in a large one doesn't count until it leaves the large one too.
 */
export function geofenceTrips<V extends VisitInput>(visits: V[]): { from: V; to: V | null }[] {
  const trips: { from: V; to: V | null }[] = [];
  let latest: V | null = null;
  for (const v of visits) {
    const prev: V | null = latest;
    if (prev && prev.exitTime !== null && prev.exitTime <= v.enterTime) trips.push({ from: prev, to: v });
    // The visit that ends last stays "latest": a short visit nested in a long one does not replace it.
    if (!prev || (prev.exitTime !== null && (v.exitTime === null || v.exitTime > prev.exitTime))) latest = v;
  }
  const last = latest as V | null;
  if (last?.exitTime) trips.push({ from: last, to: null });
  return trips;
}

/** GEOFENCE_DISTANCE: km driven from a geofence's out time to the next geofence's in time, for out times in the period. */
export async function geofenceDistanceReport(q: QueryCtx, skipFlags: number, now: number): Promise<QueryResult<GeofenceDistanceReportRow>> {
  const none = { count: 0, travelSec: 0, distanceKm: 0 };
  if (!q.ids.length) return { rows: [], totals: none, totalRows: 0 };
  const scope = { companyId: q.companyId, objectId: { in: q.ids } };
  // Long visits around the period count too: the vehicle was inside them. A visit never closed from before it doesn't.
  const where = { ...scope, OR: [{ enterTime: q.range }, { exitTime: q.range }, { enterTime: { lt: q.range.gte }, exitTime: { gte: q.range.lt } }] };
  const [inPeriod, visitCount, after, company] = await Promise.all([
    q.prisma.geofenceVisit.findMany({ where, orderBy: { enterTime: 'asc' }, take: q.maxRows }),
    q.prisma.geofenceVisit.count({ where }),
    // Where a trip that left during the period ended, if that was after the period.
    q.prisma.geofenceVisit.findMany({ where: { ...scope, enterTime: { gte: q.range.lt } }, orderBy: [{ objectId: 'asc' }, { enterTime: 'asc' }], distinct: ['objectId'] }),
    q.prisma.company.findUnique({ where: { id: q.companyId }, select: { settings: true } }),
  ]);
  if (!inPeriod.length) return { rows: [], totals: none, totalRows: 0 };
  const visits = [...inPeriod, ...after];

  const names = await q.prisma.geofence.findMany({ where: { id: { in: [...new Set(visits.map((v) => v.geofenceId))] } }, select: { id: true, name: true } });
  const gName = new Map(names.map((g) => [g.id, g.name]));
  const geofenceName = (id: string) => gName.get(id) ?? 'Deleted geofence';
  const runningSpeedKph = companyThresholds(company?.settings).runningSpeedKph;

  const byObject = new Map<string, typeof visits>();
  for (const v of visits) {
    const list = byObject.get(v.objectId);
    if (list) list.push(v);
    else byObject.set(v.objectId, [v]);
  }
  // No next entry yet: measured up to now, or the end of the period if that's earlier.
  const openEnd = Math.min(now, q.range.lt.getTime());

  const rows: GeofenceDistanceReportRow[] = [];
  const queue = [...byObject];
  const worker = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const [objectId, list] = next;
      const info = q.objects.get(objectId);
      const trips = geofenceTrips(list).filter((t) => t.from.exitTime! >= q.range.gte && t.from.exitTime! < q.range.lt);
      if (!trips.length) continue;
      const intervals = trips.map((t) => ({ from: t.from.exitTime!.getTime(), to: Math.max(t.to?.enterTime.getTime() ?? openEnd, t.from.exitTime!.getTime()), metres: 0 }));
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
      trips.forEach((t, i) => {
        rows.push({
          objectId,
          objectName: info?.name ?? 'Unknown object',
          plateNumber: info?.plateNumber ?? null,
          fromGeofenceName: geofenceName(t.from.geofenceId),
          outTime: t.from.exitTime!.toISOString(),
          toGeofenceName: t.to ? geofenceName(t.to.geofenceId) : null,
          inTime: t.to?.enterTime.toISOString() ?? null,
          untilTime: new Date(intervals[i].to).toISOString(),
          travelSec: Math.round((intervals[i].to - intervals[i].from) / 1000),
          distanceKm: round3(intervals[i].metres / 1000),
        });
      });
    }
  };
  await Promise.all(Array.from({ length: CONCURRENT_VEHICLES }, worker));

  rows.sort((a, b) => a.objectName.localeCompare(b.objectName) || a.outTime.localeCompare(b.outTime));
  const shown = rows.slice(0, q.maxRows);
  return {
    rows: shown,
    totals: { count: rows.length, travelSec: rows.reduce((s, r) => s + r.travelSec, 0), distanceKm: round3(rows.reduce((s, r) => s + r.distanceKm, 0)) },
    // Visits beyond the limit weren't read: at least that many more trips exist.
    totalRows: rows.length + (visitCount - inPeriod.length),
  };
}

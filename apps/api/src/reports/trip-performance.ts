import { ON_TIME_TOLERANCE_SEC, PlannedTripReportRow, TripPerformanceGroupBy, TripPerformanceReportRow } from '@veetracer/shared';
import { haversineMeters } from '../tracking/geo';

/**
 * Pure figures of the TRIP_PERFORMANCE and PLANNED_TRIPS reports (docs/routes-trips/SPEC.md §4.6). The builder reduces
 * each planned trip (with its stops) to small `TripFacts` page by page, then groups the facts; nothing here touches
 * the database.
 */

export interface PerfStopInput {
  seq: number;
  lat: number;
  lng: number;
  status: string;
  /** actualArrival − plannedArrival (s); null until the stop is reached. */
  delaySec: number | null;
}

export interface PerfTripInput {
  id: string;
  /** Null for ETMS door-to-door trips (origin ETMS). */
  routeId: string | null;
  routeName: string;
  objectId: string;
  driverId: string | null;
  status: string;
  closedBy: string | null;
  plannedStart: Date;
  plannedEnd: Date;
  actualStart: Date | null;
  actualEnd: Date | null;
  /** Snapshot road path [[lng, lat], ...] or null. */
  path: unknown;
  distanceKm: number | null;
  deviationCount: number;
  delaySec: number | null;
  stops: PerfStopInput[];
}

/** One trip reduced to what the reports need. */
export interface TripFacts {
  id: string;
  routeId: string | null;
  routeName: string;
  objectId: string;
  driverId: string | null;
  status: string;
  closedBy: string | null;
  plannedStart: string;
  plannedEnd: string;
  actualStart: string | null;
  actualEnd: string | null;
  startDelaySec: number | null;
  delaySec: number | null;
  stopCount: number;
  /** Stops arrived at or departed from. */
  stopsDone: number;
  skippedStops: number;
  /** Reached (not skipped) stops with a recorded delay: the on-time denominator. */
  ratedStops: number;
  onTimeStops: number;
  stopDelaySumSec: number;
  plannedKm: number;
  distanceKm: number | null;
  deviations: number;
}

const r1 = (v: number) => Math.round(v * 10) / 10;
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const isPair = (p: unknown): p is [number, number] => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]);

/** Length of a [[lng, lat], ...] path in km; null when it is not a usable path (fewer than 2 points). */
export function pathKm(path: unknown): number | null {
  if (!Array.isArray(path)) return null;
  const pts = path.filter(isPair);
  if (pts.length < 2) return null;
  let m = 0;
  for (let i = 1; i < pts.length; i++) m += haversineMeters(pts[i - 1][1], pts[i - 1][0], pts[i][1], pts[i][0]);
  return m / 1000;
}

/** Straight legs between consecutive stops (by seq), in km. */
export function straightLegsKm(stops: readonly { seq: number; lat: number; lng: number }[]): number {
  const s = [...stops].sort((a, b) => a.seq - b.seq);
  let m = 0;
  for (let i = 1; i < s.length; i++) m += haversineMeters(s[i - 1].lat, s[i - 1].lng, s[i].lat, s[i].lng);
  return m / 1000;
}

/** Planned km: the snapshot road path, else straight legs between the stops. */
export function plannedKmOf(trip: Pick<PerfTripInput, 'path' | 'stops'>): number {
  return pathKm(trip.path) ?? straightLegsKm(trip.stops);
}

const DONE = new Set(['ARRIVED', 'DEPARTED']);

export function tripFacts(t: PerfTripInput): TripFacts {
  let stopsDone = 0;
  let skippedStops = 0;
  let ratedStops = 0;
  let onTimeStops = 0;
  let stopDelaySumSec = 0;
  for (const s of t.stops) {
    if (s.status === 'SKIPPED') {
      skippedStops++;
      continue;
    }
    if (DONE.has(s.status)) stopsDone++;
    if (s.delaySec === null || s.delaySec === undefined || !Number.isFinite(s.delaySec)) continue;
    ratedStops++;
    stopDelaySumSec += s.delaySec;
    if (Math.abs(s.delaySec) <= ON_TIME_TOLERANCE_SEC) onTimeStops++;
  }
  return {
    id: t.id,
    routeId: t.routeId,
    routeName: t.routeName,
    objectId: t.objectId,
    driverId: t.driverId,
    status: t.status,
    closedBy: t.closedBy,
    plannedStart: t.plannedStart.toISOString(),
    plannedEnd: t.plannedEnd.toISOString(),
    actualStart: t.actualStart?.toISOString() ?? null,
    actualEnd: t.actualEnd?.toISOString() ?? null,
    startDelaySec: t.actualStart ? Math.round((t.actualStart.getTime() - t.plannedStart.getTime()) / 1000) : null,
    delaySec: t.delaySec,
    stopCount: t.stops.length,
    stopsDone,
    skippedStops,
    ratedStops,
    onTimeStops,
    stopDelaySumSec,
    plannedKm: plannedKmOf(t),
    distanceKm: t.distanceKm,
    deviations: t.deviationCount,
  };
}

/** Running sums of a group (or of the whole report for the totals row). */
interface Acc {
  trips: number;
  completed: number;
  incomplete: number;
  cancelled: number;
  ratedStops: number;
  onTimeStops: number;
  skippedStops: number;
  stopDelaySumSec: number;
  started: number;
  startDelaySumSec: number;
  plannedKm: number;
  actualKm: number;
  deviations: number;
}

const emptyAcc = (): Acc => ({ trips: 0, completed: 0, incomplete: 0, cancelled: 0, ratedStops: 0, onTimeStops: 0, skippedStops: 0, stopDelaySumSec: 0, started: 0, startDelaySumSec: 0, plannedKm: 0, actualKm: 0, deviations: 0 });

/** Planned vs actual km compare like with like: only trips that ran to an end (completed or incomplete). */
const FINISHED = new Set(['COMPLETED', 'INCOMPLETE']);

function add(a: Acc, f: TripFacts): void {
  a.trips++;
  if (f.status === 'COMPLETED') a.completed++;
  else if (f.status === 'INCOMPLETE') a.incomplete++;
  else if (f.status === 'CANCELLED') a.cancelled++;
  a.ratedStops += f.ratedStops;
  a.onTimeStops += f.onTimeStops;
  a.skippedStops += f.skippedStops;
  a.stopDelaySumSec += f.stopDelaySumSec;
  if (f.startDelaySec !== null) {
    a.started++;
    a.startDelaySumSec += f.startDelaySec;
  }
  if (FINISHED.has(f.status)) {
    a.plannedKm += f.plannedKm;
    a.actualKm += f.distanceKm ?? 0;
  }
  a.deviations += f.deviations;
}

function figures(a: Acc) {
  return {
    trips: a.trips,
    completed: a.completed,
    incomplete: a.incomplete,
    cancelled: a.cancelled,
    ratedStops: a.ratedStops,
    onTimeStops: a.onTimeStops,
    onTimePct: a.ratedStops ? r1((a.onTimeStops / a.ratedStops) * 100) : null,
    skippedStops: a.skippedStops,
    avgStartDelayMin: a.started ? r1(a.startDelaySumSec / a.started / 60) : null,
    avgStopDelayMin: a.ratedStops ? r1(a.stopDelaySumSec / a.ratedStops / 60) : null,
    plannedKm: r1(a.plannedKm),
    actualKm: r1(a.actualKm),
    deviations: a.deviations,
  };
}

/** Group key of a trip; null = trips without a driver (DRIVER) or without a route (ROUTE: ETMS door-to-door trips). */
export function groupKey(f: TripFacts, groupBy: TripPerformanceGroupBy): string | null {
  return groupBy === 'ROUTE' ? f.routeId : groupBy === 'DRIVER' ? f.driverId : f.objectId;
}

/** Group label of trips without a driver (DRIVER grouping). */
export const NO_DRIVER_GROUP_LABEL = 'No driver';
/** Group label of trips without a master Route (ROUTE grouping): ETMS door-to-door runs. */
export const NO_ROUTE_GROUP_LABEL = 'Employee transport (no route)';

export interface PerformanceNames {
  /** Current route name (falls back to the latest trip's snapshot name). */
  route?: (id: string) => string | undefined;
  driver?: (id: string) => string | undefined;
  vehicle?: (id: string) => string | undefined;
}

/**
 * TRIP_PERFORMANCE rows (by name) and the totals row. Totals are recomputed from every trip, not averaged from the
 * rows, so on-time % and the average delays are weighted by stops / trips.
 */
export function tripPerformance(
  facts: Iterable<TripFacts>,
  groupBy: TripPerformanceGroupBy,
  names: PerformanceNames = {},
): { rows: TripPerformanceReportRow[]; totals: Record<string, number> } {
  const groups = new Map<string | null, { acc: Acc; snapshot: string; latest: string }>();
  const total = emptyAcc();
  for (const f of facts) {
    const key = groupKey(f, groupBy);
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { acc: emptyAcc(), snapshot: f.routeName, latest: f.plannedStart }));
    if (f.plannedStart > g.latest) {
      g.latest = f.plannedStart;
      g.snapshot = f.routeName;
    }
    add(g.acc, f);
    add(total, f);
  }
  const nameOf = (key: string | null, snapshot: string): string => {
    // A null key means "no driver" only when grouping by driver; by route it is an ETMS trip without a master Route
    // (15 §7.1 #19, C-12: it used to be labelled "No driver" for every grouping).
    if (key === null) return groupBy === 'ROUTE' ? NO_ROUTE_GROUP_LABEL : groupBy === 'DRIVER' ? NO_DRIVER_GROUP_LABEL : 'Unknown object';
    if (groupBy === 'ROUTE') return names.route?.(key) ?? snapshot;
    if (groupBy === 'DRIVER') return names.driver?.(key) ?? 'Unknown driver';
    return names.vehicle?.(key) ?? 'Unknown object';
  };
  const rows: TripPerformanceReportRow[] = [...groups.entries()]
    .map(([key, g]) => ({ groupBy, groupId: key, groupName: nameOf(key, g.snapshot), ...figures(g.acc) }))
    .sort((a, b) => (a.groupId === null ? 1 : 0) - (b.groupId === null ? 1 : 0) || a.groupName.localeCompare(b.groupName));
  const t = figures(total);
  return {
    rows,
    totals: {
      groups: rows.length,
      trips: t.trips,
      completed: t.completed,
      incomplete: t.incomplete,
      cancelled: t.cancelled,
      ratedStops: t.ratedStops,
      onTimeStops: t.onTimeStops,
      skippedStops: t.skippedStops,
      plannedKm: t.plannedKm,
      actualKm: t.actualKm,
      deviations: t.deviations,
      // Left out (not 0) when there is nothing to average, so the totals row shows a blank.
      ...(t.onTimePct !== null ? { onTimePct: t.onTimePct } : {}),
      ...(t.avgStartDelayMin !== null ? { avgStartDelayMin: t.avgStartDelayMin } : {}),
      ...(t.avgStopDelayMin !== null ? { avgStopDelayMin: t.avgStopDelayMin } : {}),
    },
  };
}

export interface TripNames {
  vehicle: (id: string) => { name: string; plateNumber: string | null } | undefined;
  driver: (id: string) => string | undefined;
}

/** PLANNED_TRIPS row of one trip. */
export function plannedTripRow(f: TripFacts, names: TripNames): PlannedTripReportRow {
  const v = names.vehicle(f.objectId);
  return {
    tripId: f.id,
    routeId: f.routeId,
    routeName: f.routeName,
    objectId: f.objectId,
    objectName: v?.name ?? 'Unknown object',
    plateNumber: v?.plateNumber ?? null,
    driverId: f.driverId,
    driverName: f.driverId ? (names.driver(f.driverId) ?? 'Unknown driver') : null,
    status: f.status,
    closedBy: f.closedBy,
    plannedStart: f.plannedStart,
    plannedEnd: f.plannedEnd,
    actualStart: f.actualStart,
    actualEnd: f.actualEnd,
    startDelayMin: f.startDelaySec === null ? null : r1(f.startDelaySec / 60),
    delayMin: f.delaySec === null ? null : r1(f.delaySec / 60),
    stopsDone: f.stopsDone,
    stopCount: f.stopCount,
    skippedStops: f.skippedStops,
    onTimeStops: f.onTimeStops,
    deviationCount: f.deviations,
    plannedKm: r1(f.plannedKm),
    distanceKm: f.distanceKm === null ? null : r3(f.distanceKm),
  };
}

/** PLANNED_TRIPS totals over every trip (not only the returned rows). */
export function plannedTripTotals(facts: Iterable<TripFacts>): Record<string, number> {
  const t = { count: 0, completed: 0, incomplete: 0, cancelled: 0, stopsDone: 0, stopCount: 0, skippedStops: 0, onTimeStops: 0, deviationCount: 0, plannedKm: 0, distanceKm: 0 };
  for (const f of facts) {
    t.count++;
    if (f.status === 'COMPLETED') t.completed++;
    else if (f.status === 'INCOMPLETE') t.incomplete++;
    else if (f.status === 'CANCELLED') t.cancelled++;
    t.stopsDone += f.stopsDone;
    t.stopCount += f.stopCount;
    t.skippedStops += f.skippedStops;
    t.onTimeStops += f.onTimeStops;
    t.deviationCount += f.deviations;
    t.plannedKm += f.plannedKm;
    t.distanceKm += f.distanceKm ?? 0;
  }
  return { ...t, plannedKm: r1(t.plannedKm), distanceKm: r1(t.distanceKm) };
}

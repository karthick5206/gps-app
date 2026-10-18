import { BadRequestException } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import {
  ConsolidatedReportRow,
  ContinuousDrivingReportRow,
  DailySummaryDto,
  DeviceStatusReportRow,
  EventSummaryReportRow,
  GeofenceSummaryReportRow,
  IgnitionReportRow,
  ObjectType,
  OverspeedReportRow,
  POSITION_FLAGS,
  POSITIONS_REPORT_MAX_DAYS,
  PositionReportRow,
  ReportOptions,
  ReportRequest,
  VehicleType,
} from '@veetracer/shared';
import { daysBetween } from '../summarizer/tz';
import { effectiveSpeedLimit } from '../tracking/live-object';
import { continuousDriving, deviceStatus, ignitionChanges, overspeedEpisodes } from './derived';

/** Vehicle facts the reports need, keyed by object id (already limited to the caller's scope). */
export interface ObjInfo {
  name: string;
  plateNumber: string | null;
  branchId: string | null;
  branchName: string | null;
  type: ObjectType;
  vehicleType: VehicleType | null;
  speedLimitKph: number | null;
}

export interface QueryCtx {
  prisma: PrismaClient;
  companyId: string;
  objects: Map<string, ObjInfo>;
  ids: string[];
  range: { gte: Date; lt: Date };
  maxRows: number;
  options: ReportOptions;
}

export interface QueryResult<T> {
  rows: T[];
  totals: Record<string, number>;
  totalRows: number;
}

/** Points that are kept but must not count (no fix, impossible jump). */
const BAD_POINT = POSITION_FLAGS.INVALID_FIX | POSITION_FLAGS.JUMP;
/** Two over-limit points further apart than this belong to different episodes. */
const OVERSPEED_MAX_GAP_MS = 150_000;
/** Safety cap on raw rows pulled for derived reports. */
const RAW_ROW_CAP = 500_000;

const r1 = (v: number) => Math.round(v * 10) / 10;
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const nameOf = (q: QueryCtx, id: string) => q.objects.get(id)?.name ?? 'Unknown object';
const plateOf = (q: QueryCtx, id: string) => q.objects.get(id)?.plateNumber ?? null;
const vehicleSort = <T extends { objectName: string }>(a: T, b: T) => a.objectName.localeCompare(b.objectName);
const slice = <T>(rows: T[], q: QueryCtx, totals: Record<string, number>): QueryResult<T> => ({ rows: rows.slice(0, q.maxRows), totals, totalRows: rows.length });

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// ---------------------------------------------------------------------------
// CONSOLIDATED: whole range per vehicle
// ---------------------------------------------------------------------------

export async function consolidated(q: QueryCtx, days: DailySummaryDto[], req: ReportRequest): Promise<QueryResult<ConsolidatedReportRow>> {
  const [alerts, critical, visits] = await Promise.all([
    q.prisma.alert.groupBy({ by: ['objectId'], where: { companyId: q.companyId, objectId: { in: q.ids }, occurredAt: q.range }, _count: true }),
    q.prisma.alert.groupBy({ by: ['objectId'], where: { companyId: q.companyId, objectId: { in: q.ids }, occurredAt: q.range, severity: 'CRITICAL' }, _count: true }),
    q.prisma.geofenceVisit.groupBy({ by: ['objectId'], where: { companyId: q.companyId, objectId: { in: q.ids }, enterTime: q.range }, _count: true }),
  ]);
  const count = (rows: { objectId: string; _count: number }[]) => new Map(rows.map((r) => [r.objectId, r._count]));
  const alertN = count(alerts);
  const criticalN = count(critical);
  const visitN = count(visits);
  const totalDays = daysBetween(req.from, req.to) + 1;
  const byObject = new Map<string, DailySummaryDto[]>();
  for (const d of days) (byObject.get(d.objectId) ?? byObject.set(d.objectId, []).get(d.objectId)!).push(d);

  const rows: ConsolidatedReportRow[] = q.ids.map((id) => {
    const o = q.objects.get(id)!;
    const ds = byObject.get(id) ?? [];
    let speedTime = 0;
    const row: ConsolidatedReportRow = {
      objectId: id,
      objectName: o.name,
      plateNumber: o.plateNumber,
      branchName: o.branchName,
      days: totalDays,
      activeDays: 0,
      distanceKm: 0,
      runningSec: 0,
      idleSec: 0,
      stopSec: 0,
      offlineSec: 0,
      engineSec: 0,
      tripCount: 0,
      maxSpeedKph: 0,
      avgSpeedKph: 0,
      overspeedCount: 0,
      alertCount: alertN.get(id) ?? 0,
      criticalAlertCount: criticalN.get(id) ?? 0,
      geofenceVisits: visitN.get(id) ?? 0,
      firstStart: null,
      lastStop: null,
    };
    for (const d of ds) {
      if (d.distanceKm > 0 || d.runningSec > 0) row.activeDays++;
      row.distanceKm += d.distanceKm;
      row.runningSec += d.runningSec;
      row.idleSec += d.idleSec;
      row.stopSec += d.stopSec;
      row.offlineSec += d.offlineSec;
      row.engineSec += d.engineSec;
      row.tripCount += d.tripCount;
      row.overspeedCount += d.overspeedCount;
      row.maxSpeedKph = Math.max(row.maxSpeedKph, d.maxSpeedKph);
      speedTime += d.avgSpeedKph * d.runningSec;
      if (d.firstStart && (!row.firstStart || d.firstStart < row.firstStart)) row.firstStart = d.firstStart;
      if (d.lastStop && (!row.lastStop || d.lastStop > row.lastStop)) row.lastStop = d.lastStop;
    }
    row.distanceKm = r3(row.distanceKm);
    row.avgSpeedKph = row.runningSec ? r1(speedTime / row.runningSec) : 0;
    return row;
  });
  rows.sort(vehicleSort);
  const sum = (k: keyof ConsolidatedReportRow) => rows.reduce((s, r) => s + (r[k] as number), 0);
  return slice(rows, q, {
    vehicles: rows.length,
    activeDays: sum('activeDays'),
    distanceKm: r3(sum('distanceKm')),
    runningSec: sum('runningSec'),
    idleSec: sum('idleSec'),
    stopSec: sum('stopSec'),
    offlineSec: sum('offlineSec'),
    engineSec: sum('engineSec'),
    tripCount: sum('tripCount'),
    maxSpeedKph: rows.reduce((m, r) => Math.max(m, r.maxSpeedKph), 0),
    overspeedCount: sum('overspeedCount'),
    alertCount: sum('alertCount'),
    criticalAlertCount: sum('criticalAlertCount'),
    geofenceVisits: sum('geofenceVisits'),
  });
}

// ---------------------------------------------------------------------------
// POSITIONS: raw points of one vehicle
// ---------------------------------------------------------------------------

const FLAG_NAMES: [number, string][] = Object.entries(POSITION_FLAGS).map(([k, v]) => [v, k.toLowerCase().replace(/_/g, ' ')]);

export function assertPositionsRequest(q: QueryCtx, req: ReportRequest): string {
  if (q.ids.length !== 1 || (req.scope?.objectIds?.length ?? 0) !== 1) throw new BadRequestException('Choose exactly one vehicle for the Positions report');
  if (daysBetween(req.from, req.to) + 1 > POSITIONS_REPORT_MAX_DAYS) throw new BadRequestException(`Positions report covers at most ${POSITIONS_REPORT_MAX_DAYS} days`);
  return q.ids[0];
}

export async function positions(q: QueryCtx, req: ReportRequest): Promise<QueryResult<PositionReportRow>> {
  const objectId = assertPositionsRequest(q, req);
  const where: Prisma.PositionWhereInput = { objectId, fixTime: q.range };
  const [rows, total, agg] = await Promise.all([
    q.prisma.position.findMany({ where, orderBy: { fixTime: 'asc' }, take: q.maxRows }),
    q.prisma.position.count({ where }),
    q.prisma.position.aggregate({ where: { ...where, valid: true }, _max: { speedKph: true } }),
  ]);
  const name = nameOf(q, objectId);
  const out: PositionReportRow[] = rows.map((p) => {
    const a = (p.attributes ?? {}) as Record<string, unknown>;
    const odoM = num(a.odometerM) ?? num(a.mileage);
    return {
      objectId,
      objectName: name,
      fixTime: p.fixTime.toISOString(),
      serverTime: p.serverTime.toISOString(),
      lat: p.lat,
      lng: p.lng,
      speedKph: r1(p.speedKph),
      course: p.course,
      altitude: p.altitude,
      satellites: p.satellites,
      valid: p.valid,
      ignition: p.ignition,
      flags: FLAG_NAMES.filter(([bit]) => p.flags & bit).map(([, n]) => n).join(', '),
      extVoltage: num(a.extVoltage),
      batteryLevel: num(a.batteryLevel),
      gsmSignal: num(a.gsmSignal),
      alarm: typeof a.alarm === 'string' ? a.alarm : null,
      odometerKm: odoM === null ? null : r1(odoM / 1000),
    };
  });
  return { rows: out, totals: { count: total, maxSpeedKph: r1(agg._max.speedKph ?? 0) }, totalRows: total };
}

// ---------------------------------------------------------------------------
// OVERSPEED: episodes above each vehicle's limit
// ---------------------------------------------------------------------------

export async function overspeed(q: QueryCtx): Promise<QueryResult<OverspeedReportRow>> {
  const limits = new Map<string, number>();
  for (const id of q.ids) {
    const o = q.objects.get(id)!;
    const limit = effectiveSpeedLimit(o.speedLimitKph, o.type, o.vehicleType);
    if (limit !== null) limits.set(id, limit);
  }
  const ids = [...limits.keys()];
  if (!ids.length) return { rows: [], totals: { count: 0, durationSec: 0, maxSpeedKph: 0 }, totalRows: 0 };
  const points = await q.prisma.$queryRaw<{ objectId: string; fixTime: Date; speedKph: number; lat: number; lng: number }[]>`
    SELECT p."objectId", p."fixTime", p."speedKph", p.lat, p.lng
    FROM "Position" p
    JOIN unnest(${ids}::uuid[], ${ids.map((id) => limits.get(id)!)}::real[]) AS l(oid, lim) ON p."objectId" = l.oid
    WHERE p."fixTime" >= ${q.range.gte} AND p."fixTime" < ${q.range.lt}
      AND p.valid AND (p.flags & ${BAD_POINT}) = 0 AND p."speedKph" > l.lim
    ORDER BY p."objectId", p."fixTime"
    LIMIT ${RAW_ROW_CAP}`;
  const byObject = new Map<string, { t: number; speedKph: number; lat: number; lng: number }[]>();
  for (const p of points) (byObject.get(p.objectId) ?? byObject.set(p.objectId, []).get(p.objectId)!).push({ t: p.fixTime.getTime(), speedKph: p.speedKph, lat: p.lat, lng: p.lng });
  const rows: OverspeedReportRow[] = [];
  for (const [id, pts] of byObject) {
    for (const ep of overspeedEpisodes(pts, { maxGapMs: OVERSPEED_MAX_GAP_MS, minDurationSec: q.options.minOverspeedSec ?? 10 })) {
      rows.push({
        objectId: id,
        objectName: nameOf(q, id),
        plateNumber: plateOf(q, id),
        startTime: new Date(ep.start).toISOString(),
        endTime: new Date(ep.end).toISOString(),
        durationSec: Math.round((ep.end - ep.start) / 1000),
        limitKph: limits.get(id)!,
        maxSpeedKph: r1(ep.maxSpeedKph),
        avgSpeedKph: ep.avgSpeedKph,
        points: ep.points,
        lat: ep.lat,
        lng: ep.lng,
      });
    }
  }
  rows.sort((a, b) => a.startTime.localeCompare(b.startTime));
  return slice(rows, q, {
    count: rows.length,
    durationSec: rows.reduce((s, r) => s + r.durationSec, 0),
    maxSpeedKph: rows.reduce((m, r) => Math.max(m, r.maxSpeedKph), 0),
  });
}

// ---------------------------------------------------------------------------
// IGNITION: on/off changes
// ---------------------------------------------------------------------------

export async function ignition(q: QueryCtx): Promise<QueryResult<IgnitionReportRow>> {
  if (!q.ids.length) return { rows: [], totals: { count: 0, ON: 0, OFF: 0 }, totalRows: 0 };
  // Only the first point per vehicle and the points where ignition differs from the previous one.
  const pts = await q.prisma.$queryRaw<{ objectId: string; fixTime: Date; ignition: boolean; lat: number; lng: number }[]>`
    SELECT "objectId", "fixTime", ignition, lat, lng FROM (
      SELECT "objectId", "fixTime", ignition, lat, lng,
             lag(ignition) OVER (PARTITION BY "objectId" ORDER BY "fixTime") AS prev
      FROM "Position"
      WHERE "objectId" = ANY(${q.ids}::uuid[]) AND "fixTime" >= ${q.range.gte} AND "fixTime" < ${q.range.lt}
        AND ignition IS NOT NULL AND (flags & ${POSITION_FLAGS.LATE}) = 0
    ) x
    WHERE prev IS NULL OR prev IS DISTINCT FROM ignition
    ORDER BY "objectId", "fixTime"
    LIMIT ${RAW_ROW_CAP}`;
  const byObject = new Map<string, { t: number; ignition: boolean; lat: number; lng: number }[]>();
  for (const p of pts) (byObject.get(p.objectId) ?? byObject.set(p.objectId, []).get(p.objectId)!).push({ t: p.fixTime.getTime(), ignition: p.ignition, lat: p.lat, lng: p.lng });
  const rows: IgnitionReportRow[] = [];
  for (const [id, list] of byObject) {
    for (const c of ignitionChanges(list)) {
      rows.push({ objectId: id, objectName: nameOf(q, id), plateNumber: plateOf(q, id), time: new Date(c.t).toISOString(), state: c.state, previousStateSec: c.previousStateSec, lat: c.lat, lng: c.lng });
    }
  }
  rows.sort((a, b) => a.objectName.localeCompare(b.objectName) || a.time.localeCompare(b.time));
  return slice(rows, q, { count: rows.length, ON: rows.filter((r) => r.state === 'ON').length, OFF: rows.filter((r) => r.state === 'OFF').length });
}

// ---------------------------------------------------------------------------
// CONTINUOUS_DRIVING: fatigue stretches from trips
// ---------------------------------------------------------------------------

export async function continuousDrivingReport(q: QueryCtx): Promise<QueryResult<ContinuousDrivingReportRow>> {
  if (!q.ids.length) return { rows: [], totals: { count: 0, drivingSec: 0 }, totalRows: 0 };
  const trips = await q.prisma.trip.findMany({
    where: { companyId: q.companyId, objectId: { in: q.ids }, startTime: q.range },
    orderBy: [{ objectId: 'asc' }, { startTime: 'asc' }],
    select: { objectId: true, startTime: true, endTime: true, durationSec: true, distanceKm: true, startAddress: true, endAddress: true },
  });
  const byObject = new Map<string, typeof trips>();
  for (const t of trips) (byObject.get(t.objectId) ?? byObject.set(t.objectId, []).get(t.objectId)!).push(t);
  const rows: ContinuousDrivingReportRow[] = [];
  for (const [id, list] of byObject) {
    const spans = list.map((t) => ({ start: t.startTime.getTime(), end: t.endTime.getTime(), durationSec: t.durationSec, distanceKm: t.distanceKm, startAddress: t.startAddress, endAddress: t.endAddress }));
    for (const s of continuousDriving(spans, { drivingMin: q.options.drivingMin, breakMin: q.options.breakMin })) {
      rows.push({
        objectId: id,
        objectName: nameOf(q, id),
        plateNumber: plateOf(q, id),
        startTime: new Date(s.start).toISOString(),
        endTime: new Date(s.end).toISOString(),
        drivingSec: s.drivingSec,
        spanSec: s.spanSec,
        distanceKm: s.distanceKm,
        trips: s.trips,
        longestBreakSec: s.longestBreakSec,
        startAddress: s.startAddress,
        endAddress: s.endAddress,
      });
    }
  }
  rows.sort((a, b) => a.startTime.localeCompare(b.startTime));
  return slice(rows, q, { count: rows.length, drivingSec: rows.reduce((s, r) => s + r.drivingSec, 0), distanceKm: r3(rows.reduce((s, r) => s + r.distanceKm, 0)) });
}

// ---------------------------------------------------------------------------
// EVENT_SUMMARY: alert counts per vehicle and type
// ---------------------------------------------------------------------------

export function alertTypeFilter(options: ReportOptions): Prisma.AlertWhereInput {
  const types = (options.alertTypes ?? []).filter(Boolean);
  return types.length ? { type: { in: types } } : {};
}

export async function eventSummary(q: QueryCtx): Promise<QueryResult<EventSummaryReportRow>> {
  if (!q.ids.length) return { rows: [], totals: { count: 0, criticalCount: 0 }, totalRows: 0 };
  const where: Prisma.AlertWhereInput = { companyId: q.companyId, objectId: { in: q.ids }, occurredAt: q.range, ...alertTypeFilter(q.options) };
  const [groups, critical] = await Promise.all([
    q.prisma.alert.groupBy({ by: ['objectId', 'type'], where, _count: true, _min: { occurredAt: true }, _max: { occurredAt: true } }),
    q.prisma.alert.groupBy({ by: ['objectId', 'type'], where: { ...where, severity: 'CRITICAL' }, _count: true }),
  ]);
  const crit = new Map(critical.map((c) => [`${c.objectId}|${c.type}`, c._count]));
  const rows: EventSummaryReportRow[] = groups.map((g) => ({
    objectId: g.objectId,
    objectName: nameOf(q, g.objectId),
    plateNumber: plateOf(q, g.objectId),
    type: g.type,
    count: g._count,
    criticalCount: crit.get(`${g.objectId}|${g.type}`) ?? 0,
    firstAt: g._min.occurredAt!.toISOString(),
    lastAt: g._max.occurredAt!.toISOString(),
  }));
  rows.sort((a, b) => a.objectName.localeCompare(b.objectName) || b.count - a.count);
  return slice(rows, q, { count: rows.reduce((s, r) => s + r.count, 0), criticalCount: rows.reduce((s, r) => s + r.criticalCount, 0) });
}

// ---------------------------------------------------------------------------
// GEOFENCE_SUMMARY: visits and time inside per vehicle and geofence
// ---------------------------------------------------------------------------

export async function geofenceSummary(q: QueryCtx): Promise<QueryResult<GeofenceSummaryReportRow>> {
  if (!q.ids.length) return { rows: [], totals: { visits: 0, insideSec: 0 }, totalRows: 0 };
  const groups = await q.prisma.$queryRaw<{ objectId: string; geofenceId: string; visits: number; insideSec: number; firstEnter: Date; lastExit: Date | null; open: number }[]>`
    SELECT "objectId", "geofenceId", count(*)::int AS visits,
           sum(coalesce("durationSec", extract(epoch from (coalesce("exitTime", now()) - "enterTime"))::int))::float8 AS "insideSec",
           min("enterTime") AS "firstEnter", max("exitTime") AS "lastExit", count(*) FILTER (WHERE "exitTime" IS NULL)::int AS open
    FROM "GeofenceVisit"
    WHERE "companyId" = ${q.companyId}::uuid AND "objectId" = ANY(${q.ids}::uuid[]) AND "enterTime" >= ${q.range.gte} AND "enterTime" < ${q.range.lt}
    GROUP BY "objectId", "geofenceId"`;
  const geofences = groups.length
    ? await q.prisma.geofence.findMany({ where: { id: { in: [...new Set(groups.map((g) => g.geofenceId))] } }, select: { id: true, name: true } })
    : [];
  const gName = new Map(geofences.map((g) => [g.id, g.name]));
  const rows: GeofenceSummaryReportRow[] = groups.map((g) => ({
    objectId: g.objectId,
    objectName: nameOf(q, g.objectId),
    geofenceId: g.geofenceId,
    geofenceName: gName.get(g.geofenceId) ?? 'Deleted geofence',
    visits: g.visits,
    insideSec: Math.round(g.insideSec ?? 0),
    avgVisitSec: g.visits ? Math.round((g.insideSec ?? 0) / g.visits) : 0,
    firstEnter: g.firstEnter.toISOString(),
    // Still inside: no last exit to report.
    lastExit: g.open > 0 ? null : iso(g.lastExit),
  }));
  rows.sort((a, b) => a.objectName.localeCompare(b.objectName) || a.geofenceName.localeCompare(b.geofenceName));
  return slice(rows, q, { visits: rows.reduce((s, r) => s + r.visits, 0), insideSec: rows.reduce((s, r) => s + r.insideSec, 0) });
}

// ---------------------------------------------------------------------------
// DEVICE_STATUS: criticality board as a report
// ---------------------------------------------------------------------------

const STATUS_ORDER: DeviceStatusReportRow['status'][] = ['NEVER_CONNECTED', 'INACTIVE', 'NO_GPS', 'NO_DEVICE', 'ACTIVE'];

export async function deviceStatusReport(q: QueryCtx, now: number): Promise<QueryResult<DeviceStatusReportRow>> {
  const zero = { ACTIVE: 0, INACTIVE: 0, NO_GPS: 0, NEVER_CONNECTED: 0, NO_DEVICE: 0, count: 0 };
  if (!q.ids.length) return { rows: [], totals: zero, totalRows: 0 };
  const [assignments, lastFix, lastAny] = await Promise.all([
    q.prisma.deviceAssignment.findMany({
      where: { objectId: { in: q.ids }, toTime: null },
      select: { objectId: true, device: { select: { uniqueId: true, simNumber: true, lastSeenAt: true, model: { select: { brand: true, model: true } } } } },
    }),
    q.prisma.$queryRaw<{ objectId: string; fixTime: Date; lat: number; lng: number }[]>`
      SELECT DISTINCT ON ("objectId") "objectId", "fixTime", lat, lng FROM "Position"
      WHERE "objectId" = ANY(${q.ids}::uuid[]) AND valid AND (flags & ${BAD_POINT}) = 0
      ORDER BY "objectId", "fixTime" DESC`,
    q.prisma.$queryRaw<{ objectId: string; serverTime: Date; attributes: Record<string, unknown> }[]>`
      SELECT DISTINCT ON ("objectId") "objectId", "serverTime", attributes FROM "Position"
      WHERE "objectId" = ANY(${q.ids}::uuid[])
      ORDER BY "objectId", "fixTime" DESC`,
  ]);
  const dev = new Map(assignments.map((a) => [a.objectId, a.device]));
  const fix = new Map(lastFix.map((p) => [p.objectId, p]));
  const any = new Map(lastAny.map((p) => [p.objectId, p]));
  const inactiveAfterSec = (q.options.inactiveAfterMin ?? 1440) * 60;
  const rows: DeviceStatusReportRow[] = q.ids.map((id) => {
    const o = q.objects.get(id)!;
    const d = dev.get(id);
    const f = fix.get(id);
    const a = any.get(id);
    const seen = d?.lastSeenAt?.getTime() ?? a?.serverTime.getTime() ?? null;
    const status = deviceStatus({ hasDevice: !!d, lastSeenAt: seen, lastFixAt: f?.fixTime.getTime() ?? null }, now, { inactiveAfterSec, noGpsAfterSec: 6 * 3600 });
    const attrs = (a?.attributes ?? {}) as Record<string, unknown>;
    return {
      objectId: id,
      objectName: o.name,
      plateNumber: o.plateNumber,
      branchName: o.branchName,
      uniqueId: d?.uniqueId ?? null,
      model: d ? `${d.model.brand} ${d.model.model}` : null,
      simNumber: d?.simNumber ?? null,
      status,
      lastSeenAt: seen === null ? null : new Date(seen).toISOString(),
      lastFixTime: iso(f?.fixTime),
      inactiveSec: seen === null ? null : Math.max(0, Math.round((now - seen) / 1000)),
      lat: f?.lat ?? null,
      lng: f?.lng ?? null,
      batteryLevel: num(attrs.batteryLevel),
      extVoltage: num(attrs.extVoltage),
      gsmSignal: num(attrs.gsmSignal),
    };
  });
  rows.sort((x, y) => STATUS_ORDER.indexOf(x.status) - STATUS_ORDER.indexOf(y.status) || x.objectName.localeCompare(y.objectName));
  const totals: Record<string, number> = { ...zero, count: rows.length };
  for (const r of rows) totals[r.status]++;
  return slice(rows, q, totals);
}

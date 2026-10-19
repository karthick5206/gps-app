import { PrismaClient } from '@prisma/client';
import { FuelEventDto, FuelReportRow } from '@veetracer/shared';
import { aggregateFuelDays, FuelDayEvent, FuelDayInput } from '../fuel/fuel-logic';
import { fuelEventDto } from '../fuel/fuel.service';
import { addDays, daysBetween, localDayKey } from '../summarizer/tz';
import { ObjInfo } from './report-queries';

interface Range {
  gte: Date;
  lt: Date;
}

/** Vehicles in the report scope that have a fuel sensor configured. */
async function fuelObjects(prisma: PrismaClient, objects: Map<string, ObjInfo>): Promise<string[]> {
  const ids = [...objects.keys()];
  if (!ids.length) return [];
  const rows = await prisma.fuelConfig.findMany({ where: { objectId: { in: ids }, source: { not: 'none' } }, select: { objectId: true } });
  return rows.map((r) => r.objectId);
}

/** FUEL: per vehicle per day — start / end level, refills, drains, consumption, distance, km/L. */
export async function fuelReport(
  prisma: PrismaClient,
  companyId: string,
  objects: Map<string, ObjInfo>,
  range: Range,
  from: string,
  to: string,
  tz: string,
  maxRows: number,
): Promise<{ rows: FuelReportRow[]; totals: Record<string, number>; totalRows: number }> {
  const ids = await fuelObjects(prisma, objects);
  const zero = { vehicles: 0, refills: 0, refillL: 0, drains: 0, drainL: 0, consumptionL: 0, distanceKm: 0 };
  if (!ids.length) return { rows: [], totals: zero, totalRows: 0 };
  const levels = (order: 'ASC' | 'DESC') =>
    order === 'ASC'
      ? prisma.$queryRaw<{ objectId: string; d: string; l: number }[]>`
        SELECT DISTINCT ON ("objectId", d) "objectId"::text AS "objectId", d, l FROM (
          SELECT "objectId", (("fixTime" AT TIME ZONE ${tz})::date)::text AS d, ("attributes"->>'fuelL')::float8 AS l, "fixTime"
          FROM "Position"
          WHERE "objectId" = ANY(${ids}::uuid[]) AND "fixTime" >= ${range.gte} AND "fixTime" < ${range.lt} AND "attributes"->>'fuelL' IS NOT NULL
        ) p ORDER BY "objectId", d, "fixTime" ASC`
      : prisma.$queryRaw<{ objectId: string; d: string; l: number }[]>`
        SELECT DISTINCT ON ("objectId", d) "objectId"::text AS "objectId", d, l FROM (
          SELECT "objectId", (("fixTime" AT TIME ZONE ${tz})::date)::text AS d, ("attributes"->>'fuelL')::float8 AS l, "fixTime"
          FROM "Position"
          WHERE "objectId" = ANY(${ids}::uuid[]) AND "fixTime" >= ${range.gte} AND "fixTime" < ${range.lt} AND "attributes"->>'fuelL' IS NOT NULL
        ) p ORDER BY "objectId", d, "fixTime" DESC`;
  const [first, last, summaries, events] = await Promise.all([
    levels('ASC'),
    levels('DESC'),
    prisma.dailySummary.findMany({
      where: { companyId, objectId: { in: ids }, day: { gte: new Date(`${from}T00:00:00.000Z`), lte: new Date(`${to}T00:00:00.000Z`) } },
      select: { objectId: true, day: true, distanceKm: true },
    }),
    prisma.fuelEvent.findMany({ where: { companyId, objectId: { in: ids }, startTime: range }, select: { objectId: true, type: true, startTime: true, deltaL: true } }),
  ]);
  const key = (o: string, d: string) => `${o}|${d}`;
  const startL = new Map(first.map((r) => [key(r.objectId, r.d), r.l]));
  const endL = new Map(last.map((r) => [key(r.objectId, r.d), r.l]));
  const dist = new Map(summaries.map((s) => [key(s.objectId, s.day.toISOString().slice(0, 10)), s.distanceKm]));
  const dayEvents: FuelDayEvent[] = events.map((e) => ({ objectId: e.objectId, day: localDayKey(e.startTime.getTime(), tz), type: e.type as FuelDayEvent['type'], deltaL: e.deltaL }));
  const withEvents = new Set(dayEvents.map((e) => key(e.objectId, e.day)));
  const inputs: FuelDayInput[] = [];
  const n = daysBetween(from, to);
  for (const id of ids) {
    for (let i = 0; i <= n; i++) {
      const day = addDays(from, i);
      const k = key(id, day);
      if (!startL.has(k) && !withEvents.has(k)) continue; // no fuel data that day
      inputs.push({ objectId: id, day, startL: startL.get(k) ?? null, endL: endL.get(k) ?? null, distanceKm: dist.get(k) ?? 0 });
    }
  }
  const name = (id: string) => objects.get(id)?.name ?? 'Unknown object';
  const all: FuelReportRow[] = aggregateFuelDays(inputs, dayEvents)
    .map((r) => ({ ...r, objectName: name(r.objectId), plateNumber: objects.get(r.objectId)?.plateNumber ?? null }))
    .sort((a, b) => a.objectName.localeCompare(b.objectName) || a.day.localeCompare(b.day));
  const sum = (f: (r: FuelReportRow) => number) => Math.round(all.reduce((s, r) => s + f(r), 0) * 10) / 10;
  const consumption = sum((r) => r.consumptionL ?? 0);
  const distance = sum((r) => (r.consumptionL !== null ? r.distanceKm : 0));
  return {
    rows: all.slice(0, maxRows),
    totals: {
      vehicles: new Set(all.map((r) => r.objectId)).size,
      refills: sum((r) => r.refills),
      refillL: sum((r) => r.refillL),
      drains: sum((r) => r.drains),
      drainL: sum((r) => r.drainL),
      consumptionL: consumption,
      distanceKm: sum((r) => r.distanceKm),
      kmPerL: consumption >= 0.5 && distance >= 1 ? Math.round((distance / consumption) * 100) / 100 : 0,
    },
    totalRows: all.length,
  };
}

/** FUEL_EVENTS: every detected refill and drain in range. */
export async function fuelEventsReport(
  prisma: PrismaClient,
  companyId: string,
  objects: Map<string, ObjInfo>,
  range: Range,
  maxRows: number,
): Promise<{ rows: FuelEventDto[]; totals: Record<string, number>; totalRows: number }> {
  const ids = [...objects.keys()];
  if (!ids.length) return { rows: [], totals: { count: 0, refills: 0, refillL: 0, drains: 0, drainL: 0 }, totalRows: 0 };
  const where = { companyId, objectId: { in: ids }, startTime: range };
  const [rows, groups] = await Promise.all([
    prisma.fuelEvent.findMany({ where, orderBy: { startTime: 'asc' }, take: maxRows }),
    prisma.fuelEvent.groupBy({ by: ['type'], where, _count: true, _sum: { deltaL: true } }),
  ]);
  const g = (t: string) => groups.find((x) => x.type === t);
  const count = groups.reduce((s, x) => s + x._count, 0);
  const dtos = rows.map((e) => fuelEventDto(e, objects.get(e.objectId))).sort((a, b) => a.objectName.localeCompare(b.objectName) || a.startTime.localeCompare(b.startTime));
  return {
    rows: dtos,
    totals: {
      count,
      refills: g('REFILL')?._count ?? 0,
      refillL: Math.round((g('REFILL')?._sum.deltaL ?? 0) * 10) / 10,
      drains: g('DRAIN')?._count ?? 0,
      drainL: Math.round((g('DRAIN')?._sum.deltaL ?? 0) * 10) / 10,
    },
    totalRows: count,
  };
}

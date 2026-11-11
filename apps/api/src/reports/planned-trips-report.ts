import { PrismaClient } from '@prisma/client';
import { PlannedTripReportRow, TripPerformanceGroupBy, TripPerformanceReportRow } from '@veetracer/shared';
import { ObjInfo } from './report-queries';
import { plannedTripRow, plannedTripTotals, tripFacts, TripFacts, tripPerformance } from './trip-performance';

interface Range {
  gte: Date;
  lt: Date;
}

/** Trips read per query (each with its stops and snapshot path), so long ranges never load everything at once. */
const PAGE = 500;

/**
 * Facts of the planned trips of `objects` whose planned start is in `range` (company days), oldest first. Only trips of
 * vehicles in the caller's scope are read: `objects` is already the data-scope × report-scope selection.
 */
export async function loadTripFacts(prisma: PrismaClient, companyId: string, objects: Map<string, ObjInfo>, range: Range): Promise<TripFacts[]> {
  const ids = [...objects.keys()];
  if (!ids.length) return [];
  const out: TripFacts[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await prisma.plannedTrip.findMany({
      where: { companyId, objectId: { in: ids }, plannedStart: range },
      orderBy: [{ plannedStart: 'asc' }, { id: 'asc' }],
      take: PAGE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        routeId: true,
        routeName: true,
        objectId: true,
        driverId: true,
        status: true,
        closedBy: true,
        plannedStart: true,
        plannedEnd: true,
        actualStart: true,
        actualEnd: true,
        path: true,
        distanceKm: true,
        deviationCount: true,
        delaySec: true,
        stops: { select: { seq: true, lat: true, lng: true, status: true, delaySec: true } },
      },
    });
    for (const t of page) out.push(tripFacts(t));
    if (page.length < PAGE) break;
    cursor = page[page.length - 1].id;
  }
  return out;
}

async function driverNames(prisma: PrismaClient, companyId: string, facts: TripFacts[]): Promise<Map<string, string>> {
  const ids = [...new Set(facts.map((f) => f.driverId).filter((id): id is string => !!id))];
  if (!ids.length) return new Map();
  const rows = await prisma.driver.findMany({ where: { companyId, id: { in: ids } }, select: { id: true, name: true } });
  return new Map(rows.map((d) => [d.id, d.name]));
}

/** TRIP_PERFORMANCE: per route / driver / vehicle, with a totals row over every trip. */
export async function tripPerformanceReport(
  prisma: PrismaClient,
  companyId: string,
  objects: Map<string, ObjInfo>,
  range: Range,
  groupBy: TripPerformanceGroupBy,
  maxRows: number,
): Promise<{ rows: TripPerformanceReportRow[]; totals: Record<string, number>; totalRows: number }> {
  const facts = await loadTripFacts(prisma, companyId, objects, range);
  const routeIds = groupBy === 'ROUTE' ? [...new Set(facts.map((f) => f.routeId))] : [];
  const [routes, drivers] = await Promise.all([
    routeIds.length ? prisma.route.findMany({ where: { companyId, id: { in: routeIds } }, select: { id: true, name: true } }) : [],
    groupBy === 'DRIVER' ? driverNames(prisma, companyId, facts) : new Map<string, string>(),
  ]);
  const routeName = new Map(routes.map((r) => [r.id, r.name]));
  const r = tripPerformance(facts, groupBy, {
    route: (id) => routeName.get(id),
    driver: (id) => drivers.get(id),
    vehicle: (id) => objects.get(id)?.name,
  });
  return { rows: r.rows.slice(0, maxRows), totals: r.totals, totalRows: r.rows.length };
}

/** PLANNED_TRIPS: one row per trip by planned start; totals cover every trip. */
export async function plannedTripsReport(
  prisma: PrismaClient,
  companyId: string,
  objects: Map<string, ObjInfo>,
  range: Range,
  maxRows: number,
): Promise<{ rows: PlannedTripReportRow[]; totals: Record<string, number>; totalRows: number }> {
  const facts = await loadTripFacts(prisma, companyId, objects, range);
  const shown = facts.slice(0, maxRows);
  const drivers = await driverNames(prisma, companyId, shown);
  const rows = shown.map((f) => plannedTripRow(f, { vehicle: (id) => objects.get(id), driver: (id) => drivers.get(id) }));
  return { rows, totals: plannedTripTotals(facts), totalRows: facts.length };
}

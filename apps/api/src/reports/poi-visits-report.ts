import { PrismaClient } from '@prisma/client';
import { PoiVisitReportRow, StopDto } from '@veetracer/shared';
import { AuthContext } from '../access/auth-context';
import { MatchPoi, matchStopsToPois, PoiIndex } from '../pois/poi-match';
import { poiScopeWhere } from '../pois/pois.service';
import { ObjInfo } from './report-queries';

type Scope = Pick<AuthContext, 'companyId' | 'dataScope' | 'branchIds'>;

/** Stops scanned for one POI visits report (a month of a large fleet). */
const MAX_STOPS = 200_000;

export async function loadPoiIndex(prisma: PrismaClient, ctx: Scope): Promise<{ index: PoiIndex; count: number }> {
  const pois: MatchPoi[] = await prisma.poi.findMany({
    where: { AND: [poiScopeWhere(ctx), { isActive: true }] },
    select: { id: true, name: true, category: true, lat: true, lng: true, radiusM: true },
    take: 50_000,
  });
  return { index: new PoiIndex(pois), count: pois.length };
}

/** Nearest POI (within its radius) of each stop row, for the stops / idle / halt reports. */
export async function attachPoiNames(prisma: PrismaClient, ctx: Scope, stops: StopDto[]): Promise<void> {
  if (!stops.length) return;
  const { index, count } = await loadPoiIndex(prisma, ctx);
  for (const s of stops) s.poiName = count ? (index.nearest(s.lat, s.lng)?.poi.name ?? null) : null;
}

/** POI_VISITS: stops of the vehicles in range matched to the nearest POI within its radius. */
export async function poiVisitsReport(
  prisma: PrismaClient,
  ctx: Scope,
  objects: Map<string, ObjInfo>,
  range: { gte: Date; lt: Date },
  maxRows: number,
): Promise<{ rows: PoiVisitReportRow[]; totals: Record<string, number>; totalRows: number }> {
  const ids = [...objects.keys()];
  const empty = { rows: [], totals: { count: 0, durationSec: 0, pois: 0 }, totalRows: 0 };
  if (!ids.length) return empty;
  const { index, count } = await loadPoiIndex(prisma, ctx);
  if (!count) return empty;
  const stops = await prisma.stop.findMany({
    where: { companyId: ctx.companyId, objectId: { in: ids }, startTime: range },
    orderBy: [{ objectId: 'asc' }, { startTime: 'asc' }],
    take: MAX_STOPS,
    select: { objectId: true, startTime: true, endTime: true, lat: true, lng: true, durationSec: true, ignitionOn: true, address: true },
  });
  const visits = matchStopsToPois(stops, index);
  const all: PoiVisitReportRow[] = visits
    .map((v) => {
      const o = objects.get(v.objectId);
      return {
        objectId: v.objectId,
        objectName: o?.name ?? 'Unknown object',
        plateNumber: o?.plateNumber ?? null,
        poiId: v.poi.id,
        poiName: v.poi.name,
        category: v.poi.category,
        arrival: v.arrival.toISOString(),
        departure: v.departure.toISOString(),
        durationSec: v.durationSec,
        distanceM: v.distanceM,
        ignitionOn: v.ignitionOn,
        address: v.address,
      };
    })
    .sort((a, b) => a.objectName.localeCompare(b.objectName) || a.arrival.localeCompare(b.arrival));
  return {
    rows: all.slice(0, maxRows),
    totals: { count: all.length, durationSec: all.reduce((s, r) => s + r.durationSec, 0), pois: new Set(all.map((r) => r.poiId)).size },
    totalRows: all.length,
  };
}

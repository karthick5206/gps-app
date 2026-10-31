import { PrismaClient } from '@prisma/client';
import { fullTankRuns, kmBetween, type FullTankRun } from '@veetracer/shared';

/** How far before the period to look for the full fill-up that starts its first run. */
const LOOKBACK_MS = 120 * 86_400_000;

export type MileageRun = FullTankRun & { km: number };

/**
 * Full-tank runs that close (end with a full fill-up) inside [gte, lt), per vehicle, with the GPS km driven between
 * the two fill-ups (from trips).
 */
export async function mileageRuns(prisma: Pick<PrismaClient, 'expense' | 'trip'>, objectIds: string[], range: { gte: Date; lt: Date }): Promise<Map<string, MileageRun[]>> {
  const out = new Map<string, MileageRun[]>();
  if (!objectIds.length) return out;
  const fills = await prisma.expense.findMany({
    where: { objectId: { in: objectIds }, kind: 'FUEL', at: { gte: new Date(range.gte.getTime() - LOOKBACK_MS), lt: range.lt } },
    select: { objectId: true, at: true, litres: true, amountPaise: true, fullTank: true },
    orderBy: { at: 'asc' },
  });
  const byObject = new Map<string, typeof fills>();
  for (const f of fills) byObject.set(f.objectId, [...(byObject.get(f.objectId) ?? []), f]);
  const runs = new Map<string, FullTankRun[]>();
  for (const [id, list] of byObject) {
    const r = fullTankRuns(list.map((f) => ({ at: f.at.getTime(), litres: f.litres ?? 0, amountPaise: f.amountPaise, fullTank: f.fullTank }))).filter((x) => x.to >= range.gte.getTime() && x.to < range.lt.getTime());
    if (r.length) runs.set(id, r);
  }
  if (!runs.size) return out;
  const all = [...runs.values()].flat();
  const trips = await prisma.trip.findMany({
    where: { objectId: { in: [...runs.keys()] }, startTime: { lt: new Date(Math.max(...all.map((r) => r.to))) }, endTime: { gt: new Date(Math.min(...all.map((r) => r.from))) } },
    select: { objectId: true, startTime: true, endTime: true, distanceKm: true },
  });
  for (const [id, list] of runs) {
    const t = trips.filter((x) => x.objectId === id).map((x) => ({ start: x.startTime.getTime(), end: x.endTime.getTime(), km: x.distanceKm }));
    out.set(id, list.map((r) => ({ ...r, km: kmBetween(t, r.from, r.to) })));
  }
  return out;
}

/** km per litre over several runs: total km ÷ total litres (not an average of averages). */
export function runsKmPerLitre(runs: readonly MileageRun[]): number | null {
  const km = runs.reduce((s, r) => s + r.km, 0);
  const litres = runs.reduce((s, r) => s + r.litres, 0);
  return km > 0 && litres > 0 ? Math.round((km / litres) * 10) / 10 : null;
}

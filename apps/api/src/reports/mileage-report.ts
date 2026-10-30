import { PrismaClient } from '@prisma/client';
import { MileageReportRow, vehicleCost } from '@veetracer/shared';
import { ObjInfo } from './report-queries';

interface Range {
  gte: Date;
  lt: Date;
}

const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;

/** Per-vehicle mileage from fuel-log entries and driven km; vehicles with neither are left out. */
export function aggregateMileage(
  objects: Map<string, ObjInfo>,
  expenses: { objectId: string; kind: string; amountPaise: number; litres: number | null }[],
  km: Map<string, number>,
): MileageReportRow[] {
  const acc = new Map<string, { fillUps: number; litres: number; fuel: number; other: number }>();
  for (const e of expenses) {
    const a = acc.get(e.objectId) ?? { fillUps: 0, litres: 0, fuel: 0, other: 0 };
    if (e.kind === 'FUEL') {
      a.fillUps += 1;
      a.litres += e.litres ?? 0;
      a.fuel += e.amountPaise;
    } else a.other += e.amountPaise;
    acc.set(e.objectId, a);
  }
  const rows: MileageReportRow[] = [];
  for (const [objectId, a] of acc) {
    const o = objects.get(objectId);
    if (!o) continue;
    const distanceKm = r1(km.get(objectId) ?? 0);
    const c = vehicleCost(distanceKm, a.litres, a.fuel, a.other);
    rows.push({
      objectId,
      objectName: o.name,
      plateNumber: o.plateNumber,
      fillUps: a.fillUps,
      litres: r2(a.litres),
      fuelCost: a.fuel / 100,
      otherCost: a.other / 100,
      totalCost: (a.fuel + a.other) / 100,
      distanceKm,
      kmPerL: c.kmPerLitre,
      costPerKm: c.costPerKmPaise === null ? null : c.costPerKmPaise / 100,
      pricePerL: a.litres > 0 ? r2(a.fuel / 100 / a.litres) : null,
    });
  }
  return rows.sort((x, y) => x.objectName.localeCompare(y.objectName));
}

/** Fleet totals; km/L and cost/km are recomputed from the sums, not averaged. */
export function mileageTotals(rows: MileageReportRow[]): Record<string, number> {
  const sum = (f: (r: MileageReportRow) => number) => rows.reduce((s, r) => s + f(r), 0);
  const litres = sum((r) => r.litres);
  const distanceKm = r1(sum((r) => r.distanceKm));
  const fuelCost = r2(sum((r) => r.fuelCost));
  const totalCost = r2(sum((r) => r.totalCost));
  return {
    vehicles: rows.length,
    fillUps: sum((r) => r.fillUps),
    litres: r2(litres),
    fuelCost,
    otherCost: r2(sum((r) => r.otherCost)),
    totalCost,
    distanceKm,
    kmPerL: litres > 0 && distanceKm > 0 ? r1(distanceKm / litres) : 0,
    costPerKm: distanceKm > 0 ? r2(totalCost / distanceKm) : 0,
    pricePerL: litres > 0 ? r2(fuelCost / litres) : 0,
  };
}

/** MILEAGE: manual calculation from fuel fill-ups entered in Fuel & expenses against the GPS distance of the same days (not the fuel-sensor FUEL report). */
export async function mileageReport(
  prisma: PrismaClient,
  objects: Map<string, ObjInfo>,
  range: Range,
  from: string,
  to: string,
  maxRows: number,
): Promise<{ rows: MileageReportRow[]; totals: Record<string, number>; totalRows: number }> {
  const ids = [...objects.keys()];
  if (!ids.length) return { rows: [], totals: mileageTotals([]), totalRows: 0 };
  const expenses = await prisma.expense.findMany({ where: { objectId: { in: ids }, at: { gte: range.gte, lt: range.lt } }, select: { objectId: true, kind: true, amountPaise: true, litres: true } });
  const withCosts = [...new Set(expenses.map((e) => e.objectId))];
  // DailySummary.day is the local calendar day stored at UTC midnight, so the report's day keys match it directly.
  const days = withCosts.length
    ? await prisma.dailySummary.groupBy({ by: ['objectId'], where: { objectId: { in: withCosts }, day: { gte: new Date(`${from}T00:00:00.000Z`), lte: new Date(`${to}T00:00:00.000Z`) } }, _sum: { distanceKm: true } })
    : [];
  const all = aggregateMileage(objects, expenses, new Map(days.map((d) => [d.objectId, d._sum.distanceKm ?? 0])));
  return { rows: all.slice(0, maxRows), totals: mileageTotals(all), totalRows: all.length };
}

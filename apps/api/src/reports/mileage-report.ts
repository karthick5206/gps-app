import { PrismaClient } from '@prisma/client';
import { MileageReportRow } from '@veetracer/shared';
import { mileageRuns, MileageRun } from '../expenses/mileage';
import { ObjInfo } from './report-queries';

interface Range {
  gte: Date;
  lt: Date;
}

const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;

/** One row per full-tank run, by vehicle then time. */
export function mileageRows(objects: Map<string, ObjInfo>, runs: Map<string, MileageRun[]>): MileageReportRow[] {
  const rows: MileageReportRow[] = [];
  for (const [objectId, list] of runs) {
    const o = objects.get(objectId);
    if (!o) continue;
    for (const r of list) {
      const fuelCost = r.amountPaise / 100;
      rows.push({
        objectId,
        objectName: o.name,
        plateNumber: o.plateNumber,
        fromAt: new Date(r.from).toISOString(),
        toAt: new Date(r.to).toISOString(),
        fillUps: r.fills,
        litres: r2(r.litres),
        fuelCost,
        distanceKm: r.km,
        kmPerL: r.km > 0 && r.litres > 0 ? r1(r.km / r.litres) : null,
        costPerKm: r.km > 0 ? r2(fuelCost / r.km) : null,
      });
    }
  }
  return rows.sort((a, b) => a.objectName.localeCompare(b.objectName) || a.toAt.localeCompare(b.toAt));
}

/** Fleet totals; km/L and cost/km are recomputed from the sums, not averaged. */
export function mileageTotals(rows: MileageReportRow[]): Record<string, number> {
  const sum = (f: (r: MileageReportRow) => number) => rows.reduce((s, r) => s + f(r), 0);
  const litres = r2(sum((r) => r.litres));
  const distanceKm = r1(sum((r) => r.distanceKm));
  const fuelCost = r2(sum((r) => r.fuelCost));
  return {
    runs: rows.length,
    vehicles: new Set(rows.map((r) => r.objectId)).size,
    fillUps: sum((r) => r.fillUps),
    litres,
    fuelCost,
    distanceKm,
    kmPerL: litres > 0 && distanceKm > 0 ? r1(distanceKm / litres) : 0,
    costPerKm: distanceKm > 0 ? r2(fuelCost / distanceKm) : 0,
  };
}

/**
 * MILEAGE: manual calculation from fuel fill-ups entered in Fuel & expenses (full-tank method) against the GPS
 * distance between fill-ups — not the fuel-sensor FUEL report.
 */
export async function mileageReport(
  prisma: PrismaClient,
  objects: Map<string, ObjInfo>,
  range: Range,
  maxRows: number,
): Promise<{ rows: MileageReportRow[]; totals: Record<string, number>; totalRows: number }> {
  const all = mileageRows(objects, await mileageRuns(prisma, [...objects.keys()], range));
  return { rows: all.slice(0, maxRows), totals: mileageTotals(all), totalRows: all.length };
}

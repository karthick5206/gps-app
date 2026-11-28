import { PrismaClient } from '@prisma/client';
import {
  BatteryDay,
  batteryReasons,
  batteryVerdict,
  BatteryHealthReportRow,
  BatteryStatus,
  DEFAULT_FUEL_PRICE_PER_L,
  DailySummaryDto,
  FUEL_PRICE_LOOKBACK_DAYS,
  IDLE_LITRES_PER_HOUR,
  idleLitres,
  idleRupees,
  IdleCostReportRow,
  ReportOptions,
  ReportPeriod,
} from '@veetracer/shared';
import { aggregateSummaries } from './aggregate';
import { ObjInfo } from './report-queries';

interface Range {
  gte: Date;
  lt: Date;
}

/** Worst first, so the vehicles that need a look are at the top. */
const STATUS_ORDER: BatteryStatus[] = ['NOT_CHARGING', 'OVERCHARGING', 'REPLACE', 'WEAK', 'GOOD', 'NO_DATA'];

/**
 * Per vehicle per local day: night resting, all-day resting, lowest resting and charging voltage (medians), from the
 * raw points' `extVoltage`. Devices whose extVoltage carries an AC / door sensor (IoSensorConfig) are left out.
 */
export async function loadBatteryDays(prisma: PrismaClient, ids: string[], range: Range, tz: string): Promise<Map<string, BatteryDay[]>> {
  const out = new Map<string, BatteryDay[]>();
  if (!ids.length) return out;
  const rows = await prisma.$queryRaw<{ objectId: string; d: string; night: number | null; rest: number | null; minRest: number | null; charge: number | null }[]>`
    SELECT "objectId"::text AS "objectId", d,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY v) FILTER (WHERE NOT ign AND h BETWEEN 1 AND 4) AS night,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY v) FILTER (WHERE NOT ign) AS rest,
      min(v) FILTER (WHERE NOT ign) AS "minRest",
      percentile_cont(0.5) WITHIN GROUP (ORDER BY v) FILTER (WHERE ign AND spd > 5) AS charge
    FROM (
      SELECT p."objectId", (("fixTime" AT TIME ZONE ${tz})::date)::text AS d, extract(hour FROM "fixTime" AT TIME ZONE ${tz}) AS h,
        (p."attributes"->>'extVoltage')::float8 AS v, coalesce(p.ignition, false) AS ign, p."speedKph" AS spd
      FROM "Position" p
      WHERE p."objectId" = ANY(${ids}::uuid[]) AND p."fixTime" >= ${range.gte} AND p."fixTime" < ${range.lt}
        AND p."attributes" ? 'extVoltage'
        AND NOT EXISTS (SELECT 1 FROM "IoSensorConfig" s WHERE s."deviceId" = p."deviceId" AND s.enabled AND s.attribute = 'extVoltage')
    ) x
    WHERE v > 0 AND v < 40
    GROUP BY "objectId", d`;
  for (const r of rows) {
    const list = out.get(r.objectId) ?? [];
    list.push({ day: r.d, restV: r.night ?? r.rest, chargeV: r.charge, minRestV: r.minRest });
    out.set(r.objectId, list);
  }
  return out;
}

/** BATTERY_HEALTH: one row per vehicle with its verdict, worst first. */
export async function batteryHealthReport(
  prisma: PrismaClient,
  objects: Map<string, ObjInfo>,
  range: Range,
  tz: string,
  maxRows: number,
): Promise<{ rows: BatteryHealthReportRow[]; totals: Record<string, number>; totalRows: number }> {
  const ids = [...objects.keys()].filter((id) => objects.get(id)!.type === 'VEHICLE');
  const days = await loadBatteryDays(prisma, ids, range, tz);
  const all: BatteryHealthReportRow[] = ids.map((id) => {
    const o = objects.get(id)!;
    const v = batteryVerdict(days.get(id) ?? []);
    return {
      objectId: id,
      objectName: o.name,
      plateNumber: o.plateNumber,
      branchName: o.branchName,
      status: v.status,
      systemV: v.systemV,
      restV: v.restV,
      lowestRestV: v.lowestRestV,
      chargeV: v.chargeV,
      trendV: v.trendV,
      days: v.days,
      lowestRestDay: v.lowestRestDay ?? null,
      chargeDays: v.chargeDays ?? 0,
      advice: batteryReasons(v).join(' '),
    };
  });
  all.sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || a.objectName.localeCompare(b.objectName));
  const count = (s: BatteryStatus) => all.filter((r) => r.status === s).length;
  const totals = {
    vehicles: all.length,
    good: count('GOOD'),
    weak: count('WEAK'),
    replace: count('REPLACE'),
    notCharging: count('NOT_CHARGING'),
    overcharging: count('OVERCHARGING'),
    noData: count('NO_DATA'),
  };
  return { rows: all.slice(0, maxRows), totals, totalRows: all.length };
}

/** ₹ per litre from each vehicle's latest fuel bill with litres (before the end of the period, within the look-back). */
export async function latestFuelPrices(prisma: PrismaClient, companyId: string, ids: string[], before: Date): Promise<Map<string, number>> {
  if (!ids.length) return new Map();
  const since = new Date(before.getTime() - FUEL_PRICE_LOOKBACK_DAYS * 86_400_000);
  const rows = await prisma.$queryRaw<{ objectId: string; amountPaise: number; litres: number }[]>`
    SELECT DISTINCT ON ("objectId") "objectId"::text AS "objectId", "amountPaise", litres
    FROM "Expense"
    WHERE "companyId" = ${companyId}::uuid AND "objectId" = ANY(${ids}::uuid[]) AND kind = 'FUEL'
      AND litres > 0.5 AND "amountPaise" > 0 AND at >= ${since} AND at < ${before}
    ORDER BY "objectId", at DESC`;
  const out = new Map<string, number>();
  for (const r of rows) {
    const price = r.amountPaise / 100 / r.litres;
    // Ignore obviously wrong bills (typos in litres or amount).
    if (price >= 40 && price <= 250) out.set(r.objectId, Math.round(price * 100) / 100);
  }
  return out;
}

/** IDLE_COST rows from daily summaries (idle = engine on, standing). */
export function idleCostRows(
  days: DailySummaryDto[],
  period: ReportPeriod,
  objects: Map<string, ObjInfo>,
  prices: Map<string, number>,
  options: ReportOptions,
): { rows: IdleCostReportRow[]; totals: Record<string, number> } {
  const defaultPrice = options.fuelPricePerL && options.fuelPricePerL > 0 ? options.fuelPricePerL : DEFAULT_FUEL_PRICE_PER_L;
  const rows: IdleCostReportRow[] = aggregateSummaries(days, period).map((r) => {
    const o = objects.get(r.objectId);
    const lph = options.idleLitresPerHour && options.idleLitresPerHour > 0 ? options.idleLitresPerHour : IDLE_LITRES_PER_HOUR[o?.vehicleType ?? 'OTHER'] ?? IDLE_LITRES_PER_HOUR.OTHER;
    const logged = prices.get(r.objectId);
    const pricePerL = logged ?? defaultPrice;
    const litres = idleLitres(r.idleSec, lph);
    return {
      objectId: r.objectId,
      objectName: r.objectName,
      plateNumber: r.plateNumber,
      branchName: r.branchName,
      period: r.period,
      idleSec: r.idleSec,
      idlePct: r.engineSec ? Math.round((r.idleSec / r.engineSec) * 1000) / 10 : 0,
      litresPerHour: lph,
      litres,
      pricePerL,
      priceSource: logged !== undefined ? 'FUEL_LOG' : 'DEFAULT',
      rupees: idleRupees(litres, pricePerL),
    };
  });
  const sum = (k: 'idleSec' | 'litres' | 'rupees') => rows.reduce((a, r) => a + r[k], 0);
  return {
    rows,
    totals: { vehicles: new Set(rows.map((r) => r.objectId)).size, idleSec: sum('idleSec'), litres: Math.round(sum('litres') * 100) / 100, rupees: sum('rupees') },
  };
}

import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { INVENTORY_STATUSES, InventoryDashboardDto, InventoryStatus, STOCK_MOVEMENT_KINDS, StockMovementKind } from '@veetracer/shared';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryStockService } from './stock.service';

/** Day buckets of the movement chart use the platform's business time zone. */
const TZ = 'Asia/Kolkata';
const AT_CUSTOMER: InventoryStatus[] = ['ASSIGNED', 'ACTIVE'];
const IN_STOCK: InventoryStatus[] = ['IN_STOCK', 'RESERVED'];
const ATTENTION: InventoryStatus[] = ['FAULTY', 'UNDER_REPAIR', 'RETURNED'];

/** Calendar days (YYYY-MM-DD) of the last `days` days ending today in `tz`, oldest first. */
export function dayKeys(days: number, now: Date = new Date(), tz = TZ): string[] {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i--) out.push(fmt.format(new Date(now.getTime() - i * 86_400_000)));
  return [...new Set(out)];
}

/**
 * Inventory dashboard (read-only): totals by status / location / model, movements per day, and the recorded purchase
 * value of devices still held. Computed from DeviceStock / StockMovement only; nothing is written.
 */
@Injectable()
export class InventoryDashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stock: InventoryStockService,
  ) {}

  async dashboard(days = 30): Promise<InventoryDashboardDto> {
    const summary = await this.stock.summary();
    const since = new Date(Date.now() - days * 86_400_000);
    const [byLocation, byStatusValue, models, moves] = await Promise.all([
      this.prisma.deviceStock.groupBy({ by: ['locationId'], orderBy: { locationId: 'asc' }, _count: { _all: true }, _sum: { unitCostPaise: true } }),
      this.prisma.deviceStock.groupBy({ by: ['status'], orderBy: { status: 'asc' }, _count: { _all: true, unitCostPaise: true }, _sum: { unitCostPaise: true } }),
      this.prisma.$queryRaw<{ modelId: string; name: string; total: bigint; in_stock: bigint; at_customer: bigint; faulty: bigint }[]>(Prisma.sql`
        SELECT d."modelId", m."brand" || ' ' || m."model" AS name,
               count(*) AS total,
               count(*) FILTER (WHERE s."status" IN ('IN_STOCK', 'RESERVED')) AS in_stock,
               count(*) FILTER (WHERE s."status" IN ('ASSIGNED', 'ACTIVE')) AS at_customer,
               count(*) FILTER (WHERE s."status" IN ('FAULTY', 'UNDER_REPAIR', 'RETURNED')) AS faulty
        FROM "DeviceStock" s
        JOIN "Device" d ON d."id" = s."deviceId"
        JOIN "DeviceModel" m ON m."id" = d."modelId"
        GROUP BY d."modelId", m."brand", m."model"
        ORDER BY total DESC, name ASC
        LIMIT 20`),
      this.prisma.$queryRaw<{ day: string; kind: string; n: bigint }[]>(Prisma.sql`
        SELECT to_char(("at" AT TIME ZONE ${TZ})::date, 'YYYY-MM-DD') AS day, "kind", count(*) AS n
        FROM "StockMovement"
        WHERE "at" >= ${since}
        GROUP BY 1, 2`),
    ]);

    const locIds = byLocation.map((l) => l.locationId).filter((id): id is string => !!id);
    const locs = new Map((await this.prisma.stockLocation.findMany({ where: { id: { in: locIds } }, select: { id: true, code: true, name: true } })).map((l) => [l.id, l]));

    const valuationByStatus: Partial<Record<InventoryStatus, number>> = {};
    let held = 0;
    let costed = 0;
    let all = 0;
    for (const g of byStatusValue) {
      const status = g.status as InventoryStatus;
      const sum = g._sum.unitCostPaise ?? 0;
      valuationByStatus[status] = sum;
      if (status === 'RETIRED') continue;
      held += sum;
      costed += (g._count as { unitCostPaise: number }).unitCostPaise;
      all += (g._count as { _all: number })._all;
    }

    const keys = dayKeys(days);
    const perDay = new Map(keys.map((k) => [k, { day: k, total: 0, byKind: {} as Partial<Record<StockMovementKind, number>> }]));
    for (const m of moves) {
      const bucket = perDay.get(m.day);
      if (!bucket || !(STOCK_MOVEMENT_KINDS as readonly string[]).includes(m.kind)) continue;
      const n = Number(m.n);
      bucket.total += n;
      bucket.byKind[m.kind as StockMovementKind] = (bucket.byKind[m.kind as StockMovementKind] ?? 0) + n;
    }

    // Status counts from the same grouped query as the valuation, so totals and value always agree.
    const byStatus = Object.fromEntries(INVENTORY_STATUSES.map((s) => [s, 0])) as Record<InventoryStatus, number>;
    for (const g of byStatusValue) if (g.status in byStatus) byStatus[g.status as InventoryStatus] = (g._count as { _all: number })._all;
    const sum = (list: InventoryStatus[]) => list.reduce((s, k) => s + byStatus[k], 0);
    const tracked = INVENTORY_STATUSES.reduce((s, k) => s + byStatus[k], 0);
    return {
      totals: {
        tracked,
        untracked: summary.untracked,
        mismatches: summary.mismatches,
        atCustomer: sum(AT_CUSTOMER),
        inStock: sum(IN_STOCK),
        needsAttention: sum(ATTENTION),
      },
      byStatus,
      byLocation: byLocation
        .map((g) => ({
          locationId: g.locationId,
          code: g.locationId ? (locs.get(g.locationId)?.code ?? null) : null,
          name: g.locationId ? (locs.get(g.locationId)?.name ?? null) : null,
          count: (g._count as { _all: number })._all,
          valuePaise: g._sum.unitCostPaise ?? 0,
        }))
        .sort((a, b) => b.count - a.count),
      byModel: models.map((m) => ({
        modelId: m.modelId,
        name: m.name,
        total: Number(m.total),
        inStock: Number(m.in_stock),
        atCustomer: Number(m.at_customer),
        faulty: Number(m.faulty),
      })),
      movements: [...perDay.values()],
      valuation: { heldValuePaise: held, costedUnits: costed, uncostedUnits: all - costed, byStatus: valuationByStatus },
      windowDays: days,
    };
  }
}

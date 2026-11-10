import { Injectable } from '@nestjs/common';
import type { StockDashboardDto, StockDocKind, StockDocStatus } from '@veetracer/shared';
import { AuthContext } from '../access/auth-context';
import { PrismaService } from '../prisma/prisma.service';
import { planStatus } from './stock-logic';
import { StockService } from './stock.service';

const DAY_MS = 86_400_000;
/** Today in India as YYYY-MM-DD. */
const istDay = (ms = Date.now()) => new Date(ms + 5.5 * 3600_000).toISOString().slice(0, 10);
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);

/**
 * Inventory dashboard: what is in stock and what it is worth, what needs ordering (reorder level, quantity on order,
 * supplier lead time), purchase orders and when they should arrive, damaged units, sales this month, unpaid invoices.
 * The platform looks at the main store; a reseller at its own store.
 */
@Injectable()
export class StockDashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stock: StockService,
  ) {}

  async dashboard(ctx: AuthContext): Promise<StockDashboardDto> {
    const scope = await this.stock.scope(ctx);
    const locs = await this.stock.locations(ctx);
    const home = scope.kind === 'PARTNER' ? locs.find((l) => l.kind === 'PARTNER') : locs.find((l) => l.kind === 'STORE');
    const stores = locs.filter((l) => l.kind !== 'DAMAGED').map((l) => l.id);
    const damaged = locs.filter((l) => l.kind === 'DAMAGED').map((l) => l.id);
    const today = istDay();
    const monthStart = `${today.slice(0, 8)}01`;
    const own = scope.kind === 'PARTNER' ? { partnerId: scope.partnerId } : { partnerId: null };

    const [items, sums, damagedSum, monthDocs, openPos, invoices, recentDocs, resellerOrders, salesRows] = await Promise.all([
      this.prisma.stockItem.findMany({ where: { isActive: true } }),
      this.prisma.stockMove.groupBy({ by: ['itemId', 'locationId'], where: { locationId: { in: stores } }, _sum: { qty: true } }),
      damaged.length ? this.prisma.stockMove.aggregate({ where: { locationId: { in: damaged } }, _sum: { qty: true } }) : Promise.resolve({ _sum: { qty: 0 } }),
      this.prisma.stockDoc.findMany({ where: { ...own, status: 'DONE', kind: { in: ['SALE', 'RECEIPT'] }, docDate: { gte: monthStart } }, include: { lines: true } }),
      this.prisma.stockDoc.findMany({ where: { ...own, kind: 'PO', toPlatform: false, status: { in: ['OPEN', 'PARTIAL'] } }, include: { lines: true, supplier: true }, orderBy: { docDate: 'asc' } }),
      this.prisma.stockInvoice.findMany({ where: { kind: 'INVOICE', paymentStatus: { not: 'PAID' } }, select: { totalPaise: true, paidPaise: true, docId: true } }),
      this.prisma.stockDoc.findMany({ where: scope.kind === 'PARTNER' ? { OR: [{ partnerId: scope.partnerId }, { customerPartnerId: scope.partnerId }] } : {}, orderBy: { updatedAt: 'desc' }, take: 8, include: { supplier: { select: { name: true } } } }),
      scope.kind === 'PLATFORM' ? this.prisma.stockDoc.count({ where: { kind: 'PO', toPlatform: true, status: { in: ['OPEN', 'PARTIAL'] } } }) : Promise.resolve(0),
      this.prisma.stockDoc.findMany({ where: { ...own, kind: 'SALE', status: 'DONE', docDate: { gte: addDays(today, -29) } }, include: { lines: true } }),
    ]);

    const itemBy = new Map(items.map((i) => [i.id, i]));
    let unitsInStock = 0;
    let stockValuePaise = 0;
    const atHome = new Map<string, number>();
    for (const x of sums) {
      const q = x._sum.qty ?? 0;
      const item = itemBy.get(x.itemId);
      unitsInStock += q;
      stockValuePaise += q * (item?.purchasePricePaise ?? 0);
      if (x.locationId === home?.id) atHome.set(x.itemId, (atHome.get(x.itemId) ?? 0) + q);
    }

    // Received against each open PO so far, to know what is still on order.
    const receipts = openPos.length ? await this.prisma.stockDoc.findMany({ where: { sourceId: { in: openPos.map((p) => p.id) }, status: 'DONE' }, include: { lines: true } }) : [];
    const onOrder = new Map<string, number>();
    const openPurchaseOrders = openPos.map((po) => {
      const got = receipts.filter((r) => r.sourceId === po.id).flatMap((r) => r.lines);
      const { pending } = planStatus(po.lines, got);
      for (const p of pending) onOrder.set(p.itemId, (onOrder.get(p.itemId) ?? 0) + p.qty);
      const expectedBy = po.supplier ? addDays(po.docDate, po.supplier.leadTimeDays) : null;
      return { id: po.id, number: po.number, supplierName: po.supplier?.name ?? '—', docDate: po.docDate, expectedBy, overdueDays: expectedBy && expectedBy < today ? daysBetween(expectedBy, today) : 0, pendingQty: pending.reduce((t, p) => t + p.qty, 0) };
    });

    // Last supplier each item was bought from (for "order from" and its lead time).
    const lastPo = await this.prisma.stockDocLine.findMany({ where: { doc: { kind: { in: ['PO', 'RECEIPT'] }, supplierId: { not: null }, ...own } }, orderBy: { doc: { docDate: 'desc' } }, select: { itemId: true, doc: { select: { supplier: { select: { id: true, name: true, leadTimeDays: true } } } } }, take: 500 });
    const supplierOf = new Map<string, { id: string; name: string; leadTimeDays: number }>();
    for (const l of lastPo) if (l.doc.supplier && !supplierOf.has(l.itemId)) supplierOf.set(l.itemId, l.doc.supplier);

    const lowStock = items
      .filter((i) => i.lowStockAt !== null && (atHome.get(i.id) ?? 0) <= i.lowStockAt)
      .map((i) => {
        const onHand = atHome.get(i.id) ?? 0;
        const level = i.lowStockAt ?? 0;
        const ordered = onOrder.get(i.id) ?? 0;
        const sup = supplierOf.get(i.id) ?? null;
        // Enough to get back above the level with room: the usual order quantity, else twice the level.
        const suggestedQty = Math.max(i.reorderQty ?? level * 2 - onHand - ordered, 1);
        return {
          itemId: i.id,
          itemName: i.name,
          unit: i.unit,
          onHand,
          reorderLevel: level,
          onOrder: ordered,
          suggestedQty,
          supplierId: sup?.id ?? null,
          supplierName: sup?.name ?? null,
          leadTimeDays: sup?.leadTimeDays ?? null,
          expectedBy: sup ? addDays(today, sup.leadTimeDays) : null,
          orderNow: onHand + ordered <= level,
        };
      })
      .sort((a, b) => Number(b.orderNow) - Number(a.orderNow) || a.onHand / Math.max(1, a.reorderLevel) - b.onHand / Math.max(1, b.reorderLevel));

    const units = (kind: string) => monthDocs.filter((d) => d.kind === kind).reduce((t, d) => t + d.lines.reduce((s, l) => s + Math.abs(l.qty), 0), 0);
    const byDay = new Map<string, { units: number; amountPaise: number }>();
    for (let i = 29; i >= 0; i--) byDay.set(addDays(today, -i), { units: 0, amountPaise: 0 });
    for (const d of salesRows) {
      const b = byDay.get(d.docDate);
      if (!b) continue;
      b.units += d.lines.reduce((s, l) => s + Math.abs(l.qty), 0);
      b.amountPaise += d.totalPaise;
    }
    // Unpaid invoices of this side only (a reseller: invoices on sales it made).
    const mine = scope.kind === 'PARTNER' ? new Set((await this.prisma.stockDoc.findMany({ where: { id: { in: invoices.map((i) => i.docId) }, partnerId: scope.partnerId }, select: { id: true } })).map((d) => d.id)) : null;
    const unpaid = invoices.filter((i) => !mine || mine.has(i.docId));
    const dues = scope.kind === 'PLATFORM' ? await this.stock.openSupplierBills() : [];

    return {
      generatedAt: new Date().toISOString(),
      unitsInStock,
      stockValuePaise,
      damagedUnits: damagedSum._sum.qty ?? 0,
      soldUnitsMonth: units('SALE'),
      salesMonthPaise: monthDocs.filter((d) => d.kind === 'SALE').reduce((t, d) => t + d.totalPaise, 0),
      receivedUnitsMonth: units('RECEIPT'),
      resellerOrdersOpen: resellerOrders,
      unpaidInvoices: { count: unpaid.length, amountPaise: unpaid.reduce((t, i) => t + i.totalPaise - i.paidPaise, 0) },
      supplierDues: {
        count: dues.length,
        duePaise: dues.reduce((t, d) => t + d.duePaise, 0),
        overdueCount: dues.filter((d) => d.overdue).length,
        overduePaise: dues.filter((d) => d.overdue).reduce((t, d) => t + d.duePaise, 0),
        bills: dues.slice(0, 10),
      },
      lowStock,
      openPurchaseOrders,
      salesByDay: [...byDay.entries()].map(([day, v]) => ({ day, ...v })),
      recent: recentDocs.map((d) => ({ id: d.id, kind: d.kind as StockDocKind, number: d.number, status: d.status as StockDocStatus, docDate: d.docDate, party: d.supplier?.name ?? (d.customerName || ''), totalPaise: d.totalPaise })),
    };
  }
}

import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { type InventoryStatus } from '@veetracer/shared';
import type { AuthContext } from '../access/auth-context';
import { DEVICE_FACTS_SELECT, factsOf } from '../inventory/inventory.mapper';
import { PrismaService } from '../prisma/prisma.service';
import { locationCode, locationKindFor, movementKind, type SalesSerialState, type SpecialLocations, wantedStock, type WantedStock } from './inventory-link';

type Tx = Prisma.TransactionClient;
const MAIN_STORE = 'Main store';

export interface LinkResult {
  serial: string;
  /** Movement written (or that would be written in a dry run); null = already matching. */
  kind: string | null;
  from: string | null;
  to: string | null;
  note?: string;
}

/**
 * Keeps Stock & movements (the one stock register) in step with Stock & sales documents. See inventory-link.ts for the
 * rules. Stores, suppliers and receipts are matched to (or created in) Stock & movements on first use and remembered.
 * Never changes Device ownership or licence seats: StockService already did the customer assignment through
 * AdminDevicesService before this runs; the register only records it.
 */
@Injectable()
export class InventoryLinkService {
  private readonly log = new Logger('InventoryLink');

  constructor(private readonly prisma: PrismaService) {}

  // ───────────── places, suppliers, receipts ─────────────

  /** The Stock & movements location for a Stock & sales store (matched by name, else created), remembered on the store. */
  async locationFor(tx: Tx, storeId: string): Promise<{ locationId: string; holderPartnerId: string | null }> {
    const store = await tx.stockStore.findUniqueOrThrow({ where: { id: storeId }, include: { inventoryLocation: { select: { id: true } } } });
    const holderPartnerId = store.kind === 'PARTNER' ? store.partnerId : null;
    if (store.inventoryLocation) return { locationId: store.inventoryLocation.id, holderPartnerId };
    const ownerPartnerId = holderPartnerId;
    let loc = await tx.stockLocation.findFirst({ where: { ownerPartnerId, name: { equals: store.name, mode: 'insensitive' } }, select: { id: true } });
    if (!loc && ownerPartnerId) loc = await tx.stockLocation.findFirst({ where: { ownerPartnerId, kind: 'PARTNER', isActive: true }, orderBy: { createdAt: 'asc' }, select: { id: true } });
    if (!loc && store.name === MAIN_STORE) {
      // The main store is the platform's warehouse when Stock & movements has exactly one.
      const warehouses = await tx.stockLocation.findMany({ where: { ownerPartnerId: null, kind: 'WAREHOUSE', isActive: true }, select: { id: true }, take: 2 });
      if (warehouses.length === 1) loc = warehouses[0];
    }
    if (!loc) loc = await tx.stockLocation.create({ data: { kind: locationKindFor(store.kind), name: store.name, code: await this.freeCode(tx, locationCode(store.name), ownerPartnerId), ownerPartnerId }, select: { id: true } });
    await tx.stockStore.update({ where: { id: store.id }, data: { inventoryLocationId: loc.id } });
    return { locationId: loc.id, holderPartnerId };
  }

  private async freeCode(tx: Tx, base: string, ownerPartnerId: string | null): Promise<string> {
    for (let i = 1; i < 100; i++) {
      const code = i === 1 ? base : `${base.slice(0, 17)}-${i}`;
      if (!(await tx.stockLocation.findFirst({ where: { ownerPartnerId, code }, select: { id: true } }))) return code;
    }
    return `${base.slice(0, 12)}-${Date.now().toString(36)}`;
  }

  /** "Returned to supplier" and "Scrap" places (the existing ones of that kind, else created). */
  async specialLocations(tx: Tx): Promise<SpecialLocations> {
    const ensure = async (kind: 'SUPPLIER_RMA' | 'SCRAP', name: string, code: string) =>
      (await tx.stockLocation.findFirst({ where: { ownerPartnerId: null, kind, isActive: true }, orderBy: { createdAt: 'asc' }, select: { id: true } }))?.id ??
      (await tx.stockLocation.create({ data: { kind, name, code: await this.freeCode(tx, code, null) }, select: { id: true } })).id;
    return { supplierReturn: await ensure('SUPPLIER_RMA', 'Returned to supplier', 'RETURNED-TO-SUPPLIER'), scrap: await ensure('SCRAP', 'Scrap', 'SCRAP') };
  }

  /** The Stock & movements supplier for a Stock & sales supplier (matched by name, else created), remembered. */
  async supplierFor(tx: Tx, stockSupplierId: string): Promise<string> {
    const s = await tx.stockSupplier.findUniqueOrThrow({ where: { id: stockSupplierId }, include: { inventorySupplier: { select: { id: true } } } });
    if (s.inventorySupplier) return s.inventorySupplier.id;
    const found = await tx.supplier.findFirst({ where: { ownerPartnerId: null, name: { equals: s.name, mode: 'insensitive' } }, select: { id: true } });
    const id =
      found?.id ??
      (
        await tx.supplier.create({
          data: { name: s.name, gstin: s.gstin, stateCode: s.stateCode || null, contact: { contactName: s.contactName, phone: s.phone, email: s.email, address: [s.address, s.city, s.pin].filter(Boolean).join(', ') } },
          select: { id: true },
        })
      ).id;
    await tx.stockSupplier.update({ where: { id: s.id }, data: { inventorySupplierId: id } });
    return id;
  }

  /** A Stock & sales receipt with trackers appears in Stock & movements → Receipts (one receipt per document). */
  private async receiptFor(tx: Tx, ctx: AuthContext, docId: string, deviceCount: number): Promise<string | null> {
    const doc = await tx.stockDoc.findUnique({ where: { id: docId } });
    if (!doc || doc.kind !== 'RECEIPT' || !doc.locationId) return null;
    const { locationId } = await this.locationFor(tx, doc.locationId);
    const data = {
      supplierId: doc.supplierId ? await this.supplierFor(tx, doc.supplierId) : null,
      locationId,
      supplierInvoiceNo: doc.supplierInvoiceNo || null,
      supplierInvoiceAt: doc.supplierInvoiceDate ? new Date(`${doc.supplierInvoiceDate}T00:00:00Z`) : null,
      receivedAt: new Date(`${doc.docDate}T12:00:00+05:30`),
      itemCount: deviceCount,
      note: `From Stock & sales ${doc.number}`,
    };
    if (doc.inventoryReceiptId) {
      await tx.stockReceipt.update({ where: { id: doc.inventoryReceiptId }, data });
      return doc.inventoryReceiptId;
    }
    const r = await tx.stockReceipt.create({ data: { ...data, source: 'MANUAL', createdById: ctx.userId }, select: { id: true } });
    await tx.stockDoc.update({ where: { id: doc.id }, data: { inventoryReceiptId: r.id } });
    return r.id;
  }

  // ───────────── the register ─────────────

  /**
   * Brings each touched tracker to its Stock & sales state in Stock & movements (one movement per change, naming the
   * document). Only items that are trackers (DEVICE with a model). Problems are logged and returned; they never undo
   * the Stock & sales document, and "Sync with Stock & movements" can repeat it at any time.
   */
  async reconcile(ctx: AuthContext, touched: { itemId: string; serial: string }[], opts: { dryRun?: boolean } = {}): Promise<LinkResult[]> {
    if (!touched.length) return [];
    const trackerItems = new Set((await this.prisma.stockItem.findMany({ where: { id: { in: [...new Set(touched.map((t) => t.itemId))] }, kind: 'DEVICE', deviceModelId: { not: null } }, select: { id: true } })).map((i) => i.id));
    const out: LinkResult[] = [];
    for (const t of touched) {
      if (!trackerItems.has(t.itemId)) continue;
      try {
        out.push(await this.prisma.$transaction((tx) => this.one(tx, ctx, t, !!opts.dryRun), { timeout: 20_000 }));
      } catch (e) {
        this.log.warn(`Stock & movements update for ${t.serial}: ${(e as Error).message}`);
        out.push({ serial: t.serial, kind: null, from: null, to: null, note: `Not updated: ${(e as Error).message}` });
      }
    }
    return out;
  }

  private async one(tx: Tx, ctx: AuthContext, t: { itemId: string; serial: string }, dryRun: boolean): Promise<LinkResult> {
    const device = await tx.device.findUnique({ where: { uniqueId: t.serial }, select: DEVICE_FACTS_SELECT });
    if (!device) return { serial: t.serial, kind: null, from: null, to: null, note: 'Not in the device list yet' };
    const row = await tx.stockSerial.findUnique({ where: { itemId_serial: { itemId: t.itemId, serial: t.serial } } });
    const doc = row?.lastDocId ? await tx.stockDoc.findUnique({ where: { id: row.lastDocId }, include: { lines: { where: { itemId: t.itemId } } } }) : null;
    const now = await tx.deviceStock.findUnique({ where: { deviceId: device.id }, include: { receipt: { select: { salesDoc: { select: { number: true } } } } } });

    let state: SalesSerialState | null = null;
    if (row) {
      const place = row.locationId && (row.status === 'IN_STOCK' || row.status === 'DAMAGED') ? await this.locationFor(tx, row.locationId) : null;
      state = { status: row.status as SalesSerialState['status'], locationId: place?.locationId ?? null, holderPartnerId: place?.holderPartnerId ?? null };
    }
    let want: WantedStock | null = wantedStock(state, factsOf(device), await this.specialLocations(tx));
    // No longer in any Stock & sales document (its receipt was cancelled / deleted): only a unit that came in through
    // Stock & sales is taken out again; a unit received in Stock & movements keeps its own state.
    if (!want && now?.receipt?.salesDoc && (now.status === 'IN_STOCK' || now.status === 'FAULTY'))
      want = { status: 'RETIRED', locationId: null, holderPartnerId: null, why: `Receipt ${now.receipt.salesDoc.number} cancelled in Stock & sales` };
    if (!want) return { serial: t.serial, kind: null, from: now?.status ?? null, to: now?.status ?? null };

    const current = now ? { status: now.status as InventoryStatus, locationId: now.locationId, holderPartnerId: now.holderPartnerId } : null;
    const kind = movementKind(current, want);
    if (!kind) return { serial: t.serial, kind: null, from: current?.status ?? null, to: current?.status ?? null };
    if (dryRun) return { serial: t.serial, kind, from: current?.status ?? null, to: want.status };

    const line = doc?.lines.find((l) => l.serials.includes(t.serial));
    const receiptId = !now && doc?.kind === 'RECEIPT' ? await this.receiptFor(tx, ctx, doc.id, doc.lines.reduce((n, l) => n + l.serials.length, 0)) : null;
    const reference = doc ? `StockDoc:${doc.number}` : null;
    const reason = doc ? `${want.why} (Stock & sales ${doc.number})` : want.why;
    if (now) {
      // Same optimistic guard as Stock & movements: refused if someone changed the row meanwhile (retry with Sync).
      const res = await tx.deviceStock.updateMany({ where: { deviceId: device.id, updatedAt: now.updatedAt }, data: { status: want.status, locationId: want.locationId, holderPartnerId: want.holderPartnerId, ...(now.status !== want.status ? { statusChangedAt: new Date() } : {}) } });
      if (res.count !== 1) throw new Error('the stock record changed meanwhile; use Sync with Stock & movements');
    } else {
      await tx.deviceStock.create({ data: { deviceId: device.id, status: want.status, locationId: want.locationId, holderPartnerId: want.holderPartnerId, receiptId, unitCostPaise: line?.ratePaise || null, condition: 'NEW' } });
    }
    await tx.stockMovement.create({
      data: {
        deviceId: device.id,
        itemRef: device.uniqueId,
        kind,
        fromStatus: current?.status ?? null,
        toStatus: want.status,
        fromLocationId: current?.locationId ?? null,
        toLocationId: want.locationId,
        fromHolderPartnerId: current?.holderPartnerId ?? null,
        toHolderPartnerId: want.holderPartnerId,
        companyId: device.companyId,
        objectId: device.assignments[0]?.objectId ?? null,
        receiptId,
        reason,
        reference,
        createdById: ctx.userId,
        at: new Date(),
      },
    });
    return { serial: t.serial, kind, from: current?.status ?? null, to: want.status };
  }

  /** Every tracker Stock & sales knows (first link of existing data, or a repair). Dry run first: nothing is written. */
  async syncAll(ctx: AuthContext, dryRun: boolean): Promise<{ checked: number; changes: LinkResult[] }> {
    const rows = await this.prisma.stockSerial.findMany({ where: { item: { kind: 'DEVICE', deviceModelId: { not: null } } }, select: { itemId: true, serial: true } });
    const results = await this.reconcile(ctx, rows, { dryRun });
    return { checked: rows.length, changes: results.filter((r) => r.kind || r.note) };
  }

  /**
   * Trackers in stock in Stock & movements that Stock & sales has never seen (received there). Lets a sale use them:
   * StockService first brings them into its store with an adjustment, then sells them.
   */
  /** Trackers of a model in stock at a store's place in Stock & movements that Purchases & sales has never seen. */
  async registerOnlyAt(deviceModelId: string, storeId: string): Promise<string[]> {
    const { locationId } = await this.prisma.$transaction((tx) => this.locationFor(tx, storeId));
    const devices = await this.prisma.device.findMany({ where: { modelId: deviceModelId, stock: { status: 'IN_STOCK', locationId } }, select: { uniqueId: true }, take: 2000 });
    if (!devices.length) return [];
    const known = new Set((await this.prisma.stockSerial.findMany({ where: { serial: { in: devices.map((d) => d.uniqueId) } }, select: { serial: true } })).map((r) => r.serial));
    return devices.map((d) => d.uniqueId).filter((u) => !known.has(u));
  }

  async onlyInRegister(itemDeviceModelId: string, serials: string[]): Promise<string[]> {
    if (!serials.length) return [];
    const devices = await this.prisma.device.findMany({ where: { uniqueId: { in: serials }, modelId: itemDeviceModelId, stock: { status: 'IN_STOCK' } }, select: { uniqueId: true } });
    if (!devices.length) return [];
    const known = new Set((await this.prisma.stockSerial.findMany({ where: { serial: { in: devices.map((d) => d.uniqueId) } }, select: { serial: true } })).map((r) => r.serial));
    return devices.map((d) => d.uniqueId).filter((s) => !known.has(s));
  }
}

import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, StreamableFile } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  STOCK_DOC_PREFIX,
  type StockDocDto,
  type StockDocInput,
  type StockDocKind,
  type StockDocStatus,
  type StockFileDto,
  type StockItemDto,
  type StockItemKind,
  type StockStoreDto,
  type StockStoreKind,
  type StockOnHandRow,
  type StockOrderChannel,
  type StockPriceDto,
  type StockSaleTo,
  type StockSerialDto,
  type StockSerialStatus,
  type StockSupplierDto,
} from '@veetracer/shared';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AuthContext } from '../access/auth-context';
import { AuditService } from '../audit/audit.service';
import { APP_ROOT } from '../config/env';
import { AdminDevicesService } from '../masters/admin-devices/admin-devices.service';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryLinkService, type LinkResult } from './inventory-link.service';
import { checkMoves, cleanSerials, fyOf, lineQty, PLAN_ONLY, planMoves, planStatus, type PlannedMove, type SerialNow } from './stock-logic';

/*
 * Stock: items, suppliers, stores, and one document type for the whole flow (PO → receipt → return; order → sale →
 * return; adjustment). Saving a DONE document rewrites its stock moves inside one transaction after checking the goods
 * are really there; IMEI rows follow their latest move. Received trackers appear in Device Inventory; a tracker sold
 * to a customer company is assigned to it, and one returned goes back to stock (through AdminDevicesService, so seats,
 * object links and the audit trail behave exactly as when done by hand).
 *
 * One stock register: trackers are also kept in Stock & movements (Device Inventory). After every save, each touched
 * tracker gets the matching status / place there with one movement naming the document (InventoryLinkService), and a
 * sale may use trackers received in Stock & movements (they are first brought into the store by an adjustment).
 *
 * Who: the platform (Super Admin) sees everything; a reseller (partner) sees its own documents, sales made to it, and
 * its own store. Other companies get 403.
 */
export const STOCK_DIR = join(APP_ROOT, 'var', 'stock');
const MAX_FILE = 10 * 1024 * 1024;
const FILE_TYPES: Record<string, { ext: string; sig: (b: Buffer) => boolean }> = {
  'image/jpeg': { ext: 'jpg', sig: (b) => b[0] === 0xff && b[1] === 0xd8 },
  'image/png': { ext: 'png', sig: (b) => b.subarray(0, 4).toString('hex') === '89504e47' },
  'image/webp': { ext: 'webp', sig: (b) => b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP' },
  'application/pdf': { ext: 'pdf', sig: (b) => b.subarray(0, 4).toString() === '%PDF' },
};

export interface UploadedStockFile {
  buffer: Buffer;
  mimetype?: string;
  originalname?: string;
}

/** The caller's side: the platform or one reseller. */
export type StockScope = { kind: 'PLATFORM' } | { kind: 'PARTNER'; partnerId: string; partnerName: string };

const MAIN_STORE = 'Main store';
const DAMAGED_SHELF = 'Damaged shelf';

type Tx = Prisma.TransactionClient;
const DOC_INCLUDE = { lines: { orderBy: { sort: 'asc' }, include: { item: true } }, files: { orderBy: { createdAt: 'asc' } }, supplier: true } as const;
type DocRow = Prisma.StockDocGetPayload<{ include: typeof DOC_INCLUDE }>;

const today = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);

@Injectable()
export class StockService {
  private readonly log = new Logger(StockService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly devices: AdminDevicesService,
    private readonly link: InventoryLinkService,
  ) {}

  // ───────────── who ─────────────

  async scope(ctx: AuthContext): Promise<StockScope> {
    if (ctx.isSuperAdmin) return { kind: 'PLATFORM' };
    const p = await this.prisma.partner.findUnique({ where: { homeCompanyId: ctx.homeCompanyId }, select: { id: true, name: true } });
    if (!p) throw new ForbiddenException('Stock is available to the platform and its resellers only');
    return { kind: 'PARTNER', partnerId: p.id, partnerName: p.name };
  }

  private async platformOnly(ctx: AuthContext): Promise<void> {
    if ((await this.scope(ctx)).kind !== 'PLATFORM') throw new ForbiddenException('Only the platform can change this');
  }

  // ───────────── stores ─────────────

  /** Main store and damaged shelf always exist; each reseller gets its store on first use. */
  private async baseLocations(db: Tx | PrismaService = this.prisma): Promise<{ main: string; damaged: string }> {
    const ensure = async (name: string, kind: StockStoreKind) => (await db.stockStore.findUnique({ where: { name } })) ?? db.stockStore.create({ data: { name, kind } });
    const [main, damaged] = [await ensure(MAIN_STORE, 'STORE'), await ensure(DAMAGED_SHELF, 'DAMAGED')];
    return { main: main.id, damaged: damaged.id };
  }

  private async partnerLocation(partnerId: string, db: Tx | PrismaService = this.prisma): Promise<string> {
    const found = await db.stockStore.findUnique({ where: { partnerId } });
    if (found) return found.id;
    const p = await db.partner.findUnique({ where: { id: partnerId }, select: { name: true } });
    if (!p) throw new BadRequestException('Reseller not found');
    let name = `${p.name} store`;
    if (await db.stockStore.findUnique({ where: { name } })) name = `${p.name} store (${partnerId.slice(0, 4)})`;
    return (await db.stockStore.create({ data: { name, kind: 'PARTNER', partnerId } })).id;
  }

  async locations(ctx: AuthContext): Promise<StockStoreDto[]> {
    const s = await this.scope(ctx);
    await this.baseLocations();
    if (s.kind === 'PARTNER') await this.partnerLocation(s.partnerId);
    const rows = await this.prisma.stockStore.findMany({ where: s.kind === 'PARTNER' ? { partnerId: s.partnerId } : {}, orderBy: [{ kind: 'desc' }, { name: 'asc' }] });
    return rows.map((r) => ({ id: r.id, name: r.name, kind: r.kind as StockStoreKind, partnerId: r.partnerId, isActive: r.isActive }));
  }

  private async locationAllowed(s: StockScope, locationId: string | null | undefined, db: Tx | PrismaService = this.prisma): Promise<string> {
    if (s.kind === 'PARTNER') {
      const own = await this.partnerLocation(s.partnerId, db);
      if (locationId && locationId !== own) throw new ForbiddenException('Resellers work from their own store');
      return own;
    }
    if (!locationId) return (await this.baseLocations(db)).main;
    if (!(await db.stockStore.findUnique({ where: { id: locationId } }))) throw new BadRequestException('Store not found');
    return locationId;
  }

  // ───────────── items, prices, suppliers ─────────────

  async items(ctx: AuthContext): Promise<StockItemDto[]> {
    await this.scope(ctx);
    const rows = await this.prisma.stockItem.findMany({ orderBy: [{ isActive: 'desc' }, { name: 'asc' }], include: { deviceModel: { select: { brand: true, model: true } } } });
    const stores = await this.prisma.stockStore.findMany({ where: { kind: { not: 'DAMAGED' } }, select: { id: true } });
    const sums = await this.prisma.stockMove.groupBy({ by: ['itemId'], where: { locationId: { in: stores.map((s) => s.id) } }, _sum: { qty: true } });
    const on = new Map(sums.map((x) => [x.itemId, x._sum.qty ?? 0]));
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      kind: r.kind as StockItemKind,
      deviceModelId: r.deviceModelId,
      deviceModelName: r.deviceModel ? `${r.deviceModel.brand} ${r.deviceModel.model}` : null,
      sku: r.sku,
      hsnCode: r.hsnCode,
      gstRatePct: r.gstRatePct,
      unit: r.unit,
      serialTracked: r.serialTracked,
      salePricePaise: r.salePricePaise,
      purchasePricePaise: r.purchasePricePaise,
      lowStockAt: r.lowStockAt,
      reorderQty: r.reorderQty,
      isActive: r.isActive,
      onHand: on.get(r.id) ?? 0,
    }));
  }

  async saveItem(ctx: AuthContext, id: string | null, b: Omit<StockItemDto, 'id' | 'onHand' | 'deviceModelName'>): Promise<StockItemDto> {
    await this.platformOnly(ctx);
    if (!b.name?.trim()) throw new BadRequestException('Enter the item name');
    if (b.kind === 'DEVICE' && !b.deviceModelId) throw new BadRequestException('Choose the tracker model for a device item');
    const data = {
      name: b.name.trim(),
      kind: b.kind,
      deviceModelId: b.kind === 'DEVICE' ? b.deviceModelId : null,
      sku: b.sku?.trim() || null,
      hsnCode: b.hsnCode?.trim() ?? '',
      gstRatePct: b.gstRatePct ?? 18,
      unit: b.unit?.trim() || 'pcs',
      // Devices and SIMs are always tracked one by one.
      serialTracked: b.kind === 'ACCESSORY' ? !!b.serialTracked : true,
      salePricePaise: Math.max(0, Math.round(b.salePricePaise ?? 0)),
      purchasePricePaise: Math.max(0, Math.round(b.purchasePricePaise ?? 0)),
      lowStockAt: b.lowStockAt ?? null,
      reorderQty: b.reorderQty ?? null,
      isActive: b.isActive ?? true,
    };
    try {
      const before = id ? await this.prisma.stockItem.findUnique({ where: { id } }) : null;
      if (id && !before) throw new NotFoundException('Item not found');
      const row = id ? await this.prisma.stockItem.update({ where: { id }, data }) : await this.prisma.stockItem.create({ data });
      await this.audit.record(ctx, { action: id ? 'UPDATE' : 'CREATE', entity: 'StockItem', entityId: row.id, before: before ?? undefined, after: row });
      return (await this.items(ctx)).find((x) => x.id === row.id)!;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new BadRequestException('An item with this name already exists');
      throw e;
    }
  }

/** One reorder level (and optional order quantity) for every item of a kind, e.g. all devices. */
  async setReorderLevel(ctx: AuthContext, b: { kind: StockItemKind; lowStockAt: number | null; reorderQty?: number | null }): Promise<StockItemDto[]> {
    await this.platformOnly(ctx);
    const res = await this.prisma.stockItem.updateMany({ where: { kind: b.kind }, data: { lowStockAt: b.lowStockAt, ...(b.reorderQty !== undefined ? { reorderQty: b.reorderQty } : {}) } });
    await this.audit.record(ctx, { action: 'UPDATE', entity: 'StockItem', entityId: null, after: { ...b, items: res.count } });
    return this.items(ctx);
  }

  async prices(ctx: AuthContext, itemId: string): Promise<StockPriceDto[]> {
    await this.platformOnly(ctx);
    const rows = await this.prisma.stockPrice.findMany({ where: { itemId } });
    const [partners, companies] = await Promise.all([
      this.prisma.partner.findMany({ where: { id: { in: rows.map((r) => r.partnerId).filter((x): x is string => !!x) } }, select: { id: true, name: true } }),
      this.prisma.company.findMany({ where: { id: { in: rows.map((r) => r.companyId).filter((x): x is string => !!x) } }, select: { id: true, name: true } }),
    ]);
    const name = new Map([...partners, ...companies].map((x) => [x.id, x.name]));
    return rows.map((r) => ({ id: r.id, itemId: r.itemId, partnerId: r.partnerId, companyId: r.companyId, forName: name.get(r.partnerId ?? r.companyId ?? '') ?? '—', pricePaise: r.pricePaise }));
  }

  /** Set (or with pricePaise null, remove) a special price for one reseller or customer company. */
  async setPrice(ctx: AuthContext, b: { itemId: string; partnerId?: string | null; companyId?: string | null; pricePaise: number | null }): Promise<StockPriceDto[]> {
    await this.platformOnly(ctx);
    if (!!b.partnerId === !!b.companyId) throw new BadRequestException('Choose a reseller or a customer');
    const where = { itemId: b.itemId, partnerId: b.partnerId ?? null, companyId: b.companyId ?? null };
    const found = await this.prisma.stockPrice.findFirst({ where });
    if (b.pricePaise === null) {
      if (found) await this.prisma.stockPrice.delete({ where: { id: found.id } });
    } else if (found) await this.prisma.stockPrice.update({ where: { id: found.id }, data: { pricePaise: Math.max(0, Math.round(b.pricePaise)) } });
    else await this.prisma.stockPrice.create({ data: { ...where, pricePaise: Math.max(0, Math.round(b.pricePaise)) } });
    await this.audit.record(ctx, { action: 'UPDATE', entity: 'StockPrice', entityId: b.itemId, after: b });
    return this.prices(ctx, b.itemId);
  }

  /** Selling price for a buyer: customer special price, else reseller price, else the item's price. */
  async priceFor(ctx: AuthContext, itemId: string, buyer: { partnerId?: string | null; companyId?: string | null }): Promise<{ pricePaise: number }> {
    await this.scope(ctx);
    const item = await this.prisma.stockItem.findUnique({ where: { id: itemId } });
    if (!item) throw new NotFoundException('Item not found');
    const special = await this.prisma.stockPrice.findMany({ where: { itemId, OR: [buyer.companyId ? { companyId: buyer.companyId } : { id: '00000000-0000-0000-0000-000000000000' }, buyer.partnerId ? { partnerId: buyer.partnerId } : { id: '00000000-0000-0000-0000-000000000000' }] } });
    const pick = special.find((p) => p.companyId && p.companyId === buyer.companyId) ?? special.find((p) => p.partnerId && p.partnerId === buyer.partnerId);
    return { pricePaise: pick?.pricePaise ?? item.salePricePaise };
  }

  async suppliers(ctx: AuthContext): Promise<StockSupplierDto[]> {
    await this.platformOnly(ctx);
    const rows = await this.prisma.stockSupplier.findMany({ orderBy: [{ isActive: 'desc' }, { name: 'asc' }] });
    return rows.map(({ createdAt: _c, updatedAt: _u, ...r }) => r);
  }

  async saveSupplier(ctx: AuthContext, id: string | null, b: Omit<StockSupplierDto, 'id'>): Promise<StockSupplierDto> {
    await this.platformOnly(ctx);
    if (!b.name?.trim()) throw new BadRequestException('Enter the supplier name');
    const data = { ...b, name: b.name.trim(), gstin: b.gstin?.trim().toUpperCase() || null };
    try {
      const before = id ? await this.prisma.stockSupplier.findUnique({ where: { id } }) : null;
      if (id && !before) throw new NotFoundException('Supplier not found');
      const row = id ? await this.prisma.stockSupplier.update({ where: { id }, data }) : await this.prisma.stockSupplier.create({ data });
      await this.audit.record(ctx, { action: id ? 'UPDATE' : 'CREATE', entity: 'Supplier', entityId: row.id, before: before ?? undefined, after: row });
      const { createdAt: _c, updatedAt: _u, ...dto } = row;
      return dto;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new BadRequestException('A supplier with this name already exists');
      throw e;
    }
  }

  // ───────────── documents ─────────────

  private docWhere(s: StockScope): Prisma.StockDocWhereInput {
    if (s.kind === 'PLATFORM') return {};
    // A reseller sees what it raised and what the platform sold to it.
    return { OR: [{ partnerId: s.partnerId }, { customerPartnerId: s.partnerId }] };
  }

  async listDocs(ctx: AuthContext, q: { kind?: StockDocKind; status?: string; search?: string; from?: string; to?: string; inbox?: boolean }): Promise<StockDocDto[]> {
    const s = await this.scope(ctx);
    const and: Prisma.StockDocWhereInput[] = [this.docWhere(s)];
    if (q.inbox) and.push({ kind: 'PO', toPlatform: true, status: { in: ['OPEN', 'PARTIAL'] } });
    else if (q.kind) and.push({ kind: q.kind });
    if (q.status) and.push({ status: q.status });
    if (q.from) and.push({ docDate: { gte: q.from } });
    if (q.to) and.push({ docDate: { lte: q.to } });
    if (q.search?.trim()) {
      const t = q.search.trim();
      and.push({ OR: [{ number: { contains: t, mode: 'insensitive' } }, { customerName: { contains: t, mode: 'insensitive' } }, { supplierInvoiceNo: { contains: t, mode: 'insensitive' } }, { lines: { some: { serials: { has: t.toUpperCase() } } } }] });
    }
    const rows = await this.prisma.stockDoc.findMany({ where: { AND: and }, include: DOC_INCLUDE, orderBy: [{ docDate: 'desc' }, { createdAt: 'desc' }], take: 300 });
    return this.toDtos(rows, false);
  }

  async getDoc(ctx: AuthContext, id: string): Promise<StockDocDto> {
    const s = await this.scope(ctx);
    const row = await this.prisma.stockDoc.findFirst({ where: { AND: [{ id }, this.docWhere(s)] }, include: DOC_INCLUDE });
    if (!row) throw new NotFoundException('Document not found');
    return (await this.toDtos([row], true))[0];
  }

  /** Next number of a series inside the saving transaction (row lock until commit: gap-free, no duplicates). */
  private async nextSeq(tx: Tx, key: string): Promise<number> {
    const rows = await tx.$queryRaw<{ lastSeq: number }[]>`
      INSERT INTO "StockCounter" ("key", "lastSeq") VALUES (${key}, 1)
      ON CONFLICT ("key") DO UPDATE SET "lastSeq" = "StockCounter"."lastSeq" + 1
      RETURNING "lastSeq"`;
    return Number(rows[0].lastSeq);
  }

  async saveDoc(ctx: AuthContext, id: string | null, input: StockDocInput): Promise<StockDocDto> {
    const s = await this.scope(ctx);
    const before = id ? await this.prisma.stockDoc.findFirst({ where: { AND: [{ id }, this.docWhere(s)] }, include: DOC_INCLUDE }) : null;
    if (id && !before) throw new NotFoundException('Document not found');
    if (before && s.kind === 'PARTNER' && before.partnerId !== s.partnerId) throw new ForbiddenException('Only the platform can change this document');
    const kind = (before?.kind as StockDocKind | undefined) ?? input.kind;
    // A reseller's purchase order always goes to VeeTrax (suppliers are the platform's).
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.docDate ?? '')) throw new BadRequestException('Choose the date');
    if (!input.lines?.length) throw new BadRequestException('Add at least one item');
    const status = this.statusFor(kind, input.status);

    const items = new Map((await this.prisma.stockItem.findMany({ where: { id: { in: input.lines.map((l) => l.itemId) } } })).map((i) => [i.id, i]));
    const lines = input.lines.map((l, i) => {
      const item = items.get(l.itemId);
      if (!item) throw new BadRequestException('One of the items no longer exists');
      const serials = item.serialTracked ? cleanSerials(l.serials ?? []) : [];
      const qty = item.serialTracked && !PLAN_ONLY.includes(kind) ? serials.length : Math.round(l.qty ?? 0);
      if (!qty) throw new BadRequestException(item.serialTracked && !PLAN_ONLY.includes(kind) ? `Enter the IMEI / numbers for ${item.name}` : `Enter the quantity for ${item.name}`);
      if (kind !== 'ADJUSTMENT' && qty < 0) throw new BadRequestException('Quantities must be positive');
      return { itemId: item.id, qty, ratePaise: Math.max(0, Math.round(l.ratePaise ?? 0)), gstRatePct: l.gstRatePct ?? item.gstRatePct, serials, condition: (l.condition === 'DAMAGED' ? 'DAMAGED' : 'OK') as 'OK' | 'DAMAGED', note: (l.note ?? '').slice(0, 300), sort: i, serialTracked: item.serialTracked, isDevice: item.kind === 'DEVICE' };
    });

    const saleTo: StockSaleTo | null = kind === 'SALE' ? (input.saleTo ?? 'CUSTOMER') : null;
    if (kind === 'SALE' && saleTo === 'PARTNER' && (!input.customerPartnerId || s.kind !== 'PLATFORM')) throw new BadRequestException('Choose the reseller (only the platform sells to resellers)');
    if ((kind === 'RECEIPT' || kind === 'PURCHASE_RETURN') && s.kind === 'PLATFORM' && !input.supplierId && !input.sourceId) throw new BadRequestException('Choose the supplier');
    const totalPaise = lines.reduce((t, l) => t + Math.abs(l.qty) * l.ratePaise, 0);
    if (kind === 'SALE' && status === 'DONE' && s.kind === 'PLATFORM') await this.bringInFromRegister(ctx, input, lines, items, before?.id ?? null);

    const result = await this.prisma.$transaction(
      async (tx) => {
        const base = await this.baseLocations(tx);
        const locationId = await this.locationAllowed(s, input.locationId ?? (kind === 'PURCHASE_RETURN' && s.kind === 'PLATFORM' ? base.damaged : null), tx);
        const partnerLocationId = saleTo === 'PARTNER' && input.customerPartnerId ? await this.partnerLocation(input.customerPartnerId, tx) : null;
        const fy = before?.fy ?? fyOf(input.docDate);
        const seq = before?.seq ?? (await this.nextSeq(tx, `${STOCK_DOC_PREFIX[kind]}:${fy}`));
        const data = {
          status,
          docDate: input.docDate,
          supplierId: s.kind === 'PARTNER' && kind === 'PO' ? null : (input.supplierId ?? null),
          toPlatform: kind === 'PO' && s.kind === 'PARTNER',
          saleTo,
          customerCompanyId: input.customerCompanyId ?? null,
          customerPartnerId: saleTo === 'PARTNER' || kind === 'ORDER' ? (input.customerPartnerId ?? null) : null,
          customerName: (input.customerName ?? '').trim(),
          customerPhone: (input.customerPhone ?? '').trim(),
          customerEmail: (input.customerEmail ?? '').trim(),
          customerGstin: input.customerGstin?.trim().toUpperCase() || null,
          customerStateCode: input.customerStateCode ?? '',
          customerAddress: (input.customerAddress ?? '').trim(),
          locationId,
          sourceId: input.sourceId ?? null,
          channel: input.channel ?? null,
          supplierInvoiceNo: (input.supplierInvoiceNo ?? '').trim(),
          supplierInvoiceDate: input.supplierInvoiceDate ?? null,
          supplierInvoiceAmountPaise: input.supplierInvoiceAmountPaise ?? null,
          reason: (input.reason ?? '').trim(),
          notes: (input.notes ?? '').trim(),
          totalPaise,
          updatedById: ctx.userId,
        };
        const doc = before
          ? await tx.stockDoc.update({ where: { id: before.id }, data })
          : await tx.stockDoc.create({ data: { ...data, kind, fy, seq, number: `${STOCK_DOC_PREFIX[kind]}/${fy}/${String(seq).padStart(4, '0')}`, partnerId: s.kind === 'PARTNER' ? s.partnerId : null, createdById: ctx.userId } });
        await tx.stockDocLine.deleteMany({ where: { docId: doc.id } });
        await tx.stockDocLine.createMany({ data: lines.map(({ serialTracked: _s, isDevice: _d, ...l }) => ({ ...l, docId: doc.id })) });

        // Rewrite this document's moves, after checking them against everything else.
        const oldMoves = await tx.stockMove.findMany({ where: { docId: doc.id } });
        await tx.stockMove.deleteMany({ where: { docId: doc.id } });
        const planned = planMoves({ kind, status, saleTo, locationId }, lines, { damagedLocationId: base.damaged, partnerLocationId });
        if (planned.length) {
          const errors = await this.check(tx, kind, planned);
          if (errors.length) throw new BadRequestException(errors.slice(0, 8).join(' '));
          // Moves are dated by when the document was first made, so editing an old one keeps the order of events.
          const t0 = doc.createdAt.getTime();
          await tx.stockMove.createMany({ data: planned.map((m, i) => ({ docId: doc.id, itemId: m.itemId, locationId: m.locationId, qty: m.qty, serial: m.serial, effect: m.effect, at: new Date(t0 + i) })) });
        }
        // Taking back goods this document brought in is only possible while nothing later used them: an IMEI moved on
        // by another document, or a counted item whose store would go below zero.
        const stillIn = new Set(planned.filter((m) => m.serial && m.qty > 0).map((m) => `${m.itemId}|${m.serial}|${m.locationId}`));
        const blocked: string[] = [];
        for (const m of oldMoves) {
          if (!m.serial || m.qty <= 0 || stillIn.has(`${m.itemId}|${m.serial}|${m.locationId}`)) continue;
          const later = await tx.stockMove.findFirst({ where: { itemId: m.itemId, serial: m.serial, at: { gt: m.at }, docId: { not: doc.id } }, include: { doc: { select: { number: true } } } });
          if (later) blocked.push(`${m.serial} was used later in ${later.doc.number}; change or cancel that first.`);
        }
        const keys = new Map<string, { itemId: string; locationId: string | null }>();
        for (const m of [...oldMoves, ...planned]) if (!m.serial) keys.set(`${m.itemId}|${m.locationId}`, { itemId: m.itemId, locationId: m.locationId });
        for (const k of keys.values()) {
          const sum = await tx.stockMove.aggregate({ where: { itemId: k.itemId, locationId: k.locationId }, _sum: { qty: true } });
          if ((sum._sum.qty ?? 0) < 0) {
            const item = await tx.stockItem.findUnique({ where: { id: k.itemId }, select: { name: true } });
            blocked.push(`${item?.name ?? 'An item'} would go below zero: some of it was already sold or moved.`);
          }
        }
        if (blocked.length) throw new BadRequestException(blocked.slice(0, 6).join(' '));
        const touched = new Map<string, { itemId: string; serial: string }>();
        for (const m of [...oldMoves, ...planned]) if (m.serial) touched.set(`${m.itemId}|${m.serial}`, { itemId: m.itemId, serial: m.serial });
        await this.refreshSerials(tx, [...touched.values()]);
        if (doc.sourceId) await this.refreshPlan(tx, doc.sourceId);
        if (before?.sourceId && before.sourceId !== doc.sourceId) await this.refreshPlan(tx, before.sourceId);
        return { doc, touched: [...touched.values()] };
      },
      { timeout: 30_000 },
    );
    await this.audit.record(ctx, { action: id ? 'UPDATE' : 'CREATE', entity: 'StockDoc', entityId: result.doc.id, before: before ? this.auditView(before) : undefined, after: { number: result.doc.number, status, lines: lines.map((l) => ({ itemId: l.itemId, qty: l.qty, serials: l.serials })) } });
    await this.syncDevices(ctx, result.touched);
    await this.link.reconcile(ctx, result.touched);
    return this.getDoc(ctx, result.doc.id);
  }

  /**
   * A sale of trackers that are in stock in Stock & movements but were never received in Purchases & sales (received
   * there, or before this module): bring them into the selling store first with one adjustment, so the sale can take
   * them. Their place in Stock & movements then follows the sale like any other tracker.
   */
  private async bringInFromRegister(ctx: AuthContext, input: StockDocInput, lines: { itemId: string; serials: string[] }[], items: Map<string, { id: string; kind: string; deviceModelId: string | null }>, editingId: string | null): Promise<void> {
    const bring: { itemId: string; serials: string[] }[] = [];
    for (const l of lines) {
      const item = items.get(l.itemId);
      if (item?.kind !== 'DEVICE' || !item.deviceModelId || !l.serials.length) continue;
      // IMEIs this sale already holds (when editing it) are known to Purchases & sales: onlyInRegister skips them.
      const extra = await this.link.onlyInRegister(item.deviceModelId, l.serials);
      if (extra.length) bring.push({ itemId: l.itemId, serials: extra });
    }
    if (!bring.length) return;
    await this.saveDoc(ctx, null, {
      kind: 'ADJUSTMENT',
      status: 'DONE',
      docDate: input.docDate,
      locationId: input.locationId ?? null,
      reason: `Brought in from Stock & movements for a sale${editingId ? ' (edited)' : ''}: already in stock there`,
      lines: bring.map((b) => ({ itemId: b.itemId, qty: b.serials.length, ratePaise: 0, serials: b.serials })) as StockDocInput['lines'],
    });
  }

  /** Super Admin: check (dry run) or repair the tracker states in Stock & movements from Purchases & sales. */
  async syncRegister(ctx: AuthContext, dryRun: boolean): Promise<{ checked: number; changes: LinkResult[] }> {
    await this.platformOnly(ctx);
    return this.link.syncAll(ctx, dryRun);
  }

  /** Allowed statuses: plans (PO / order) are DRAFT, OPEN or CANCELLED (PARTIAL / DONE follow their receipts / sales). */
  private statusFor(kind: StockDocKind, want: string): StockDocStatus {
    if (want === 'CANCELLED' || want === 'DRAFT') return want;
    return PLAN_ONLY.includes(kind) ? 'OPEN' : 'DONE';
  }

  private auditView(d: DocRow) {
    return { number: d.number, status: d.status, lines: d.lines.map((l) => ({ itemId: l.itemId, qty: l.qty, serials: l.serials })) };
  }

  /** checkMoves with current stock read from the ledger (this document's moves were already removed). */
  private async check(tx: Tx, kind: StockDocKind, planned: PlannedMove[]): Promise<string[]> {
    const serials = planned.filter((m) => m.serial);
    const serialRows = serials.length ? await tx.stockSerial.findMany({ where: { OR: serials.map((m) => ({ itemId: m.itemId, serial: m.serial! })) } }) : [];
    // A serial's state from its latest remaining move (the serial row may still reflect this document).
    const latest = new Map<string, SerialNow>();
    for (const r of serialRows) {
      const mv = await tx.stockMove.findFirst({ where: { itemId: r.itemId, serial: r.serial }, orderBy: [{ at: 'desc' }, { id: 'desc' }] });
      if (mv) latest.set(`${r.itemId}|${r.serial}`, { status: mv.effect as StockSerialStatus, locationId: mv.qty > 0 ? mv.locationId : null });
    }
    const counted = planned.filter((m) => !m.serial && m.qty < 0);
    const sums = counted.length ? await tx.stockMove.groupBy({ by: ['itemId', 'locationId'], where: { OR: counted.map((m) => ({ itemId: m.itemId, locationId: m.locationId })) }, _sum: { qty: true } }) : [];
    const have = new Map(sums.map((x) => [`${x.itemId}|${x.locationId}`, x._sum.qty ?? 0]));
    const ids = [...new Set(planned.map((m) => m.itemId))];
    const itemNames = new Map((await tx.stockItem.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })).map((i) => [i.id, i.name]));
    const locNames = new Map((await tx.stockStore.findMany({ select: { id: true, name: true } })).map((l) => [l.id, l.name]));
    return checkMoves(kind, planned, (i, s) => latest.get(`${i}|${s}`), (i, l) => have.get(`${i}|${l}`) ?? 0, { item: (i) => itemNames.get(i) ?? 'item', location: (l) => (l ? (locNames.get(l) ?? 'store') : 'outside stock') });
  }

  /** IMEI rows follow their latest move (or disappear when no move is left, e.g. a receipt was deleted). */
  private async refreshSerials(tx: Tx, keys: { itemId: string; serial: string }[]): Promise<void> {
    for (const k of keys) {
      const mv = await tx.stockMove.findFirst({ where: { itemId: k.itemId, serial: k.serial }, orderBy: [{ at: 'desc' }, { id: 'desc' }], include: { doc: { select: { id: true, customerCompanyId: true, customerPartnerId: true, saleTo: true } } } });
      if (!mv) {
        await tx.stockSerial.deleteMany({ where: { itemId: k.itemId, serial: k.serial } });
        continue;
      }
      const data = {
        status: mv.effect,
        locationId: mv.qty > 0 ? mv.locationId : null,
        customerCompanyId: mv.effect === 'SOLD' ? mv.doc.customerCompanyId : null,
        customerPartnerId: mv.effect === 'SOLD' && mv.doc.saleTo === 'PARTNER' ? mv.doc.customerPartnerId : null,
        lastDocId: mv.doc.id,
      };
      await tx.stockSerial.upsert({ where: { itemId_serial: { itemId: k.itemId, serial: k.serial } }, create: { itemId: k.itemId, serial: k.serial, ...data }, update: data });
    }
  }

  /** PO / order status from its DONE follow-ups (receipts for a PO; sales for an order or a reseller's PO). */
  private async refreshPlan(tx: Tx, planId: string): Promise<void> {
    const plan = await tx.stockDoc.findUnique({ where: { id: planId }, include: { lines: true } });
    if (!plan || !PLAN_ONLY.includes(plan.kind as StockDocKind) || plan.status === 'CANCELLED' || plan.status === 'DRAFT') return;
    const follow = await tx.stockDoc.findMany({ where: { sourceId: planId, status: 'DONE', kind: { in: ['RECEIPT', 'SALE'] } }, include: { lines: true } });
    const { status } = planStatus(plan.lines, follow.flatMap((f) => f.lines.map((l) => ({ itemId: l.itemId, qty: l.qty }))));
    if (status !== plan.status) await tx.stockDoc.update({ where: { id: planId }, data: { status } });
  }

  /**
   * Trackers follow their IMEI: received → created in Device Inventory (no company); sold to a customer company →
   * assigned to it; back in stock (return, edit, cancel) → no company. Problems are logged, never block the stock entry.
   */
  private async syncDevices(ctx: AuthContext, touched: { itemId: string; serial: string }[]): Promise<void> {
    if (!touched.length) return;
    const items = new Map((await this.prisma.stockItem.findMany({ where: { id: { in: [...new Set(touched.map((t) => t.itemId))] }, kind: 'DEVICE' } })).map((i) => [i.id, i]));
    for (const t of touched) {
      const item = items.get(t.itemId);
      if (!item?.deviceModelId) continue;
      try {
        const serial = await this.prisma.stockSerial.findUnique({ where: { itemId_serial: { itemId: t.itemId, serial: t.serial } } });
        const device = await this.prisma.device.findFirst({ where: { uniqueId: t.serial } });
        const inStock = serial && ['IN_STOCK', 'DAMAGED', 'WITH_SUPPLIER', 'SCRAPPED'].includes(serial.status);
        const want = serial?.status === 'SOLD' && serial.customerCompanyId ? serial.customerCompanyId : inStock ? null : undefined;
        if (!device) {
          if (serial) await this.devices.create(ctx, { modelId: item.deviceModelId, uniqueId: t.serial, companyId: want ?? null } as never);
        } else if (want !== undefined && device.companyId !== want) {
          await this.devices.update(ctx, device.id, { companyId: want } as never);
        }
      } catch (e) {
        this.log.warn(`Device sync for ${t.serial}: ${(e as Error).message}`);
      }
    }
  }

  async deleteDoc(ctx: AuthContext, id: string): Promise<{ ok: true }> {
    const s = await this.scope(ctx);
    const doc = await this.prisma.stockDoc.findFirst({ where: { AND: [{ id }, this.docWhere(s)] }, include: { lines: true } });
    if (!doc) throw new NotFoundException('Document not found');
    if (doc.status !== 'DRAFT' && doc.status !== 'CANCELLED') throw new BadRequestException('Only drafts and cancelled documents can be deleted; cancel it first');
    if (await this.prisma.stockInvoice.findUnique({ where: { docId: id } })) throw new BadRequestException('This document has an invoice; it can not be deleted');
    await this.prisma.stockDoc.delete({ where: { id } });
    await this.audit.record(ctx, { action: 'DELETE', entity: 'StockDoc', entityId: id, before: { number: doc.number, status: doc.status } });
    return { ok: true };
  }

  // ───────────── files ─────────────

  async attach(ctx: AuthContext, docId: string, file: UploadedStockFile | undefined): Promise<StockDocDto> {
    await this.getDoc(ctx, docId);
    if (!file?.buffer?.length) throw new BadRequestException('Choose a file');
    if (file.buffer.length > MAX_FILE) throw new BadRequestException('The file is larger than 10 MB');
    const type = FILE_TYPES[(file.mimetype ?? '').toLowerCase()];
    if (!type || !type.sig(file.buffer)) throw new BadRequestException('Upload a PDF or a photo (JPEG, PNG, WebP)');
    await mkdir(STOCK_DIR, { recursive: true });
    const path = join(STOCK_DIR, `${docId}-${randomUUID()}.${type.ext}`);
    await writeFile(path, file.buffer);
    const name = (file.originalname ?? `file.${type.ext}`).replace(/[^\w.\- ]+/g, '_').slice(0, 120);
    await this.prisma.stockFile.create({ data: { docId, fileName: name, filePath: path, fileType: (file.mimetype ?? '').toLowerCase(), fileSize: file.buffer.length, uploadedById: ctx.userId } });
    await this.audit.record(ctx, { action: 'UPDATE', entity: 'StockDoc', entityId: docId, after: { fileAdded: name } });
    return this.getDoc(ctx, docId);
  }

  async file(ctx: AuthContext, fileId: string): Promise<StreamableFile> {
    const f = await this.prisma.stockFile.findUnique({ where: { id: fileId } });
    if (!f) throw new NotFoundException('File not found');
    await this.getDoc(ctx, f.docId);
    const info = await stat(f.filePath).catch(() => null);
    if (!info) throw new NotFoundException('The file no longer exists');
    return new StreamableFile(createReadStream(f.filePath), { type: f.fileType, length: info.size, disposition: `inline; filename="${f.fileName}"` });
  }

  async removeFile(ctx: AuthContext, fileId: string): Promise<StockDocDto> {
    const f = await this.prisma.stockFile.findUnique({ where: { id: fileId } });
    if (!f) throw new NotFoundException('File not found');
    await this.getDoc(ctx, f.docId);
    await this.prisma.stockFile.delete({ where: { id: fileId } });
    await unlink(f.filePath).catch(() => undefined);
    await this.audit.record(ctx, { action: 'UPDATE', entity: 'StockDoc', entityId: f.docId, after: { fileRemoved: f.fileName } });
    return this.getDoc(ctx, f.docId);
  }

  // ───────────── stock on hand, IMEI lookup ─────────────

  async onHand(ctx: AuthContext): Promise<StockOnHandRow[]> {
    const s = await this.scope(ctx);
    const locs = await this.locations(ctx);
    const sums = await this.prisma.stockMove.groupBy({ by: ['itemId', 'locationId'], where: { locationId: { in: locs.map((l) => l.id) } }, _sum: { qty: true } });
    const items = new Map((await this.prisma.stockItem.findMany()).map((i) => [i.id, i]));
    const locBy = new Map(locs.map((l) => [l.id, l]));
    const rows: StockOnHandRow[] = [];
    for (const x of sums) {
      const item = items.get(x.itemId);
      const loc = x.locationId ? locBy.get(x.locationId) : undefined;
      if (!item || !loc || !(x._sum.qty ?? 0)) continue;
      rows.push({ itemId: item.id, itemName: item.name, kind: item.kind as StockItemKind, unit: item.unit, locationId: loc.id, locationName: loc.name, locationKind: loc.kind, qty: x._sum.qty ?? 0, lowStockAt: item.lowStockAt });
    }
    void s;
    return rows.sort((a, b) => a.itemName.localeCompare(b.itemName) || a.locationName.localeCompare(b.locationName));
  }

  /** IMEIs / SIM numbers in a store right now (to pick from when selling or returning). */
  async availableSerials(ctx: AuthContext, itemId: string, locationId: string | null, status: 'IN_STOCK' | 'DAMAGED' | 'SOLD'): Promise<string[]> {
    const s = await this.scope(ctx);
    const where: Prisma.StockSerialWhereInput = { itemId, status };
    if (status !== 'SOLD') where.locationId = await this.locationAllowed(s, locationId);
    const rows = await this.prisma.stockSerial.findMany({ where, select: { serial: true }, orderBy: { serial: 'asc' }, take: 2000 });
    const out = rows.map((r) => r.serial);
    // Platform sales may also pick trackers received in Stock & movements at this store's place (brought in on save).
    if (s.kind === 'PLATFORM' && status === 'IN_STOCK' && where.locationId) {
      const item = await this.prisma.stockItem.findUnique({ where: { id: itemId }, select: { kind: true, deviceModelId: true } });
      if (item?.kind === 'DEVICE' && item.deviceModelId) out.push(...(await this.link.registerOnlyAt(item.deviceModelId, where.locationId as string)));
    }
    return [...new Set(out)].sort();
  }

  async serial(ctx: AuthContext, serialRaw: string): Promise<StockSerialDto[]> {
    const s = await this.scope(ctx);
    const serial = serialRaw.trim().toUpperCase();
    const rows = await this.prisma.stockSerial.findMany({ where: { serial }, include: { item: { select: { name: true } } } });
    const out: StockSerialDto[] = [];
    for (const r of rows) {
      const moves = await this.prisma.stockMove.findMany({ where: { itemId: r.itemId, serial }, orderBy: [{ at: 'asc' }, { id: 'asc' }], include: { doc: { include: { supplier: { select: { name: true } } } } } });
      if (s.kind === 'PARTNER' && !moves.some((m) => m.doc.partnerId === s.partnerId || m.doc.customerPartnerId === s.partnerId)) continue;
      const locIds = [...new Set([r.locationId, ...moves.map((m) => m.locationId)].filter((x): x is string => !!x))];
      const locNames = new Map((await this.prisma.stockStore.findMany({ where: { id: { in: locIds } }, select: { id: true, name: true } })).map((l) => [l.id, l.name]));
      const company = r.customerCompanyId ? await this.prisma.company.findUnique({ where: { id: r.customerCompanyId }, select: { name: true } }) : null;
      out.push({
        serial,
        itemId: r.itemId,
        itemName: r.item.name,
        status: r.status as StockSerialStatus,
        locationName: r.locationId ? (locNames.get(r.locationId) ?? null) : null,
        customerName: company?.name ?? null,
        history: moves.map((m) => ({ docId: m.docId, kind: m.doc.kind as StockDocKind, number: m.doc.number, docDate: m.doc.docDate, party: m.doc.supplier?.name ?? m.doc.customerName ?? '', effect: m.effect as StockSerialStatus, locationName: m.locationId ? (locNames.get(m.locationId) ?? null) : null })),
      });
    }
    return out;
  }

  // ───────────── DTOs ─────────────

  private async toDtos(rows: DocRow[], full: boolean): Promise<StockDocDto[]> {
    const ids = rows.map((r) => r.id);
    const partnerIds = [...new Set(rows.flatMap((r) => [r.partnerId, r.customerPartnerId]).filter((x): x is string => !!x))];
    const userIds = [...new Set(rows.flatMap((r) => [r.createdById, r.updatedById]).filter((x): x is string => !!x))];
    const sourceIds = [...new Set(rows.map((r) => r.sourceId).filter((x): x is string => !!x))];
    const [partners, users, locs, sources, invoices, follow] = await Promise.all([
      this.prisma.partner.findMany({ where: { id: { in: partnerIds } }, select: { id: true, name: true } }),
      this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }),
      this.prisma.stockStore.findMany({ select: { id: true, name: true } }),
      this.prisma.stockDoc.findMany({ where: { id: { in: sourceIds } }, select: { id: true, number: true } }),
      this.prisma.stockInvoice.findMany({ where: { docId: { in: ids } } }),
      full ? this.prisma.stockDoc.findMany({ where: { sourceId: { in: ids } }, include: { lines: true }, orderBy: { createdAt: 'asc' } }) : Promise.resolve([]),
    ]);
    const pName = new Map(partners.map((p) => [p.id, p.name]));
    const uName = new Map(users.map((u) => [u.id, u.name]));
    const lName = new Map(locs.map((l) => [l.id, l.name]));
    const sNum = new Map(sources.map((x) => [x.id, x.number]));
    const inv = new Map(invoices.map((i) => [i.docId, i]));
    return rows.map((r) => {
      const ups = follow.filter((f) => f.sourceId === r.id);
      const pending = PLAN_ONLY.includes(r.kind as StockDocKind)
        ? planStatus(r.lines, ups.filter((f) => f.status === 'DONE' && (f.kind === 'RECEIPT' || f.kind === 'SALE')).flatMap((f) => f.lines)).pending.map((p) => ({ ...p, itemName: r.lines.find((l) => l.itemId === p.itemId)?.item.name ?? '' }))
        : [];
      const i = inv.get(r.id);
      const files: StockFileDto[] = r.files.map((f) => ({ id: f.id, fileName: f.fileName, fileType: f.fileType, fileSize: f.fileSize, createdAt: f.createdAt.toISOString() }));
      return {
        id: r.id,
        kind: r.kind as StockDocKind,
        number: r.number,
        status: r.status as StockDocStatus,
        docDate: r.docDate,
        partnerId: r.partnerId,
        partnerName: r.partnerId ? (pName.get(r.partnerId) ?? null) : null,
        supplierId: r.supplierId,
        supplierName: r.supplier?.name ?? (r.toPlatform ? 'VeeTrax' : null),
        toPlatform: r.toPlatform,
        saleTo: r.saleTo as StockSaleTo | null,
        customerCompanyId: r.customerCompanyId,
        customerPartnerId: r.customerPartnerId,
        customerName: r.customerName || (r.customerPartnerId ? (pName.get(r.customerPartnerId) ?? '') : ''),
        customerPhone: r.customerPhone,
        customerEmail: r.customerEmail,
        customerGstin: r.customerGstin,
        customerStateCode: r.customerStateCode,
        customerAddress: r.customerAddress,
        locationId: r.locationId,
        locationName: r.locationId ? (lName.get(r.locationId) ?? null) : null,
        sourceId: r.sourceId,
        sourceNumber: r.sourceId ? (sNum.get(r.sourceId) ?? null) : null,
        channel: r.channel as StockOrderChannel | null,
        supplierInvoiceNo: r.supplierInvoiceNo,
        supplierInvoiceDate: r.supplierInvoiceDate,
        supplierInvoiceAmountPaise: r.supplierInvoiceAmountPaise,
        reason: r.reason,
        notes: r.notes,
        totalPaise: r.totalPaise,
        lines: r.lines.map((l) => ({ id: l.id, itemId: l.itemId, itemName: l.item.name, serialTracked: l.item.serialTracked, unit: l.item.unit, hsnCode: l.item.hsnCode, qty: lineQty({ serialTracked: l.item.serialTracked && !PLAN_ONLY.includes(r.kind as StockDocKind), qty: l.qty, serials: l.serials }) * (l.qty < 0 ? -1 : 1), ratePaise: l.ratePaise, gstRatePct: l.gstRatePct, serials: l.serials, condition: l.condition as 'OK' | 'DAMAGED', note: l.note })),
        files,
        followUps: ups.map((f) => ({ id: f.id, kind: f.kind as StockDocKind, number: f.number, status: f.status as StockDocStatus, docDate: f.docDate })),
        invoice: i ? { id: i.id, kind: i.kind as 'INVOICE' | 'CREDIT_NOTE', number: i.number, totalPaise: i.totalPaise, paymentStatus: i.paymentStatus } : null,
        pending,
        createdByName: r.createdById ? (uName.get(r.createdById) ?? null) : null,
        updatedByName: r.updatedById ? (uName.get(r.updatedById) ?? null) : null,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      };
    });
  }

  /** Today in India, for new documents. */
  today(): string {
    return today();
  }
}

import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  deriveDeviceStatus,
  DeviceCondition,
  DeviceStockDto,
  INVENTORY_STATUSES,
  InventoryStatus,
  StockImportReport,
  StockImportRowResult,
  StockMovementKind,
  StockSummaryDto,
  statusHoldsLocation,
  validateStatusChange,
} from '@veetracer/shared';
import { AuthContext } from '../access/auth-context';
import { AuditService } from '../audit/audit.service';
import { ListSpec, listResult, planList } from '../common/list-query';
import { AdminDevicesService } from '../masters/admin-devices/admin-devices.service';
import { CreateAdminDeviceDto } from '../masters/admin-devices/admin-devices.dto';
import { DeviceRow } from '../masters/devices/device.mapper';
import { normalizeDeviceUniqueId } from '../masters/device-unique-id';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryCatalogService } from './catalog.service';
import {
  AdjustDto,
  ChangeStatusDto,
  CreateReceiptDto,
  ImportDto,
  MovementListQuery,
  ReceiptListQuery,
  StockListQuery,
  SyncDto,
  TransferDto,
} from './inventory.dto';
import {
  dateOnly,
  DEVICE_FACTS_SELECT,
  DeviceFactsRow,
  factsOf,
  MOVEMENT_CSV,
  MOVEMENT_INCLUDE,
  RECEIPT_INCLUDE,
  STOCK_CSV,
  STOCK_INCLUDE,
  toMovementDto,
  toReceiptDto,
  toStockDto,
} from './inventory.mapper';
import { parseStockCsv, StockCsvFormatError } from './stock-csv';

type Tx = Prisma.TransactionClient;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TX_OPTIONS = { timeout: 120_000, maxWait: 10_000 };

const STOCK_LIST: ListSpec = {
  search: (q) => ({
    OR: [
      { device: { uniqueId: { contains: q } } },
      { device: { simNumber: { contains: q } } },
      { serialNumber: { contains: q, mode: 'insensitive' } },
    ],
  }),
  sort: { uniqueId: 'device.uniqueId', status: 'status', statusChangedAt: 'statusChangedAt', createdAt: 'createdAt', updatedAt: 'updatedAt' },
  defaultSort: 'uniqueId',
  status: null,
  tiebreaker: 'deviceId',
};

const MOVEMENT_LIST: ListSpec = {
  search: ['itemRef', 'reference', 'reason', 'note'],
  sort: { at: 'at', kind: 'kind', itemRef: 'itemRef' },
  defaultSort: 'at',
  defaultOrder: 'desc',
  status: null,
};

const RECEIPT_LIST: ListSpec = {
  search: ['supplierInvoiceNo', 'note'],
  sort: { receivedAt: 'receivedAt', createdAt: 'createdAt' },
  defaultSort: 'receivedAt',
  defaultOrder: 'desc',
  status: null,
};

/** Stock rows whose stored status disagrees with the real company / vehicle assignment (see isMismatch). */
const MISMATCH_WHERE: Prisma.DeviceStockWhereInput = {
  OR: [
    { status: { in: ['ASSIGNED', 'ACTIVE'] }, device: { companyId: null } },
    { status: 'ASSIGNED', device: { assignments: { some: { toTime: null } } } },
    { status: 'ACTIVE', device: { assignments: { none: { toTime: null } } } },
    { status: { in: ['IN_STOCK', 'RESERVED'] }, device: { companyId: { not: null } } },
  ],
};

/** One item of a receipt / import after validation against the database. */
export interface PlanInput {
  deviceId?: string;
  uniqueId?: string | null;
  modelId?: string | null;
  simNumber?: string | null;
  simOperator?: string | null;
  firmware?: string | null;
  serialNumber?: string | null;
  unitCostPaise?: number | null;
  warrantyUntil?: string | null;
  condition?: DeviceCondition | null;
  note?: string | null;
  /** Errors found before the database checks (CSV parsing / model lookup). */
  preErrors?: string[];
}

export interface PlannedItem {
  input: PlanInput;
  action: 'CREATE_DEVICE' | 'ADD_STOCK' | 'ERROR';
  uniqueId: string | null;
  deviceId: string | null;
  initialStatus: InventoryStatus;
  /** For CREATE_DEVICE: what goes to the Device Inventory create path (stock: never a company, never isActive). */
  createDto: CreateAdminDeviceDto | null;
  errors: string[];
}

interface MovementInput {
  deviceId: string;
  itemRef: string;
  kind: StockMovementKind;
  fromStatus: string | null;
  toStatus: string;
  fromLocationId?: string | null;
  toLocationId?: string | null;
  fromHolderPartnerId?: string | null;
  toHolderPartnerId?: string | null;
  companyId?: string | null;
  objectId?: string | null;
  partnerId?: string | null;
  receiptId?: string | null;
  reason?: string | null;
  reference?: string | null;
  note?: string | null;
  changes?: Prisma.InputJsonValue;
}

/**
 * Device stock: receipts, status / location changes, adjustments and the movement ledger.
 *
 * Licence safety: this service never writes Device.companyId / Device.isActive and never touches LicenceSeat. New
 * devices are registered through AdminDevicesService.createInTx with no company, which takes no seat. Every stock
 * change writes its StockMovement in the same transaction.
 */
@Injectable()
export class InventoryStockService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly catalog: InventoryCatalogService,
    private readonly devices: AdminDevicesService,
  ) {}

  // ───────────── Read ─────────────

  async list(query: StockListQuery) {
    const plan = planList<Prisma.DeviceStockWhereInput, Prisma.DeviceStockOrderByWithRelationInput>(query, STOCK_LIST);
    const filters: Prisma.DeviceStockWhereInput[] = [plan.where];
    if (query.stockStatus) filters.push({ status: query.stockStatus });
    if (query.locationId) filters.push({ locationId: query.locationId });
    if (query.holderPartnerId) filters.push({ holderPartnerId: query.holderPartnerId });
    if (query.receiptId) filters.push({ receiptId: query.receiptId });
    if (query.supplierId) filters.push({ receipt: { supplierId: query.supplierId } });
    if (query.modelId) filters.push({ device: { modelId: query.modelId } });
    if (query.companyId) filters.push({ device: { companyId: query.companyId } });
    if (query.mismatch) filters.push(MISMATCH_WHERE);
    const where: Prisma.DeviceStockWhereInput = { AND: filters };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.deviceStock.findMany({ where, orderBy: plan.orderBy, skip: plan.skip, take: plan.take, include: STOCK_INCLUDE }),
      this.prisma.deviceStock.count({ where }),
    ]);
    return listResult(plan, rows.map(toStockDto), total, STOCK_CSV);
  }

  async get(deviceId: string): Promise<DeviceStockDto> {
    const row = await this.prisma.deviceStock.findUnique({ where: { deviceId }, include: STOCK_INCLUDE });
    if (!row) throw new NotFoundException('This device has no stock record yet');
    return toStockDto(row);
  }

  async summary(): Promise<StockSummaryDto> {
    const [byStatus, byLocation, mismatches, untracked] = await this.prisma.$transaction([
      this.prisma.deviceStock.groupBy({ by: ['status'], orderBy: { status: 'asc' }, _count: { _all: true } }),
      this.prisma.deviceStock.groupBy({ by: ['locationId'], orderBy: { locationId: 'asc' }, _count: { _all: true } }),
      this.prisma.deviceStock.count({ where: MISMATCH_WHERE }),
      this.prisma.device.count({ where: { stock: null } }),
    ]);
    const locIds = byLocation.map((l) => l.locationId).filter((id): id is string => !!id);
    const locs = new Map((await this.prisma.stockLocation.findMany({ where: { id: { in: locIds } }, select: { id: true, code: true, name: true } })).map((l) => [l.id, l]));
    const counts = Object.fromEntries(INVENTORY_STATUSES.map((s) => [s, 0])) as Record<InventoryStatus, number>;
    for (const g of byStatus) if (g.status in counts) counts[g.status as InventoryStatus] = (g._count as { _all: number })._all;
    return {
      byStatus: counts,
      byLocation: byLocation.map((g) => ({
        locationId: g.locationId,
        code: g.locationId ? (locs.get(g.locationId)?.code ?? null) : null,
        name: g.locationId ? (locs.get(g.locationId)?.name ?? null) : null,
        count: (g._count as { _all: number })._all,
      })),
      mismatches,
      untracked,
    };
  }

  async movements(query: MovementListQuery) {
    const plan = planList<Prisma.StockMovementWhereInput, Prisma.StockMovementOrderByWithRelationInput>(query, MOVEMENT_LIST);
    const filters: Prisma.StockMovementWhereInput[] = [plan.where];
    if (query.kind) filters.push({ kind: query.kind });
    if (query.deviceId) filters.push({ deviceId: query.deviceId });
    if (query.receiptId) filters.push({ receiptId: query.receiptId });
    if (query.locationId) filters.push({ OR: [{ fromLocationId: query.locationId }, { toLocationId: query.locationId }] });
    if (query.from) filters.push({ at: { gte: new Date(query.from) } });
    if (query.to) filters.push({ at: { lte: new Date(query.to) } });
    const where: Prisma.StockMovementWhereInput = { AND: filters };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.stockMovement.findMany({ where, orderBy: plan.orderBy, skip: plan.skip, take: plan.take, include: MOVEMENT_INCLUDE }),
      this.prisma.stockMovement.count({ where }),
    ]);
    const ids = [...new Set(rows.map((r) => r.createdById).filter((id): id is string => !!id))];
    const users = new Map((await this.prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
    return listResult(plan, rows.map((r) => toMovementDto(r, users)), total, MOVEMENT_CSV);
  }

  async listReceipts(query: ReceiptListQuery) {
    const plan = planList<Prisma.StockReceiptWhereInput, Prisma.StockReceiptOrderByWithRelationInput>(query, RECEIPT_LIST);
    const filters: Prisma.StockReceiptWhereInput[] = [plan.where];
    if (query.supplierId) filters.push({ supplierId: query.supplierId });
    if (query.locationId) filters.push({ locationId: query.locationId });
    const where: Prisma.StockReceiptWhereInput = { AND: filters };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.stockReceipt.findMany({ where, orderBy: plan.orderBy, skip: plan.skip, take: plan.take, include: RECEIPT_INCLUDE }),
      this.prisma.stockReceipt.count({ where }),
    ]);
    return { items: rows.map(toReceiptDto), total, page: plan.page, pageSize: plan.pageSize };
  }

  async getReceipt(id: string) {
    const row = await this.prisma.stockReceipt.findUnique({ where: { id }, include: RECEIPT_INCLUDE });
    if (!row) throw new NotFoundException('Receipt not found');
    return toReceiptDto(row);
  }

  // ───────────── Receive ─────────────

  async createReceipt(ctx: AuthContext, dto: CreateReceiptDto) {
    await this.assertReceiptRefs(dto.locationId, dto.supplierId);
    const planned = await this.planItems(dto.items);
    const bad = planned.map((p, i) => ({ p, i })).filter(({ p }) => p.errors.length);
    if (bad.length) {
      throw new BadRequestException(
        bad
          .slice(0, 20)
          .map(({ p, i }) => `Item ${i + 1}${p.uniqueId ? ` (${p.uniqueId})` : ''}: ${p.errors.join('; ')}`)
          .join(' | '),
      );
    }
    return this.executeReceipt(ctx, dto, planned, 'MANUAL');
  }

  /**
   * CSV bulk receive. Dry-run (default) validates every row against the file and the database and returns the
   * report; dryRun=false applies it as one receipt, and is refused (applied=false) while any row has an error.
   */
  async importCsv(ctx: AuthContext, dto: ImportDto): Promise<StockImportReport> {
    const dryRun = dto.dryRun !== false;
    let parsed;
    try {
      parsed = parseStockCsv(dto.csv);
    } catch (e) {
      if (e instanceof StockCsvFormatError) throw new BadRequestException(e.message);
      throw e;
    }
    await this.assertReceiptRefs(dto.locationId, dto.supplierId);
    const models = await this.prisma.deviceModel.findMany({ select: { id: true, brand: true, model: true } });
    const byName = new Map(models.map((m) => [`${m.brand} ${m.model}`.toLowerCase().replace(/\s+/g, ' '), m.id]));
    const byId = new Set(models.map((m) => m.id));
    const inputs: PlanInput[] = parsed.map((r) => {
      const preErrors = [...r.errors];
      let modelId: string | null = null;
      if (r.model) {
        const key = r.model.toLowerCase().replace(/\s+/g, ' ');
        modelId = UUID_RE.test(r.model) && byId.has(r.model.toLowerCase()) ? r.model.toLowerCase() : (byName.get(key) ?? null);
        if (!modelId) preErrors.push(`Unknown device model "${r.model}" (use "Brand Model" as in Device Models)`);
      }
      return {
        uniqueId: r.uniqueId,
        modelId,
        simNumber: r.simNumber,
        simOperator: r.simOperator,
        serialNumber: r.serialNumber,
        unitCostPaise: r.unitCostPaise,
        warrantyUntil: r.warrantyUntil,
        condition: r.condition,
        note: r.note,
        preErrors,
      };
    });
    const planned = await this.planItems(inputs);
    const rows: StockImportRowResult[] = planned.map((p, i) => ({ line: parsed[i].line, uniqueId: p.uniqueId, action: p.action, errors: p.errors }));
    const summary = {
      rows: rows.length,
      createDevice: rows.filter((r) => r.action === 'CREATE_DEVICE').length,
      addStock: rows.filter((r) => r.action === 'ADD_STOCK').length,
      errors: rows.filter((r) => r.action === 'ERROR').length,
    };
    if (dryRun || summary.errors) return { dryRun, applied: false, receiptId: null, summary, rows };
    const result = await this.executeReceipt(
      ctx,
      { locationId: dto.locationId, supplierId: dto.supplierId, supplierInvoiceNo: dto.supplierInvoiceNo, supplierInvoiceAt: dto.supplierInvoiceAt, note: dto.note },
      planned,
      'CSV_IMPORT',
    );
    return { dryRun, applied: true, receiptId: result.receipt.id, summary, rows };
  }

  /**
   * Validate receipt items against the database: the IMEI is unique (Device.uniqueId), an existing device has no stock
   * record yet and is not in a customer account, a new IMEI has a model, serial numbers are unique.
   */
  async planItems(items: PlanInput[]): Promise<PlannedItem[]> {
    const seenDevice = new Map<string, number>();
    const seenSerial = new Map<string, number>();
    const out: PlannedItem[] = [];
    for (const [i, input] of items.entries()) {
      const errors = [...(input.preErrors ?? [])];
      let device: (DeviceFactsRow & { stock: { deviceId: string } | null; company: { name: string } | null }) | null = null;
      let uniqueId = input.uniqueId ?? null;
      let createDto: CreateAdminDeviceDto | null = null;
      const select = { ...DEVICE_FACTS_SELECT, stock: { select: { deviceId: true } }, company: { select: { name: true } } } as const;

      if (input.deviceId) {
        device = await this.prisma.device.findUnique({ where: { id: input.deviceId }, select });
        if (!device) errors.push('Device not found');
        else uniqueId = device.uniqueId;
      } else if (uniqueId) {
        device = await this.prisma.device.findUnique({ where: { uniqueId }, select });
        if (!device && input.modelId) {
          try {
            const normalised = await normalizeDeviceUniqueId(this.prisma, input.modelId, uniqueId);
            if (normalised !== uniqueId) {
              uniqueId = normalised;
              device = await this.prisma.device.findUnique({ where: { uniqueId }, select });
            }
          } catch (e) {
            errors.push(e instanceof Error ? e.message : 'Invalid unique id');
          }
        }
        if (!device && !errors.length) {
          if (!input.modelId) errors.push('New IMEI: the device model is required');
          else if (!(await this.prisma.deviceModel.count({ where: { id: input.modelId } }))) errors.push('Unknown device model');
          else {
            // Explicit fields only: a receipt never sets a company or the active flag (no licence seat is taken).
            createDto = {
              uniqueId,
              modelId: input.modelId,
              simNumber: input.simNumber ?? undefined,
              simOperator: input.simOperator ?? undefined,
              firmware: input.firmware ?? undefined,
            };
          }
        }
      } else if (!errors.length) {
        errors.push('Give a deviceId or an IMEI');
      }

      if (device) {
        if (device.stock) errors.push('Already has a stock record (IMEI already received)');
        if (device.companyId) errors.push(`In a customer account (${device.company?.name ?? 'company'}); stock records for assigned devices come from the backfill, not a receipt`);
      }

      const key = device?.id ?? uniqueId?.toLowerCase();
      if (key) {
        const first = seenDevice.get(key);
        if (first !== undefined) errors.push(`Same device as item ${first + 1}`);
        else seenDevice.set(key, i);
      }
      if (input.serialNumber) {
        const s = input.serialNumber.toLowerCase();
        const first = seenSerial.get(s);
        if (first !== undefined) errors.push(`Same serial number as item ${first + 1}`);
        else seenSerial.set(s, i);
        if (await this.prisma.deviceStock.count({ where: { serialNumber: { equals: input.serialNumber, mode: 'insensitive' } } })) {
          errors.push('Serial number already recorded on another device');
        }
      }

      const action = errors.length ? 'ERROR' : device ? 'ADD_STOCK' : 'CREATE_DEVICE';
      out.push({
        input,
        action,
        uniqueId,
        deviceId: device?.id ?? null,
        initialStatus: device ? deriveDeviceStatus(factsOf(device)) : 'IN_STOCK',
        createDto: action === 'CREATE_DEVICE' ? createDto : null,
        errors: [...new Set(errors)],
      });
    }
    return out;
  }

  private async executeReceipt(
    ctx: AuthContext,
    head: Pick<CreateReceiptDto, 'locationId' | 'supplierId' | 'supplierInvoiceNo' | 'supplierInvoiceAt' | 'receivedAt' | 'note'>,
    planned: PlannedItem[],
    source: 'MANUAL' | 'CSV_IMPORT',
  ) {
    const created: DeviceRow[] = [];
    const prepared = await Promise.all(planned.map(async (p) => (p.createDto ? this.devices.prepareCreate(p.createDto) : null)));
    const receiptId = await this.prisma.$transaction(async (tx) => {
      const receipt = await tx.stockReceipt.create({
        data: {
          locationId: head.locationId,
          supplierId: head.supplierId ?? null,
          supplierInvoiceNo: head.supplierInvoiceNo ?? null,
          supplierInvoiceAt: dateOnly(head.supplierInvoiceAt) ?? null,
          receivedAt: head.receivedAt ? new Date(head.receivedAt) : new Date(),
          source,
          itemCount: planned.length,
          note: head.note ?? null,
          createdById: ctx.userId,
        },
      });
      for (const [i, p] of planned.entries()) {
        let deviceId = p.deviceId;
        let itemRef = p.uniqueId ?? '';
        const dto = prepared[i];
        if (dto) {
          // Existing Device Inventory create path (IMEI normalisation, unique IMEI, model check). No company → no seat.
          const row = await this.devices.createInTx(tx, ctx, { ...dto, companyId: undefined, isActive: undefined });
          created.push(row);
          deviceId = row.id;
          itemRef = row.uniqueId;
        }
        if (!deviceId) throw new BadRequestException(`Item ${i + 1}: no device`);
        await tx.deviceStock.create({
          data: {
            deviceId,
            status: p.initialStatus,
            locationId: head.locationId,
            receiptId: receipt.id,
            serialNumber: p.input.serialNumber ?? null,
            unitCostPaise: p.input.unitCostPaise ?? null,
            warrantyUntil: dateOnly(p.input.warrantyUntil) ?? null,
            condition: p.input.condition ?? null,
            note: p.input.note ?? null,
          },
        });
        await this.move(tx, ctx, {
          deviceId,
          itemRef,
          kind: 'RECEIVE',
          fromStatus: null,
          toStatus: p.initialStatus,
          toLocationId: head.locationId,
          receiptId: receipt.id,
          reference: head.supplierInvoiceNo ?? null,
          note: source === 'CSV_IMPORT' ? 'CSV import' : null,
        });
      }
      await this.audit.record(
        ctx,
        { action: 'CREATE', entity: 'stock_receipt', entityId: receipt.id, details: { source, locationId: head.locationId, supplierId: head.supplierId ?? null, items: planned.length, newDevices: created.length } },
        tx,
      );
      return receipt.id;
    }, TX_OPTIONS);
    for (const row of created) await this.devices.afterCreate(ctx, row);
    const receipt = await this.getReceipt(receiptId);
    return { receipt, created: created.length, received: planned.length };
  }

  private async assertReceiptRefs(locationId: string, supplierId?: string): Promise<void> {
    await this.catalog.assertUsableLocation(locationId);
    if (supplierId) await this.catalog.assertUsableSupplier(supplierId);
  }

  // ───────────── Change ─────────────

  async changeStatus(ctx: AuthContext, deviceId: string, dto: ChangeStatusDto): Promise<DeviceStockDto> {
    await this.mutate(deviceId, async (tx, stock, device) => {
      const from = stock.status as InventoryStatus;
      const error = validateStatusChange({ kind: 'STATUS', from, to: dto.status, facts: factsOf(device), reason: dto.reason });
      if (error) throw new BadRequestException(error);
      let locationId = stock.locationId;
      if (!statusHoldsLocation(dto.status)) {
        if (dto.toLocationId) throw new BadRequestException('An assigned / active device has no stock location');
        locationId = null;
      } else if (dto.toLocationId) {
        locationId = (await this.catalog.assertUsableLocation(dto.toLocationId, tx)).id;
      }
      await this.guardedUpdate(tx, stock, { status: dto.status, locationId, statusChangedAt: new Date() });
      await this.move(tx, ctx, {
        ...this.assignmentLink(device),
        deviceId,
        itemRef: device.uniqueId,
        kind: 'STATUS',
        fromStatus: from,
        toStatus: dto.status,
        fromLocationId: stock.locationId,
        toLocationId: locationId,
        fromHolderPartnerId: stock.holderPartnerId,
        toHolderPartnerId: stock.holderPartnerId,
        reason: dto.reason?.trim() || null,
        reference: dto.reference ?? null,
        note: dto.note ?? null,
      });
    });
    return this.get(deviceId);
  }

  async transfer(ctx: AuthContext, deviceId: string, dto: TransferDto): Promise<DeviceStockDto> {
    if (dto.toLocationId === undefined && dto.holderPartnerId === undefined) throw new BadRequestException('Give a new location or holder partner');
    await this.mutate(deviceId, async (tx, stock, device) => {
      const status = stock.status as InventoryStatus;
      if (!statusHoldsLocation(status)) {
        throw new BadRequestException('An assigned / active device is at the customer; move it between companies in Device Inventory');
      }
      const locationId = dto.toLocationId ? (await this.catalog.assertUsableLocation(dto.toLocationId, tx)).id : stock.locationId;
      const holder = dto.holderPartnerId === undefined ? stock.holderPartnerId : dto.holderPartnerId;
      if (holder && holder !== stock.holderPartnerId && !(await tx.partner.count({ where: { id: holder } }))) throw new NotFoundException('Partner not found');
      if (locationId === stock.locationId && holder === stock.holderPartnerId) throw new BadRequestException('Nothing changes: same location and holder');
      await this.guardedUpdate(tx, stock, { locationId, holderPartnerId: holder });
      await this.move(tx, ctx, {
        ...this.assignmentLink(device),
        deviceId,
        itemRef: device.uniqueId,
        kind: 'TRANSFER',
        fromStatus: status,
        toStatus: status,
        fromLocationId: stock.locationId,
        toLocationId: locationId,
        fromHolderPartnerId: stock.holderPartnerId,
        toHolderPartnerId: holder,
        partnerId: holder,
        reason: dto.reason?.trim() || null,
        reference: dto.reference ?? null,
        note: dto.note ?? null,
      });
    });
    return this.get(deviceId);
  }

  async adjust(ctx: AuthContext, deviceId: string, dto: AdjustDto): Promise<DeviceStockDto> {
    await this.mutate(deviceId, async (tx, stock, device) => {
      const from = stock.status as InventoryStatus;
      const to = dto.status ?? from;
      if (to !== from) {
        const error = validateStatusChange({ kind: 'ADJUST', from, to, facts: factsOf(device), reason: dto.reason });
        if (error) throw new BadRequestException(error);
      }
      let locationId = dto.locationId === undefined ? stock.locationId : dto.locationId;
      if (!statusHoldsLocation(to)) {
        if (dto.locationId) throw new BadRequestException('An assigned / active device has no stock location');
        locationId = null;
      } else if (locationId && locationId !== stock.locationId) {
        await this.catalog.assertUsableLocation(locationId, tx);
      }
      const holder = dto.holderPartnerId === undefined ? stock.holderPartnerId : dto.holderPartnerId;
      if (holder && holder !== stock.holderPartnerId && !(await tx.partner.count({ where: { id: holder } }))) throw new NotFoundException('Partner not found');
      const next = {
        status: to,
        locationId,
        holderPartnerId: holder,
        serialNumber: dto.serialNumber === undefined ? stock.serialNumber : dto.serialNumber?.trim() || null,
        unitCostPaise: dto.unitCostPaise === undefined ? stock.unitCostPaise : dto.unitCostPaise,
        warrantyUntil: dto.warrantyUntil === undefined ? stock.warrantyUntil : (dateOnly(dto.warrantyUntil) ?? null),
        condition: dto.condition === undefined ? stock.condition : dto.condition,
        note: dto.note === undefined ? stock.note : dto.note,
      };
      const changes = diff(stock, next);
      if (!Object.keys(changes).length) throw new BadRequestException('Nothing to adjust');
      await this.guardedUpdate(tx, stock, { ...next, ...(to !== from ? { statusChangedAt: new Date() } : {}) });
      await this.move(tx, ctx, {
        ...this.assignmentLink(device),
        deviceId,
        itemRef: device.uniqueId,
        kind: 'ADJUST',
        fromStatus: from,
        toStatus: to,
        fromLocationId: stock.locationId,
        toLocationId: locationId,
        fromHolderPartnerId: stock.holderPartnerId,
        toHolderPartnerId: holder,
        reason: dto.reason.trim(),
        reference: dto.reference ?? null,
        changes: changes as Prisma.InputJsonValue,
      });
    });
    return this.get(deviceId);
  }

  /** Align the stored status with the existing assignment (after an admin assign / move / claim / fitting). */
  async sync(ctx: AuthContext, deviceId: string, dto: SyncDto): Promise<DeviceStockDto> {
    await this.mutate(deviceId, async (tx, stock, device) => {
      const from = stock.status as InventoryStatus;
      const facts = factsOf(device);
      const to = deriveDeviceStatus(facts);
      const error = validateStatusChange({ kind: 'SYNC', from, to, facts });
      if (error) throw new BadRequestException(error);
      const locationId = statusHoldsLocation(to) ? stock.locationId : null;
      await this.guardedUpdate(tx, stock, { status: to, locationId, statusChangedAt: new Date() });
      const link = this.assignmentLink(device);
      await this.move(tx, ctx, {
        ...link,
        deviceId,
        itemRef: device.uniqueId,
        kind: 'SYNC',
        fromStatus: from,
        toStatus: to,
        fromLocationId: stock.locationId,
        toLocationId: locationId,
        fromHolderPartnerId: stock.holderPartnerId,
        toHolderPartnerId: stock.holderPartnerId,
        reference: device.assignments[0] ? `DeviceAssignment:${device.assignments[0].id}` : device.companyId ? `Company:${device.companyId}` : null,
        note: dto.note ?? null,
      });
    });
    return this.get(deviceId);
  }

  // ───────────── Internals ─────────────

  private async mutate(
    deviceId: string,
    fn: (tx: Tx, stock: Prisma.DeviceStockGetPayload<object>, device: DeviceFactsRow) => Promise<void>,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const stock = await tx.deviceStock.findUnique({ where: { deviceId } });
      if (!stock) throw new NotFoundException('This device has no stock record yet (receive it first)');
      const device = await tx.device.findUnique({ where: { id: deviceId }, select: DEVICE_FACTS_SELECT });
      if (!device) throw new NotFoundException('Device not found');
      await fn(tx, stock, device);
    }, TX_OPTIONS);
  }

  /** Optimistic update: refused when the row changed since it was read (two operators on the same device). */
  private async guardedUpdate(tx: Tx, stock: { deviceId: string; updatedAt: Date }, data: Prisma.DeviceStockUncheckedUpdateManyInput): Promise<void> {
    const res = await tx.deviceStock.updateMany({ where: { deviceId: stock.deviceId, updatedAt: stock.updatedAt }, data });
    if (res.count !== 1) throw new ConflictException('The stock record changed meanwhile; reload and try again');
  }

  /** The existing assignment, read-only, recorded on the movement. */
  private assignmentLink(device: DeviceFactsRow): Pick<MovementInput, 'companyId' | 'objectId'> {
    return { companyId: device.companyId, objectId: device.assignments[0]?.objectId ?? null };
  }

  /** Append-only ledger write; always inside the caller's transaction. */
  private async move(tx: Tx, ctx: AuthContext, m: MovementInput): Promise<void> {
    await tx.stockMovement.create({ data: { ...m, createdById: ctx.userId, at: new Date() } });
  }
}

function norm(v: unknown): unknown {
  return v instanceof Date ? v.toISOString().slice(0, 10) : (v ?? null);
}

function diff(before: Record<string, unknown>, after: Record<string, unknown>): Record<string, { from: unknown; to: unknown }> {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const [k, v] of Object.entries(after)) {
    const a = norm(before[k]);
    const b = norm(v);
    if (JSON.stringify(a) !== JSON.stringify(b)) out[k] = { from: a, to: b };
  }
  return out;
}

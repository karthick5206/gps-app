import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { StockLocationDto, SupplierDto } from '@veetracer/shared';
import { AuthContext } from '../access/auth-context';
import { AuditService } from '../audit/audit.service';
import { CsvSpec, ListSpec, listResult, planList } from '../common/list-query';
import { IN_USE_MESSAGE } from '../common/prisma-errors';
import { PrismaService } from '../prisma/prisma.service';
import { CreateLocationDto, CreateSupplierDto, LocationListQuery, SupplierListQuery, UpdateLocationDto, UpdateSupplierDto } from './inventory.dto';
import { LOCATION_INCLUDE, LocationRow, toLocationDto, toSupplierDto } from './inventory.mapper';

const LOCATION_LIST: ListSpec = {
  search: ['code', 'name', 'address'],
  sort: { code: 'code', name: 'name', kind: 'kind', createdAt: 'createdAt', updatedAt: 'updatedAt' },
  defaultSort: 'code',
};
const LOCATION_CSV: CsvSpec<StockLocationDto> = {
  name: 'stock-locations',
  columns: [
    { header: 'Code', value: (l) => l.code },
    { header: 'Name', value: (l) => l.name },
    { header: 'Kind', value: (l) => l.kind },
    { header: 'Address', value: (l) => l.address },
    { header: 'State code', value: (l) => l.stateCode },
    { header: 'Devices', value: (l) => l.deviceCount },
    { header: 'Active', value: (l) => (l.isActive ? 'Yes' : 'No') },
  ],
};
const SUPPLIER_LIST: ListSpec = {
  search: ['name', 'gstin'],
  sort: { name: 'name', createdAt: 'createdAt', updatedAt: 'updatedAt' },
  defaultSort: 'name',
};
const SUPPLIER_CSV: CsvSpec<SupplierDto> = {
  name: 'suppliers',
  columns: [
    { header: 'Name', value: (s) => s.name },
    { header: 'GSTIN', value: (s) => s.gstin },
    { header: 'State code', value: (s) => s.stateCode },
    { header: 'Contact', value: (s) => Object.entries(s.contact).map(([k, v]) => `${k}: ${v}`).join('; ') },
    { header: 'Active', value: (s) => (s.isActive ? 'Yes' : 'No') },
  ],
};

function contactJson(contact: Record<string, string> | undefined): Prisma.InputJsonValue | undefined {
  if (contact === undefined) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(contact).slice(0, 10)) if (typeof v === 'string' && k.length <= 40) out[k] = v.slice(0, 200);
  return out;
}

/**
 * Stock locations and suppliers (platform-level, Super Admin). Rows that stock, receipts or movements point at are
 * never deleted (deactivate instead), so the movement ledger keeps its references.
 */
@Injectable()
export class InventoryCatalogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ───────────── Locations ─────────────

  async listLocations(query: LocationListQuery) {
    const plan = planList<Prisma.StockLocationWhereInput, Prisma.StockLocationOrderByWithRelationInput>(query, LOCATION_LIST);
    const where: Prisma.StockLocationWhereInput = { AND: [plan.where, { ownerPartnerId: null }, query.kind ? { kind: query.kind } : {}] };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.stockLocation.findMany({ where, orderBy: plan.orderBy, skip: plan.skip, take: plan.take, include: LOCATION_INCLUDE }),
      this.prisma.stockLocation.count({ where }),
    ]);
    return listResult(plan, rows.map(toLocationDto), total, LOCATION_CSV);
  }

  async getLocation(id: string): Promise<StockLocationDto> {
    return toLocationDto(await this.findLocation(id));
  }

  async createLocation(ctx: AuthContext, dto: CreateLocationDto): Promise<StockLocationDto> {
    await this.assertLocationCodeFree(dto.code);
    const row = await this.prisma.stockLocation.create({ data: { ...dto, ownerPartnerId: null }, include: LOCATION_INCLUDE });
    await this.audit.record(ctx, { action: 'CREATE', entity: 'stock_location', entityId: row.id, after: snapshotLocation(row) });
    return toLocationDto(row);
  }

  async updateLocation(ctx: AuthContext, id: string, dto: UpdateLocationDto): Promise<StockLocationDto> {
    const before = await this.findLocation(id);
    if (dto.code !== undefined && dto.code !== before.code) await this.assertLocationCodeFree(dto.code);
    const row = await this.prisma.stockLocation.update({ where: { id }, data: dto, include: LOCATION_INCLUDE });
    await this.audit.record(ctx, { action: 'UPDATE', entity: 'stock_location', entityId: id, before: snapshotLocation(before), after: snapshotLocation(row) });
    return toLocationDto(row);
  }

  async removeLocation(ctx: AuthContext, id: string): Promise<void> {
    const before = await this.findLocation(id);
    const [stock, receipts, movements] = await this.prisma.$transaction([
      this.prisma.deviceStock.count({ where: { locationId: id } }),
      this.prisma.stockReceipt.count({ where: { locationId: id } }),
      this.prisma.stockMovement.count({ where: { OR: [{ fromLocationId: id }, { toLocationId: id }] } }),
    ]);
    if (stock + receipts + movements > 0) throw new ConflictException(IN_USE_MESSAGE);
    await this.prisma.stockLocation.delete({ where: { id } });
    await this.audit.record(ctx, { action: 'DELETE', entity: 'stock_location', entityId: id, before: snapshotLocation(before) });
  }

  /** Active platform location, or 400-style error message. */
  async assertUsableLocation(id: string, db: Prisma.TransactionClient = this.prisma): Promise<{ id: string; code: string }> {
    const loc = await db.stockLocation.findUnique({ where: { id }, select: { id: true, code: true, isActive: true, ownerPartnerId: true } });
    if (!loc || loc.ownerPartnerId) throw new NotFoundException('Stock location not found');
    if (!loc.isActive) throw new ConflictException(`Location ${loc.code} is inactive`);
    return loc;
  }

  private async findLocation(id: string): Promise<LocationRow> {
    const row = await this.prisma.stockLocation.findFirst({ where: { id, ownerPartnerId: null }, include: LOCATION_INCLUDE });
    if (!row) throw new NotFoundException('Stock location not found');
    return row;
  }

  private async assertLocationCodeFree(code: string): Promise<void> {
    if (await this.prisma.stockLocation.count({ where: { ownerPartnerId: null, code } })) throw new ConflictException(`Location code ${code} already exists`);
  }

  // ───────────── Suppliers ─────────────

  async listSuppliers(query: SupplierListQuery) {
    const plan = planList<Prisma.SupplierWhereInput, Prisma.SupplierOrderByWithRelationInput>(query, SUPPLIER_LIST);
    const where: Prisma.SupplierWhereInput = { AND: [plan.where, { ownerPartnerId: null }] };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.supplier.findMany({ where, orderBy: plan.orderBy, skip: plan.skip, take: plan.take }),
      this.prisma.supplier.count({ where }),
    ]);
    return listResult(plan, rows.map(toSupplierDto), total, SUPPLIER_CSV);
  }

  async getSupplier(id: string): Promise<SupplierDto> {
    return toSupplierDto(await this.findSupplier(id));
  }

  async createSupplier(ctx: AuthContext, dto: CreateSupplierDto): Promise<SupplierDto> {
    await this.assertSupplierNameFree(dto.name);
    const row = await this.prisma.supplier.create({ data: { ...dto, contact: contactJson(dto.contact) ?? {}, ownerPartnerId: null } });
    await this.audit.record(ctx, { action: 'CREATE', entity: 'supplier', entityId: row.id, after: { ...row } });
    return toSupplierDto(row);
  }

  async updateSupplier(ctx: AuthContext, id: string, dto: UpdateSupplierDto): Promise<SupplierDto> {
    const before = await this.findSupplier(id);
    if (dto.name !== undefined && dto.name !== before.name) await this.assertSupplierNameFree(dto.name);
    const row = await this.prisma.supplier.update({ where: { id }, data: { ...dto, contact: contactJson(dto.contact) } });
    await this.audit.record(ctx, { action: 'UPDATE', entity: 'supplier', entityId: id, before: { ...before }, after: { ...row } });
    return toSupplierDto(row);
  }

  async removeSupplier(ctx: AuthContext, id: string): Promise<void> {
    const before = await this.findSupplier(id);
    if (await this.prisma.stockReceipt.count({ where: { supplierId: id } })) throw new ConflictException(IN_USE_MESSAGE);
    await this.prisma.supplier.delete({ where: { id } });
    await this.audit.record(ctx, { action: 'DELETE', entity: 'supplier', entityId: id, before: { ...before } });
  }

  async assertUsableSupplier(id: string, db: Prisma.TransactionClient = this.prisma): Promise<void> {
    const s = await db.supplier.findUnique({ where: { id }, select: { isActive: true, ownerPartnerId: true, name: true } });
    if (!s || s.ownerPartnerId) throw new NotFoundException('Supplier not found');
    if (!s.isActive) throw new ConflictException(`Supplier ${s.name} is inactive`);
  }

  private async findSupplier(id: string) {
    const row = await this.prisma.supplier.findFirst({ where: { id, ownerPartnerId: null } });
    if (!row) throw new NotFoundException('Supplier not found');
    return row;
  }

  private async assertSupplierNameFree(name: string): Promise<void> {
    if (await this.prisma.supplier.count({ where: { ownerPartnerId: null, name } })) throw new ConflictException(`Supplier ${name} already exists`);
  }
}

function snapshotLocation(l: LocationRow) {
  const { _count, ...scalars } = l;
  return scalars;
}

import { BadRequestException, Body, ConflictException, Controller, Delete, Get, Injectable, Module, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  ADJUSTMENT_DEDUCTS,
  ADJUSTMENT_KINDS,
  minimumTopUp,
  type AdjustmentKind,
  inNightWindow,
  minuteOfDayIn,
  monthlyCharge,
  nightSafetyOf,
  pickRateCard,
  RATE_MODELS,
  tripCharge,
  type RateAddons,
  type RateModel,
  type RateParams,
  type TransportRateCardDto,
  type TransportVendorAssetsDto,
  type TransportVendorDto,
  type VendorStatementDto,
  type VendorStatementLine,
  type VendorStatementVehicle,
} from '@veetracer/shared';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsEmail, IsIn, IsNumber, IsObject, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, ValidateIf } from 'class-validator';
import { AuthContext } from '../../access/auth-context';
import { Auth, RequirePermission } from '../../access/decorators';
import { AuditService } from '../../audit/audit.service';
import { ListQueryDto, listResult, planList, type CsvSpec, type ListSpec } from '../../common/list-query';
import { PrismaService } from '../../prisma/prisma.service';
import { TransportFeatureGuard } from '../transport-feature.guard';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const nullable = (_o: unknown, v: unknown) => v !== null;
const s = (v: string | null | undefined) => (v && v.trim() ? v.trim() : null);
const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

// ───────────────────────────── DTOs ─────────────────────────────

export class VendorDto {
  @IsString() @MaxLength(160) name!: string;
  @IsOptional() @ValidateIf(nullable) @Matches(/^[0-9A-Z]{15}$/, { message: 'GSTIN must be 15 letters / digits' }) gstin?: string | null;
  @IsOptional() @ValidateIf(nullable) @Matches(/^[A-Z]{5}[0-9]{4}[A-Z]$/, { message: 'PAN must look like ABCDE1234F' }) pan?: string | null;
  @IsOptional() @ValidateIf(nullable) @IsString() @MaxLength(120) contactName?: string | null;
  @IsOptional() @ValidateIf(nullable) @IsString() @MaxLength(30) phone?: string | null;
  @IsOptional() @ValidateIf(nullable) @IsEmail() @MaxLength(160) email?: string | null;
  @IsOptional() @ValidateIf(nullable) @IsString() @MaxLength(500) address?: string | null;
  @IsOptional() @ValidateIf(nullable) @IsString() @MaxLength(120) bankName?: string | null;
  @IsOptional() @ValidateIf(nullable) @IsString() @MaxLength(40) bankAccount?: string | null;
  @IsOptional() @ValidateIf(nullable) @Matches(/^[A-Z]{4}0[A-Z0-9]{6}$/, { message: 'IFSC must look like HDFC0001234' }) ifsc?: string | null;
  @IsOptional() @ValidateIf(nullable) @IsString() @MaxLength(80) upiId?: string | null;
  @IsOptional() @IsArray() @ArrayMaxSize(500) @IsUUID('all', { each: true }) branchIds?: string[];
  @IsOptional() @ValidateIf(nullable) @IsString() @MaxLength(1000) notes?: string | null;
  @IsOptional() @IsBoolean() isActive?: boolean;
}
export class UpdateVendorDto extends VendorDto {
  @IsOptional() @IsString() @MaxLength(160) declare name: string;
}
export class VendorAssetsDto {
  @IsArray() @ArrayMaxSize(1000) @IsUUID('all', { each: true }) objectIds!: string[];
  @IsArray() @ArrayMaxSize(1000) @IsUUID('all', { each: true }) driverIds!: string[];
}
export class RateCardDto {
  @IsString() @MaxLength(120) name!: string;
  @IsOptional() @ValidateIf(nullable) @IsUUID() branchId?: string | null;
  @IsOptional() @ValidateIf(nullable) @IsString() @MaxLength(40) vehicleCategory?: string | null;
  @IsIn(RATE_MODELS) model!: RateModel;
  @IsObject() params!: RateParams;
  @IsOptional() @IsObject() addons?: RateAddons;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) @Max(40) gstPct?: number;
  @Matches(DAY_RE) validFrom!: string;
  @IsOptional() @ValidateIf(nullable) @Matches(DAY_RE) validTo?: string | null;
  @IsOptional() @IsBoolean() isActive?: boolean;
}
export class VehicleVendorDto {
  @IsOptional() @ValidateIf(nullable) @IsUUID() vendorId?: string | null;
}
export class AdjustmentDto {
  @Matches(MONTH_RE, { message: 'month must be YYYY-MM' }) month!: string;
  @IsUUID() vendorId!: string;
  @IsOptional() @ValidateIf(nullable) @IsUUID() objectId?: string | null;
  @IsIn(ADJUSTMENT_KINDS) kind!: AdjustmentKind;
  @IsOptional() @ValidateIf(nullable) @Type(() => Number) @IsNumber() @Min(0) @Max(31) days?: number | null;
  @IsOptional() @ValidateIf(nullable) @Type(() => Number) @IsNumber() @Min(0) @Max(100_000_000) amount?: number | null;
  @IsOptional() @ValidateIf(nullable) @IsString() @MaxLength(300) note?: string | null;
}
export class StatementQuery {
  @Matches(MONTH_RE, { message: 'month must be YYYY-MM' }) month!: string;
  @IsUUID() vendorId!: string;
  @IsOptional() @IsUUID() branchId?: string;
}

/** Non-negative numbers only; other keys are dropped. */
function cleanNumbers<T extends object>(o: object | undefined, keys: readonly (keyof T)[]): T {
  const out: Record<string, number> = {};
  for (const k of keys) {
    const v = (o as Record<string, unknown> | undefined)?.[k as string];
    if (v === undefined || v === null || v === '') continue;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 10_000_000) throw new BadRequestException(`${String(k)} must be a number ≥ 0`);
    out[k as string] = n;
  }
  return out as T;
}
const PARAM_KEYS = ['perTrip', 'perKm', 'minKm', 'baseFare', 'baseKm', 'perKmAfter', 'monthlyFee', 'includedKm', 'perExtraKm', 'hours', 'km', 'fare', 'perExtraHour', 'perSeat', 'minMonthly'] as const;
/** v1.16.13 choices kept on a card's params (MONTHLY): booleans and the extra-km source. */
function cardFlags(p: RateParams | undefined): Partial<RateParams> {
  const out: Partial<RateParams> = {};
  if (typeof p?.billIdle === 'boolean') out.billIdle = p.billIdle;
  if (typeof p?.prorate === 'boolean') out.prorate = p.prorate;
  if (p?.extraKmSource === 'GPS' || p?.extraKmSource === 'TRIPS') out.extraKmSource = p.extraKmSource;
  return out;
}
const ADDON_KEYS = ['nightAllowance', 'escortPerNightTrip', 'waitingFreeMin', 'waitingPerHour', 'deadKmPerTrip'] as const;

const LIST: ListSpec = { search: ['name', 'gstin', 'contactName', 'phone'], sort: { name: 'name', createdAt: 'createdAt' }, defaultSort: 'name' };
const CSV: CsvSpec<TransportVendorDto> = {
  name: 'transport-vendors',
  columns: [
    { header: 'Name', value: (v) => v.name },
    { header: 'GSTIN', value: (v) => v.gstin ?? '' },
    { header: 'PAN', value: (v) => v.pan ?? '' },
    { header: 'Contact', value: (v) => v.contactName ?? '' },
    { header: 'Phone', value: (v) => v.phone ?? '' },
    { header: 'Email', value: (v) => v.email ?? '' },
    { header: 'Branches', value: (v) => (v.branchNames.length ? v.branchNames.join('; ') : 'All') },
    { header: 'Vehicles', value: (v) => String(v.vehicleCount) },
    { header: 'Drivers', value: (v) => String(v.driverCount) },
    { header: 'Bank', value: (v) => v.bankName ?? '' },
    { header: 'Account', value: (v) => v.bankAccount ?? '' },
    { header: 'IFSC', value: (v) => v.ifsc ?? '' },
    { header: 'Active', value: (v) => (v.isActive ? 'Yes' : 'No') },
  ],
};

// ───────────────────────────── Service ─────────────────────────────

/**
 * v1.16.9 transport vendors (menu etms_vendors) and the monthly vendor statement (menu etms_billing). Company-scoped:
 * every id of another company is 404. Vehicles / drivers must be the company's own. Audited (entity transport_vendor,
 * transport_rate_card).
 */
@Injectable()
export class TransportVendorsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private async vendorRow(ctx: AuthContext, id: string) {
    const v = await this.prisma.transportVendor.findFirst({ where: { id, companyId: ctx.companyId } });
    if (!v) throw new NotFoundException('Vendor not found');
    return v;
  }

  private async toDtos(ctx: AuthContext, rows: Prisma.TransportVendorGetPayload<object>[]): Promise<TransportVendorDto[]> {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const [veh, drv, cards, branches] = await Promise.all([
      this.prisma.transportVendorVehicle.groupBy({ by: ['vendorId'], where: { vendorId: { in: ids } }, _count: { _all: true } }),
      this.prisma.transportVendorDriver.groupBy({ by: ['vendorId'], where: { vendorId: { in: ids } }, _count: { _all: true } }),
      this.prisma.transportRateCard.groupBy({ by: ['vendorId'], where: { vendorId: { in: ids } }, _count: { _all: true } }),
      this.prisma.branch.findMany({ where: { companyId: ctx.companyId }, select: { id: true, name: true } }),
    ]);
    const count = (g: { vendorId: string; _count: { _all: number } }[], id: string) => g.find((x) => x.vendorId === id)?._count._all ?? 0;
    const bname = new Map(branches.map((b) => [b.id, b.name]));
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      gstin: r.gstin,
      pan: r.pan,
      contactName: r.contactName,
      phone: r.phone,
      email: r.email,
      address: r.address,
      bankName: r.bankName,
      bankAccount: r.bankAccount,
      ifsc: r.ifsc,
      upiId: r.upiId,
      branchIds: r.branchIds,
      branchNames: r.branchIds.map((b) => bname.get(b) ?? '—'),
      notes: r.notes,
      isActive: r.isActive,
      vehicleCount: count(veh, r.id),
      driverCount: count(drv, r.id),
      rateCardCount: count(cards, r.id),
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }));
  }

  async list(ctx: AuthContext, q: ListQueryDto) {
    const plan = planList<Prisma.TransportVendorWhereInput, Prisma.TransportVendorOrderByWithRelationInput>(q, LIST);
    const where: Prisma.TransportVendorWhereInput = { AND: [{ companyId: ctx.companyId }, plan.where] };
    const [rows, total] = await Promise.all([this.prisma.transportVendor.findMany({ where, orderBy: plan.orderBy, skip: plan.skip, take: plan.take }), this.prisma.transportVendor.count({ where })]);
    return listResult(plan, await this.toDtos(ctx, rows), total, CSV);
  }

  async get(ctx: AuthContext, id: string) {
    return (await this.toDtos(ctx, [await this.vendorRow(ctx, id)]))[0];
  }

  private async ownBranches(ctx: AuthContext, ids: string[] | undefined): Promise<string[] | undefined> {
    if (!ids) return undefined;
    const uniq = [...new Set(ids)];
    const n = await this.prisma.branch.count({ where: { id: { in: uniq }, companyId: ctx.companyId } });
    if (n !== uniq.length) throw new BadRequestException('Unknown branch');
    return uniq;
  }

  private data(dto: Partial<VendorDto>) {
    const out: Record<string, unknown> = {};
    if (dto.name !== undefined) out.name = dto.name.trim();
    for (const k of ['gstin', 'pan', 'contactName', 'phone', 'email', 'address', 'bankName', 'bankAccount', 'ifsc', 'upiId', 'notes'] as const) if (dto[k] !== undefined) out[k] = s(dto[k] as string | null);
    if (dto.isActive !== undefined) out.isActive = dto.isActive;
    return out;
  }

  async create(ctx: AuthContext, dto: VendorDto) {
    if (!dto.name?.trim()) throw new BadRequestException('Give the vendor a name');
    try {
      const row = await this.prisma.transportVendor.create({ data: { ...(this.data(dto) as { name: string }), companyId: ctx.companyId, branchIds: (await this.ownBranches(ctx, dto.branchIds)) ?? [] } });
      await this.audit.record(ctx, { action: 'CREATE', entity: 'transport_vendor', entityId: row.id, after: { name: row.name } });
      return this.get(ctx, row.id);
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException('A vendor with this name already exists');
      throw e;
    }
  }

  async update(ctx: AuthContext, id: string, dto: UpdateVendorDto) {
    const before = await this.vendorRow(ctx, id);
    const branchIds = await this.ownBranches(ctx, dto.branchIds);
    try {
      await this.prisma.transportVendor.update({ where: { id }, data: { ...this.data(dto), ...(branchIds ? { branchIds } : {}) } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException('A vendor with this name already exists');
      throw e;
    }
    await this.audit.record(ctx, { action: 'UPDATE', entity: 'transport_vendor', entityId: id, before: { name: before.name, isActive: before.isActive }, after: { name: dto.name ?? before.name, isActive: dto.isActive ?? before.isActive } });
    return this.get(ctx, id);
  }

  async remove(ctx: AuthContext, id: string) {
    const v = await this.vendorRow(ctx, id);
    await this.prisma.transportVendor.delete({ where: { id } });
    await this.audit.record(ctx, { action: 'DELETE', entity: 'transport_vendor', entityId: id, before: { name: v.name } });
    return { ok: true };
  }

  // ── vehicles & drivers ──

  async assets(ctx: AuthContext, id: string): Promise<TransportVendorAssetsDto> {
    await this.vendorRow(ctx, id);
    const [veh, drv] = await Promise.all([
      this.prisma.transportVendorVehicle.findMany({ where: { vendorId: id }, include: { object: { select: { name: true, plateNumber: true, transportProfile: { select: { category: true, seats: true } } } } } }),
      this.prisma.transportVendorDriver.findMany({ where: { vendorId: id }, include: { driver: { select: { name: true, mobile: true } } } }),
    ]);
    return {
      vehicles: veh.map((v) => ({ objectId: v.objectId, name: v.object.name, plateNumber: v.object.plateNumber, category: v.object.transportProfile?.category ?? null, seats: v.object.transportProfile?.seats ?? null })).sort((a, b) => a.name.localeCompare(b.name)),
      drivers: drv.map((d) => ({ driverId: d.driverId, name: d.driver.name, mobile: d.driver.mobile })).sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  /** Replaces the vendor's vehicles and drivers. A vehicle / driver moves here from another vendor of the company. */
  async setAssets(ctx: AuthContext, id: string, dto: VendorAssetsDto): Promise<TransportVendorAssetsDto> {
    await this.vendorRow(ctx, id);
    const objectIds = [...new Set(dto.objectIds)];
    const driverIds = [...new Set(dto.driverIds)];
    const [objs, drvs] = await Promise.all([
      this.prisma.trackedObject.count({ where: { id: { in: objectIds }, companyId: ctx.companyId } }),
      this.prisma.driver.count({ where: { id: { in: driverIds }, companyId: ctx.companyId } }),
    ]);
    if (objs !== objectIds.length) throw new NotFoundException('Vehicle not found');
    if (drvs !== driverIds.length) throw new NotFoundException('Driver not found');
    await this.prisma.$transaction(async (tx) => {
      await tx.transportVendorVehicle.deleteMany({ where: { OR: [{ vendorId: id }, { objectId: { in: objectIds } }], companyId: ctx.companyId } });
      await tx.transportVendorDriver.deleteMany({ where: { OR: [{ vendorId: id }, { driverId: { in: driverIds } }], companyId: ctx.companyId } });
      if (objectIds.length) await tx.transportVendorVehicle.createMany({ data: objectIds.map((objectId) => ({ objectId, vendorId: id, companyId: ctx.companyId })) });
      if (driverIds.length) await tx.transportVendorDriver.createMany({ data: driverIds.map((driverId) => ({ driverId, vendorId: id, companyId: ctx.companyId })) });
    });
    await this.audit.record(ctx, { action: 'UPDATE', entity: 'transport_vendor', entityId: id, details: { vehicles: objectIds.length, drivers: driverIds.length } });
    return this.assets(ctx, id);
  }

  // ── one vehicle's vendor (vehicle form) ──

  async vehicleVendor(ctx: AuthContext, objectId: string): Promise<{ vendorId: string | null }> {
    const row = await this.prisma.transportVendorVehicle.findFirst({ where: { objectId, companyId: ctx.companyId }, select: { vendorId: true } });
    return { vendorId: row?.vendorId ?? null };
  }

  async setVehicleVendor(ctx: AuthContext, objectId: string, vendorId: string | null): Promise<{ vendorId: string | null }> {
    if (!(await this.prisma.trackedObject.count({ where: { id: objectId, companyId: ctx.companyId } }))) throw new NotFoundException('Vehicle not found');
    if (vendorId) await this.vendorRow(ctx, vendorId);
    await this.prisma.$transaction(async (tx) => {
      await tx.transportVendorVehicle.deleteMany({ where: { objectId, companyId: ctx.companyId } });
      if (vendorId) await tx.transportVendorVehicle.create({ data: { objectId, vendorId, companyId: ctx.companyId } });
    });
    await this.audit.record(ctx, { action: 'UPDATE', entity: 'transport_vendor_vehicle', entityId: objectId, details: { vendorId } });
    return { vendorId };
  }

  // ── rate cards ──

  private async cardDtos(ctx: AuthContext, rows: Prisma.TransportRateCardGetPayload<object>[]): Promise<TransportRateCardDto[]> {
    const branches = new Map((await this.prisma.branch.findMany({ where: { companyId: ctx.companyId }, select: { id: true, name: true } })).map((b) => [b.id, b.name]));
    return rows.map((c) => ({
      id: c.id,
      vendorId: c.vendorId,
      name: c.name,
      branchId: c.branchId,
      branchName: c.branchId ? (branches.get(c.branchId) ?? '—') : null,
      vehicleCategory: c.vehicleCategory,
      model: c.model as RateModel,
      params: c.params as RateParams,
      addons: c.addons as RateAddons,
      gstPct: c.gstPct,
      validFrom: day(c.validFrom)!,
      validTo: day(c.validTo),
      isActive: c.isActive,
    }));
  }

  async rateCards(ctx: AuthContext, vendorId: string): Promise<TransportRateCardDto[]> {
    await this.vendorRow(ctx, vendorId);
    return this.cardDtos(ctx, await this.prisma.transportRateCard.findMany({ where: { vendorId, companyId: ctx.companyId }, orderBy: [{ isActive: 'desc' }, { validFrom: 'desc' }, { name: 'asc' }] }));
  }

  private async cardData(ctx: AuthContext, dto: RateCardDto) {
    if (dto.branchId && !(await this.prisma.branch.count({ where: { id: dto.branchId, companyId: ctx.companyId } }))) throw new BadRequestException('Unknown branch');
    if (dto.validTo && dto.validTo < dto.validFrom) throw new BadRequestException('Valid to must not be before valid from');
    return {
      name: dto.name.trim(),
      branchId: dto.branchId ?? null,
      vehicleCategory: s(dto.vehicleCategory),
      model: dto.model,
      params: { ...cleanNumbers<RateParams>(dto.params, PARAM_KEYS), ...cardFlags(dto.params) } as Prisma.InputJsonValue,
      addons: cleanNumbers<RateAddons>(dto.addons, ADDON_KEYS) as Prisma.InputJsonValue,
      gstPct: dto.gstPct ?? 0,
      validFrom: new Date(`${dto.validFrom}T00:00:00Z`),
      validTo: dto.validTo ? new Date(`${dto.validTo}T00:00:00Z`) : null,
      isActive: dto.isActive ?? true,
    };
  }

  async createCard(ctx: AuthContext, vendorId: string, dto: RateCardDto) {
    await this.vendorRow(ctx, vendorId);
    const row = await this.prisma.transportRateCard.create({ data: { ...(await this.cardData(ctx, dto)), vendorId, companyId: ctx.companyId } });
    await this.audit.record(ctx, { action: 'CREATE', entity: 'transport_rate_card', entityId: row.id, after: { name: row.name, model: row.model, params: row.params, addons: row.addons, gstPct: row.gstPct } });
    return (await this.cardDtos(ctx, [row]))[0];
  }

  async updateCard(ctx: AuthContext, vendorId: string, id: string, dto: RateCardDto) {
    const before = await this.prisma.transportRateCard.findFirst({ where: { id, vendorId, companyId: ctx.companyId } });
    if (!before) throw new NotFoundException('Rate card not found');
    const row = await this.prisma.transportRateCard.update({ where: { id }, data: await this.cardData(ctx, dto) });
    await this.audit.record(ctx, { action: 'UPDATE', entity: 'transport_rate_card', entityId: id, before: { model: before.model, params: before.params, addons: before.addons, gstPct: before.gstPct }, after: { model: row.model, params: row.params, addons: row.addons, gstPct: row.gstPct } });
    return (await this.cardDtos(ctx, [row]))[0];
  }

  async removeCard(ctx: AuthContext, vendorId: string, id: string) {
    const before = await this.prisma.transportRateCard.findFirst({ where: { id, vendorId, companyId: ctx.companyId } });
    if (!before) throw new NotFoundException('Rate card not found');
    await this.prisma.transportRateCard.delete({ where: { id } });
    await this.audit.record(ctx, { action: 'DELETE', entity: 'transport_rate_card', entityId: id, before: { name: before.name } });
    return { ok: true };
  }

  // ── statement ──

  async statement(ctx: AuthContext, q: StatementQuery): Promise<VendorStatementDto> {
    const vendor = await this.vendorRow(ctx, q.vendorId);
    const company = await this.prisma.company.findUniqueOrThrow({ where: { id: ctx.companyId }, select: { settings: true, timezone: true } });
    const night = nightSafetyOf(company.settings);
    const [y, m] = q.month.split('-').map(Number);
    const from = new Date(Date.UTC(y, m - 1, 1));
    const to = new Date(Date.UTC(y, m, 0));
    const daysInMonth = to.getUTCDate();
    const monthStart = day(from)!;
    const monthEnd = day(to)!;
    const vehicles = await this.prisma.transportVendorVehicle.findMany({ where: { vendorId: vendor.id }, include: { object: { select: { id: true, name: true, plateNumber: true, branchId: true, transportProfile: { select: { category: true } } } } } });
    const mapped = vehicles.filter((v) => !q.branchId || v.object.branchId === q.branchId);
    const byObject = new Map(mapped.map((v) => [v.objectId, v.object]));
    const linkedOn = new Map(mapped.map((v) => [v.objectId, day(v.createdAt)!]));
    const cards = (await this.cardDtos(ctx, await this.prisma.transportRateCard.findMany({ where: { vendorId: vendor.id, companyId: ctx.companyId } }))).filter((c) => !q.branchId || !c.branchId || c.branchId === q.branchId);
    const objectIds = [...byObject.keys()];
    const [trips, summaries, adjustments] = await Promise.all([
      objectIds.length
        ? this.prisma.transportTrip.findMany({
            where: { providerCompanyId: ctx.companyId, serviceDate: { gte: from, lte: to }, cancelledAt: null, plannedTrip: { objectId: { in: objectIds }, status: { in: ['COMPLETED', 'INCOMPLETE'] } } },
            select: {
              id: true,
              serviceDate: true,
              direction: true,
              passengers: { select: { status: true } },
              plannedTrip: { select: { objectId: true, driverId: true, routeName: true, distanceKm: true, actualStart: true, actualEnd: true, plannedStart: true, plannedEnd: true } },
            },
            orderBy: [{ serviceDate: 'asc' }],
            take: 20_000,
          })
        : [],
      objectIds.length ? this.prisma.dailySummary.findMany({ where: { objectId: { in: objectIds }, day: { gte: from, lte: to } }, select: { objectId: true, day: true, distanceKm: true } }) : [],
      this.prisma.transportStatementAdjustment.findMany({ where: { companyId: ctx.companyId, vendorId: vendor.id, month: q.month }, orderBy: { createdAt: 'asc' } }),
    ]);
    const driverIds = [...new Set(trips.flatMap((t) => (t.plannedTrip?.driverId ? [t.plannedTrip.driverId] : [])))];
    const drivers = new Map((await this.prisma.driver.findMany({ where: { id: { in: driverIds } }, select: { id: true, name: true } })).map((d) => [d.id, d.name]));

    // ── per trip ──
    const lines: VendorStatementLine[] = [];
    const lineObject = new Map<string, string>();
    for (const t of trips) {
      const pt = t.plannedTrip!;
      const o = byObject.get(pt.objectId)!;
      const d = day(t.serviceDate)!;
      const card = pickRateCard(cards, d, o.branchId, o.transportProfile?.category ?? null);
      const km = Math.round((pt.distanceKm ?? 0) * 10) / 10;
      const passengers = t.passengers.filter((p) => p.status === 'BOARDED' || p.status === 'DROPPED').length;
      const isNight = night.on && !!pt.actualStart && inNightWindow(minuteOfDayIn(pt.actualStart, company.timezone), night.from, night.to);
      const durationMin = pt.actualStart && pt.actualEnd ? (pt.actualEnd.getTime() - pt.actualStart.getTime()) / 60_000 : null;
      const plannedMin = (pt.plannedEnd.getTime() - pt.plannedStart.getTime()) / 60_000;
      const base = { tripId: t.id, day: d, vehicle: o.name, plateNumber: o.plateNumber, driver: pt.driverId ? (drivers.get(pt.driverId) ?? null) : null, trip: pt.routeName, direction: t.direction as 'IN' | 'OUT', start: pt.actualStart?.toISOString() ?? null, end: pt.actualEnd?.toISOString() ?? null, km, passengers, night: isNight };
      lineObject.set(t.id, o.id);
      if (!card) {
        // Say why: a card that would match except for its dates, or no card for this type at all.
        const cat = o.transportProfile?.category ?? null;
        const later = cards.filter((c) => c.isActive && (!c.branchId || c.branchId === o.branchId) && (!c.vehicleCategory || c.vehicleCategory === cat)).sort((a, b) => a.validFrom.localeCompare(b.validFrom))[0];
        const why = later ? (later.validFrom > d ? `No rate valid on ${d}: '${later.name}' starts ${later.validFrom}` : `No rate valid on ${d}: '${later.name}' ended ${later.validTo}`) : `No rate card for ${cat ? cat.toLowerCase().replace(/_/g, ' ') : 'this vehicle (set its type)'}`;
        lines.push({ ...base, rateCard: null, basis: '', base: 0, addons: 0, addonText: [], amount: 0, issue: why });
        continue;
      }
      const c = tripCharge(card.model, card.params, card.addons, { km, durationMin, plannedMin, passengers, night: isNight });
      lines.push({ ...base, rateCard: card.name, basis: c.basis, base: c.base, addons: c.addons, addonText: c.addonText, amount: Math.round((c.base + c.addons) * 100) / 100, issue: pt.distanceKm === null && card.model !== 'TRIP' && card.model !== 'SEAT' && card.model !== 'MONTHLY' ? 'No GPS km for this trip' : null });
    }

    // ── per vehicle: monthly (with or without trips), minimum guarantee, idle days, adjustments ──
    const r2 = (n: number) => Math.round(n * 100) / 100;
    const gstOfCard = new Map(cards.map((c) => [c.name, c.gstPct]));
    let taxable = lines.reduce((sum, l) => sum + (l.amount * (gstOfCard.get(l.rateCard ?? '') ?? 0)) / 100, 0);
    const vehicleRows: VendorStatementVehicle[] = [];
    for (const o of byObject.values()) {
      const mine = lines.filter((l) => lineObject.get(l.tripId) === o.id);
      const tripKm = Math.round(mine.reduce((sum, l) => sum + l.km, 0) * 10) / 10;
      // Attached: from the later of month start / link date, to month end (the card's validity narrows it below).
      const linked = linkedOn.get(o.id)!;
      const card = pickRateCard(cards, monthEnd, o.branchId, o.transportProfile?.category ?? null) ?? pickRateCard(cards, monthStart, o.branchId, o.transportProfile?.category ?? null);
      const startDay = [monthStart, linked > monthStart ? linked : monthStart, card && card.validFrom > monthStart ? card.validFrom : monthStart].sort().at(-1)!;
      const endDay = card?.validTo && card.validTo < monthEnd ? card.validTo : monthEnd;
      const attachedDays = startDay > endDay ? 0 : Math.round((Date.parse(`${endDay}T00:00:00Z`) - Date.parse(`${startDay}T00:00:00Z`)) / 86_400_000) + 1;
      const attached = { days: attachedDays, daysInMonth };
      const mineDays = summaries.filter((s2) => s2.objectId === o.id && day(s2.day)! >= startDay && day(s2.day)! <= endDay);
      const gpsKm = Math.round(mineDays.reduce((sum, s2) => sum + s2.distanceKm, 0) * 10) / 10;
      const tripDays = new Set(mine.map((l) => l.day));
      const movedDays = new Set(mineDays.filter((s2) => s2.distanceKm >= 1).map((s2) => day(s2.day)!));
      const idleDays = Math.max(0, attachedDays - new Set([...tripDays, ...movedDays]).size);
      let monthly: VendorStatementVehicle['monthly'] = null;
      let minimum: VendorStatementVehicle['minimum'] = null;
      const tripAmount = r2(mine.reduce((sum, l) => sum + l.amount, 0));
      if (card?.model === 'MONTHLY' && attachedDays > 0 && (mine.length > 0 || card.params.billIdle !== false)) {
        monthly = monthlyCharge(card.params, card.params.extraKmSource === 'TRIPS' ? tripKm : gpsKm, attached);
        taxable += (monthly.amount * card.gstPct) / 100;
      } else if (card && card.model !== 'MONTHLY' && attachedDays > 0) {
        minimum = minimumTopUp(card.params, tripAmount, attached);
        if (minimum) taxable += (minimum.topUp * card.gstPct) / 100;
      }
      const adj = adjustments.filter((a) => a.objectId === o.id);
      const adjNoToll = adj.filter((a) => a.kind !== 'TOLL_PARKING').reduce((sum, a) => sum + a.amount, 0);
      if (card) taxable += (adjNoToll * card.gstPct) / 100;
      const adjSum = r2(adj.reduce((sum, a) => sum + a.amount, 0));
      if (!mine.length && !monthly && !minimum && !adj.length) continue;
      vehicleRows.push({ objectId: o.id, vehicle: o.name, plateNumber: o.plateNumber, trips: mine.length, km: tripKm, passengers: mine.reduce((sum, l) => sum + l.passengers, 0), amount: r2(tripAmount + (monthly?.amount ?? 0) + (minimum?.topUp ?? 0) + adjSum), monthly, minimum, attachedDays, idleDays, gpsKm, adjustments: adjSum });
    }
    vehicleRows.sort((a, b) => a.vehicle.localeCompare(b.vehicle));
    const vendorLevel = adjustments.filter((a) => !a.objectId);
    const vendorLevelSum = r2(vendorLevel.reduce((sum, a) => sum + a.amount, 0));
    const anyGst = cards.find((c) => c.isActive)?.gstPct ?? 0;
    taxable += (vendorLevel.filter((a) => a.kind !== 'TOLL_PARKING').reduce((sum, a) => sum + a.amount, 0) * anyGst) / 100;
    const subtotal = r2(vehicleRows.reduce((sum, v) => sum + v.amount, 0) + vendorLevelSum);
    const gst = r2(Math.max(0, taxable));
    const names = new Map(mapped.map((v) => [v.objectId, v.object.name]));
    return {
      month: q.month,
      vendor: { id: vendor.id, name: vendor.name, gstin: vendor.gstin },
      branchId: q.branchId ?? null,
      lines,
      vehicles: vehicleRows,
      adjustments: adjustments.map((a) => ({ id: a.id, month: a.month, objectId: a.objectId, vehicle: a.objectId ? (names.get(a.objectId) ?? null) : null, kind: a.kind as AdjustmentKind, days: a.days, amount: a.amount, note: a.note, createdAt: a.createdAt.toISOString() })),
      totals: {
        trips: lines.length,
        km: Math.round(lines.reduce((sum, l) => sum + l.km, 0) * 10) / 10,
        passengers: lines.reduce((sum, l) => sum + l.passengers, 0),
        subtotal,
        gst,
        total: r2(subtotal + gst),
        unpriced: lines.filter((l) => l.issue).length,
        adjustments: r2(adjustments.reduce((sum, a) => sum + a.amount, 0)),
        tollParking: r2(adjustments.filter((a) => a.kind === 'TOLL_PARKING').reduce((sum, a) => sum + a.amount, 0)),
      },
    };
  }

  // ── statement adjustments ──

  async addAdjustment(ctx: AuthContext, dto: AdjustmentDto) {
    const vendor = await this.vendorRow(ctx, dto.vendorId);
    if (dto.objectId && !(await this.prisma.transportVendorVehicle.count({ where: { objectId: dto.objectId, vendorId: vendor.id } }))) throw new BadRequestException('That vehicle is not this vendor’s');
    let amount = dto.amount ?? null;
    if (dto.kind === 'NOT_AVAILABLE') {
      if (!dto.days || dto.days <= 0) throw new BadRequestException('Give the number of days not available');
      if (amount === null) {
        // Days × the vehicle's monthly fee per day (its monthly card); needs a vehicle with a monthly card.
        if (!dto.objectId) throw new BadRequestException('Choose the vehicle, or give the amount');
        const o = await this.prisma.trackedObject.findFirst({ where: { id: dto.objectId, companyId: ctx.companyId }, select: { branchId: true, transportProfile: { select: { category: true } } } });
        const [yy, mm] = dto.month.split('-').map(Number);
        const end = new Date(Date.UTC(yy, mm, 0));
        const cards = await this.cardDtos(ctx, await this.prisma.transportRateCard.findMany({ where: { vendorId: vendor.id, companyId: ctx.companyId } }));
        const card = pickRateCard(cards, day(end)!, o?.branchId ?? null, o?.transportProfile?.category ?? null);
        if (card?.model !== 'MONTHLY' || !card.params.monthlyFee) throw new BadRequestException('This vehicle has no monthly rate: give the amount to deduct');
        amount = Math.round(((card.params.monthlyFee * dto.days) / end.getUTCDate()) * 100) / 100;
      }
    }
    if (amount === null || amount < 0) throw new BadRequestException('Give the amount');
    const signed = (ADJUSTMENT_DEDUCTS as readonly string[]).includes(dto.kind) ? -amount : amount;
    const row = await this.prisma.transportStatementAdjustment.create({ data: { companyId: ctx.companyId, vendorId: vendor.id, month: dto.month, objectId: dto.objectId ?? null, kind: dto.kind, days: dto.days ?? null, amount: signed, note: s(dto.note), createdById: ctx.userId } });
    await this.audit.record(ctx, { action: 'CREATE', entity: 'transport_statement_adjustment', entityId: row.id, after: { vendor: vendor.name, month: row.month, kind: row.kind, days: row.days, amount: row.amount } });
    return { id: row.id };
  }

  async removeAdjustment(ctx: AuthContext, id: string) {
    const row = await this.prisma.transportStatementAdjustment.findFirst({ where: { id, companyId: ctx.companyId } });
    if (!row) throw new NotFoundException('Adjustment not found');
    await this.prisma.transportStatementAdjustment.delete({ where: { id } });
    await this.audit.record(ctx, { action: 'DELETE', entity: 'transport_statement_adjustment', entityId: id, before: { kind: row.kind, amount: row.amount, month: row.month } });
    return { ok: true };
  }
}

// ───────────────────────────── Controllers ─────────────────────────────

/** v1.16.10: every company (normal tracking too), not only the Employee transport add-on. */
@Controller('transport/vendors')
export class TransportVendorsController {
  constructor(private readonly vendors: TransportVendorsService) {}

  @Get() @RequirePermission('etms_vendors', 'view')
  list(@Auth() ctx: AuthContext, @Query() q: ListQueryDto) {
    return this.vendors.list(ctx, q);
  }
  @Get('by-vehicle/:objectId') @RequirePermission('objects', 'view')
  vehicleVendor(@Auth() ctx: AuthContext, @Param('objectId', ParseUUIDPipe) objectId: string) {
    return this.vendors.vehicleVendor(ctx, objectId);
  }
  @Put('by-vehicle/:objectId') @RequirePermission('objects', 'edit')
  setVehicleVendor(@Auth() ctx: AuthContext, @Param('objectId', ParseUUIDPipe) objectId: string, @Body() dto: VehicleVendorDto) {
    return this.vendors.setVehicleVendor(ctx, objectId, dto.vendorId ?? null);
  }
  @Get(':id') @RequirePermission('etms_vendors', 'view')
  get(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.vendors.get(ctx, id);
  }
  @Post() @RequirePermission('etms_vendors', 'create')
  create(@Auth() ctx: AuthContext, @Body() dto: VendorDto) {
    return this.vendors.create(ctx, dto);
  }
  @Patch(':id') @RequirePermission('etms_vendors', 'edit')
  update(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateVendorDto) {
    return this.vendors.update(ctx, id, dto);
  }
  @Delete(':id') @RequirePermission('etms_vendors', 'delete')
  remove(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.vendors.remove(ctx, id);
  }
  @Get(':id/assets') @RequirePermission('etms_vendors', 'view')
  assets(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.vendors.assets(ctx, id);
  }
  @Put(':id/assets') @RequirePermission('etms_vendors', 'edit')
  setAssets(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: VendorAssetsDto) {
    return this.vendors.setAssets(ctx, id, dto);
  }
  @Get(':id/rate-cards') @RequirePermission('etms_vendors', 'view')
  rateCards(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.vendors.rateCards(ctx, id);
  }
  @Post(':id/rate-cards') @RequirePermission('etms_vendors', 'edit')
  createCard(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RateCardDto) {
    return this.vendors.createCard(ctx, id, dto);
  }
  @Put(':id/rate-cards/:cardId') @RequirePermission('etms_vendors', 'edit')
  updateCard(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Param('cardId', ParseUUIDPipe) cardId: string, @Body() dto: RateCardDto) {
    return this.vendors.updateCard(ctx, id, cardId, dto);
  }
  @Delete(':id/rate-cards/:cardId') @RequirePermission('etms_vendors', 'edit')
  removeCard(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Param('cardId', ParseUUIDPipe) cardId: string) {
    return this.vendors.removeCard(ctx, id, cardId);
  }
}

@Controller('transport/billing')
@UseGuards(TransportFeatureGuard)
export class TransportBillingController {
  constructor(private readonly vendors: TransportVendorsService) {}

  @Get('statement') @RequirePermission('etms_billing', 'view')
  statement(@Auth() ctx: AuthContext, @Query() q: StatementQuery) {
    return this.vendors.statement(ctx, q);
  }
  @Post('adjustments') @RequirePermission('etms_billing', 'export')
  addAdjustment(@Auth() ctx: AuthContext, @Body() dto: AdjustmentDto) {
    return this.vendors.addAdjustment(ctx, dto);
  }
  @Delete('adjustments/:id') @RequirePermission('etms_billing', 'export')
  removeAdjustment(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.vendors.removeAdjustment(ctx, id);
  }
}

@Module({
  controllers: [TransportVendorsController, TransportBillingController],
  providers: [TransportVendorsService],
})
export class EtmsVendorsModule {}

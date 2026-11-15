import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  AVAILABILITY_FREQUENCIES,
  BILLING_FREQUENCIES,
  COVERAGE_KINDS,
  DISTANCE_SOURCES,
  DOWNTIME_KINDS,
  isCurrency,
  isYmd,
  mergeVehicleOverrides,
  MISSING_GPS_POLICIES,
  PRICING_COMPONENT_KINDS,
  priceTrip,
  pricePeriod,
  REPLACEMENT_BILLING,
  ROUNDING_MODES,
  SHARED_FARE_METHODS,
  validateComponents,
  type CoverageKind,
  type CreatePricingContractRequest,
  type CreatePricingDowntimeRequest,
  type CreatePricingVehicleAssignmentRequest,
  type CreatePricingVehicleRateRequest,
  type CreatePricingVersionRequest,
  type PeriodFacts,
  type PricingComponentDto,
  type PricingComponentInput,
  type PricingContractDto,
  type PricingContractListQuery,
  type PricingContractStatus,
  type PricingContractSummaryDto,
  type PricingContractVersionDto,
  type PricingDowntimeDto,
  type PricingPage,
  type PricingPolicies,
  type PricingPreviewRequest,
  type PricingPreviewResponse,
  type PricingVehicleAssignmentDto,
  type PricingVehicleRateDto,
  type PricingVersionStatus,
  type ReplacePricingComponentsRequest,
  type RoundingMode,
  type TripFacts,
  type UpdatePricingContractRequest,
  type UpdatePricingVehicleAssignmentRequest,
  type UpdatePricingVehicleRateRequest,
} from '@veetracer/shared';
import type { AuthContext } from '../access/auth-context';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { PricingSettingsService } from './settings.service';
import {
  asJson,
  assertContractWritable,
  conflict,
  contractVisible,
  dateOnly,
  forbidden,
  guardDb,
  invalid,
  isCompanyScope,
  isoOf,
  notFound,
  optionalDate,
  pageOf,
  paging,
  pricingError,
  reasonOf,
  resultDto,
  versionConflict,
  ymd,
  ymdOf,
  type Db,
} from './pricing-common';

type ContractRow = Prisma.PricingContractGetPayload<object>;
type VersionRow = Prisma.PricingContractVersionGetPayload<{ include: { components: true } }>;
type ContractFull = Prisma.PricingContractGetPayload<{ include: { versions: { include: { components: true } } } }>;

const PRICING_VERSIONS = ['ACTIVE', 'SUPERSEDED'];
const MAX_COMPONENTS = 100;
const today = () => new Date().toISOString().slice(0, 10);

// ───────────── Component / policy sanitising (bodies are only shape-checked by class-validator) ─────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function sanitizeComponents(raw: unknown): PricingComponentInput[] {
  if (!Array.isArray(raw)) throw invalid('components must be an array');
  if (raw.length > MAX_COMPONENTS) throw invalid(`At most ${MAX_COMPONENTS} components`);
  return raw.map((c, i) => {
    if (!isPlainObject(c)) throw invalid(`components[${i}] must be an object`);
    const kind = c.kind as PricingComponentInput['kind'];
    if (!PRICING_COMPONENT_KINDS.includes(kind)) throw invalid(`components[${i}].kind is invalid`);
    if (!isPlainObject(c.params ?? {})) throw invalid(`components[${i}].params must be an object`);
    if (c.scope !== undefined && c.scope !== null && !isPlainObject(c.scope)) throw invalid(`components[${i}].scope must be an object`);
    const covers = (c.covers ?? []) as CoverageKind[];
    if (!Array.isArray(covers) || covers.some((k) => !COVERAGE_KINDS.includes(k))) throw invalid(`components[${i}].covers is invalid`);
    if (c.taxCode !== undefined && c.taxCode !== null && (typeof c.taxCode !== 'string' || !/^[A-Z0-9_]{1,32}$/.test(c.taxCode))) throw invalid(`components[${i}].taxCode is invalid`);
    if (c.label !== undefined && c.label !== null && (typeof c.label !== 'string' || c.label.length > 120)) throw invalid(`components[${i}].label is too long`);
    if (JSON.stringify(c.params ?? {}).length > 4000) throw invalid(`components[${i}].params is too large`);
    return {
      kind,
      label: (c.label as string | null | undefined) ?? null,
      scope: (c.scope as PricingComponentInput['scope']) ?? null,
      params: (c.params as Record<string, unknown>) ?? {},
      covers,
      taxCode: (c.taxCode as string | null | undefined) ?? null,
      sortOrder: Number.isInteger(c.sortOrder) ? (c.sortOrder as number) : i,
    };
  });
}

const POLICY_KEYS: (keyof PricingPolicies)[] = ['alsoChargeTrips', 'chargeWithoutTrips', 'gpsMinPctOfPlanned', 'gpsMaxPctOfPlanned', 'sharedFareMethod', 'sharedDiscountPercent', 'sharedFixedAmount', 'allowEqualSplit', 'tripOverrideNeedsApproval', 'calendarId'];

export function sanitizePolicies(raw: unknown): PricingPolicies {
  if (raw === undefined || raw === null) return {};
  if (!isPlainObject(raw)) throw invalid('policies must be an object');
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!POLICY_KEYS.includes(k as keyof PricingPolicies)) throw invalid(`Unknown policy ${k}`);
    if (v !== undefined) out[k] = v;
  }
  for (const k of ['alsoChargeTrips', 'chargeWithoutTrips', 'allowEqualSplit', 'tripOverrideNeedsApproval'] as const) if (k in out && typeof out[k] !== 'boolean') throw invalid(`policies.${k} must be true / false`);
  for (const k of ['gpsMinPctOfPlanned', 'gpsMaxPctOfPlanned'] as const) if (k in out && (!Number.isInteger(out[k]) || (out[k] as number) < 0 || (out[k] as number) > 1000)) throw invalid(`policies.${k} must be 0–1000`);
  if ('sharedFareMethod' in out && !SHARED_FARE_METHODS.includes(out.sharedFareMethod as never)) throw invalid('policies.sharedFareMethod is invalid');
  for (const k of ['sharedDiscountPercent', 'sharedFixedAmount'] as const) if (k in out && (typeof out[k] !== 'string' || !/^\d{1,12}(\.\d{1,6})?$/.test(out[k] as string))) throw invalid(`policies.${k} must be a decimal string`);
  if ('calendarId' in out && out.calendarId !== null && typeof out.calendarId !== 'string') throw invalid('policies.calendarId is invalid');
  return out as PricingPolicies;
}

/** Engine validation (§5.5 "Validation at approval"): params per kind, ambiguous base model, double charging. */
export function assertComponentsValid(components: PricingComponentInput[], policies: PricingPolicies): void {
  const issues = validateComponents(components, policies);
  if (issues.length) throw pricingError(HttpStatus.BAD_REQUEST, 'INVALID_COMPONENTS', issues.map((i) => i.message).join('; '), { issues });
}

/**
 * QA 5: availability periods follow the contract's billing frequency. A WEEKLY / MONTHLY fee needs the same billing
 * frequency (a period is one fee period); a DAILY fee may be billed per day, week or month (not per trip).
 */
export function assertFrequencyConsistent(billingFrequency: string, components: PricingComponentInput[]): void {
  for (const c of components.filter((x) => x.kind === 'AVAILABILITY_FEE')) {
    const f = (c.params ?? {}).frequency;
    if (f === 'DAILY' ? billingFrequency === 'TRIP' : f !== billingFrequency) {
      throw pricingError(HttpStatus.BAD_REQUEST, 'INVALID_COMPONENTS', `The availability fee is ${String(f).toLowerCase()} but the contract bills ${billingFrequency.toLowerCase()}; use the same frequency (a daily fee can be billed daily, weekly or monthly)`);
    }
  }
}

export function engineComponents(rows: Prisma.PricingComponentGetPayload<object>[]): PricingComponentInput[] {
  return [...rows]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((c) => ({ kind: c.kind as PricingComponentInput['kind'], label: c.label, scope: (c.scope ?? null) as PricingComponentInput['scope'], params: (c.params ?? {}) as Record<string, unknown>, covers: c.covers as CoverageKind[], taxCode: c.taxCode, sortOrder: c.sortOrder }));
}

const componentDto = (c: Prisma.PricingComponentGetPayload<object>): PricingComponentDto => ({ id: c.id, ...engineComponents([c])[0] });

export function versionDto(v: VersionRow): PricingContractVersionDto {
  return {
    id: v.id,
    contractId: v.contractId,
    versionNo: v.versionNo,
    validFrom: ymd(v.validFrom),
    validTo: ymdOf(v.validTo),
    status: v.status as PricingVersionStatus,
    policies: (v.policies ?? {}) as PricingPolicies,
    components: [...v.components].sort((a, b) => a.sortOrder - b.sortOrder).map(componentDto),
    submittedById: v.submittedById,
    submittedAt: isoOf(v.submittedAt),
    approvedById: v.approvedById,
    approvedAt: isoOf(v.approvedAt),
    rejectReason: v.rejectReason,
    supersedesId: v.supersedesId,
    createdAt: v.createdAt.toISOString(),
  };
}

function covers(v: { validFrom: Date; validTo: Date | null }, day: string): boolean {
  const d = new Date(`${day}T00:00:00.000Z`);
  return v.validFrom <= d && (!v.validTo || v.validTo > d);
}

function summaryDto(c: ContractRow, versions: { id: string; versionNo: number; validFrom: Date; validTo: Date | null; status: string }[]): PricingContractSummaryDto {
  const current = versions.find((v) => PRICING_VERSIONS.includes(v.status) && covers(v, today()));
  return {
    id: c.id,
    name: c.name,
    reference: c.reference,
    customerCompanyId: c.customerCompanyId,
    customerName: c.customerName,
    agreementId: c.agreementId,
    currency: c.currency,
    billingFrequency: c.billingFrequency as PricingContractSummaryDto['billingFrequency'],
    status: c.status as PricingContractStatus,
    isDefault: c.isDefault,
    branchIds: c.branchIds,
    currentVersion: current ? { id: current.id, versionNo: current.versionNo, validFrom: ymd(current.validFrom), validTo: ymdOf(current.validTo) } : null,
    pendingVersionId: versions.find((v) => v.status === 'PENDING_APPROVAL')?.id ?? null,
    version: c.version,
    updatedAt: c.updatedAt.toISOString(),
  };
}

export function contractDto(c: ContractFull): PricingContractDto {
  return {
    ...summaryDto(c, c.versions),
    paymentTermsDays: c.paymentTermsDays,
    taxProfileId: c.taxProfileId,
    defaultCovers: c.defaultCovers as ('INTERNAL' | 'EXTERNAL')[],
    allowVehicleOverrides: c.allowVehicleOverrides,
    allowTripOverrides: c.allowTripOverrides,
    distanceSource: c.distanceSource as PricingContractDto['distanceSource'],
    onMissingGps: c.onMissingGps as PricingContractDto['onMissingGps'],
    roundingMode: c.roundingMode as RoundingMode,
    approvedById: c.approvedById,
    approvedAt: isoOf(c.approvedAt),
    suspendedAt: isoOf(c.suspendedAt),
    suspendedReason: c.suspendedReason,
    createdById: c.createdById,
    createdAt: c.createdAt.toISOString(),
    versions: [...c.versions].sort((a, b) => b.versionNo - a.versionNo).map(versionDto),
  };
}

function rateDto(r: Prisma.PricingVehicleRateGetPayload<object>): PricingVehicleRateDto {
  return {
    id: r.id,
    contractId: r.contractId,
    objectId: r.objectId,
    objectName: r.objectName,
    validFrom: ymd(r.validFrom),
    validTo: ymdOf(r.validTo),
    componentOverrides: (Array.isArray(r.componentOverrides) ? r.componentOverrides : []) as unknown as PricingComponentDto[],
    category: r.category,
    seats: r.seats,
    status: r.status as PricingVersionStatus,
    reason: r.reason,
    submittedById: r.submittedById,
    approvedById: r.approvedById,
    approvedAt: isoOf(r.approvedAt),
    version: r.version,
    createdAt: r.createdAt.toISOString(),
  };
}

const downtimeDto = (d: Prisma.PricingDowntimeGetPayload<object>): PricingDowntimeDto => ({ id: d.id, assignmentId: d.assignmentId, fromDate: ymd(d.fromDate), toDate: ymd(d.toDate), kind: d.kind as PricingDowntimeDto['kind'], billable: d.billable, reason: d.reason, createdAt: d.createdAt.toISOString() });

function assignmentDto(a: Prisma.PricingVehicleAssignmentGetPayload<{ include: { downtimes: true } }>): PricingVehicleAssignmentDto {
  return {
    id: a.id,
    contractId: a.contractId,
    objectId: a.objectId,
    objectName: a.objectName,
    driverId: a.driverId,
    fleetAllocationId: a.fleetAllocationId,
    branchId: a.branchId,
    validFrom: ymd(a.validFrom),
    validTo: ymdOf(a.validTo),
    operatingHours: (a.operatingHours ?? {}) as PricingVehicleAssignmentDto['operatingHours'],
    replacesAssignmentId: a.replacesAssignmentId,
    replacementBilling: a.replacementBilling as PricingVehicleAssignmentDto['replacementBilling'],
    status: a.status as 'ACTIVE' | 'ENDED',
    version: a.version,
    downtimes: a.downtimes.map(downtimeDto),
  };
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
function operatingHours(raw: unknown): Prisma.InputJsonValue {
  if (raw === undefined || raw === null) return {};
  if (!isPlainObject(raw)) throw invalid('operatingHours must be an object');
  const { from, to, weekdays } = raw as { from?: unknown; to?: unknown; weekdays?: unknown };
  if ((from !== undefined && !HHMM.test(String(from))) || (to !== undefined && !HHMM.test(String(to)))) throw invalid('operatingHours from / to are HH:MM');
  if (weekdays !== undefined && (!Array.isArray(weekdays) || weekdays.some((w) => !Number.isInteger(w) || w < 1 || w > 7))) throw invalid('operatingHours.weekdays are 1–7');
  return { ...(from !== undefined ? { from } : {}), ...(to !== undefined ? { to } : {}), ...(weekdays !== undefined ? { weekdays } : {}) } as Prisma.InputJsonValue;
}

/**
 * Doc 19 §3–§4 contracts: header + effective-dated versions with components, maker-checker approval (approver ≠
 * submitter, server-side), lifecycle, sample calculation, vehicle-level overrides (only when the contract permits) and
 * dedicated vehicles with downtime. Every change is audited in the same transaction.
 */
@Injectable()
export class PricingContractsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly settings: PricingSettingsService,
  ) {}

  // ───────────── reads ─────────────

  private async load(ctx: AuthContext, id: string, db: Db | PrismaService = this.prisma): Promise<ContractFull> {
    const c = await db.pricingContract.findFirst({ where: { id, companyId: ctx.companyId }, include: { versions: { include: { components: true } } } });
    if (!c || !contractVisible(ctx, c)) throw notFound();
    return c;
  }

  /** Locks the contract row (FOR UPDATE) and returns it, for every write. */
  private async lock(tx: Db, ctx: AuthContext, id: string): Promise<ContractFull> {
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "PricingContract" WHERE "id" = ${id}::uuid AND "companyId" = ${ctx.companyId}::uuid FOR UPDATE`;
    if (!rows.length) throw notFound();
    return this.load(ctx, id, tx);
  }

  async list(ctx: AuthContext, q: PricingContractListQuery): Promise<PricingPage<PricingContractSummaryDto>> {
    const p = paging(q);
    const where: Prisma.PricingContractWhereInput = {
      companyId: ctx.companyId,
      ...(q.status ? { status: q.status } : {}),
      ...(q.customerCompanyId ? { customerCompanyId: q.customerCompanyId } : {}),
      ...(q.q ? { OR: [{ name: { contains: q.q, mode: 'insensitive' } }, { customerName: { contains: q.q, mode: 'insensitive' } }, { reference: { contains: q.q, mode: 'insensitive' } }] } : {}),
      ...(isCompanyScope(ctx) ? {} : { OR: [{ branchIds: { isEmpty: true } }, { branchIds: { hasSome: ctx.branchIds } }] }),
    };
    const [rows, total] = await Promise.all([
      this.prisma.pricingContract.findMany({ where, orderBy: [{ status: 'asc' }, { name: 'asc' }], skip: p.skip, take: p.pageSize, include: { versions: { select: { id: true, versionNo: true, validFrom: true, validTo: true, status: true } } } }),
      this.prisma.pricingContract.count({ where }),
    ]);
    return pageOf(rows.map((r) => summaryDto(r, r.versions)), total, p);
  }

  async get(ctx: AuthContext, id: string): Promise<PricingContractDto> {
    return contractDto(await this.load(ctx, id));
  }

  async history(ctx: AuthContext, id: string) {
    await this.load(ctx, id);
    return this.audit.history(ctx, 'pricing_contract', id);
  }

  // ───────────── header ─────────────

  private async headerChecks(ctx: AuthContext, db: Db, d: { customerCompanyId: string | null; agreementId: string | null; currency: string; billingFrequency: string; taxProfileId: string | null; branchIds: string[]; isDefault: boolean; defaultCovers: string[]; distanceSource: string; onMissingGps: string; roundingMode: string; paymentTermsDays: number }) {
    if (!isCurrency(d.currency)) throw invalid('currency must be an ISO 4217 code the engine knows (e.g. INR, USD, AED, JPY, KWD)');
    if (!BILLING_FREQUENCIES.includes(d.billingFrequency as never)) throw invalid('billingFrequency is invalid');
    if (!DISTANCE_SOURCES.includes(d.distanceSource as never)) throw invalid('distanceSource is invalid');
    if (!MISSING_GPS_POLICIES.includes(d.onMissingGps as never)) throw invalid('onMissingGps is invalid');
    if (!ROUNDING_MODES.includes(d.roundingMode as never)) throw invalid('roundingMode is invalid');
    if (!Number.isInteger(d.paymentTermsDays) || d.paymentTermsDays < 0 || d.paymentTermsDays > 365) throw invalid('paymentTermsDays must be 0–365');
    if (d.isDefault && d.customerCompanyId) throw invalid('A default contract has no customer');
    if (d.defaultCovers.some((x) => x !== 'INTERNAL' && x !== 'EXTERNAL')) throw invalid('defaultCovers is INTERNAL / EXTERNAL');
    if (d.customerCompanyId === ctx.companyId) throw invalid('Internal charge-back contracts have no customer company (leave it empty)');
    if (d.customerCompanyId && !(await db.company.findUnique({ where: { id: d.customerCompanyId }, select: { id: true } }))) throw invalid('Unknown customer company');
    if (d.agreementId) {
      const a = await db.transportServiceAgreement.findUnique({ where: { id: d.agreementId }, select: { providerCompanyId: true, customerCompanyId: true } });
      // §3.1: the contract's customer must equal the agreement's customer, and this company must be its provider.
      if (!a || a.providerCompanyId !== ctx.companyId || a.customerCompanyId !== d.customerCompanyId) throw invalid('The agreement must be one where this company is the provider for the same customer');
    }
    if (d.taxProfileId && !(await db.pricingTaxProfile.findFirst({ where: { id: d.taxProfileId, companyId: ctx.companyId }, select: { id: true } }))) throw invalid('Unknown tax profile');
    if (d.branchIds.length) {
      const n = await db.branch.count({ where: { companyId: ctx.companyId, id: { in: d.branchIds } } });
      if (n !== new Set(d.branchIds).size) throw invalid('Unknown branch');
      if (!isCompanyScope(ctx) && d.branchIds.some((b) => !ctx.branchIds.includes(b))) throw forbidden('BRANCH_SCOPE', 'You can only use your own branches');
    } else if (!isCompanyScope(ctx)) throw forbidden('BRANCH_SCOPE', 'A contract for every branch needs a company-wide user; pick your branches');
  }

  async create(ctx: AuthContext, dto: CreatePricingContractRequest): Promise<PricingContractDto> {
    const policies = sanitizePolicies(dto.policies);
    const components = sanitizeComponents(dto.components ?? []);
    const validFrom = dateOnly(dto.validFrom, 'validFrom');
    const validTo = optionalDate(dto.validTo, 'validTo');
    if (validTo && validTo <= validFrom) throw invalid('validTo must be after validFrom');
    const header = {
      customerCompanyId: dto.customerCompanyId ?? null,
      agreementId: dto.agreementId ?? null,
      currency: (dto.currency ?? '').toUpperCase(),
      billingFrequency: dto.billingFrequency,
      taxProfileId: dto.taxProfileId ?? null,
      branchIds: [...new Set(dto.branchIds ?? [])],
      isDefault: !!dto.isDefault,
      defaultCovers: dto.defaultCovers ?? [],
      distanceSource: dto.distanceSource ?? 'GPS',
      onMissingGps: dto.onMissingGps ?? 'REVIEW',
      roundingMode: dto.roundingMode ?? 'HALF_UP',
      paymentTermsDays: dto.paymentTermsDays ?? 30,
    };
    const id = await this.prisma.$transaction(async (tx) => {
      await this.headerChecks(ctx, tx, header);
      let customerName = dto.customerName?.trim() ?? '';
      if (header.customerCompanyId) customerName = customerName || (await tx.company.findUniqueOrThrow({ where: { id: header.customerCompanyId }, select: { name: true } })).name;
      if (!customerName) throw invalid('customerName is required for an internal contract (the internal client / branch billed)');
      const c = await guardDb(
        tx.pricingContract.create({
          data: { companyId: ctx.companyId, ...header, customerName, name: dto.name.trim(), reference: dto.reference?.trim() || null, allowVehicleOverrides: !!dto.allowVehicleOverrides, allowTripOverrides: !!dto.allowTripOverrides, createdById: ctx.userId },
        }),
      );
      const v = await tx.pricingContractVersion.create({
        data: { companyId: ctx.companyId, contractId: c.id, versionNo: 1, validFrom, validTo, policies: asJson(policies), createdById: ctx.userId, components: { create: components.map((x) => this.componentData(ctx, x)) } },
        include: { components: true },
      });
      await this.audit.record(ctx, { action: 'CREATE', entity: 'pricing_contract', entityId: c.id, after: c }, tx);
      await this.audit.record(ctx, { action: 'CREATE', entity: 'pricing_contract_version', entityId: v.id, after: { ...v, components: v.components } }, tx);
      return c.id;
    });
    return this.get(ctx, id);
  }

  private componentData(ctx: AuthContext, c: PricingComponentInput) {
    return { companyId: ctx.companyId, kind: c.kind, label: c.label ?? null, scope: asJson(c.scope ?? {}), params: asJson(c.params ?? {}), covers: c.covers ?? [], taxCode: c.taxCode ?? null, sortOrder: c.sortOrder ?? 0 };
  }

  async update(ctx: AuthContext, id: string, dto: UpdatePricingContractRequest): Promise<PricingContractDto> {
    await this.prisma.$transaction(async (tx) => {
      const before = await this.lock(tx, ctx, id);
      assertContractWritable(ctx, before);
      if (dto.expectedVersion !== before.version) throw versionConflict(before.version);
      const draftOnly: (keyof UpdatePricingContractRequest)[] = ['currency', 'billingFrequency', 'isDefault', 'agreementId', 'distanceSource', 'onMissingGps', 'roundingMode', 'allowVehicleOverrides', 'allowTripOverrides', 'defaultCovers'];
      if (before.status !== 'DRAFT' && draftOnly.some((k) => dto[k] !== undefined && dto[k] !== (before as Record<string, unknown>)[k])) throw conflict('CONTRACT_NOT_DRAFT', 'Commercial terms of an approved contract change through a new version; only name, reference, payment terms, tax profile and branches can change now');
      const next = {
        customerCompanyId: before.customerCompanyId,
        agreementId: dto.agreementId !== undefined ? dto.agreementId : before.agreementId,
        currency: (dto.currency ?? before.currency).toUpperCase(),
        billingFrequency: dto.billingFrequency ?? before.billingFrequency,
        taxProfileId: dto.taxProfileId !== undefined ? dto.taxProfileId : before.taxProfileId,
        branchIds: dto.branchIds ? [...new Set(dto.branchIds)] : before.branchIds,
        isDefault: dto.isDefault ?? before.isDefault,
        defaultCovers: dto.defaultCovers ?? before.defaultCovers,
        distanceSource: dto.distanceSource ?? before.distanceSource,
        onMissingGps: dto.onMissingGps ?? before.onMissingGps,
        roundingMode: dto.roundingMode ?? before.roundingMode,
        paymentTermsDays: dto.paymentTermsDays ?? before.paymentTermsDays,
      };
      await this.headerChecks(ctx, tx, next);
      const after = await guardDb(
        tx.pricingContract.update({
          where: { id },
          data: { ...next, name: dto.name?.trim() ?? before.name, reference: dto.reference !== undefined ? dto.reference?.trim() || null : before.reference, customerName: dto.customerName?.trim() || before.customerName, allowVehicleOverrides: dto.allowVehicleOverrides ?? before.allowVehicleOverrides, allowTripOverrides: dto.allowTripOverrides ?? before.allowTripOverrides, version: { increment: 1 } },
        }),
      );
      const { versions: _v, ...b } = before;
      await this.audit.record(ctx, { action: 'UPDATE', entity: 'pricing_contract', entityId: id, before: b, after }, tx);
    });
    return this.get(ctx, id);
  }

  /** A DRAFT contract that never had an approved version (nothing priced with it) may be deleted. */
  async remove(ctx: AuthContext, id: string): Promise<{ ok: true }> {
    await this.prisma.$transaction(async (tx) => {
      const c = await this.lock(tx, ctx, id);
      assertContractWritable(ctx, c);
      if (c.status !== 'DRAFT' || c.versions.some((v) => PRICING_VERSIONS.includes(v.status))) throw conflict('CONTRACT_NOT_DRAFT', 'Only a draft contract that was never approved can be deleted; expire it instead');
      const used = await tx.tripPriceSnapshot.count({ where: { companyId: ctx.companyId, contractId: id } });
      if (used || (await tx.pricingVehicleRate.count({ where: { contractId: id } })) || (await tx.pricingVehicleAssignment.count({ where: { contractId: id } }))) throw conflict('CONTRACT_NOT_DRAFT', 'The contract has vehicles, rates or prices; expire it instead');
      await tx.pricingContractVersion.deleteMany({ where: { contractId: id } });
      await tx.pricingContract.delete({ where: { id } });
      const { versions: _v, ...b } = c;
      await this.audit.record(ctx, { action: 'DELETE', entity: 'pricing_contract', entityId: id, before: b }, tx);
    });
    return { ok: true };
  }

  // ───────────── versions ─────────────

  async createVersion(ctx: AuthContext, id: string, dto: CreatePricingVersionRequest): Promise<PricingContractDto> {
    await this.prisma.$transaction(async (tx) => {
      const c = await this.lock(tx, ctx, id);
      assertContractWritable(ctx, c);
      if (c.status === 'EXPIRED') throw conflict('CONTRACT_NOT_ACTIVE', 'The contract has expired');
      if (c.versions.some((v) => v.status === 'DRAFT' || v.status === 'PENDING_APPROVAL')) throw conflict('VALIDATION_FAILED', 'Finish (approve / reject) the open draft version first');
      const validFrom = dateOnly(dto.validFrom, 'validFrom');
      const validTo = optionalDate(dto.validTo, 'validTo');
      if (validTo && validTo <= validFrom) throw invalid('validTo must be after validFrom');
      const source = dto.copyFromVersionId ? c.versions.find((v) => v.id === dto.copyFromVersionId) : [...c.versions].sort((a, b) => b.versionNo - a.versionNo)[0];
      if (dto.copyFromVersionId && !source) throw notFound();
      const components = dto.components ? sanitizeComponents(dto.components) : source ? engineComponents(source.components) : [];
      const policies = dto.policies ? sanitizePolicies(dto.policies) : ((source?.policies ?? {}) as PricingPolicies);
      const versionNo = Math.max(0, ...c.versions.map((v) => v.versionNo)) + 1;
      const v = await tx.pricingContractVersion.create({
        data: { companyId: ctx.companyId, contractId: id, versionNo, validFrom, validTo, policies: asJson(policies), createdById: ctx.userId, components: { create: components.map((x) => this.componentData(ctx, x)) } },
        include: { components: true },
      });
      await this.audit.record(ctx, { action: 'CREATE', entity: 'pricing_contract_version', entityId: v.id, after: { ...v, components: v.components } }, tx);
    });
    return this.get(ctx, id);
  }

  private draftVersion(c: ContractFull, versionId: string): VersionRow {
    const v = c.versions.find((x) => x.id === versionId);
    if (!v) throw notFound();
    return v;
  }

  async replaceComponents(ctx: AuthContext, id: string, versionId: string, dto: ReplacePricingComponentsRequest): Promise<PricingContractDto> {
    const components = sanitizeComponents(dto.components);
    await this.prisma.$transaction(async (tx) => {
      const c = await this.lock(tx, ctx, id);
      assertContractWritable(ctx, c);
      const v = this.draftVersion(c, versionId);
      if (v.status !== 'DRAFT' && v.status !== 'REJECTED') throw conflict('CONTRACT_VERSION_IMMUTABLE', 'Only a draft (or rejected) version can be edited; create a new version');
      const validFrom = dto.validFrom ? dateOnly(dto.validFrom, 'validFrom') : v.validFrom;
      const validTo = dto.validTo !== undefined ? optionalDate(dto.validTo, 'validTo') : v.validTo;
      if (validTo && validTo <= validFrom) throw invalid('validTo must be after validFrom');
      await tx.pricingComponent.deleteMany({ where: { versionId } });
      const after = await guardDb(
        tx.pricingContractVersion.update({
          where: { id: versionId },
          data: { status: 'DRAFT', rejectReason: null, lastEditedById: ctx.userId, validFrom, validTo, ...(dto.policies !== undefined ? { policies: asJson(sanitizePolicies(dto.policies)) } : {}), components: { create: components.map((x) => this.componentData(ctx, x)) } },
          include: { components: true },
        }),
      );
      await this.audit.record(ctx, { action: 'UPDATE', entity: 'pricing_contract_version', entityId: versionId, before: { ...v, components: v.components }, after: { ...after, components: after.components } }, tx);
    });
    return this.get(ctx, id);
  }

  async submit(ctx: AuthContext, id: string, versionId: string): Promise<PricingContractDto> {
    await this.prisma.$transaction(async (tx) => {
      const c = await this.lock(tx, ctx, id);
      assertContractWritable(ctx, c);
      const v = this.draftVersion(c, versionId);
      if (v.status !== 'DRAFT') throw conflict('CONTRACT_NOT_DRAFT', 'Only a draft version can be submitted');
      const components = engineComponents(v.components);
      if (!components.length) throw pricingError(HttpStatus.BAD_REQUEST, 'INVALID_COMPONENTS', 'A version needs at least one pricing component');
      assertComponentsValid(components, (v.policies ?? {}) as PricingPolicies);
      assertFrequencyConsistent(c.billingFrequency, components);
      const now = new Date();
      await tx.pricingContractVersion.update({ where: { id: versionId }, data: { status: 'PENDING_APPROVAL', submittedById: ctx.userId, submittedAt: now } });
      if (c.status === 'DRAFT') await tx.pricingContract.update({ where: { id }, data: { status: 'PENDING_APPROVAL', submittedById: ctx.userId, submittedAt: now, version: { increment: 1 } } });
      await this.audit.record(ctx, { action: 'UPDATE', entity: 'pricing_contract_version', entityId: versionId, details: { event: 'SUBMITTED', contractId: id, versionNo: v.versionNo } }, tx);
    });
    return this.get(ctx, id);
  }

  /**
   * Maker-checker (§9.3): the approver must hold pricing_contracts:approve AND not be the user who submitted the version
   * (owner decision 5 default: two users always, also in single-admin companies; the Super Admin is no exception).
   * Activates the version; an earlier ACTIVE version overlapping it is closed at the new validFrom and SUPERSEDED.
   */
  async approve(ctx: AuthContext, id: string, versionId: string, note?: string | null): Promise<PricingContractDto> {
    await this.prisma.$transaction(async (tx) => {
      const c = await this.lock(tx, ctx, id);
      const v = this.draftVersion(c, versionId);
      if (v.status !== 'PENDING_APPROVAL') throw conflict('CONTRACT_NOT_DRAFT', 'Only a version waiting for approval can be approved');
      // QA 10: the approver is neither the submitter nor the author / last editor of the version.
      if (!v.submittedById || [v.submittedById, v.createdById, v.lastEditedById].includes(ctx.userId)) throw forbidden('MAKER_CHECKER_SAME_USER', 'A version must be approved by a different user than the one who wrote or submitted it');
      if (c.status === 'EXPIRED') throw conflict('CONTRACT_NOT_ACTIVE', 'The contract has expired');
      if (!c.taxProfileId) throw pricingError(HttpStatus.CONFLICT, 'TAX_PROFILE_MISSING', 'Pick the contract tax profile before approval (no tax rate is ever assumed)');
      if (c.agreementId) {
        const a = await tx.transportServiceAgreement.findUnique({ where: { id: c.agreementId }, select: { status: true } });
        if (a?.status !== 'ACTIVE') throw conflict('CONTRACT_NOT_ACTIVE', 'The linked service agreement must be ACTIVE');
      }
      assertComponentsValid(engineComponents(v.components), (v.policies ?? {}) as PricingPolicies);
      assertFrequencyConsistent(c.billingFrequency, engineComponents(v.components));
      let supersedesId: string | null = null;
      for (const prev of c.versions.filter((x) => x.status === 'ACTIVE' && x.id !== v.id)) {
        const overlaps = (!prev.validTo || prev.validTo > v.validFrom) && (!v.validTo || v.validTo > prev.validFrom);
        if (!overlaps) continue;
        if (prev.validFrom >= v.validFrom) throw conflict('CONTRACT_OVERLAP', `Version ${prev.versionNo} starts on or after ${ymd(v.validFrom)}; a new version must start after the version it replaces`);
        await guardDb(tx.pricingContractVersion.update({ where: { id: prev.id }, data: { status: 'SUPERSEDED', validTo: v.validFrom } }));
        supersedesId = prev.id;
        await this.audit.record(ctx, { action: 'UPDATE', entity: 'pricing_contract_version', entityId: prev.id, details: { event: 'SUPERSEDED', by: v.id, validTo: ymd(v.validFrom) } }, tx);
      }
      const now = new Date();
      await guardDb(tx.pricingContractVersion.update({ where: { id: versionId }, data: { status: 'ACTIVE', approvedById: ctx.userId, approvedAt: now, supersedesId } }));
      await tx.pricingContract.update({ where: { id }, data: { status: c.status === 'SUSPENDED' ? 'SUSPENDED' : 'ACTIVE', approvedById: ctx.userId, approvedAt: now, version: { increment: 1 } } });
      await this.audit.record(ctx, { action: 'UPDATE', entity: 'pricing_contract_version', entityId: versionId, details: { event: 'APPROVED', contractId: id, versionNo: v.versionNo, submittedById: v.submittedById, approvedById: ctx.userId, note: note ?? null } }, tx);
    });
    return this.get(ctx, id);
  }

  async reject(ctx: AuthContext, id: string, versionId: string, reason: string): Promise<PricingContractDto> {
    const why = reasonOf(reason);
    await this.prisma.$transaction(async (tx) => {
      const c = await this.lock(tx, ctx, id);
      const v = this.draftVersion(c, versionId);
      if (v.status !== 'PENDING_APPROVAL') throw conflict('CONTRACT_NOT_DRAFT', 'Only a version waiting for approval can be rejected');
      if ([v.submittedById, v.createdById, v.lastEditedById].includes(ctx.userId)) throw forbidden('MAKER_CHECKER_SAME_USER', 'The author or submitter cannot decide on their own version');
      await tx.pricingContractVersion.update({ where: { id: versionId }, data: { status: 'REJECTED', rejectReason: why } });
      if (c.status === 'PENDING_APPROVAL') await tx.pricingContract.update({ where: { id }, data: { status: 'DRAFT', version: { increment: 1 } } });
      await this.audit.record(ctx, { action: 'UPDATE', entity: 'pricing_contract_version', entityId: versionId, details: { event: 'REJECTED', contractId: id, reason: why } }, tx);
    });
    return this.get(ctx, id);
  }

  async lifecycle(ctx: AuthContext, id: string, action: 'suspend' | 'resume' | 'expire', dto: { reason: string; expectedVersion: number }): Promise<PricingContractDto> {
    const why = reasonOf(dto.reason);
    await this.prisma.$transaction(async (tx) => {
      const c = await this.lock(tx, ctx, id);
      if (dto.expectedVersion !== c.version) throw versionConflict(c.version);
      const allowed: Record<typeof action, string[]> = { suspend: ['ACTIVE'], resume: ['SUSPENDED'], expire: ['ACTIVE', 'SUSPENDED', 'DRAFT', 'PENDING_APPROVAL'] };
      if (!allowed[action].includes(c.status)) throw conflict('CONTRACT_NOT_ACTIVE', `A ${c.status} contract cannot be ${action === 'expire' ? 'expired' : `${action}ed`}`);
      const data: Prisma.PricingContractUpdateInput =
        action === 'suspend' ? { status: 'SUSPENDED', suspendedAt: new Date(), suspendedReason: why } : action === 'resume' ? { status: 'ACTIVE', suspendedAt: null, suspendedReason: null } : { status: 'EXPIRED' };
      const after = await tx.pricingContract.update({ where: { id }, data: { ...data, version: { increment: 1 } } });
      const { versions: _v, ...b } = c;
      await this.audit.record(ctx, { action: 'UPDATE', entity: 'pricing_contract', entityId: id, before: b, after: { ...after, _event: action.toUpperCase(), _reason: why } }, tx);
      await this.audit.record(ctx, { action: 'UPDATE', entity: 'pricing_contract', entityId: id, details: { event: action.toUpperCase(), reason: why } }, tx);
    });
    return this.get(ctx, id);
  }

  // ───────────── pricing lookups (also used by trip pricing / availability) ─────────────

  /** The ACTIVE / SUPERSEDED version covering `day`, with components. */
  async versionFor(db: Db | PrismaService, contractId: string, day: string): Promise<VersionRow | null> {
    const d = new Date(`${day}T00:00:00.000Z`);
    return db.pricingContractVersion.findFirst({ where: { contractId, status: { in: PRICING_VERSIONS }, validFrom: { lte: d }, OR: [{ validTo: null }, { validTo: { gt: d } }] }, include: { components: true } });
  }

  /** Vehicle rate of `objectId` ACTIVE on `day`; `permitted` false when the contract does not allow overrides (§5.7 order 2). */
  async vehicleRateFor(db: Db | PrismaService, contract: { id: string; allowVehicleOverrides: boolean }, objectId: string | null, day: string): Promise<{ rate: Prisma.PricingVehicleRateGetPayload<object> | null; permitted: boolean }> {
    if (!objectId) return { rate: null, permitted: contract.allowVehicleOverrides };
    const d = new Date(`${day}T00:00:00.000Z`);
    const rate = await db.pricingVehicleRate.findFirst({ where: { contractId: contract.id, objectId, status: { in: PRICING_VERSIONS }, validFrom: { lte: d }, OR: [{ validTo: null }, { validTo: { gt: d } }] } });
    return { rate, permitted: contract.allowVehicleOverrides };
  }

  /** Sample calculation (§6 contract screen): nothing is stored. */
  async preview(ctx: AuthContext, id: string, dto: PricingPreviewRequest): Promise<PricingPreviewResponse> {
    const c = await this.load(ctx, id);
    let components: PricingComponentInput[];
    let policies: PricingPolicies;
    if (dto.components) {
      components = sanitizeComponents(dto.components);
      policies = sanitizePolicies(dto.policies);
    } else {
      const ordered = [...c.versions].sort((a, b) => b.versionNo - a.versionNo);
      const v = dto.versionId ? c.versions.find((x) => x.id === dto.versionId) : (ordered.find((x) => x.status === 'DRAFT' || x.status === 'PENDING_APPROVAL') ?? ordered.find((x) => x.status === 'ACTIVE' && covers(x, today())) ?? ordered[0]);
      if (!v) throw notFound();
      components = engineComponents(v.components);
      policies = dto.policies ? sanitizePolicies(dto.policies) : ((v.policies ?? {}) as PricingPolicies);
    }
    const roundingMode = c.roundingMode as RoundingMode;
    if (dto.kind === 'TRIP') {
      const t = dto.trip;
      if (!t || !isYmd(t.serviceDate)) throw invalid('trip.serviceDate is required');
      const facts: TripFacts = { ...t, tollsMinor: t.tollsMinor ? BigInt(/^\d{1,15}$/.test(t.tollsMinor) ? t.tollsMinor : '0') : null };
      for (const k of ['billableDistanceM', 'actualDurationS', 'reservedDurationS', 'waitingS', 'stops', 'passengers', 'cancelledMinutesBefore', 'startMinuteOfDay', 'seats'] as const) {
        const v = facts[k];
        if (v !== undefined && v !== null && (!Number.isInteger(v) || v < 0 || v > 100_000_000)) throw invalid(`trip.${k} must be a whole number 0–100000000`);
      }
      if (dto.objectId) {
        const { rate, permitted } = await this.vehicleRateFor(this.prisma, c, dto.objectId, t.serviceDate);
        if (rate && permitted) components = mergeVehicleOverrides(components, sanitizeComponents(rate.componentOverrides));
      }
      const tax = await this.settings.taxConfigFor(this.prisma, ctx.companyId, c, t.serviceDate, dto.buyerStateCode);
      return resultDto(priceTrip({ currency: c.currency, roundingMode, components, policies, facts, tax, estimate: false }));
    }
    const p = dto.period as PeriodFacts | undefined;
    if (!p || !isYmd(p.periodStart) || !isYmd(p.periodEnd) || !AVAILABILITY_FREQUENCIES.includes(p.frequency)) throw invalid('period needs frequency, periodStart and periodEnd');
    for (const k of ['attachedDays', 'downtimeDays', 'suspensionDays', 'replacementCoveredDays', 'holidayDaysWorked', 'usedDistanceM', 'usedDurationS', 'overtimeS', 'tripCount'] as const) {
      const v = p[k];
      if (v !== undefined && v !== null && (!Number.isInteger(v) || v < 0 || v > 100_000_000)) throw invalid(`period.${k} must be a whole number`);
    }
    const tax = await this.settings.taxConfigFor(this.prisma, ctx.companyId, c, p.periodEnd, dto.buyerStateCode);
    return resultDto(pricePeriod({ currency: c.currency, roundingMode, components, policies, facts: p, tax }));
  }

  // ───────────── vehicle rates ─────────────

  async listVehicleRates(ctx: AuthContext, contractId: string): Promise<PricingVehicleRateDto[]> {
    await this.load(ctx, contractId);
    const rows = await this.prisma.pricingVehicleRate.findMany({ where: { companyId: ctx.companyId, contractId }, orderBy: [{ objectName: 'asc' }, { validFrom: 'desc' }] });
    return rows.map(rateDto);
  }

  private async objectOf(db: Db, ctx: AuthContext, objectId: string) {
    const o = await db.trackedObject.findFirst({ where: { id: objectId, companyId: ctx.companyId }, select: { id: true, name: true, branchId: true } });
    if (!o) throw invalid('Unknown vehicle');
    if (!isCompanyScope(ctx) && !(o.branchId && ctx.branchIds.includes(o.branchId)) && !ctx.objectIds.includes(o.id)) throw invalid('Unknown vehicle');
    return o;
  }

  async createVehicleRate(ctx: AuthContext, contractId: string, dto: CreatePricingVehicleRateRequest): Promise<PricingVehicleRateDto> {
    const overrides = sanitizeComponents(dto.componentOverrides);
    if (!overrides.length) throw invalid('componentOverrides needs at least one component');
    const validFrom = dateOnly(dto.validFrom, 'validFrom');
    const validTo = optionalDate(dto.validTo, 'validTo');
    if (validTo && validTo <= validFrom) throw invalid('validTo must be after validFrom');
    return this.prisma.$transaction(async (tx) => {
      const c = await this.lock(tx, ctx, contractId);
      assertContractWritable(ctx, c);
      // §3.2: server-enforced; the UI hides the action too.
      if (!c.allowVehicleOverrides) throw conflict('VEHICLE_OVERRIDE_NOT_PERMITTED', 'This contract does not permit vehicle-level rates');
      const o = await this.objectOf(tx, ctx, dto.objectId);
      const profile = await tx.transportVehicleProfile.findUnique({ where: { objectId: o.id }, select: { category: true, seats: true } });
      const row = await tx.pricingVehicleRate.create({
        data: { companyId: ctx.companyId, contractId, objectId: o.id, objectName: o.name, validFrom, validTo, componentOverrides: asJson(overrides), category: profile?.category ?? null, seats: profile?.seats ?? null, reason: dto.reason?.trim() || null, createdById: ctx.userId },
      });
      await this.audit.record(ctx, { action: 'CREATE', entity: 'pricing_vehicle_rate', entityId: row.id, after: row }, tx);
      return rateDto(row);
    });
  }

  private async lockRate(tx: Db, ctx: AuthContext, contractId: string, rateId: string) {
    const c = await this.lock(tx, ctx, contractId);
    const r = await tx.pricingVehicleRate.findFirst({ where: { id: rateId, contractId, companyId: ctx.companyId } });
    if (!r) throw notFound();
    return { c, r };
  }

  async updateVehicleRate(ctx: AuthContext, contractId: string, rateId: string, dto: UpdatePricingVehicleRateRequest): Promise<PricingVehicleRateDto> {
    return this.prisma.$transaction(async (tx) => {
      const { c, r } = await this.lockRate(tx, ctx, contractId, rateId);
      assertContractWritable(ctx, c);
      if (!c.allowVehicleOverrides) throw conflict('VEHICLE_OVERRIDE_NOT_PERMITTED', 'This contract does not permit vehicle-level rates');
      if (dto.expectedVersion !== r.version) throw versionConflict(r.version);
      if (r.status !== 'DRAFT' && r.status !== 'REJECTED') throw conflict('CONTRACT_VERSION_IMMUTABLE', 'An approved vehicle rate cannot be changed; add a new one from a later date');
      const validFrom = dto.validFrom ? dateOnly(dto.validFrom, 'validFrom') : r.validFrom;
      const validTo = dto.validTo !== undefined ? optionalDate(dto.validTo, 'validTo') : r.validTo;
      if (validTo && validTo <= validFrom) throw invalid('validTo must be after validFrom');
      const after = await tx.pricingVehicleRate.update({
        where: { id: rateId },
        data: { status: 'DRAFT', lastEditedById: ctx.userId, validFrom, validTo, ...(dto.componentOverrides ? { componentOverrides: asJson(sanitizeComponents(dto.componentOverrides)) } : {}), ...(dto.reason !== undefined ? { reason: dto.reason?.trim() || null } : {}), version: { increment: 1 } },
      });
      await this.audit.record(ctx, { action: 'UPDATE', entity: 'pricing_vehicle_rate', entityId: rateId, before: r, after }, tx);
      return rateDto(after);
    });
  }

  async decideVehicleRate(ctx: AuthContext, contractId: string, rateId: string, decision: 'submit' | 'approve' | 'reject', reason?: string): Promise<PricingVehicleRateDto> {
    return this.prisma.$transaction(async (tx) => {
      const { c, r } = await this.lockRate(tx, ctx, contractId, rateId);
      if (!c.allowVehicleOverrides) throw conflict('VEHICLE_OVERRIDE_NOT_PERMITTED', 'This contract does not permit vehicle-level rates');
      let data: Prisma.PricingVehicleRateUpdateInput;
      if (decision === 'submit') {
        assertContractWritable(ctx, c);
        if (r.status !== 'DRAFT') throw conflict('CONTRACT_NOT_DRAFT', 'Only a draft rate can be submitted');
        data = { status: 'PENDING_APPROVAL', submittedById: ctx.userId };
      } else {
        if (r.status !== 'PENDING_APPROVAL') throw conflict('CONTRACT_NOT_DRAFT', 'Only a rate waiting for approval can be decided');
        if (!r.submittedById || [r.submittedById, r.createdById, r.lastEditedById].includes(ctx.userId)) throw forbidden('MAKER_CHECKER_SAME_USER', 'A vehicle rate must be approved by a different user than the one who wrote or submitted it');
        if (decision === 'reject') data = { status: 'REJECTED', reason: reasonOf(reason) };
        else {
          const prev = await tx.pricingVehicleRate.findMany({ where: { contractId, objectId: r.objectId, status: 'ACTIVE', id: { not: r.id } } });
          for (const p of prev) {
            if (!((!p.validTo || p.validTo > r.validFrom) && (!r.validTo || r.validTo > p.validFrom))) continue;
            if (p.validFrom >= r.validFrom) throw conflict('CONTRACT_OVERLAP', 'An approved rate for this vehicle starts on or after this one');
            await tx.pricingVehicleRate.update({ where: { id: p.id }, data: { status: 'SUPERSEDED', validTo: r.validFrom, version: { increment: 1 } } });
          }
          data = { status: 'ACTIVE', approvedById: ctx.userId, approvedAt: new Date() };
        }
      }
      const after = await guardDb(tx.pricingVehicleRate.update({ where: { id: rateId }, data: { ...data, version: { increment: 1 } } }));
      await this.audit.record(ctx, { action: 'UPDATE', entity: 'pricing_vehicle_rate', entityId: rateId, before: r, after: { ...after, _event: decision.toUpperCase() } }, tx);
      return rateDto(after);
    });
  }

  // ───────────── dedicated vehicles ─────────────

  async listAssignments(ctx: AuthContext, contractId: string): Promise<PricingVehicleAssignmentDto[]> {
    await this.load(ctx, contractId);
    const rows = await this.prisma.pricingVehicleAssignment.findMany({ where: { companyId: ctx.companyId, contractId }, include: { downtimes: { orderBy: { fromDate: 'asc' } } }, orderBy: [{ status: 'asc' }, { objectName: 'asc' }] });
    return rows.map(assignmentDto);
  }

  async createAssignment(ctx: AuthContext, contractId: string, dto: CreatePricingVehicleAssignmentRequest): Promise<PricingVehicleAssignmentDto> {
    const validFrom = dateOnly(dto.validFrom, 'validFrom');
    const validTo = optionalDate(dto.validTo, 'validTo');
    if (validTo && validTo <= validFrom) throw invalid('validTo must be after validFrom');
    if (dto.replacementBilling && !REPLACEMENT_BILLING.includes(dto.replacementBilling)) throw invalid('replacementBilling is ORIGINAL / SEPARATE');
    const hours = operatingHours(dto.operatingHours);
    return this.prisma.$transaction(async (tx) => {
      const c = await this.lock(tx, ctx, contractId);
      assertContractWritable(ctx, c);
      if (c.status === 'EXPIRED') throw conflict('CONTRACT_NOT_ACTIVE', 'The contract has expired');
      const o = await this.objectOf(tx, ctx, dto.objectId);
      if (dto.replacesAssignmentId && !(await tx.pricingVehicleAssignment.findFirst({ where: { id: dto.replacesAssignmentId, contractId } }))) throw invalid('replacesAssignmentId must be a vehicle of the same contract');
      if (dto.fleetAllocationId && !(await tx.transportFleetAllocation.findFirst({ where: { id: dto.fleetAllocationId, providerCompanyId: ctx.companyId } }))) throw invalid('Unknown fleet allocation');
      if (dto.driverId && !(await tx.driver.findFirst({ where: { id: dto.driverId, companyId: ctx.companyId } }))) throw invalid('Unknown driver');
      const branchId = dto.branchId ?? o.branchId ?? null;
      if (branchId && !(await tx.branch.findFirst({ where: { id: branchId, companyId: ctx.companyId } }))) throw invalid('Unknown branch');
      const row = await tx.pricingVehicleAssignment.create({
        data: { companyId: ctx.companyId, contractId, objectId: o.id, objectName: o.name, driverId: dto.driverId ?? null, fleetAllocationId: dto.fleetAllocationId ?? null, branchId, validFrom, validTo, operatingHours: hours, replacesAssignmentId: dto.replacesAssignmentId ?? null, replacementBilling: dto.replacementBilling ?? (dto.replacesAssignmentId ? 'ORIGINAL' : 'SEPARATE'), createdById: ctx.userId },
        include: { downtimes: true },
      });
      await this.audit.record(ctx, { action: 'CREATE', entity: 'pricing_vehicle_assignment', entityId: row.id, after: row }, tx);
      return assignmentDto(row);
    });
  }

  async updateAssignment(ctx: AuthContext, contractId: string, assignmentId: string, dto: UpdatePricingVehicleAssignmentRequest): Promise<PricingVehicleAssignmentDto> {
    return this.prisma.$transaction(async (tx) => {
      const c = await this.lock(tx, ctx, contractId);
      assertContractWritable(ctx, c);
      const a = await tx.pricingVehicleAssignment.findFirst({ where: { id: assignmentId, contractId, companyId: ctx.companyId } });
      if (!a) throw notFound();
      if (dto.expectedVersion !== a.version) throw versionConflict(a.version);
      const validTo = dto.validTo !== undefined ? optionalDate(dto.validTo, 'validTo') : a.validTo;
      if (validTo && validTo <= a.validFrom) throw invalid('validTo must be after validFrom');
      if (dto.status && dto.status !== 'ACTIVE' && dto.status !== 'ENDED') throw invalid('status is ACTIVE / ENDED');
      const after = await tx.pricingVehicleAssignment.update({ where: { id: assignmentId }, data: { validTo, ...(dto.operatingHours !== undefined ? { operatingHours: operatingHours(dto.operatingHours) } : {}), ...(dto.status ? { status: dto.status } : {}), version: { increment: 1 } }, include: { downtimes: true } });
      const { downtimes: _d, ...b } = after;
      await this.audit.record(ctx, { action: 'UPDATE', entity: 'pricing_vehicle_assignment', entityId: assignmentId, before: a, after: b }, tx);
      return assignmentDto(after);
    });
  }

  async addDowntime(ctx: AuthContext, contractId: string, assignmentId: string, dto: CreatePricingDowntimeRequest): Promise<PricingVehicleAssignmentDto> {
    const fromDate = dateOnly(dto.fromDate, 'fromDate');
    const toDate = dateOnly(dto.toDate, 'toDate');
    if (toDate < fromDate) throw invalid('toDate must not be before fromDate');
    if (!DOWNTIME_KINDS.includes(dto.kind)) throw invalid('kind is invalid');
    const reason = reasonOf(dto.reason);
    return this.prisma.$transaction(async (tx) => {
      const c = await this.lock(tx, ctx, contractId);
      assertContractWritable(ctx, c);
      const a = await tx.pricingVehicleAssignment.findFirst({ where: { id: assignmentId, contractId, companyId: ctx.companyId } });
      if (!a) throw notFound();
      const row = await tx.pricingDowntime.create({ data: { companyId: ctx.companyId, assignmentId, fromDate, toDate, kind: dto.kind, billable: !!dto.billable, reason, createdById: ctx.userId } });
      await this.audit.record(ctx, { action: 'CREATE', entity: 'pricing_downtime', entityId: row.id, after: row }, tx);
      return assignmentDto(await tx.pricingVehicleAssignment.findUniqueOrThrow({ where: { id: assignmentId }, include: { downtimes: { orderBy: { fromDate: 'asc' } } } }));
    });
  }
}

import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  formatMicro,
  isYmd,
  percentToPpm,
  TAX_REGIMES,
  type BillingSupplierProfileDto,
  type CreatePricingTaxProfileRequest,
  type CreatePricingTaxRateRequest,
  type PricingCalendarDto,
  type PricingTaxProfileDto,
  type TaxConfig,
  type TaxRegime,
  type UpsertBillingSupplierProfileRequest,
  type UpsertPricingCalendarRequest,
} from '@veetracer/shared';
import type { AuthContext } from '../access/auth-context';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { conflict, dateOnly, invalid, notFound, optionalDate, pricingError, versionConflict, ymd, ymdOf, type Db } from './pricing-common';

const TAX_CODE_RE = /^[A-Z0-9_]{1,32}$/;

type ProfileRow = Prisma.PricingTaxProfileGetPayload<{ include: { rates: true } }>;

export function supplierDto(r: Prisma.BillingSupplierProfileGetPayload<object>): BillingSupplierProfileDto {
  return {
    companyId: r.companyId,
    legalName: r.legalName,
    address: r.address,
    city: r.city,
    stateCode: r.stateCode,
    country: r.country,
    taxRegime: r.taxRegime as TaxRegime,
    taxRegistration: r.taxRegistration,
    invoicePrefix: r.invoicePrefix,
    creditNotePrefix: r.creditNotePrefix,
    fiscalYearStartMonth: r.fiscalYearStartMonth,
    email: r.email,
    phone: r.phone,
    bankDetails: (r.bankDetails ?? {}) as Record<string, string>,
    version: r.version,
  };
}

function profileDto(p: ProfileRow): PricingTaxProfileDto {
  return {
    id: p.id,
    name: p.name,
    regime: p.regime as TaxRegime,
    jurisdiction: p.jurisdiction,
    defaultTaxCode: p.defaultTaxCode,
    rates: p.rates
      .sort((a, b) => a.taxCode.localeCompare(b.taxCode) || a.validFrom.getTime() - b.validFrom.getTime())
      .map((r) => ({ id: r.id, taxCode: r.taxCode, label: r.label, ratePpm: r.ratePpm, ratePercent: trimZeros(formatMicro(BigInt(r.ratePpm) * 100n, 6)), sac: r.sac, validFrom: ymd(r.validFrom), validTo: ymdOf(r.validTo) })),
  };
}
/** ppm × 100 at 6 places = percent at 4 places ("18.000000" → "18"). */
function trimZeros(s: string): string {
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

/**
 * Doc 19 §3.2 / §5.6: supplier legal / tax / numbering settings and tax profiles with effective-dated rates. No rate is
 * ever assumed: a contract without a tax profile (or a rate missing for a date) prices with TAX_PROFILE_MISSING.
 */
@Injectable()
export class PricingSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async getSupplier(ctx: AuthContext): Promise<BillingSupplierProfileDto | null> {
    const r = await this.prisma.billingSupplierProfile.findUnique({ where: { companyId: ctx.companyId } });
    return r ? supplierDto(r) : null;
  }

  async putSupplier(ctx: AuthContext, dto: UpsertBillingSupplierProfileRequest): Promise<BillingSupplierProfileDto> {
    if (!TAX_REGIMES.includes(dto.taxRegime)) throw invalid('taxRegime is invalid');
    const fy = dto.fiscalYearStartMonth ?? (dto.taxRegime === 'IN_GST' ? 4 : 1);
    if (!Number.isInteger(fy) || fy < 1 || fy > 12) throw invalid('fiscalYearStartMonth must be 1–12');
    if (dto.taxRegime === 'IN_GST' && !/^\d{2}$/.test(dto.stateCode ?? '')) throw invalid('India GST needs the two-digit GST state code of the supplier');
    for (const p of [dto.invoicePrefix, dto.creditNotePrefix]) if (p !== undefined && !/^[A-Za-z0-9\-]{0,16}$/.test(p)) throw invalid('Prefixes are up to 16 letters, digits or -');
    const data = {
      legalName: dto.legalName.trim(),
      address: dto.address.trim(),
      city: dto.city?.trim() ?? '',
      stateCode: dto.stateCode ?? null,
      country: (dto.country ?? 'IN').toUpperCase(),
      taxRegime: dto.taxRegime,
      taxRegistration: dto.taxRegistration?.trim() || null,
      invoicePrefix: dto.invoicePrefix ?? 'INV',
      creditNotePrefix: dto.creditNotePrefix ?? 'CN',
      fiscalYearStartMonth: fy,
      email: dto.email ?? null,
      phone: dto.phone ?? null,
      bankDetails: (dto.bankDetails ?? {}) as Prisma.InputJsonValue,
    };
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.billingSupplierProfile.findUnique({ where: { companyId: ctx.companyId } });
      let row;
      if (!before) {
        row = await tx.billingSupplierProfile.create({ data: { companyId: ctx.companyId, ...data } });
      } else {
        if (dto.expectedVersion !== before.version) throw versionConflict(before.version);
        const n = await tx.billingSupplierProfile.updateMany({ where: { companyId: ctx.companyId, version: before.version }, data: { ...data, version: { increment: 1 } } });
        if (!n.count) throw versionConflict(before.version);
        row = await tx.billingSupplierProfile.findUniqueOrThrow({ where: { companyId: ctx.companyId } });
      }
      await this.audit.record(ctx, { action: before ? 'UPDATE' : 'CREATE', entity: 'billing_supplier_profile', entityId: ctx.companyId, before: before ?? null, after: row }, tx);
      return supplierDto(row);
    });
  }

  async listTaxProfiles(ctx: AuthContext): Promise<PricingTaxProfileDto[]> {
    const rows = await this.prisma.pricingTaxProfile.findMany({ where: { companyId: ctx.companyId }, include: { rates: true }, orderBy: { name: 'asc' } });
    return rows.map(profileDto);
  }

  private rateData(ctx: AuthContext, r: CreatePricingTaxRateRequest) {
    if (!TAX_CODE_RE.test(r.taxCode ?? '')) throw invalid('taxCode must be 1–32 of A-Z, 0-9, _');
    if (r.taxCode === 'EXEMPT') throw invalid("'EXEMPT' is reserved (no tax)");
    let ppm: number;
    try {
      ppm = percentToPpm(r.ratePercent);
    } catch {
      throw invalid('ratePercent must be a decimal percent such as "18"');
    }
    if (ppm < 0 || ppm > 1_000_000) throw invalid('ratePercent must be 0–100');
    const validFrom = dateOnly(r.validFrom, 'validFrom');
    const validTo = optionalDate(r.validTo, 'validTo');
    if (validTo && validTo <= validFrom) throw invalid('validTo must be after validFrom');
    return { companyId: ctx.companyId, taxCode: r.taxCode, label: (r.label ?? r.taxCode).trim(), ratePpm: ppm, sac: r.sac ?? null, validFrom, validTo };
  }

  async createTaxProfile(ctx: AuthContext, dto: CreatePricingTaxProfileRequest): Promise<PricingTaxProfileDto> {
    if (!TAX_REGIMES.includes(dto.regime)) throw invalid('regime is invalid');
    const rates = (dto.rates ?? []).map((r) => this.rateData(ctx, r));
    if (dto.defaultTaxCode && !TAX_CODE_RE.test(dto.defaultTaxCode)) throw invalid('defaultTaxCode is invalid');
    return this.prisma.$transaction(async (tx) => {
      const exists = await tx.pricingTaxProfile.findUnique({ where: { companyId_name: { companyId: ctx.companyId, name: dto.name.trim() } } });
      if (exists) throw conflict('VALIDATION_FAILED', 'A tax profile with this name exists');
      const row = await tx.pricingTaxProfile.create({
        data: { companyId: ctx.companyId, name: dto.name.trim(), regime: dto.regime, jurisdiction: dto.jurisdiction ?? null, defaultTaxCode: dto.defaultTaxCode ?? null, rates: { create: rates.map(({ companyId: _c, ...r }) => ({ ...r, companyId: ctx.companyId })) } },
        include: { rates: true },
      });
      await this.audit.record(ctx, { action: 'CREATE', entity: 'pricing_tax_profile', entityId: row.id, after: { ...row, rates: row.rates } }, tx);
      return profileDto(row);
    });
  }

  /** Rates are effective-dated: a new rate for a code closes the open one at its validFrom (history kept). */
  async addTaxRate(ctx: AuthContext, profileId: string, dto: CreatePricingTaxRateRequest): Promise<PricingTaxProfileDto> {
    const data = this.rateData(ctx, dto);
    return this.prisma.$transaction(async (tx) => {
      const profile = await tx.pricingTaxProfile.findFirst({ where: { id: profileId, companyId: ctx.companyId } });
      if (!profile) throw notFound();
      const open = await tx.pricingTaxRate.findMany({ where: { profileId, taxCode: data.taxCode, OR: [{ validTo: null }, { validTo: { gt: data.validFrom } }] } });
      for (const r of open) {
        if (r.validFrom >= data.validFrom) throw conflict('CONTRACT_OVERLAP', `Rate ${r.taxCode} from ${ymd(r.validFrom)} overlaps; add the new rate after it`);
        await tx.pricingTaxRate.update({ where: { id: r.id }, data: { validTo: data.validFrom } });
      }
      const rate = await tx.pricingTaxRate.create({ data: { ...data, profileId } });
      await this.audit.record(ctx, { action: 'CREATE', entity: 'pricing_tax_rate', entityId: rate.id, after: rate }, tx);
      return profileDto(await tx.pricingTaxProfile.findUniqueOrThrow({ where: { id: profileId }, include: { rates: true } }));
    });
  }

  async listCalendars(ctx: AuthContext): Promise<PricingCalendarDto[]> {
    const rows = await this.prisma.pricingCalendar.findMany({ where: { companyId: ctx.companyId }, orderBy: { name: 'asc' } });
    return rows.map((c) => ({ id: c.id, name: c.name, holidays: c.holidays, nonOperatingWeekdays: c.nonOperatingWeekdays }));
  }

  async upsertCalendar(ctx: AuthContext, dto: UpsertPricingCalendarRequest): Promise<PricingCalendarDto> {
    const name = (dto.name ?? '').trim();
    if (!name) throw invalid('name is required');
    if (!Array.isArray(dto.holidays) || dto.holidays.some((d) => !isYmd(d)) || dto.holidays.length > 400) throw invalid('holidays must be up to 400 dates YYYY-MM-DD');
    const weekdays = dto.nonOperatingWeekdays ?? [];
    if (weekdays.some((w) => !Number.isInteger(w) || w < 1 || w > 7)) throw invalid('nonOperatingWeekdays are 1 (Mon) – 7 (Sun)');
    const holidays = [...new Set(dto.holidays)].sort();
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.pricingCalendar.findUnique({ where: { companyId_name: { companyId: ctx.companyId, name } } });
      const row = await tx.pricingCalendar.upsert({ where: { companyId_name: { companyId: ctx.companyId, name } }, create: { companyId: ctx.companyId, name, holidays, nonOperatingWeekdays: weekdays }, update: { holidays, nonOperatingWeekdays: weekdays } });
      await this.audit.record(ctx, { action: before ? 'UPDATE' : 'CREATE', entity: 'pricing_calendar', entityId: row.id, before, after: row }, tx);
      return { id: row.id, name: row.name, holidays: row.holidays, nonOperatingWeekdays: row.nonOperatingWeekdays };
    });
  }

  /**
   * Tax configuration for pricing on `date` (§5.6). The buyer state comes from the customer's BillingProfile (internal
   * contracts: the supplier's own state); `buyerStateCode` overrides it (preview). Missing pieces stay missing: the
   * engine then reports TAX_PROFILE_MISSING and nothing can be invoiced.
   */
  async taxConfigFor(db: Db | PrismaService, companyId: string, contract: { taxProfileId: string | null; customerCompanyId: string | null }, date: string, buyerStateCode?: string | null): Promise<TaxConfig> {
    if (!contract.taxProfileId) return { regime: 'SIMPLE', rates: [], defaultTaxCode: null };
    const day = new Date(`${date}T00:00:00.000Z`);
    const profile = await db.pricingTaxProfile.findFirst({
      where: { id: contract.taxProfileId, companyId },
      include: { rates: { where: { validFrom: { lte: day }, OR: [{ validTo: null }, { validTo: { gt: day } }] } } },
    });
    if (!profile) return { regime: 'SIMPLE', rates: [], defaultTaxCode: null };
    const supplier = await db.billingSupplierProfile.findUnique({ where: { companyId }, select: { stateCode: true } });
    let buyer = buyerStateCode ?? null;
    if (!buyer && profile.regime === 'IN_GST') {
      if (!contract.customerCompanyId) buyer = supplier?.stateCode ?? null;
      else buyer = (await db.billingProfile.findUnique({ where: { companyId: contract.customerCompanyId }, select: { stateCode: true } }))?.stateCode ?? null;
    }
    return {
      regime: profile.regime as TaxRegime,
      rates: profile.rates.map((r) => ({ taxCode: r.taxCode, label: r.label, ratePpm: r.ratePpm })),
      // QA 9: no fallback to an arbitrary rate; lines without a code then price with TAX_PROFILE_MISSING (review).
      defaultTaxCode: profile.defaultTaxCode ?? null,
      supplierStateCode: supplier?.stateCode ?? null,
      buyerStateCode: buyer,
    };
  }

  async requireSupplier(db: Db, companyId: string) {
    const s = await db.billingSupplierProfile.findUnique({ where: { companyId } });
    if (!s) throw pricingError(HttpStatus.CONFLICT, 'SUPPLIER_PROFILE_MISSING', 'Set up the supplier billing profile (legal name, address, tax registration, numbering) first');
    return s;
  }
}

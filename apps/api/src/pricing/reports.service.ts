import { BadRequestException, Injectable, StreamableFile } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  COST_CATEGORIES,
  COST_SOURCES,
  isCurrency,
  isYmd,
  PRICING_REPORT_GROUPS,
  PRICING_REPORT_TYPES,
  type CreateOperatingCostRequest,
  type OperatingCostDto,
  type OperatingCostListQuery,
  type PricingDashboardDto,
  type PricingPage,
  type PricingReportColumn,
  type PricingReportDto,
  type PricingReportGroup,
  type PricingReportQuery,
  type PricingReportType,
} from '@veetracer/shared';
import type { AuthContext } from '../access/auth-context';
import { AuditService } from '../audit/audit.service';
import { csvFile } from '../common/csv';
import { PrismaService } from '../prisma/prisma.service';
import { branchWhere, canSeeCosts, dateOnly, forbidden, invalid, isCompanyScope, localYmd, majorToMinor, pageOf, paging, ymd, ymdOf } from './pricing-common';

const MAX_ROWS = 100_000;
const DAY = 86_400_000;

function costDto(c: Prisma.OperatingCostRecordGetPayload<object>): OperatingCostDto {
  return { id: c.id, objectId: c.objectId, driverId: c.driverId, transportTripId: c.transportTripId, branchId: c.branchId, date: ymd(c.date), category: c.category as OperatingCostDto['category'], amountMinor: c.amountMinor.toString(), currency: c.currency, source: c.source as OperatingCostDto['source'], sourceRef: c.sourceRef, note: c.note, createdAt: c.createdAt.toISOString() };
}

interface Agg {
  key: string;
  label: string;
  currency: string;
  trips: number;
  tripRevenueMinor: bigint;
  availabilityRevenueMinor: bigint;
  taxMinor: bigint;
  costMinor: bigint;
}

/**
 * Doc 19 §5.10 / §6 reports: revenue (trip snapshots + availability periods, before tax), trips by status, availability,
 * invoice ageing, and margin (revenue − operating costs). Cost and margin are projected out unless the caller holds
 * pricing_costs:view (customer, dispatcher and ordinary pricing roles never see them); the margin report itself is refused.
 */
@Injectable()
export class PricingReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async report(ctx: AuthContext, type: string, q: PricingReportQuery): Promise<PricingReportDto | StreamableFile> {
    if (!PRICING_REPORT_TYPES.includes(type as PricingReportType)) throw invalid(`Unknown report ${type}`);
    if (!isYmd(q.from) || !isYmd(q.to) || q.to < q.from) throw invalid('from / to must be dates YYYY-MM-DD, to ≥ from');
    if (new Date(q.to).getTime() - new Date(q.from).getTime() > 400 * DAY) throw invalid('At most 400 days per report');
    const groupBy = (q.groupBy ?? 'contract') as PricingReportGroup;
    if (!PRICING_REPORT_GROUPS.includes(groupBy)) throw invalid('groupBy is invalid');
    const costVisible = canSeeCosts(ctx);
    if (type === 'margin' && !costVisible) throw forbidden('COST_HIDDEN', 'Margin needs the Operating costs & margin permission');
    let out: PricingReportDto;
    if (type === 'ageing') out = await this.ageing(ctx, q);
    else if (type === 'trips') out = await this.trips(ctx, q, groupBy);
    else out = await this.revenue(ctx, q, groupBy, type as 'revenue' | 'availability' | 'margin', costVisible);
    if (q.format === 'csv') {
      return csvFile(`pricing-${type}`, out.rows, out.columns.map((c) => ({ header: c.label, value: (r: Record<string, unknown>) => r[c.key] })));
    }
    return out;
  }

  private keyOf(groupBy: PricingReportGroup, r: { contractId: string | null; customerCompanyId: string | null; branchId: string | null; objectId: string | null; day: Date }): string {
    switch (groupBy) {
      case 'contract':
        return r.contractId ?? '—';
      case 'customer':
        return r.customerCompanyId ?? 'internal';
      case 'branch':
        return r.branchId ?? '—';
      case 'vehicle':
        return r.objectId ?? '—';
      case 'day':
        return ymd(r.day);
      case 'month':
        return ymd(r.day).slice(0, 7);
    }
  }

  private async labels(ctx: AuthContext, groupBy: PricingReportGroup, keys: string[]): Promise<Map<string, string>> {
    const ids = keys.filter((k) => /^[0-9a-f-]{36}$/.test(k));
    if (groupBy === 'contract') return new Map((await this.prisma.pricingContract.findMany({ where: { companyId: ctx.companyId, id: { in: ids } }, select: { id: true, name: true } })).map((r) => [r.id, r.name]));
    if (groupBy === 'customer') return new Map((await this.prisma.company.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })).map((r) => [r.id, r.name]));
    if (groupBy === 'branch') return new Map((await this.prisma.branch.findMany({ where: { companyId: ctx.companyId, id: { in: ids } }, select: { id: true, name: true } })).map((r) => [r.id, r.name]));
    if (groupBy === 'vehicle') return new Map((await this.prisma.trackedObject.findMany({ where: { companyId: ctx.companyId, id: { in: ids } }, select: { id: true, name: true } })).map((r) => [r.id, r.name]));
    return new Map();
  }

  private async revenue(ctx: AuthContext, q: PricingReportQuery, groupBy: PricingReportGroup, type: 'revenue' | 'availability' | 'margin', costVisible: boolean): Promise<PricingReportDto> {
    const from = new Date(`${q.from}T00:00:00Z`);
    const to = new Date(`${q.to}T00:00:00Z`);
    const scope = { companyId: ctx.companyId, ...branchWhere(ctx), ...(q.contractId ? { contractId: q.contractId } : {}), ...(q.branchId ? { branchId: q.branchId } : {}) };
    const snaps =
      type === 'availability'
        ? []
        : await this.prisma.tripPriceSnapshot.findMany({ where: { ...scope, isCurrent: true, status: { in: ['PRICED', 'COVERED'] }, serviceDate: { gte: from, lte: to } }, select: { contractId: true, customerCompanyId: true, branchId: true, objectId: true, serviceDate: true, currency: true, subtotalMinor: true, discountMinor: true, taxMinor: true }, take: MAX_ROWS + 1 });
    const periods = await this.prisma.availabilityBillingPeriod.findMany({ where: { ...scope, status: { in: ['CLOSED', 'INVOICED'] }, periodEnd: { gte: from, lte: to } }, select: { contractId: true, branchId: true, objectId: true, periodEnd: true, currency: true, subtotalMinor: true, discountMinor: true, taxMinor: true }, take: MAX_ROWS + 1 });
    if (snaps.length > MAX_ROWS || periods.length > MAX_ROWS) throw new BadRequestException({ code: 'VALIDATION_FAILED', message: 'Too many rows; narrow the period or filter by contract' });
    const contractCustomer = new Map((await this.prisma.pricingContract.findMany({ where: { companyId: ctx.companyId }, select: { id: true, customerCompanyId: true } })).map((c) => [c.id, c.customerCompanyId]));
    const aggs = new Map<string, Agg>();
    const bucket = (key: string, currency: string) => {
      const k = `${key}|${currency}`;
      let a = aggs.get(k);
      if (!a) aggs.set(k, (a = { key, label: key, currency, trips: 0, tripRevenueMinor: 0n, availabilityRevenueMinor: 0n, taxMinor: 0n, costMinor: 0n }));
      return a;
    };
    for (const s of snaps) {
      const a = bucket(this.keyOf(groupBy, { ...s, day: s.serviceDate }), s.currency);
      a.trips++;
      a.tripRevenueMinor += s.subtotalMinor - s.discountMinor;
      a.taxMinor += s.taxMinor;
    }
    for (const p of periods) {
      const a = bucket(this.keyOf(groupBy, { ...p, customerCompanyId: contractCustomer.get(p.contractId) ?? null, day: p.periodEnd }), p.currency);
      a.availabilityRevenueMinor += p.subtotalMinor - p.discountMinor;
      a.taxMinor += p.taxMinor;
    }
    if (costVisible && (groupBy === 'vehicle' || groupBy === 'day' || groupBy === 'month' || groupBy === 'branch')) {
      const costs = await this.prisma.operatingCostRecord.findMany({ where: { companyId: ctx.companyId, ...branchWhere(ctx), ...(q.branchId ? { branchId: q.branchId } : {}), date: { gte: from, lte: to } }, select: { objectId: true, branchId: true, date: true, currency: true, amountMinor: true }, take: MAX_ROWS });
      for (const c of costs) bucket(this.keyOf(groupBy, { contractId: null, customerCompanyId: null, branchId: c.branchId, objectId: c.objectId, day: c.date }), c.currency).costMinor += c.amountMinor;
    }
    const labels = await this.labels(ctx, groupBy, [...new Set([...aggs.values()].map((a) => a.key))]);
    const columns: PricingReportColumn[] = [
      { key: 'label', label: groupBy[0].toUpperCase() + groupBy.slice(1), kind: 'text' },
      { key: 'currency', label: 'Currency', kind: 'text' },
      { key: 'trips', label: 'Trips', kind: 'number' },
      { key: 'tripRevenueMinor', label: 'Trip revenue', kind: 'money' },
      { key: 'availabilityRevenueMinor', label: 'Availability revenue', kind: 'money' },
      { key: 'revenueMinor', label: 'Revenue (before tax)', kind: 'money' },
      { key: 'taxMinor', label: 'Tax', kind: 'money' },
    ];
    const withCost = costVisible && (type === 'margin' || type === 'revenue');
    if (withCost) columns.push({ key: 'costMinor', label: 'Operating cost', kind: 'money' }, { key: 'marginMinor', label: 'Margin', kind: 'money' });
    const rows = [...aggs.values()]
      .sort((a, b) => a.key.localeCompare(b.key))
      .map((a) => {
        const revenue = a.tripRevenueMinor + a.availabilityRevenueMinor;
        const row: Record<string, string | number | null> = { key: a.key, label: labels.get(a.key) ?? a.key, currency: a.currency, trips: a.trips, tripRevenueMinor: a.tripRevenueMinor.toString(), availabilityRevenueMinor: a.availabilityRevenueMinor.toString(), revenueMinor: revenue.toString(), taxMinor: a.taxMinor.toString() };
        if (withCost) {
          row.costMinor = a.costMinor.toString();
          row.marginMinor = (revenue - a.costMinor).toString();
        }
        return row;
      });
    return { type, from: q.from, to: q.to, groupBy, columns, rows, costVisible: withCost };
  }

  private async trips(ctx: AuthContext, q: PricingReportQuery, groupBy: PricingReportGroup): Promise<PricingReportDto> {
    const rows = await this.prisma.tripPriceSnapshot.groupBy({
      by: ['status', 'currency'],
      where: { companyId: ctx.companyId, isCurrent: true, ...branchWhere(ctx), ...(q.contractId ? { contractId: q.contractId } : {}), ...(q.branchId ? { branchId: q.branchId } : {}), serviceDate: { gte: new Date(`${q.from}T00:00:00Z`), lte: new Date(`${q.to}T00:00:00Z`) } },
      _count: { _all: true },
      _sum: { totalMinor: true, billableDistanceM: true },
    });
    return {
      type: 'trips',
      from: q.from,
      to: q.to,
      groupBy: groupBy ?? null,
      columns: [
        { key: 'status', label: 'Status', kind: 'text' },
        { key: 'currency', label: 'Currency', kind: 'text' },
        { key: 'trips', label: 'Trips', kind: 'number' },
        { key: 'billableKm', label: 'Billable km', kind: 'number' },
        { key: 'totalMinor', label: 'Total (incl. tax)', kind: 'money' },
      ],
      rows: rows.map((r) => ({ status: r.status, currency: r.currency, trips: r._count._all, billableKm: Math.round((r._sum.billableDistanceM ?? 0) / 1000), totalMinor: (r._sum.totalMinor ?? 0n).toString() })),
      costVisible: false,
    };
  }

  private async ageing(ctx: AuthContext, q: PricingReportQuery): Promise<PricingReportDto> {
    const invoices = await this.prisma.customerInvoice.findMany({
      where: { companyId: ctx.companyId, status: 'ISSUED', ...(isCompanyScope(ctx) ? {} : { consolidated: false, ...branchWhere(ctx) }), ...(q.contractId ? { contractId: q.contractId } : {}), invoiceDate: { lte: new Date(`${q.to}T00:00:00Z`) } },
      include: { creditNotes: { select: { totalMinor: true } }, payments: { select: { amountMinor: true } } },
      take: MAX_ROWS,
    });
    const asOf = new Date(`${q.to}T00:00:00Z`).getTime();
    const rows = invoices
      .map((i) => {
        const balance = i.totalMinor - i.creditNotes.reduce((s, c) => s + c.totalMinor, 0n) - i.payments.reduce((s, p) => s + p.amountMinor, 0n);
        const overdueDays = i.dueDate ? Math.floor((asOf - i.dueDate.getTime()) / DAY) : 0;
        const bucket = overdueDays <= 0 ? 'Not due' : overdueDays <= 30 ? '1–30' : overdueDays <= 60 ? '31–60' : overdueDays <= 90 ? '61–90' : '90+';
        return { number: i.number, invoiceDate: ymdOf(i.invoiceDate), dueDate: ymdOf(i.dueDate), currency: i.currency, totalMinor: i.totalMinor.toString(), balanceMinor: balance.toString(), overdueDays: Math.max(0, overdueDays), bucket, _b: balance };
      })
      .filter((r) => r._b !== 0n)
      .map(({ _b, ...r }) => r);
    return {
      type: 'ageing',
      from: q.from,
      to: q.to,
      groupBy: null,
      columns: [
        { key: 'number', label: 'Invoice', kind: 'text' },
        { key: 'invoiceDate', label: 'Date', kind: 'text' },
        { key: 'dueDate', label: 'Due', kind: 'text' },
        { key: 'currency', label: 'Currency', kind: 'text' },
        { key: 'totalMinor', label: 'Total', kind: 'money' },
        { key: 'balanceMinor', label: 'Balance', kind: 'money' },
        { key: 'overdueDays', label: 'Days overdue', kind: 'number' },
        { key: 'bucket', label: 'Bucket', kind: 'text' },
      ],
      rows,
      costVisible: false,
    };
  }

  async dashboard(ctx: AuthContext): Promise<PricingDashboardDto> {
    const company = await this.prisma.company.findUniqueOrThrow({ where: { id: ctx.companyId }, select: { timezone: true } });
    const today = localYmd(new Date(), company.timezone);
    const month = today.slice(0, 7);
    const q = { from: `${month}-01`, to: today };
    const rev = (await this.revenue(ctx, q, 'month', canSeeCosts(ctx) ? 'margin' : 'revenue', canSeeCosts(ctx))).rows;
    const scope = { companyId: ctx.companyId, isCurrent: true, ...branchWhere(ctx), serviceDate: { gte: new Date(`${q.from}T00:00:00Z`) } };
    const [priced, review, noPricing] = await Promise.all([
      this.prisma.tripPriceSnapshot.count({ where: { ...scope, status: { in: ['PRICED', 'COVERED'] } } }),
      this.prisma.tripPriceSnapshot.count({ where: { ...scope, status: 'NEEDS_REVIEW' } }),
      this.prisma.tripPriceSnapshot.count({ where: { ...scope, status: { in: ['NO_APPLICABLE_PRICING', 'ERROR'] } } }),
    ]);
    const invoices = await this.prisma.customerInvoice.findMany({ where: { companyId: ctx.companyId, status: 'ISSUED', ...(isCompanyScope(ctx) ? {} : { consolidated: false, ...branchWhere(ctx) }) }, include: { creditNotes: { select: { totalMinor: true } }, payments: { select: { amountMinor: true } } }, take: MAX_ROWS });
    const outstanding = new Map<string, bigint>();
    let open = 0;
    let overdue = 0;
    const now = new Date(`${today}T00:00:00Z`);
    for (const i of invoices) {
      const bal = i.totalMinor - i.creditNotes.reduce((s, c) => s + c.totalMinor, 0n) - i.payments.reduce((s, p) => s + p.amountMinor, 0n);
      if (bal <= 0n) continue;
      open++;
      if (i.dueDate && i.dueDate < now) overdue++;
      outstanding.set(i.currency, (outstanding.get(i.currency) ?? 0n) + bal);
    }
    const in30 = new Date(now.getTime() + 30 * DAY);
    const [pending, expiring] = await Promise.all([
      this.prisma.pricingContractVersion.count({ where: { companyId: ctx.companyId, status: 'PENDING_APPROVAL' } }),
      this.prisma.pricingContractVersion.count({ where: { companyId: ctx.companyId, status: 'ACTIVE', validTo: { gte: now, lte: in30 } } }),
    ]);
    return {
      month,
      revenue: rev.map((r) => ({ currency: String(r.currency), totalMinor: String(r.revenueMinor) })),
      tripsPriced: priced,
      tripsNeedingReview: review,
      tripsWithoutPricing: noPricing,
      openInvoices: open,
      overdueInvoices: overdue,
      outstanding: [...outstanding].map(([currency, b]) => ({ currency, balanceMinor: b.toString() })),
      contractsPendingApproval: pending,
      contractsExpiringSoon: expiring,
      margin: canSeeCosts(ctx) ? rev.map((r) => ({ currency: String(r.currency), revenueMinor: String(r.revenueMinor), costMinor: String(r.costMinor ?? '0'), marginMinor: String(r.marginMinor ?? r.revenueMinor) })) : null,
    };
  }

  // ───────────── operating costs (pricing_costs only) ─────────────

  async listCosts(ctx: AuthContext, q: OperatingCostListQuery): Promise<PricingPage<OperatingCostDto>> {
    const p = paging(q);
    const where: Prisma.OperatingCostRecordWhereInput = {
      companyId: ctx.companyId,
      ...branchWhere(ctx),
      ...(q.objectId ? { objectId: q.objectId } : {}),
      ...(q.category ? { category: q.category } : {}),
      ...(q.from || q.to ? { date: { ...(q.from ? { gte: new Date(`${q.from}T00:00:00Z`) } : {}), ...(q.to ? { lte: new Date(`${q.to}T00:00:00Z`) } : {}) } } : {}),
    };
    const [rows, total] = await Promise.all([this.prisma.operatingCostRecord.findMany({ where, orderBy: { date: 'desc' }, skip: p.skip, take: p.pageSize }), this.prisma.operatingCostRecord.count({ where })]);
    return pageOf(rows.map(costDto), total, p);
  }

  async createCost(ctx: AuthContext, dto: CreateOperatingCostRequest): Promise<OperatingCostDto> {
    if (!COST_CATEGORIES.includes(dto.category)) throw invalid('category is invalid');
    if (dto.source && !COST_SOURCES.includes(dto.source)) throw invalid('source is invalid');
    const currency = (dto.currency ?? '').toUpperCase();
    if (!isCurrency(currency)) throw invalid('currency must be an ISO 4217 code');
    const amount = majorToMinor(dto.amount, currency, 'amount', { positive: true, allowZero: true });
    const date = dateOnly(dto.date, 'date');
    return this.prisma.$transaction(async (tx) => {
      if (dto.objectId && !(await tx.trackedObject.findFirst({ where: { id: dto.objectId, companyId: ctx.companyId } }))) throw invalid('Unknown vehicle');
      if (dto.branchId && !(await tx.branch.findFirst({ where: { id: dto.branchId, companyId: ctx.companyId } }))) throw invalid('Unknown branch');
      if (!isCompanyScope(ctx) && (!dto.branchId || !ctx.branchIds.includes(dto.branchId))) throw forbidden('BRANCH_SCOPE', 'Record costs for one of your branches');
      const row = await tx.operatingCostRecord.create({ data: { companyId: ctx.companyId, objectId: dto.objectId ?? null, driverId: dto.driverId ?? null, transportTripId: dto.transportTripId ?? null, branchId: dto.branchId ?? null, date, category: dto.category, amountMinor: amount, currency, source: dto.source ?? 'MANUAL', sourceRef: dto.sourceRef ?? null, note: dto.note ?? null, createdById: ctx.userId } });
      await this.audit.record(ctx, { action: 'CREATE', entity: 'operating_cost', entityId: row.id, after: row }, tx);
      return costDto(row);
    });
  }
}

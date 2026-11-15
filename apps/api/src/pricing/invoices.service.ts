import { HttpStatus, Injectable, StreamableFile } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  allocateLargestRemainder,
  applyTax,
  divRound,
  fiscalYearLabel,
  formatDocumentNumber,
  formatMinor,
  isYmd,
  PAYMENT_METHODS,
  addDaysYmd,
  type BillingPaymentDto,
  type CreateCreditNoteRequest,
  type CustomerCreditNoteDto,
  type CustomerInvoiceDto,
  type CustomerInvoiceListQuery,
  type CustomerInvoiceSummaryDto,
  type GenerateInvoiceRequest,
  type GenerateInvoiceResponse,
  type InvoicePartySnapshot,
  type InvoicePaymentStatus,
  type PriceLine,
  type PricingPage,
  type RecordPaymentRequest,
  type RoundingMode,
  type TaxLineDto,
} from '@veetracer/shared';
import pdfmake from 'pdfmake';
import type { Content, TDocumentDefinitions } from 'pdfmake/interfaces';
import type { AuthContext } from '../access/auth-context';
import { AuditService } from '../audit/audit.service';
import { setupPdf } from '../reports/report-files';
import { PrismaService } from '../prisma/prisma.service';
import { periodSourceKey } from './availability.service';
import { requestHash } from '../etms/dispatch/e3-common';
import { BillingRunsService, runDto } from './billing-runs.service';
import {
  asJson,
  branchVisible,
  branchWhere,
  conflict,
  contractVisible,
  dateOnly,
  forbidden,
  guardDb,
  invalid,
  isCompanyScope,
  isoOf,
  localYmd,
  majorToMinor,
  notFound,
  pageOf,
  paging,
  pricingError,
  reasonOf,
  taxLineDto,
  ymd,
  ymdOf,
  type Db,
} from './pricing-common';
import { PricingSettingsService } from './settings.service';
import { INVOICEABLE_TRIP_STATUSES, tripSourceKey } from './trip-pricing.service';

type InvoiceRow = Prisma.CustomerInvoiceGetPayload<object>;
type InvoiceFull = Prisma.CustomerInvoiceGetPayload<{ include: { lines: true; creditNotes: true; payments: true } }>;
export const adjustmentSourceKey = (id: string) => `ADJ:${id}`;

/** Sum tax lines per code (minor strings). */
function mergeTaxLines(groups: TaxLineDto[][]): TaxLineDto[] {
  const by = new Map<string, TaxLineDto>();
  const add = (a: string | undefined, b: string | undefined) => (a === undefined && b === undefined ? undefined : (BigInt(a ?? '0') + BigInt(b ?? '0')).toString());
  for (const t of groups.flat()) {
    const k = `${t.taxCode}|${t.ratePpm}`;
    const prev = by.get(k);
    if (!prev) {
      by.set(k, { ...t });
      continue;
    }
    by.set(k, { ...prev, taxableMinor: add(prev.taxableMinor, t.taxableMinor)!, taxMinor: add(prev.taxMinor, t.taxMinor)!, cgstMinor: add(prev.cgstMinor, t.cgstMinor), sgstMinor: add(prev.sgstMinor, t.sgstMinor), utgstMinor: add(prev.utgstMinor, t.utgstMinor), igstMinor: add(prev.igstMinor, t.igstMinor) });
  }
  return [...by.values()];
}

function paymentState(total: bigint, credited: bigint, paid: bigint): { balance: bigint; status: InvoicePaymentStatus } {
  const balance = total - credited - paid;
  if (balance < 0n) return { balance, status: 'OVERPAID' };
  if (balance === 0n) return { balance, status: 'PAID' };
  return { balance, status: paid > 0n ? 'PART' : 'UNPAID' };
}

/**
 * Doc 19 §5.8 invoicing: DRAFT invoices from un-invoiced PRICED trip snapshots, CLOSED availability periods and approved
 * adjustments (each source on one line only: partial unique sourceKey), gap-free numbering per supplier company and
 * fiscal year at issue (row lock + counter upsert in the same transaction), frozen supplier / buyer / tax snapshots,
 * DB-immutable once ISSUED; corrections by credit notes (own series) and a payment ledger (append-only).
 */
@Injectable()
export class CustomerInvoicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly settings: PricingSettingsService,
    private readonly runs: BillingRunsService,
  ) {}

  // ───────────── reads ─────────────

  private async contractNames(ids: (string | null)[]): Promise<Map<string, { name: string; customerName: string }>> {
    const rows = await this.prisma.pricingContract.findMany({ where: { id: { in: [...new Set(ids.filter((x): x is string => !!x))] } }, select: { id: true, name: true, customerName: true } });
    return new Map(rows.map((r) => [r.id, r]));
  }

  private summary(i: InvoiceRow & { creditNotes: { totalMinor: bigint }[]; payments: { amountMinor: bigint }[] }, names: Map<string, { name: string; customerName: string }>): CustomerInvoiceSummaryDto {
    const credited = i.creditNotes.reduce((s, c) => s + c.totalMinor, 0n);
    const paid = i.payments.reduce((s, p) => s + p.amountMinor, 0n);
    const st = paymentState(i.totalMinor, credited, paid);
    const c = i.contractId ? names.get(i.contractId) : undefined;
    return {
      id: i.id,
      number: i.number,
      fy: i.fy,
      status: i.status as CustomerInvoiceSummaryDto['status'],
      contractId: i.contractId,
      contractName: c?.name ?? null,
      customerCompanyId: i.customerCompanyId,
      customerName: ((i.buyer ?? {}) as { name?: string }).name ?? c?.customerName ?? null,
      branchId: i.branchId,
      consolidated: i.consolidated,
      periodStart: ymd(i.periodStart),
      periodEnd: ymd(i.periodEnd),
      currency: i.currency,
      subtotalMinor: i.subtotalMinor.toString(),
      discountMinor: i.discountMinor.toString(),
      taxMinor: i.taxMinor.toString(),
      totalMinor: i.totalMinor.toString(),
      paidMinor: paid.toString(),
      creditedMinor: credited.toString(),
      balanceMinor: st.balance.toString(),
      paymentStatus: st.status,
      issuedAt: isoOf(i.issuedAt),
      invoiceDate: ymdOf(i.invoiceDate),
      dueDate: ymdOf(i.dueDate),
      createdAt: i.createdAt.toISOString(),
    };
  }

  private full(i: InvoiceFull, names: Map<string, { name: string; customerName: string }>): CustomerInvoiceDto {
    const reversed = new Map(i.payments.filter((p) => p.reversalOf).map((p) => [p.reversalOf!, p.id]));
    return {
      ...this.summary(i, names),
      supplier: (i.supplier ?? {}) as unknown as InvoicePartySnapshot,
      buyer: (i.buyer ?? {}) as unknown as InvoicePartySnapshot,
      taxKind: i.taxKind,
      taxLines: (Array.isArray(i.taxLines) ? i.taxLines : []) as unknown as TaxLineDto[],
      lines: [...i.lines]
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((l) => ({ id: l.id, sourceType: l.sourceType as CustomerInvoiceDto['lines'][number]['sourceType'], sourceId: l.sourceId, description: l.description, quantity: l.quantity.toString(), unit: l.unit, rate: l.rate?.toString() ?? null, amountMinor: l.amountMinor.toString(), discountMinor: l.discountMinor.toString(), taxCode: l.taxCode, taxMinor: l.taxMinor.toString(), totalMinor: l.totalMinor.toString(), branchId: l.branchId, serviceDate: ymdOf(l.serviceDate) })),
      creditNotes: i.creditNotes.map(creditNoteDto),
      payments: i.payments.map((p) => paymentDto(p, reversed.get(p.id) ?? null)),
    };
  }

  private async load(db: Db | PrismaService, ctx: AuthContext, id: string): Promise<InvoiceFull> {
    const i = await db.customerInvoice.findFirst({ where: { id, companyId: ctx.companyId }, include: { lines: true, creditNotes: { orderBy: { issuedAt: 'asc' } }, payments: { orderBy: { createdAt: 'asc' } } } });
    // §9.3: consolidated invoices need COMPANY scope; branch invoices are visible to that branch's users.
    if (!i || (!isCompanyScope(ctx) && (i.consolidated || !branchVisible(ctx, i.branchId)))) throw notFound();
    return i;
  }

  async get(ctx: AuthContext, id: string): Promise<CustomerInvoiceDto> {
    const i = await this.load(this.prisma, ctx, id);
    return this.full(i, await this.contractNames([i.contractId]));
  }

  async list(ctx: AuthContext, q: CustomerInvoiceListQuery): Promise<PricingPage<CustomerInvoiceSummaryDto>> {
    const p = paging(q);
    const where: Prisma.CustomerInvoiceWhereInput = {
      companyId: ctx.companyId,
      ...(isCompanyScope(ctx) ? {} : { consolidated: false, ...branchWhere(ctx) }),
      ...(q.status ? { status: q.status } : {}),
      ...(q.contractId ? { contractId: q.contractId } : {}),
      ...(q.customerCompanyId ? { customerCompanyId: q.customerCompanyId } : {}),
      ...(q.branchId ? { branchId: q.branchId } : {}),
      ...(q.from ? { periodEnd: { gte: new Date(`${q.from}T00:00:00Z`) } } : {}),
      ...(q.to ? { periodStart: { lte: new Date(`${q.to}T00:00:00Z`) } } : {}),
    };
    const rows = await this.prisma.customerInvoice.findMany({ where, orderBy: [{ createdAt: 'desc' }], include: { creditNotes: { select: { totalMinor: true } }, payments: { select: { amountMinor: true } } }, ...(q.paymentStatus ? {} : { skip: p.skip, take: p.pageSize }) });
    const names = await this.contractNames(rows.map((r) => r.contractId));
    let items = rows.map((r) => this.summary(r, names));
    let total = q.paymentStatus ? 0 : await this.prisma.customerInvoice.count({ where });
    if (q.paymentStatus) {
      items = items.filter((i) => i.status === 'ISSUED' && i.paymentStatus === q.paymentStatus);
      total = items.length;
      items = items.slice(p.skip, p.skip + p.pageSize);
    }
    return pageOf(items, total, p);
  }

  // ───────────── generate ─────────────

  async generate(ctx: AuthContext, dto: GenerateInvoiceRequest, key: string, opts: { jobRunId?: string } = {}): Promise<GenerateInvoiceResponse> {
    if (!isYmd(dto.periodStart) || !isYmd(dto.periodEnd) || dto.periodEnd < dto.periodStart) throw invalid('periodStart / periodEnd must be dates YYYY-MM-DD, end ≥ start');
    const branchId = dto.branchId ?? null;
    if (!branchId && !isCompanyScope(ctx)) throw forbidden('CONSOLIDATED_NEEDS_COMPANY_SCOPE', 'A consolidated invoice needs a company-wide user; pick your branch');
    if (branchId && !branchVisible(ctx, branchId)) throw forbidden('BRANCH_SCOPE', 'You can only invoice your own branches');
    const contract = await this.prisma.pricingContract.findFirst({ where: { id: dto.contractId, companyId: ctx.companyId } });
    if (!contract || !contractVisible(ctx, contract)) throw notFound();
    const body = { contractId: dto.contractId, periodStart: dto.periodStart, periodEnd: dto.periodEnd, branchId };
    // Idempotency-Key replay (same key + body = the same invoice).
    const hash = requestHash(body);
    const prior = await this.prisma.customerInvoice.findUnique({ where: { companyId_idempotencyKey: { companyId: ctx.companyId, idempotencyKey: key } } });
    if (prior) {
      if (prior.requestHash !== hash) throw pricingError(HttpStatus.UNPROCESSABLE_ENTITY, 'IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used for a different request');
      const run = prior.billingRunId ? await this.prisma.billingRun.findUnique({ where: { id: prior.billingRunId } }) : null;
      if (!run) throw notFound();
      return { invoice: await this.get(ctx, prior.id), run: runDto(run), skipped: ((run.stats ?? {}) as { skipped?: GenerateInvoiceResponse['skipped'] }).skipped ?? { needsReview: 0, noPricing: 0, errors: 0 }, replayed: true };
    }
    const claim = await this.runs.claim(ctx, { contractId: dto.contractId, kind: 'INVOICE', periodStart: dto.periodStart, periodEnd: dto.periodEnd, key, body });
    if (claim.replay) throw conflict('BILLING_RUN_DONE', 'The invoice of this run was deleted; generate with a new Idempotency-Key');
    try {
      const { invoiceId, skipped } = await this.prisma.$transaction((tx) => this.buildDraft(tx, ctx, contract, dto.periodStart, dto.periodEnd, branchId, key, hash, claim.run.id), { timeout: 60_000 });
      const run = await this.runs.finish(claim.run.id, 'DONE', { invoiceId, skipped, jobRunId: opts.jobRunId ?? null });
      return { invoice: await this.get(ctx, invoiceId), run: runDto(run), skipped, replayed: false };
    } catch (e) {
      await this.runs.finish(claim.run.id, 'FAILED', {}, (e as Error).message);
      throw e;
    }
  }

  private async buildDraft(tx: Db, ctx: AuthContext, contract: Prisma.PricingContractGetPayload<object>, periodStart: string, periodEnd: string, branchId: string | null, key: string, hash: string, runId: string) {
    const from = new Date(`${periodStart}T00:00:00Z`);
    const to = new Date(`${periodEnd}T00:00:00Z`);
    const branch = branchId ? { branchId } : {};
    const snaps = await tx.tripPriceSnapshot.findMany({ where: { companyId: ctx.companyId, contractId: contract.id, isCurrent: true, serviceDate: { gte: from, lte: to }, ...branch }, orderBy: [{ serviceDate: 'asc' }, { calculatedAt: 'asc' }] });
    const invoiced = new Set((await tx.customerInvoiceLine.findMany({ where: { sourceKey: { in: snaps.map((s) => tripSourceKey(s.transportTripId, s.passengerId)) } }, select: { sourceKey: true } })).map((l) => l.sourceKey));
    const skipped = { needsReview: 0, noPricing: 0, errors: 0 };
    const usable = snaps.filter((s) => {
      if (invoiced.has(tripSourceKey(s.transportTripId, s.passengerId))) return false;
      if (s.status === 'NEEDS_REVIEW' || s.status === 'ESTIMATE') skipped.needsReview++;
      else if (s.status === 'NO_APPLICABLE_PRICING') skipped.noPricing++;
      else if (s.status === 'ERROR') skipped.errors++;
      return INVOICEABLE_TRIP_STATUSES.includes(s.status) && s.totalMinor !== 0n;
    });
    const periods = await tx.availabilityBillingPeriod.findMany({ where: { companyId: ctx.companyId, contractId: contract.id, status: 'CLOSED', periodStart: { gte: from }, periodEnd: { lte: to }, ...branch }, orderBy: { periodStart: 'asc' } });
    const periodTaken = new Set((await tx.customerInvoiceLine.findMany({ where: { sourceKey: { in: periods.map((p) => periodSourceKey(p.id)) } }, select: { sourceKey: true } })).map((l) => l.sourceKey));
    const openPeriods = periods.filter((p) => !periodTaken.has(periodSourceKey(p.id)));
    const adjustments = branchId ? [] : await tx.billingAdjustment.findMany({ where: { companyId: ctx.companyId, contractId: contract.id, status: 'APPROVED', kind: { in: ['CREDIT', 'DEBIT', 'WAIVER'] }, invoiceId: null } });
    const adjTaken = new Set((await tx.customerInvoiceLine.findMany({ where: { sourceKey: { in: adjustments.map((a) => adjustmentSourceKey(a.id)) } }, select: { sourceKey: true } })).map((l) => l.sourceKey));
    const openAdj = adjustments.filter((a) => !adjTaken.has(adjustmentSourceKey(a.id)));
    if (!usable.length && !openPeriods.length && !openAdj.length) throw conflict('NOTHING_TO_INVOICE', 'Nothing to invoice for this contract and period (no priced trips, closed periods or approved adjustments)', { skipped });
    for (const c of [...usable.map((s) => s.currency), ...openPeriods.map((p) => p.currency), ...openAdj.map((a) => a.currency)]) if (c !== contract.currency) throw conflict('CURRENCY_MISMATCH', `A source is in ${c}, the contract in ${contract.currency}`);

    type Line = Prisma.CustomerInvoiceLineCreateManyInvoiceInput;
    const lines: Line[] = [];
    const lineTax: TaxLineDto[][] = [];
    let order = 0;
    for (const s of usable) {
      const tl = (Array.isArray(s.taxLines) ? s.taxLines : []) as unknown as TaxLineDto[];
      lineTax.push(tl);
      lines.push({ companyId: ctx.companyId, sourceType: 'TRIP_SNAPSHOT', sourceId: s.id, sourceKey: tripSourceKey(s.transportTripId, s.passengerId), description: `Trip ${ymd(s.serviceDate)}${s.billableDistanceM !== null ? ` · ${(s.billableDistanceM / 1000).toFixed(3)} km` : ''}${s.status === 'COVERED' ? ' (covered)' : ''}`, quantity: new Prisma.Decimal(1), unit: 'trip', rate: null, amountMinor: s.subtotalMinor, discountMinor: s.discountMinor, taxCode: tl[0]?.taxCode ?? null, taxMinor: s.taxMinor, totalMinor: s.totalMinor, taxLines: asJson(tl), branchId: s.branchId, serviceDate: s.serviceDate, sortOrder: order++ });
    }
    for (const p of openPeriods) {
      const tl = (Array.isArray(p.taxLines) ? p.taxLines : []) as unknown as TaxLineDto[];
      lineTax.push(tl);
      const name = (await tx.pricingVehicleAssignment.findUnique({ where: { id: p.assignmentId }, select: { objectName: true } }))?.objectName ?? 'vehicle';
      lines.push({ companyId: ctx.companyId, sourceType: 'AVAILABILITY_PERIOD', sourceId: p.id, sourceKey: periodSourceKey(p.id), description: `Availability ${name} ${ymd(p.periodStart)} – ${ymd(p.periodEnd)} (${p.billableDays}/${p.attachedDays} days)`, quantity: new Prisma.Decimal(1), unit: 'period', rate: null, amountMinor: p.subtotalMinor, discountMinor: p.discountMinor, taxCode: tl[0]?.taxCode ?? null, taxMinor: p.taxMinor, totalMinor: p.totalMinor, taxLines: asJson(tl), branchId: p.branchId, serviceDate: p.periodEnd, sortOrder: order++ });
    }
    if (openAdj.length) {
      // Adjustments are tax-exclusive amounts taxed at the contract's default code on the period end (§5.6).
      const tax = await this.settings.taxConfigFor(tx, ctx.companyId, contract, periodEnd);
      for (const a of openAdj) {
        const base: PriceLine = { component: a.kind, label: a.kind, quantity: '1', unit: 'adjustment', amountMinor: a.amountMinor, discountMinor: 0n, taxCode: null, taxMinor: 0n, basis: a.reason };
        const taxed = applyTax([base], tax, contract.roundingMode as RoundingMode);
        if (taxed.issues.length) throw pricingError(HttpStatus.CONFLICT, 'TAX_PROFILE_MISSING', taxed.issues.map((i) => i.message).join('; '));
        const l = taxed.lines[0];
        const tl = taxed.taxLines.map(taxLineDto);
        lineTax.push(tl);
        lines.push({ companyId: ctx.companyId, sourceType: 'ADJUSTMENT', sourceId: a.id, sourceKey: adjustmentSourceKey(a.id), description: `${a.kind === 'DEBIT' ? 'Debit' : a.kind === 'WAIVER' ? 'Waiver' : 'Credit'}: ${a.reason}`, quantity: new Prisma.Decimal(1), unit: 'adjustment', rate: null, amountMinor: l.amountMinor, discountMinor: 0n, taxCode: l.taxCode, taxMinor: l.taxMinor, totalMinor: l.amountMinor + l.taxMinor, taxLines: asJson(tl), branchId: null, serviceDate: to, sortOrder: order++ });
      }
    }
    const sum = (k: 'amountMinor' | 'discountMinor' | 'taxMinor' | 'totalMinor') => lines.reduce((s, l) => s + BigInt(l[k] as bigint), 0n);
    const totals = { subtotalMinor: sum('amountMinor'), discountMinor: sum('discountMinor'), taxMinor: sum('taxMinor'), totalMinor: sum('totalMinor') };
    if (totals.totalMinor < 0n) throw conflict('NOTHING_TO_INVOICE', 'The credits exceed the charges of this period; issue a credit note against an earlier invoice instead');
    const invoice = await guardDb(
      tx.customerInvoice.create({
        data: { companyId: ctx.companyId, contractId: contract.id, customerCompanyId: contract.customerCompanyId, branchId, consolidated: !branchId, periodStart: from, periodEnd: to, currency: contract.currency, ...totals, taxLines: asJson(mergeTaxLines(lineTax)), status: 'DRAFT', idempotencyKey: key, requestHash: hash, billingRunId: runId, createdById: ctx.userId ?? null, buyer: asJson({ name: contract.customerName }), lines: { createMany: { data: lines } } },
      }),
    );
    await this.audit.record(ctx, { action: 'CREATE', entity: 'customer_invoice', entityId: invoice.id, details: { event: 'GENERATED', contractId: contract.id, periodStart, periodEnd, branchId, lines: lines.length, totalMinor: totals.totalMinor.toString(), currency: contract.currency, skipped } }, tx);
    return { invoiceId: invoice.id, skipped };
  }

  // ───────────── issue / delete ─────────────

  async issue(ctx: AuthContext, id: string, invoiceDate?: string | null): Promise<CustomerInvoiceDto> {
    await this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "CustomerInvoice" WHERE "id" = ${id}::uuid AND "companyId" = ${ctx.companyId}::uuid FOR UPDATE`;
      if (!locked.length) throw notFound();
      const inv = await this.load(tx, ctx, id);
      if (inv.status !== 'DRAFT') throw conflict('INVOICE_NOT_DRAFT', 'Only a draft invoice can be issued');
      const supplier = await this.settings.requireSupplier(tx, ctx.companyId);
      const contract = inv.contractId ? await tx.pricingContract.findUnique({ where: { id: inv.contractId } }) : null;
      const company = await tx.company.findUniqueOrThrow({ where: { id: ctx.companyId }, select: { timezone: true } });
      const date = invoiceDate ? ymd(dateOnly(invoiceDate, 'invoiceDate')) : localYmd(new Date(), company.timezone);
      const fy = fiscalYearLabel(date, supplier.fiscalYearStartMonth);
      // Gap-free per supplier company and fiscal year: the counter row stays locked until this transaction commits.
      const [{ lastSeq }] = await tx.$queryRaw<{ lastSeq: number }[]>`
        INSERT INTO "BillingCounter" ("key", "lastSeq") VALUES (${`CINV:${ctx.companyId}:${fy}`}, 1)
        ON CONFLICT ("key") DO UPDATE SET "lastSeq" = "BillingCounter"."lastSeq" + 1 RETURNING "lastSeq"`;
      const seq = Number(lastSeq);
      const number = formatDocumentNumber(supplier.invoicePrefix, fy, seq);
      const buyerProfile = inv.customerCompanyId ? await tx.billingProfile.findUnique({ where: { companyId: inv.customerCompanyId } }) : null;
      const buyer: InvoicePartySnapshot = buyerProfile
        ? { name: buyerProfile.billingName, address: buyerProfile.address, city: buyerProfile.city, stateCode: buyerProfile.stateCode, country: 'IN', taxRegistration: buyerProfile.gstin, email: buyerProfile.email }
        : { name: contract?.customerName ?? ((inv.buyer ?? {}) as { name?: string }).name ?? 'Customer', stateCode: inv.customerCompanyId ? null : supplier.stateCode, country: supplier.country };
      const supplierSnap: InvoicePartySnapshot = { name: supplier.legalName, address: supplier.address, city: supplier.city, stateCode: supplier.stateCode, country: supplier.country, taxRegistration: supplier.taxRegistration, email: supplier.email };
      const taxKind = supplier.taxRegime === 'IN_GST' ? (supplier.stateCode && buyer.stateCode && supplier.stateCode !== buyer.stateCode ? 'IGST' : 'CGST_SGST') : supplier.taxRegime;
      const dueDate = addDaysYmd(date, contract?.paymentTermsDays ?? 0);
      await guardDb(
        tx.customerInvoice.update({
          where: { id },
          data: { status: 'ISSUED', number, fy, seq, issuedAt: new Date(), issuedById: ctx.userId, invoiceDate: new Date(`${date}T00:00:00Z`), dueDate: new Date(`${dueDate}T00:00:00Z`), supplier: asJson({ ...supplierSnap, bank: supplier.bankDetails }), buyer: asJson(buyer), taxKind },
        }),
      );
      const periodIds = inv.lines.filter((l) => l.sourceType === 'AVAILABILITY_PERIOD' && l.sourceId).map((l) => l.sourceId!);
      if (periodIds.length) await tx.availabilityBillingPeriod.updateMany({ where: { id: { in: periodIds }, status: 'CLOSED' }, data: { status: 'INVOICED' } });
      const adjIds = inv.lines.filter((l) => l.sourceType === 'ADJUSTMENT' && l.sourceId).map((l) => l.sourceId!);
      if (adjIds.length) await tx.billingAdjustment.updateMany({ where: { id: { in: adjIds }, status: 'APPROVED' }, data: { status: 'APPLIED', invoiceId: id, appliedAt: new Date(), version: { increment: 1 } } });
      await this.audit.record(ctx, { action: 'UPDATE', entity: 'customer_invoice', entityId: id, details: { event: 'ISSUED', number, fy, seq, totalMinor: inv.totalMinor.toString(), currency: inv.currency } }, tx);
    });
    return this.get(ctx, id);
  }

  async remove(ctx: AuthContext, id: string): Promise<{ ok: true }> {
    await this.prisma.$transaction(async (tx) => {
      const inv = await this.load(tx, ctx, id);
      if (inv.status !== 'DRAFT') throw conflict('INVOICE_ISSUED_IMMUTABLE', 'An issued invoice cannot be deleted; issue a credit note');
      await guardDb(tx.customerInvoice.delete({ where: { id } }));
      // Free the run claim so the period can be generated again (with a new Idempotency-Key).
      if (inv.billingRunId) await tx.billingRun.updateMany({ where: { id: inv.billingRunId }, data: { status: 'FAILED', error: 'draft invoice deleted', finishedAt: new Date() } });
      const { lines: _l, creditNotes: _c, payments: _p, ...before } = inv;
      await this.audit.record(ctx, { action: 'DELETE', entity: 'customer_invoice', entityId: id, before: { ...before, lines: inv.lines.length } }, tx);
    });
    return { ok: true };
  }

  // ───────────── credit notes ─────────────

  async createCreditNote(ctx: AuthContext, id: string, dto: CreateCreditNoteRequest): Promise<CustomerCreditNoteDto> {
    const reason = reasonOf(dto.reason);
    return this.prisma.$transaction(async (tx) => {
      // Row lock on the invoice (FOR UPDATE is not an UPDATE: the immutability trigger does not fire).
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "CustomerInvoice" WHERE "id" = ${id}::uuid AND "companyId" = ${ctx.companyId}::uuid FOR UPDATE`;
      if (!locked.length) throw notFound();
      const inv = await this.load(tx, ctx, id);
      if (inv.status !== 'ISSUED') throw conflict('INVOICE_NOT_DRAFT', 'Credit notes are issued against issued invoices only');
      const credited = inv.creditNotes.reduce((s, c) => s + c.totalMinor, 0n);
      const remaining = inv.totalMinor - credited;
      const amount = dto.amount ? majorToMinor(dto.amount, inv.currency, 'amount', { positive: true }) : remaining;
      if (amount <= 0n || amount > remaining) throw conflict('CREDIT_EXCEEDS_INVOICE', `At most ${formatMinor(remaining, inv.currency)} ${inv.currency} can still be credited`, { remainingMinor: remaining.toString() });
      // Pro rata split over the invoice's tax (a full credit reverses the tax exactly).
      const taxMinor = amount === remaining && credited === 0n ? inv.taxMinor : divRound(inv.taxMinor * amount, inv.totalMinor === 0n ? 1n : inv.totalMinor, 'HALF_UP');
      const invTax = (Array.isArray(inv.taxLines) ? inv.taxLines : []) as unknown as TaxLineDto[];
      const shares = invTax.length ? allocateLargestRemainder(taxMinor, invTax.map((t) => BigInt(t.taxMinor) > 0n ? BigInt(t.taxMinor) : 0n)) : [];
      const taxLines: TaxLineDto[] = invTax.map((t, i) => ({ taxCode: t.taxCode, label: t.label, ratePpm: t.ratePpm, taxableMinor: divRound(BigInt(t.taxableMinor) * amount, inv.totalMinor === 0n ? 1n : inv.totalMinor, 'HALF_UP').toString(), taxMinor: (shares[i] ?? 0n).toString() }));
      const supplier = await this.settings.requireSupplier(tx, ctx.companyId);
      const company = await tx.company.findUniqueOrThrow({ where: { id: ctx.companyId }, select: { timezone: true } });
      const fy = fiscalYearLabel(localYmd(new Date(), company.timezone), supplier.fiscalYearStartMonth);
      const [{ lastSeq }] = await tx.$queryRaw<{ lastSeq: number }[]>`
        INSERT INTO "BillingCounter" ("key", "lastSeq") VALUES (${`CCN:${ctx.companyId}:${fy}`}, 1)
        ON CONFLICT ("key") DO UPDATE SET "lastSeq" = "BillingCounter"."lastSeq" + 1 RETURNING "lastSeq"`;
      const seq = Number(lastSeq);
      const cn = await tx.customerCreditNote.create({
        data: { companyId: ctx.companyId, invoiceId: id, number: formatDocumentNumber(supplier.creditNotePrefix, fy, seq), fy, seq, currency: inv.currency, lines: asJson([{ description: `Credit against ${inv.number}`, amountMinor: (amount - taxMinor).toString(), taxMinor: taxMinor.toString() }]), subtotalMinor: amount - taxMinor, taxMinor, totalMinor: amount, taxLines: asJson(taxLines), reason, issuedById: ctx.userId },
      });
      await this.audit.record(ctx, { action: 'CREATE', entity: 'customer_credit_note', entityId: cn.id, after: { ...cn, invoiceNumber: inv.number } }, tx);
      await this.audit.record(ctx, { action: 'UPDATE', entity: 'customer_invoice', entityId: id, details: { event: 'CREDITED', creditNoteId: cn.id, number: cn.number, totalMinor: amount.toString(), reason } }, tx);
      return creditNoteDto(cn);
    });
  }

  // ───────────── payments ─────────────

  async payments(ctx: AuthContext, id: string): Promise<BillingPaymentDto[]> {
    const inv = await this.load(this.prisma, ctx, id);
    const reversed = new Map(inv.payments.filter((p) => p.reversalOf).map((p) => [p.reversalOf!, p.id]));
    return inv.payments.map((p) => paymentDto(p, reversed.get(p.id) ?? null));
  }

  async recordPayment(ctx: AuthContext, id: string, dto: RecordPaymentRequest): Promise<BillingPaymentDto> {
    if (!PAYMENT_METHODS.includes(dto.method)) throw invalid('method is invalid');
    const receivedAt = new Date(dto.receivedAt);
    if (Number.isNaN(receivedAt.getTime())) throw invalid('receivedAt must be a date / time');
    return this.prisma.$transaction(async (tx) => {
      const inv = await this.load(tx, ctx, id);
      if (inv.status !== 'ISSUED') throw conflict('INVOICE_NOT_DRAFT', 'Payments are recorded against issued invoices');
      const amount = majorToMinor(dto.amount, inv.currency, 'amount', { positive: true });
      const p = await tx.billingPayment.create({ data: { companyId: ctx.companyId, invoiceId: id, amountMinor: amount, currency: inv.currency, receivedAt, method: dto.method, reference: dto.reference?.trim() || null, note: dto.note?.trim() || null, recordedById: ctx.userId } });
      await this.audit.record(ctx, { action: 'CREATE', entity: 'billing_payment', entityId: p.id, after: p }, tx);
      return paymentDto(p, null);
    });
  }

  async reversePayment(ctx: AuthContext, paymentId: string, reason: string): Promise<BillingPaymentDto> {
    const why = reasonOf(reason);
    return this.prisma.$transaction(async (tx) => {
      const p = await tx.billingPayment.findFirst({ where: { id: paymentId, companyId: ctx.companyId } });
      if (!p) throw notFound();
      await this.load(tx, ctx, p.invoiceId);
      if (p.reversalOf || p.amountMinor < 0n) throw conflict('VALIDATION_FAILED', 'A reversal cannot be reversed');
      const r = await guardDb(tx.billingPayment.create({ data: { companyId: ctx.companyId, invoiceId: p.invoiceId, amountMinor: -p.amountMinor, currency: p.currency, receivedAt: new Date(), method: p.method, reference: p.reference, note: why, recordedById: ctx.userId, reversalOf: p.id } }));
      await this.audit.record(ctx, { action: 'CREATE', entity: 'billing_payment', entityId: r.id, details: { event: 'REVERSED', reversalOf: p.id, amountMinor: r.amountMinor.toString(), reason: why } }, tx);
      return paymentDto(r, null);
    }).catch((e: unknown) => {
      if (e instanceof Error && /reversalOf/.test(e.message) && /Unique/i.test(e.message)) throw conflict('VALIDATION_FAILED', 'This payment was already reversed');
      throw e;
    });
  }

  // ───────────── PDF (rendered from the frozen snapshot: identical every time) ─────────────

  async pdf(ctx: AuthContext, id: string): Promise<StreamableFile> {
    const inv = await this.get(ctx, id);
    if (inv.status !== 'ISSUED') throw conflict('INVOICE_NOT_DRAFT', 'Only issued invoices have a PDF');
    setupPdf();
    const money = (m: string) => `${formatMinor(BigInt(m), inv.currency)} ${inv.currency}`;
    const party = (title: string, p: InvoicePartySnapshot): Content => ({ stack: [{ text: title, bold: true, fontSize: 9, color: '#666' }, { text: p.name, bold: true }, ...[p.address, [p.city, p.stateCode].filter(Boolean).join(' '), p.taxRegistration ? `Tax reg.: ${p.taxRegistration}` : null, p.email].filter((x): x is string => !!x).map((t) => ({ text: t, fontSize: 9 }))] });
    const doc: TDocumentDefinitions = {
      pageSize: 'A4',
      pageMargins: [36, 40, 36, 40],
      defaultStyle: { font: 'NotoSans', fontSize: 10 },
      content: [
        { text: 'TAX INVOICE', bold: true, fontSize: 16, margin: [0, 0, 0, 8] },
        { columns: [party('Supplier', inv.supplier), party('Bill to', inv.buyer), { stack: [{ text: `Invoice ${inv.number}`, bold: true }, { text: `Date ${inv.invoiceDate}` }, { text: `Due ${inv.dueDate}` }, { text: `Period ${inv.periodStart} – ${inv.periodEnd}`, fontSize: 9 }] }], columnGap: 12, margin: [0, 0, 0, 12] },
        {
          table: {
            headerRows: 1,
            widths: ['*', 'auto', 'auto', 'auto', 'auto'],
            body: [
              ['Description', 'Amount', 'Discount', 'Tax', 'Total'].map((t) => ({ text: t, bold: true })),
              ...inv.lines.map((l) => [l.description, money(l.amountMinor), money(l.discountMinor), money(l.taxMinor), money(l.totalMinor)]),
            ],
          },
          layout: 'lightHorizontalLines',
          fontSize: 9,
        },
        {
          margin: [0, 10, 0, 0],
          table: {
            widths: ['*', 'auto'],
            body: [
              ['Subtotal', money(inv.subtotalMinor)],
              ['Discount', money(inv.discountMinor)],
              ...inv.taxLines.flatMap((t) => {
                const parts: [string, string | undefined][] = [['CGST', t.cgstMinor], ['SGST', t.sgstMinor], ['UTGST', t.utgstMinor], ['IGST', t.igstMinor]];
                const split = parts.filter(([, v]) => v !== undefined && v !== '0');
                return split.length ? split.map(([k, v]) => [`${k} (${t.label})`, money(v!)]) : [[t.label, money(t.taxMinor)]];
              }),
              [{ text: 'Total', bold: true }, { text: money(inv.totalMinor), bold: true }],
            ],
          },
          layout: 'noBorders',
        },
      ],
    };
    const buffer: Buffer = await pdfmake.createPdf(doc).getBuffer();
    return new StreamableFile(buffer, { type: 'application/pdf', disposition: `attachment; filename="${(inv.number ?? inv.id).replace(/[^A-Za-z0-9-]/g, '_')}.pdf"` });
  }
}

export function creditNoteDto(c: Prisma.CustomerCreditNoteGetPayload<object>): CustomerCreditNoteDto {
  return { id: c.id, invoiceId: c.invoiceId, number: c.number, fy: c.fy, currency: c.currency, subtotalMinor: c.subtotalMinor.toString(), taxMinor: c.taxMinor.toString(), totalMinor: c.totalMinor.toString(), taxLines: (Array.isArray(c.taxLines) ? c.taxLines : []) as unknown as TaxLineDto[], reason: c.reason, issuedAt: c.issuedAt.toISOString(), issuedById: c.issuedById };
}

export function paymentDto(p: Prisma.BillingPaymentGetPayload<object>, reversedBy: string | null): BillingPaymentDto {
  return { id: p.id, invoiceId: p.invoiceId, amountMinor: p.amountMinor.toString(), currency: p.currency, receivedAt: p.receivedAt.toISOString(), method: p.method as BillingPaymentDto['method'], reference: p.reference, note: p.note, recordedById: p.recordedById, reversalOf: p.reversalOf, reversedBy, createdAt: p.createdAt.toISOString() };
}

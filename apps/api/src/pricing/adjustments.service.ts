import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  REQUESTABLE_ADJUSTMENT_KINDS,
  type BillingAdjustmentDto,
  type BillingAdjustmentListQuery,
  type CreateBillingAdjustmentRequest,
  type PricingPage,
} from '@veetracer/shared';
import type { AuthContext } from '../access/auth-context';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { asJson, conflict, contractVisible, forbidden, invalid, isCompanyScope, majorToMinor, notFound, pageOf, paging, reasonOf } from './pricing-common';
import { CustomerInvoicesService } from './invoices.service';
import { adjustmentDto, TripPricingService } from './trip-pricing.service';

/**
 * Doc 19 §3.2 BillingAdjustment, maker-checker: a request (pricing_adjustments:create) is decided by a different user
 * holding pricing_adjustments:approve (also enforced by a CHECK in the database). Approved CREDIT / DEBIT / WAIVER
 * amounts go on the contract's next invoice; an approved PRICE_OVERRIDE re-prices its trip with the negotiated price.
 */
@Injectable()
export class BillingAdjustmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly trips: TripPricingService,
    private readonly invoices: CustomerInvoicesService,
  ) {}

  private async visibleContractIds(ctx: AuthContext): Promise<string[] | null> {
    if (isCompanyScope(ctx)) return null;
    const rows = await this.prisma.pricingContract.findMany({ where: { companyId: ctx.companyId }, select: { id: true, branchIds: true } });
    return rows.filter((c) => contractVisible(ctx, c)).map((c) => c.id);
  }

  async list(ctx: AuthContext, q: BillingAdjustmentListQuery): Promise<PricingPage<BillingAdjustmentDto>> {
    const p = paging(q);
    const visible = await this.visibleContractIds(ctx);
    const where: Prisma.BillingAdjustmentWhereInput = {
      companyId: ctx.companyId,
      ...(q.status ? { status: q.status } : {}),
      ...(q.contractId ? { contractId: q.contractId } : {}),
      ...(visible ? { contractId: { in: q.contractId ? visible.filter((v) => v === q.contractId) : visible } } : {}),
    };
    const [rows, total] = await Promise.all([this.prisma.billingAdjustment.findMany({ where, orderBy: { requestedAt: 'desc' }, skip: p.skip, take: p.pageSize }), this.prisma.billingAdjustment.count({ where })]);
    return pageOf(rows.map(adjustmentDto), total, p);
  }

  async create(ctx: AuthContext, dto: CreateBillingAdjustmentRequest): Promise<BillingAdjustmentDto> {
    if (!REQUESTABLE_ADJUSTMENT_KINDS.includes(dto.kind)) throw invalid('kind must be CREDIT, DEBIT or WAIVER');
    const reason = reasonOf(dto.reason);
    return this.prisma.$transaction(async (tx) => {
      const contract = await tx.pricingContract.findFirst({ where: { id: dto.contractId, companyId: ctx.companyId } });
      if (!contract || !contractVisible(ctx, contract)) throw notFound();
      const amount = majorToMinor(dto.amount, contract.currency, 'amount', { positive: true });
      if (dto.transportTripId && !(await tx.transportTrip.findFirst({ where: { id: dto.transportTripId, providerCompanyId: ctx.companyId } }))) throw invalid('Unknown trip');
      const row = await tx.billingAdjustment.create({
        data: { companyId: ctx.companyId, contractId: contract.id, transportTripId: dto.transportTripId ?? null, kind: dto.kind, amountMinor: dto.kind === 'DEBIT' ? amount : -amount, currency: contract.currency, reason, requestedById: ctx.userId },
      });
      await this.audit.record(ctx, { action: 'CREATE', entity: 'billing_adjustment', entityId: row.id, after: row }, tx);
      return adjustmentDto(row);
    });
  }

  async decide(ctx: AuthContext, id: string, approve: boolean, note?: string | null): Promise<BillingAdjustmentDto> {
    const why = approve ? (note?.trim() || null) : reasonOf(note, 'note');
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "BillingAdjustment" WHERE "id" = ${id}::uuid AND "companyId" = ${ctx.companyId}::uuid FOR UPDATE`;
      if (!rows.length) throw notFound();
      const a = await tx.billingAdjustment.findUniqueOrThrow({ where: { id } });
      const contract = await tx.pricingContract.findUniqueOrThrow({ where: { id: a.contractId } });
      if (!contractVisible(ctx, contract)) throw notFound();
      if (a.status !== 'PENDING_APPROVAL') throw conflict('VALIDATION_FAILED', `This adjustment is already ${a.status.toLowerCase()}`);
      if (a.requestedById === ctx.userId) throw forbidden('MAKER_CHECKER_SAME_USER', 'An adjustment must be decided by a different user than the one who requested it');
      let status = approve ? 'APPROVED' : 'REJECTED';
      const extra: Record<string, unknown> = {};
      if (approve && a.kind === 'CREDIT' && a.invoiceId) {
        // QA 10: the approver (≠ requester) issues the credit note.
        const amount = BigInt(((a.data ?? {}) as { amountMinor?: string }).amountMinor ?? (-a.amountMinor).toString());
        const cn = await this.invoices.issueCreditNoteInTx(tx, ctx, a.invoiceId, amount, a.reason, a.id);
        extra.creditNoteId = cn.id;
        extra.creditNoteNumber = cn.number;
        status = 'APPLIED';
      }
      if (approve && a.kind === 'DISTANCE_CORRECTION') {
        if (!a.transportTripId) throw conflict('VALIDATION_FAILED', 'The correction has no trip');
        if (!contract.allowTripOverrides && contract.distanceSource !== 'MANUAL_APPROVED') throw conflict('TRIP_OVERRIDE_NOT_PERMITTED', 'This contract no longer permits manual billable distances');
        const m = Number(((a.data ?? {}) as { manualDistanceM?: number }).manualDistanceM);
        await this.trips.priceInTx(tx, ctx, a.transportTripId, { reason: `manual distance: ${a.reason} (approved)`, manualDistanceM: m });
        status = 'APPLIED';
      }
      if (approve && a.kind === 'PRICE_OVERRIDE') {
        if (!a.transportTripId) throw conflict('VALIDATION_FAILED', 'The override has no trip');
        if (!contract.allowTripOverrides) throw conflict('TRIP_OVERRIDE_NOT_PERMITTED', 'This contract no longer permits trip overrides');
        const overrideMinor = BigInt(((a.data ?? {}) as { overrideMinor?: string }).overrideMinor ?? '0');
        await this.trips.priceInTx(tx, ctx, a.transportTripId, { reason: `override: ${a.reason}`, override: { minor: overrideMinor, reason: a.reason, byId: a.requestedById, approvedById: ctx.userId } });
        status = 'APPLIED';
      }
      const after = await tx.billingAdjustment.update({ where: { id }, data: { status, decidedById: ctx.userId, decidedAt: new Date(), decisionNote: why, ...(status === 'APPLIED' ? { appliedAt: new Date() } : {}), ...(Object.keys(extra).length ? { data: asJson({ ...((a.data ?? {}) as object), ...extra }) } : {}), version: { increment: 1 } } });
      await this.audit.record(ctx, { action: 'UPDATE', entity: 'billing_adjustment', entityId: id, before: a, after }, tx);
      return adjustmentDto(after);
    });
  }
}

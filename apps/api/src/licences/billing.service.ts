import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  addYears,
  BillingProfileDto,
  CheckoutDto,
  gstBreakdown,
  gstinError,
  LICENCE_TYPE_LABELS,
  LicenceOverviewDto,
  LicenceOwnerRef,
  OfflinePaymentRequest,
  PurchaseRequest,
  QuoteDto,
  QuoteLineDto,
  renewedExpiry,
  stateByCode,
} from '@veetracer/shared';
import { AuthContext } from '../access/auth-context';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { InvoicesService } from './invoices.service';
import { LicencePolicyService } from './licence-policy.service';
import { LicenceSettingsService } from './licence-settings.service';
import { RazorpayClient, razorpayConfig, webhookPayment } from './razorpay';
import { quoteLines } from './seat-logic';
import { PoolsService } from './pools.service';

/** Buyer of licences: a customer company (its own pool) or a partner (bulk pool). */
export interface Owner extends LicenceOwnerRef {
  /** For a company: its partner (partner prices apply when the partner has overrides). */
  partnerId: string | null;
}

export const ownerWhere = (o: Owner) => (o.kind === 'COMPANY' ? { companyId: o.id } : { partnerId: o.id, companyId: null });

const emptyProfile: BillingProfileDto = { billingName: '', address: '', city: '', stateCode: '', pin: '', gstin: '', email: '', complete: false };

export function profileDto(p: { billingName: string; address: string; city: string; stateCode: string; pin: string; gstin: string | null; email: string } | null): BillingProfileDto {
  if (!p) return emptyProfile;
  return {
    billingName: p.billingName,
    address: p.address,
    city: p.city,
    stateCode: p.stateCode,
    pin: p.pin,
    gstin: p.gstin ?? '',
    email: p.email,
    complete: !!(p.billingName.trim() && p.address.trim() && stateByCode(p.stateCode) && p.email.trim()),
  };
}

/** Stored quote lines of an order. */
export interface OrderItems {
  lines: QuoteLineDto[];
}

/**
 * Purchases and renewals: billing profiles, GST quotes, Razorpay checkout (activation only after a verified webhook or a
 * server-side signature check plus a payment fetch), offline payments recorded by a Super Admin / partner, and order
 * fulfilment (new seats, renewals, invoice) — idempotent per order and per Razorpay payment id.
 */
@Injectable()
export class BillingService {
  private readonly logger = new Logger('Billing');
  private readonly razorpay: RazorpayClient | null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: LicenceSettingsService,
    private readonly policy: LicencePolicyService,
    private readonly invoices: InvoicesService,
    private readonly pools: PoolsService,
    private readonly audit: AuditService,
  ) {
    const cfg = razorpayConfig();
    this.razorpay = cfg ? new RazorpayClient(cfg) : null;
  }

  get onlineEnabled(): boolean {
    return !!this.razorpay;
  }

  get razorpayKeyId(): string | null {
    return this.razorpay?.keyId ?? null;
  }

  // ───────────── owners ─────────────

  async companyOwner(companyId: string): Promise<Owner> {
    const c = await this.prisma.company.findUnique({ where: { id: companyId }, select: { id: true, name: true, partnerId: true, isPlatform: true } });
    if (!c) throw new NotFoundException('Company not found');
    if (c.isPlatform) throw new BadRequestException('The platform company does not need licences');
    return { kind: 'COMPANY', id: c.id, name: c.name, partnerId: c.partnerId };
  }

  async partnerOwner(partnerId: string): Promise<Owner> {
    const p = await this.prisma.partner.findUnique({ where: { id: partnerId }, select: { id: true, name: true } });
    if (!p) throw new NotFoundException('Partner not found');
    return { kind: 'PARTNER', id: p.id, name: p.name, partnerId: p.id };
  }

  /** The partner whose own (home) company the caller belongs to; Forbidden for everyone else. */
  async partnerOf(ctx: AuthContext): Promise<Owner> {
    const p = await this.prisma.partner.findUnique({ where: { homeCompanyId: ctx.homeCompanyId }, select: { id: true } });
    if (!p) throw new ForbiddenException('Your account is not a partner (reseller) account');
    return this.partnerOwner(p.id);
  }

  // ───────────── billing profile ─────────────

  async profile(owner: Owner): Promise<BillingProfileDto> {
    return profileDto(await this.prisma.billingProfile.findUnique({ where: owner.kind === 'COMPANY' ? { companyId: owner.id } : { partnerId: owner.id } }));
  }

  async saveProfile(ctx: AuthContext, owner: Owner, dto: Omit<BillingProfileDto, 'complete'>): Promise<BillingProfileDto> {
    if (!stateByCode(dto.stateCode)) throw new BadRequestException('Select the billing state');
    if (dto.pin && !/^\d{6}$/.test(dto.pin.trim())) throw new BadRequestException('PIN code must be 6 digits');
    const gstin = dto.gstin?.trim().toUpperCase() || null;
    if (gstin) {
      const err = gstinError(gstin, dto.stateCode);
      if (err) throw new BadRequestException(err);
    }
    const data = {
      billingName: dto.billingName.trim(),
      address: dto.address.trim(),
      city: dto.city.trim(),
      stateCode: dto.stateCode,
      pin: dto.pin.trim(),
      gstin,
      email: dto.email.trim().toLowerCase(),
    };
    const key = owner.kind === 'COMPANY' ? { companyId: owner.id } : { partnerId: owner.id };
    const before = await this.prisma.billingProfile.findUnique({ where: key });
    const row = await this.prisma.billingProfile.upsert({ where: key, create: { ...key, ...data }, update: data });
    await this.audit.record(ctx, { action: before ? 'UPDATE' : 'CREATE', entity: 'billing_profile', entityId: row.id, before: before ?? undefined, after: row });
    return profileDto(row);
  }

  // ───────────── quotes ─────────────

  async quote(owner: Owner, req: PurchaseRequest, paidAt = new Date()): Promise<QuoteDto> {
    const items = (req.items ?? []).filter((i) => i.quantity > 0);
    const renewIds = [...new Set(req.renewSeatIds ?? [])];
    if (!items.length && !renewIds.length) throw new BadRequestException('Choose licences to buy or seats to renew');
    if (items.some((i) => !Number.isInteger(i.quantity) || i.quantity > 1000)) throw new BadRequestException('Quantity must be a whole number up to 1000');
    const renewals = renewIds.length
      ? await this.prisma.licenceSeat.findMany({ where: { id: { in: renewIds }, ...ownerWhere(owner) }, select: { id: true, type: true, expiresAt: true } })
      : [];
    if (renewals.length !== renewIds.length) throw new BadRequestException('Some seats to renew were not found in this pool');
    const prices = await this.settings.pricesFor(owner.kind === 'PARTNER' ? owner.id : owner.partnerId);
    const unpriced = [...items.map((i) => i.type), ...renewals.map((r) => r.type)].find((t) => !prices[t]);
    if (unpriced) throw new BadRequestException(`The ${LICENCE_TYPE_LABELS[unpriced].toLowerCase()} licence price has not been set yet. Please contact support.`);
    const lines = quoteLines(items, renewals, prices, paidAt);
    const s = await this.settings.get();
    const profile = await this.profile(owner);
    const customerState = profile.stateCode || s.stateCode;
    return {
      lines,
      gst: gstBreakdown(lines.map((l) => l.amountPaise), s.gstRatePct, s.stateCode, customerState),
      customerStateCode: customerState,
      supplierStateCode: s.stateCode,
    };
  }

  private async requireProfile(owner: Owner): Promise<BillingProfileDto> {
    const p = await this.profile(owner);
    if (!p.complete) throw new BadRequestException('Fill in the billing details (name, address, state and e-mail) before buying');
    return p;
  }

  async overview(owner: Owner): Promise<LicenceOverviewDto> {
    const { seats, summary } = await this.pools.seats(ownerWhere(owner));
    const s = await this.settings.get();
    return {
      owner: { kind: owner.kind, id: owner.id, name: owner.name },
      summary,
      seats,
      pricesPaise: await this.settings.pricesFor(owner.kind === 'PARTNER' ? owner.id : owner.partnerId),
      gstRatePct: s.gstRatePct,
      graceDays: s.graceDays,
      billing: await this.profile(owner),
      onlinePayment: { enabled: this.onlineEnabled, keyId: this.razorpayKeyId },
      payOffline: {
        bankName: s.bankName,
        bankAccountName: s.bankAccountName,
        bankAccountNo: s.bankAccountNo,
        bankIfsc: s.bankIfsc,
        bankBranch: s.bankBranch,
        upiId: s.upiId,
        supplierName: s.legalName,
      },
    };
  }

  // ───────────── offline payments ─────────────

  /** Cash / UPI / bank transfer / cheque received: activates the seats and issues the invoice at once. */
  async recordOffline(ctx: AuthContext, owner: Owner, dto: OfflinePaymentRequest): Promise<{ orderId: string; invoiceId: string | null }> {
    await this.requireProfile(owner);
    const paidAt = paidOnDate(dto.paidOn);
    if (paidAt.getTime() > Date.now() + 86_400_000) throw new BadRequestException('The payment date cannot be in the future');
    const q = await this.quote(owner, dto, paidAt);
    if (q.gst.totalPaise !== dto.amountPaise) {
      throw new BadRequestException(`The amount must equal the total of Rs. ${(q.gst.totalPaise / 100).toFixed(2)} (GST inclusive)`);
    }
    const order = await this.prisma.licenceOrder.create({
      data: {
        ...(owner.kind === 'COMPANY' ? { companyId: owner.id } : { partnerId: owner.id }),
        status: 'CREATED',
        mode: dto.mode,
        items: { lines: q.lines } as unknown as Prisma.InputJsonValue,
        amountPaise: q.gst.totalPaise,
        paymentReference: dto.reference?.trim() || null,
        createdById: ctx.userId,
      },
    });
    const invoiceId = await this.fulfil(order.id, { paidAt, reference: dto.reference?.trim() || null });
    await this.audit.record(ctx, {
      action: 'CREATE',
      entity: 'licence_payment',
      entityId: order.id,
      details: { owner: `${owner.kind}:${owner.id}`, mode: dto.mode, reference: dto.reference ?? null, amountPaise: dto.amountPaise, paidOn: dto.paidOn, invoiceId },
    });
    return { orderId: order.id, invoiceId };
  }

  // ───────────── Razorpay ─────────────

  async checkout(ctx: AuthContext, owner: Owner, req: PurchaseRequest): Promise<CheckoutDto> {
    if (!this.razorpay) throw new ServiceUnavailableException('Online payment is not available. Pay by bank transfer / UPI and send the reference to us.');
    const profile = await this.requireProfile(owner);
    const q = await this.quote(owner, req);
    const order = await this.prisma.licenceOrder.create({
      data: {
        ...(owner.kind === 'COMPANY' ? { companyId: owner.id } : { partnerId: owner.id }),
        status: 'CREATED',
        mode: 'ONLINE',
        items: { lines: q.lines } as unknown as Prisma.InputJsonValue,
        amountPaise: q.gst.totalPaise,
        createdById: ctx.userId,
      },
    });
    const rz = await this.razorpay.createOrder(q.gst.totalPaise, order.id, { orderId: order.id, owner: `${owner.kind}:${owner.id}` });
    await this.prisma.licenceOrder.update({ where: { id: order.id }, data: { razorpayOrderId: rz.id } });
    const user = await this.prisma.user.findUnique({ where: { id: ctx.userId }, select: { mobile: true } });
    return {
      orderId: order.id,
      razorpayOrderId: rz.id,
      keyId: this.razorpay.keyId,
      amountPaise: q.gst.totalPaise,
      currency: 'INR',
      name: 'VeeTrax',
      description: q.lines.map((l) => `${l.quantity} x ${LICENCE_TYPE_LABELS[l.type]}${l.kind === 'RENEWAL' ? ' renewal' : ''}`).join(', ').slice(0, 250),
      prefill: { name: profile.billingName, email: profile.email, contact: user?.mobile ?? '' },
    };
  }

  /**
   * Checkout success callback from the browser. Never trusted on its own: the signature is verified with the key
   * secret and the payment is fetched from Razorpay; only a captured payment of the right order and amount activates.
   */
  async verifyCheckout(owner: Owner, body: { razorpayOrderId: string; razorpayPaymentId: string; razorpaySignature: string }): Promise<{ status: 'PAID' | 'PENDING'; invoiceId: string | null }> {
    if (!this.razorpay) throw new ServiceUnavailableException('Online payment is not available');
    const order = await this.prisma.licenceOrder.findFirst({
      where: { razorpayOrderId: body.razorpayOrderId, ...(owner.kind === 'COMPANY' ? { companyId: owner.id } : { partnerId: owner.id }) },
    });
    if (!order) throw new NotFoundException('Order not found');
    if (order.status === 'PAID') return { status: 'PAID', invoiceId: await this.invoiceIdOf(order.id) };
    if (!this.razorpay.verifyCheckout(body.razorpayOrderId, body.razorpayPaymentId, body.razorpaySignature)) throw new BadRequestException('Payment signature is invalid');
    const payment = await this.razorpay.fetchPayment(body.razorpayPaymentId);
    if (payment.order_id !== body.razorpayOrderId || payment.amount !== order.amountPaise) throw new BadRequestException('Payment does not match the order');
    if (payment.status !== 'captured') return { status: 'PENDING', invoiceId: null };
    const invoiceId = await this.fulfil(order.id, { paidAt: new Date(), razorpayPaymentId: payment.id });
    return { status: 'PAID', invoiceId: invoiceId ?? (await this.invoiceIdOf(order.id)) };
  }

  /** Razorpay webhook (payment.captured / order.paid / payment.failed); the raw body's signature is checked first. */
  async webhook(rawBody: Buffer | undefined, signature: string | undefined): Promise<{ ok: true; result: string }> {
    if (!this.razorpay) throw new ServiceUnavailableException('Online payment is not configured');
    if (!rawBody || !this.razorpay.verifyWebhook(rawBody, signature)) throw new BadRequestException('Invalid webhook signature');
    let body: unknown;
    try {
      body = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw new BadRequestException('Invalid JSON');
    }
    const p = webhookPayment(body);
    if (!p.orderId) return { ok: true, result: 'ignored' };
    const order = await this.prisma.licenceOrder.findUnique({ where: { razorpayOrderId: p.orderId } });
    if (!order) return { ok: true, result: 'unknown order' };
    if (p.event === 'payment.failed') {
      await this.prisma.licenceOrder.updateMany({ where: { id: order.id, status: 'CREATED' }, data: { status: 'FAILED', failureReason: 'Payment failed' } });
      return { ok: true, result: 'failed' };
    }
    if (p.event !== 'payment.captured' && p.event !== 'order.paid') return { ok: true, result: 'ignored' };
    if (!p.paymentId) return { ok: true, result: 'no payment' };
    if (p.amount !== null && p.amount !== order.amountPaise) {
      this.logger.warn(`Razorpay payment ${p.paymentId} amount ${p.amount} does not match order ${order.id} (${order.amountPaise}); not activated`);
      return { ok: true, result: 'amount mismatch' };
    }
    const invoiceId = await this.fulfil(order.id, { paidAt: new Date(), razorpayPaymentId: p.paymentId });
    return { ok: true, result: invoiceId ? 'activated' : 'duplicate' };
  }

  private async invoiceIdOf(orderId: string): Promise<string | null> {
    return (await this.prisma.invoice.findUnique({ where: { orderId }, select: { id: true } }))?.id ?? null;
  }

  // ───────────── fulfilment ─────────────

  /**
   * Mark the order paid and apply it — once: the CREATED → PAID claim is a conditional update, so a duplicate webhook,
   * the checkout callback and a retry can race safely. Creates the new seats, extends renewed ones, rebalances the
   * company pool and issues the invoice in one transaction (so an invoice number is never lost); e-mails it after.
   */
  async fulfil(orderId: string, pay: { paidAt: Date; razorpayPaymentId?: string; reference?: string | null }): Promise<string | null> {
    const invoiceId = await this.prisma.$transaction(
      async (tx) => {
        const claimed = await tx.licenceOrder.updateMany({
          where: { id: orderId, status: { in: ['CREATED', 'FAILED'] } },
          data: {
            status: 'PAID',
            paidAt: pay.paidAt,
            razorpayPaymentId: pay.razorpayPaymentId,
            ...(pay.reference !== undefined ? { paymentReference: pay.reference } : {}),
            failureReason: null,
          },
        });
        if (claimed.count !== 1) return null;
        const order = await tx.licenceOrder.findUniqueOrThrow({ where: { id: orderId } });
        const owner = order.companyId ? { companyId: order.companyId } : { partnerId: order.partnerId, companyId: null };
        const lines: QuoteLineDto[] = [];
        for (const l of (order.items as unknown as OrderItems).lines) {
          if (l.kind === 'NEW') {
            const expiresAt = addYears(pay.paidAt);
            const seatIds: string[] = [];
            for (let i = 0; i < l.quantity; i++) {
              const seat = await tx.licenceSeat.create({
                data: { type: l.type, ...owner, source: 'PURCHASE', activatedAt: pay.paidAt, expiresAt, lastOrderId: order.id },
                select: { id: true },
              });
              seatIds.push(seat.id);
            }
            lines.push({ ...l, periodFrom: pay.paidAt.toISOString(), periodTo: expiresAt.toISOString(), seatIds });
            continue;
          }
          for (const seatId of l.seatIds) {
            const seat = await tx.licenceSeat.findFirst({ where: { id: seatId, ...owner } });
            if (!seat) {
              // The seat left this pool meanwhile: the buyer gets a fresh seat for the year paid for.
              const expiresAt = addYears(pay.paidAt);
              const fresh = await tx.licenceSeat.create({ data: { type: l.type, ...owner, source: 'PURCHASE', activatedAt: pay.paidAt, expiresAt, lastOrderId: order.id } });
              lines.push({ ...l, seatIds: [fresh.id], periodFrom: pay.paidAt.toISOString(), periodTo: expiresAt.toISOString() });
              continue;
            }
            const from = seat.expiresAt.getTime() > pay.paidAt.getTime() ? seat.expiresAt : pay.paidAt;
            const expiresAt = renewedExpiry(seat.expiresAt, pay.paidAt);
            await tx.licenceSeat.update({ where: { id: seat.id }, data: { expiresAt, notifiedState: null, lastOrderId: order.id } });
            lines.push({ ...l, periodFrom: from.toISOString(), periodTo: expiresAt.toISOString() });
          }
        }
        if (order.companyId) await this.pools.rebalance(tx, order.companyId, pay.paidAt.getTime());
        return (await this.invoices.issue(tx, order, lines, pay)).id;
      },
      { timeout: 30_000, maxWait: 10_000 },
    );
    if (invoiceId) {
      this.policy.invalidate();
      void this.invoices.deliver(invoiceId).catch((e: Error) => this.logger.error(`Invoice ${invoiceId} delivery failed: ${e.message}`));
    }
    return invoiceId;
  }
}

/** YYYY-MM-DD → today: now; another day: noon India time of that day. */
export function paidOnDate(ymd: string, now = Date.now()): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) throw new BadRequestException('Payment date must be YYYY-MM-DD');
  const todayIst = new Date(now + 330 * 60_000).toISOString().slice(0, 10);
  if (ymd === todayIst) return new Date(now);
  const d = new Date(`${ymd}T12:00:00+05:30`);
  if (Number.isNaN(d.getTime())) throw new BadRequestException('Payment date is invalid');
  return d;
}

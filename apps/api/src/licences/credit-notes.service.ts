import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { CreditNote, Invoice, Prisma } from '@prisma/client';
import { CreditNoteDto, CreditNoteRequest, financialYear, formatInr, formatInvoiceNumber, InvoiceCreditsDto, RefundMode, TaxKind } from '@veetracer/shared';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AuthContext } from '../access/auth-context';
import { AuditService } from '../audit/audit.service';
import { MailerService } from '../auth/mailer.service';
import { PrismaService } from '../prisma/prisma.service';
import { ApiAccessService } from './api-access.service';
import { CreditNoteLineSnapshot, creditableLines, pickSeatsToRevoke, planCredit, PriorCreditLine, revokedExpiry } from './credit-logic';
import { CreditNoteSnapshot, renderCreditNotePdf } from './credit-note-pdf';
import { nextCreditNoteSeq } from './invoice-numbering';
import { invoiceDate, InvoiceSnapshot } from './invoice-pdf';
import { INVOICE_DIR, invoiceDto } from './invoices.service';
import { LicencePolicyService } from './licence-policy.service';
import { LicenceSettingsService } from './licence-settings.service';
import { PoolsService } from './pools.service';

type CreditNoteRow = CreditNote & { invoice: { number: string } };

export function creditNoteDto(c: CreditNoteRow): CreditNoteDto {
  return {
    id: c.id,
    number: c.number,
    issuedAt: c.issuedAt.toISOString(),
    invoiceId: c.invoiceId,
    invoiceNumber: c.invoice.number,
    buyerName: c.buyerName,
    companyId: c.companyId,
    partnerId: c.partnerId,
    gstin: c.buyerGstin,
    stateCode: c.buyerStateCode,
    reason: c.reason,
    taxablePaise: c.taxablePaise,
    cgstPaise: c.cgstPaise,
    sgstPaise: c.sgstPaise,
    utgstPaise: c.utgstPaise,
    igstPaise: c.igstPaise,
    totalPaise: c.totalPaise,
    refundMode: c.refundMode as RefundMode,
    refundReference: c.refundReference,
    keepSeatsActive: c.keepSeatsActive,
    revokedSeats: c.revokedSeatIds.length,
    emailedAt: c.emailedAt?.toISOString() ?? null,
  };
}

const priorLines = (notes: Pick<CreditNote, 'snapshot'>[]): PriorCreditLine[] =>
  notes.flatMap((n) => (n.snapshot as unknown as CreditNoteSnapshot).lines.map((l) => ({ lineIndex: l.lineIndex, quantity: l.quantity, amountPaise: l.amountPaise })));

const INCLUDE = { invoice: { select: { number: true } } } as const;

/**
 * GST credit notes (Super Admin only): full or partial credit of an invoice, own gap-free number series per financial
 * year, credited seats expired (unless kept for a price correction), PDF stored and e-mailed like invoices.
 * Refunds are recorded, not executed: the Razorpay refunds API is not wired up yet (see TODO in create()).
 */
@Injectable()
export class CreditNotesService {
  private readonly logger = new Logger('CreditNotes');

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: LicenceSettingsService,
    private readonly pools: PoolsService,
    private readonly policy: LicencePolicyService,
    private readonly apiAccess: ApiAccessService,
    private readonly mailer: MailerService,
    private readonly audit: AuditService,
  ) {}

  /** The invoice with its creditable lines and credit notes so far (scope limits to a company / partner). */
  async credits(invoiceId: string, scope: { companyId?: string; partnerId?: string } = {}): Promise<InvoiceCreditsDto> {
    const inv = await this.prisma.invoice.findFirst({ where: { id: invoiceId, ...scope }, include: { creditNotes: { include: INCLUDE, orderBy: { issuedAt: 'asc' } } } });
    if (!inv) throw new NotFoundException('Invoice not found');
    const snap = inv.lines as unknown as InvoiceSnapshot;
    const credited = inv.creditNotes.reduce((a, c) => a + c.totalPaise, 0);
    return {
      invoice: invoiceDto(inv),
      lines: creditableLines(snap.lines, priorLines(inv.creditNotes)),
      creditedPaise: credited,
      remainingPaise: Math.max(0, inv.totalPaise - credited),
      creditNotes: inv.creditNotes.map(creditNoteDto),
    };
  }

  /** Issue a credit note against an invoice (Super Admin). Serialised per invoice by a row lock on the invoice. */
  async create(ctx: AuthContext, invoiceId: string, req: CreditNoteRequest): Promise<CreditNoteDto> {
    if (!ctx.isSuperAdmin) throw new ForbiddenException('Only a Super Admin can issue credit notes');
    const reason = req.reason?.trim() ?? '';
    if (reason.length < 3) throw new BadRequestException('A reason is required');
    const s = await this.settings.get();
    const now = new Date();
    const result = await this.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "Invoice" WHERE "id" = ${invoiceId}::uuid FOR UPDATE`;
        const inv = await tx.invoice.findUnique({ where: { id: invoiceId }, include: { creditNotes: { select: { snapshot: true, revokedSeatIds: true } } } });
        if (!inv) throw new NotFoundException('Invoice not found');
        const snap = inv.lines as unknown as InvoiceSnapshot;
        const plan = planCredit(snap.lines, priorLines(inv.creditNotes), req.lines, inv.taxKind as TaxKind, inv.gstRatePct, inv.totalPaise);
        const revoked = req.keepSeatsActive ? [] : await this.revokeSeats(tx, inv, snap, plan.lines, new Set(inv.creditNotes.flatMap((c) => c.revokedSeatIds)), now);
        const fy = financialYear(now);
        const seq = await nextCreditNoteSeq(tx, fy);
        const number = formatInvoiceNumber(s.creditNotePrefix || 'CN', fy, seq);
        const snapshot: CreditNoteSnapshot = {
          number,
          issuedAt: now.toISOString(),
          invoiceNumber: inv.number,
          invoiceIssuedAt: inv.issuedAt.toISOString(),
          reason,
          supplier: { name: s.legalName, addressLines: s.addressLines, city: s.city, stateCode: s.stateCode, pin: s.pin, gstin: s.gstin || null, pan: s.pan, phone: s.phone, email: s.email, website: s.website },
          buyer: snap.buyer,
          sacCode: inv.sacCode,
          lines: plan.lines,
          taxKind: inv.taxKind as TaxKind,
          gstRatePct: inv.gstRatePct,
          taxablePaise: plan.taxablePaise,
          cgstPaise: plan.cgstPaise,
          sgstPaise: plan.sgstPaise,
          utgstPaise: plan.utgstPaise,
          igstPaise: plan.igstPaise,
          totalPaise: plan.totalPaise,
          refundMode: req.refundMode,
          refundReference: req.refundReference?.trim() || null,
          keepSeatsActive: req.keepSeatsActive,
          footerNote: s.footerNote,
        };
        // TODO(razorpay-refunds): when the Razorpay refunds API is configured, refund ONLINE invoices here
        // (POST /payments/{razorpayPaymentId}/refund with plan.totalPaise) instead of recording RAZORPAY_REFUND_MANUAL.
        const cn = await tx.creditNote.create({
          data: {
            number,
            fy,
            seq,
            issuedAt: now,
            invoiceId: inv.id,
            companyId: inv.companyId,
            partnerId: inv.partnerId,
            buyerName: inv.buyerName,
            buyerGstin: inv.buyerGstin,
            buyerStateCode: inv.buyerStateCode,
            snapshot: snapshot as unknown as Prisma.InputJsonValue,
            reason,
            taxKind: inv.taxKind,
            gstRatePct: inv.gstRatePct,
            taxablePaise: plan.taxablePaise,
            cgstPaise: plan.cgstPaise,
            sgstPaise: plan.sgstPaise,
            utgstPaise: plan.utgstPaise,
            igstPaise: plan.igstPaise,
            totalPaise: plan.totalPaise,
            refundMode: req.refundMode,
            refundReference: snapshot.refundReference,
            keepSeatsActive: req.keepSeatsActive,
            revokedSeatIds: revoked,
            createdById: ctx.userId,
          },
          include: INCLUDE,
        });
        await this.audit.record(
          { ...ctx, companyId: inv.companyId ?? ctx.companyId },
          {
            action: 'CREATE',
            entity: 'credit_note',
            entityId: cn.id,
            details: { number, invoice: inv.number, totalPaise: plan.totalPaise, reason, refundMode: req.refundMode, refundReference: snapshot.refundReference, keepSeatsActive: req.keepSeatsActive, revokedSeatIds: revoked, lines: plan.lines.map((l) => ({ lineIndex: l.lineIndex, quantity: l.quantity, amountPaise: l.amountPaise })) },
          },
          tx,
        );
        return cn;
      },
      { timeout: 30_000, maxWait: 10_000 },
    );
    this.policy.invalidate();
    this.apiAccess.invalidate();
    void this.deliver(result.id).catch((e: Error) => this.logger.error(`Credit note ${result.number} delivery failed: ${e.message}`));
    return creditNoteDto(result);
  }

  /** Expire the credited seats (see revokedExpiry) and let the pool move subjects onto any free seat. */
  private async revokeSeats(tx: Prisma.TransactionClient, inv: Invoice, snap: InvoiceSnapshot, lines: CreditNoteLineSnapshot[], already: Set<string>, now: Date): Promise<string[]> {
    const revoked: string[] = [];
    const companies = new Set<string>();
    for (const l of lines) {
      if (!l.quantity) continue;
      const ids = snap.lines[l.lineIndex]?.seatIds;
      const seats = await tx.licenceSeat.findMany({
        // Invoices issued before seat ids were stored: the seats this order bought / renewed, by type.
        where: ids?.length ? { id: { in: ids } } : { lastOrderId: inv.orderId, type: l.type },
        select: { id: true, companyId: true, expiresAt: true, userId: true, deviceId: true, fuelObjectId: true },
      });
      const picked = pickSeatsToRevoke(seats.map((x) => ({ ...x, assigned: !!(x.userId || x.deviceId || x.fuelObjectId) })), l.quantity, new Set([...already, ...revoked]));
      for (const seat of picked) {
        const expiresAt = revokedExpiry(seat.expiresAt, l.periodFrom, l.periodTo, now.getTime());
        await tx.licenceSeat.update({ where: { id: seat.id }, data: { expiresAt, note: `Credited (credit note against ${inv.number})` } });
        revoked.push(seat.id);
        if (seat.companyId) companies.add(seat.companyId);
      }
    }
    for (const companyId of companies) await this.pools.rebalance(tx, companyId, now.getTime());
    return revoked;
  }

  async list(f: { companyId?: string; partnerId?: string; from?: string; to?: string }, take = 1000): Promise<CreditNoteDto[]> {
    const range = f.from || f.to ? { issuedAt: { ...(f.from ? { gte: new Date(`${f.from}T00:00:00+05:30`) } : {}), ...(f.to ? { lte: new Date(`${f.to}T23:59:59.999+05:30`) } : {}) } } : {};
    const rows = await this.prisma.creditNote.findMany({
      where: { ...(f.companyId ? { companyId: f.companyId } : {}), ...(f.partnerId ? { partnerId: f.partnerId } : {}), ...range },
      include: INCLUDE,
      orderBy: { issuedAt: 'desc' },
      take,
    });
    return rows.map(creditNoteDto);
  }

  async find(id: string, scope: { companyId?: string; partnerId?: string } = {}): Promise<CreditNoteRow> {
    const cn = await this.prisma.creditNote.findFirst({ where: { id, ...scope }, include: INCLUDE });
    if (!cn) throw new NotFoundException('Credit note not found');
    return cn;
  }

  fileName(cn: Pick<CreditNote, 'number'>): string {
    return `CreditNote-${cn.number.replace(/[^A-Za-z0-9-]+/g, '-')}.pdf`;
  }

  /** The PDF: stored on first render under var/invoices/<fy>/ and served from there afterwards. */
  async pdf(cn: CreditNote): Promise<Buffer> {
    if (cn.pdfFile) {
      const path = join(INVOICE_DIR, cn.pdfFile);
      if (existsSync(path)) return readFile(path);
    }
    const buffer = await renderCreditNotePdf(cn.snapshot as unknown as CreditNoteSnapshot, await this.settings.logo());
    const rel = `${cn.fy}/${this.fileName(cn)}`;
    await mkdir(join(INVOICE_DIR, cn.fy), { recursive: true });
    await writeFile(join(INVOICE_DIR, rel), buffer);
    await this.prisma.creditNote.update({ where: { id: cn.id }, data: { pdfFile: rel } });
    return buffer;
  }

  /** E-mail the credit note to the buyer's billing e-mail (copy to the accounts e-mail), like invoices. */
  async deliver(id: string): Promise<void> {
    const cn = await this.prisma.creditNote.findUnique({ where: { id } });
    if (!cn) return;
    const pdf = await this.pdf(cn);
    const snap = cn.snapshot as unknown as CreditNoteSnapshot;
    const s = await this.settings.get();
    const from = snap.supplier.name || 'VeeTrax';
    const subject = `Credit note ${cn.number} from ${from}`;
    const text = [
      `Dear ${snap.buyer.name},`,
      '',
      `Please find attached credit note ${cn.number} dated ${invoiceDate(cn.issuedAt.toISOString())} for ₹${formatInr(cn.totalPaise)} (GST inclusive) against invoice ${snap.invoiceNumber}.`,
      `Reason: ${snap.reason}`,
      '',
      'Regards,',
      from,
    ].join('\n');
    const html = text
      .split('\n')
      .map((l) => (l ? `<p style="margin:0 0 8px">${l.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</p>` : ''))
      .join('');
    const attachments = [{ filename: this.fileName(cn), content: pdf, contentType: 'application/pdf' }];
    const recipients = [snap.buyer.email ?? '', s.accountsEmail].filter((r, i, all) => !!r && all.indexOf(r) === i);
    const errors: string[] = [];
    for (const to of recipients) {
      try {
        await this.mailer.send({ to, subject, html, text, attachments });
      } catch (e) {
        errors.push(`${to}: ${(e as Error).message}`);
        this.logger.warn(`Credit note ${cn.number} e-mail to ${to} failed: ${(e as Error).message}`);
      }
    }
    await this.prisma.creditNote.update({
      where: { id: cn.id },
      data: recipients.length && errors.length >= recipients.length ? { emailError: errors.join('; ').slice(0, 500) } : { emailedAt: new Date(), emailError: errors.join('; ') || null },
    });
  }
}

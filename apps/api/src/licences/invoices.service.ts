import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { CreditNote, Invoice, LicenceOrder, Prisma } from '@prisma/client';
import { financialYear, formatInr, formatInvoiceNumber, gstBreakdown, InvoiceDto, PaymentMode, QuoteLineDto, stateByCode, TaxKind } from '@veetracer/shared';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MailerService } from '../auth/mailer.service';
import { CsvColumn, toCsv } from '../common/csv';
import { APP_ROOT } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { nextInvoiceSeq } from './invoice-numbering';
import { invoiceDate, InvoiceSnapshot, renderInvoicePdf } from './invoice-pdf';
import { LicenceSettingsService } from './licence-settings.service';

export const INVOICE_DIR = join(APP_ROOT, 'var', 'invoices');

export function invoiceDto(i: Invoice & { creditNotes?: { totalPaise: number }[] }): InvoiceDto {
  return {
    id: i.id,
    number: i.number,
    issuedAt: i.issuedAt.toISOString(),
    buyerName: i.buyerName,
    companyId: i.companyId,
    partnerId: i.partnerId,
    gstin: i.buyerGstin,
    stateCode: i.buyerStateCode,
    taxablePaise: i.taxablePaise,
    cgstPaise: i.cgstPaise,
    sgstPaise: i.sgstPaise,
    utgstPaise: i.utgstPaise,
    igstPaise: i.igstPaise,
    totalPaise: i.totalPaise,
    paymentMode: i.paymentMode as PaymentMode,
    paymentReference: i.paymentReference,
    emailedAt: i.emailedAt?.toISOString() ?? null,
    creditedPaise: (i.creditNotes ?? []).reduce((a, c) => a + c.totalPaise, 0),
  };
}

const rupees = (paise: number) => (paise / 100).toFixed(2);

/** One row of the GST summary: a tax invoice (INV) or a credit note (CN, negative amounts, with the original invoice). */
export interface GstRow {
  docType: 'INV' | 'CN';
  number: string;
  issuedAt: Date;
  originalInvoice: string;
  buyerName: string;
  buyerGstin: string | null;
  buyerStateCode: string;
  taxablePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  utgstPaise: number;
  igstPaise: number;
  totalPaise: number;
  paymentMode: string;
  paymentReference: string | null;
}

export const invoiceGstRow = (i: Invoice): GstRow => ({ docType: 'INV', originalInvoice: '', ...i });

export const creditNoteGstRow = (c: CreditNote & { invoice: { number: string } }): GstRow => ({
  docType: 'CN',
  number: c.number,
  issuedAt: c.issuedAt,
  originalInvoice: c.invoice.number,
  buyerName: c.buyerName,
  buyerGstin: c.buyerGstin,
  buyerStateCode: c.buyerStateCode,
  taxablePaise: -c.taxablePaise,
  cgstPaise: -c.cgstPaise,
  sgstPaise: -c.sgstPaise,
  utgstPaise: -c.utgstPaise,
  igstPaise: -c.igstPaise,
  totalPaise: -c.totalPaise,
  paymentMode: `REFUND:${c.refundMode}`,
  paymentReference: c.refundReference,
});

export const GST_CSV: CsvColumn<GstRow>[] = [
  { header: 'Document type', value: (i) => i.docType },
  { header: 'Document no', value: (i) => i.number },
  { header: 'Document date', value: (i) => invoiceDate(i.issuedAt.toISOString()) },
  { header: 'Original invoice', value: (i) => i.originalInvoice },
  { header: 'Customer', value: (i) => i.buyerName },
  { header: 'GSTIN', value: (i) => i.buyerGstin ?? '' },
  { header: 'State', value: (i) => `${stateByCode(i.buyerStateCode)?.name ?? ''} (${i.buyerStateCode})` },
  { header: 'Taxable value', value: (i) => rupees(i.taxablePaise) },
  { header: 'CGST', value: (i) => rupees(i.cgstPaise) },
  { header: 'SGST / UTGST', value: (i) => rupees(i.sgstPaise + i.utgstPaise) },
  { header: 'IGST', value: (i) => rupees(i.igstPaise) },
  { header: 'Total', value: (i) => rupees(i.totalPaise) },
  { header: 'Payment mode', value: (i) => i.paymentMode },
  { header: 'Payment reference', value: (i) => i.paymentReference ?? '' },
];

export interface InvoiceFilter {
  companyId?: string;
  partnerId?: string;
  from?: string;
  to?: string;
}

/** GST tax invoices: issued inside the order's transaction (gap-free numbers), rendered to PDF, e-mailed with the PDF. */
@Injectable()
export class InvoicesService {
  private readonly logger = new Logger('Invoices');

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: LicenceSettingsService,
    private readonly mailer: MailerService,
  ) {}

  async issue(tx: Prisma.TransactionClient, order: LicenceOrder, lines: QuoteLineDto[], pay: { paidAt: Date; reference?: string | null; razorpayPaymentId?: string }): Promise<Invoice> {
    const s = await this.settings.get();
    const profile = await tx.billingProfile.findUnique({ where: order.companyId ? { companyId: order.companyId } : { partnerId: order.partnerId! } });
    if (!profile) throw new BadRequestException('Billing details missing');
    const gst = gstBreakdown(lines.map((l) => l.amountPaise), s.gstRatePct, s.stateCode, profile.stateCode);
    const issuedAt = new Date();
    const fy = financialYear(issuedAt);
    const seq = await nextInvoiceSeq(tx, fy);
    const number = formatInvoiceNumber(s.invoicePrefix, fy, seq);
    const ut = gst.kind === 'CGST_UTGST';
    const reference = pay.razorpayPaymentId ?? pay.reference ?? order.paymentReference ?? null;
    const snapshot: InvoiceSnapshot = {
      number,
      issuedAt: issuedAt.toISOString(),
      supplier: {
        name: s.legalName,
        addressLines: s.addressLines,
        city: s.city,
        stateCode: s.stateCode,
        pin: s.pin,
        gstin: s.gstin || null,
        pan: s.pan,
        phone: s.phone,
        email: s.email,
        website: s.website,
      },
      buyer: {
        name: profile.billingName,
        addressLines: profile.address.split(/\r?\n/).map((l) => l.trim()).filter(Boolean),
        city: profile.city,
        stateCode: profile.stateCode,
        pin: profile.pin,
        gstin: profile.gstin,
        email: profile.email,
      },
      sacCode: s.sacCode,
      lines: lines.map((l, i) => ({
        type: l.type,
        kind: l.kind,
        quantity: l.quantity,
        periodFrom: l.periodFrom,
        periodTo: l.periodTo,
        unitPaise: l.unitPaise,
        amountPaise: l.amountPaise,
        taxablePaise: gst.lines[i].taxablePaise,
        ...(l.plan ? { plan: l.plan } : {}),
        seatIds: l.seatIds,
      })),
      taxKind: gst.kind as TaxKind,
      gstRatePct: s.gstRatePct,
      taxablePaise: gst.taxablePaise,
      cgstPaise: gst.cgstPaise,
      sgstPaise: ut ? 0 : gst.sgstPaise,
      utgstPaise: ut ? gst.sgstPaise : 0,
      igstPaise: gst.igstPaise,
      totalPaise: gst.totalPaise,
      paymentMode: order.mode as PaymentMode,
      paymentReference: reference,
      paidAt: pay.paidAt.toISOString(),
      bank: { bankName: s.bankName, bankAccountName: s.bankAccountName, bankAccountNo: s.bankAccountNo, bankIfsc: s.bankIfsc, bankBranch: s.bankBranch, upiId: s.upiId },
      terms: s.terms,
      footerNote: s.footerNote,
    };
    return tx.invoice.create({
      data: {
        number,
        fy,
        seq,
        issuedAt,
        orderId: order.id,
        companyId: order.companyId,
        partnerId: order.companyId ? null : order.partnerId,
        buyerName: profile.billingName,
        buyerGstin: profile.gstin,
        buyerStateCode: profile.stateCode,
        supplier: snapshot.supplier as unknown as Prisma.InputJsonValue,
        buyer: snapshot.buyer as unknown as Prisma.InputJsonValue,
        lines: snapshot as unknown as Prisma.InputJsonValue,
        taxKind: gst.kind,
        gstRatePct: s.gstRatePct,
        sacCode: s.sacCode,
        taxablePaise: snapshot.taxablePaise,
        cgstPaise: snapshot.cgstPaise,
        sgstPaise: snapshot.sgstPaise,
        utgstPaise: snapshot.utgstPaise,
        igstPaise: snapshot.igstPaise,
        totalPaise: snapshot.totalPaise,
        paymentMode: order.mode,
        paymentReference: reference,
        paidAt: pay.paidAt,
      },
    });
  }

  fileName(inv: Pick<Invoice, 'number'>): string {
    return `Invoice-${inv.number.replace(/[^A-Za-z0-9-]+/g, '-')}.pdf`;
  }

  /** The invoice PDF: stored on first render under var/invoices/<fy>/ and served from there afterwards. */
  async pdf(inv: Invoice): Promise<Buffer> {
    if (inv.pdfFile) {
      const path = join(INVOICE_DIR, inv.pdfFile);
      if (existsSync(path)) return readFile(path);
    }
    const buffer = await renderInvoicePdf(inv.lines as unknown as InvoiceSnapshot, await this.settings.logo());
    const rel = `${inv.fy}/${this.fileName(inv)}`;
    await mkdir(join(INVOICE_DIR, inv.fy), { recursive: true });
    await writeFile(join(INVOICE_DIR, rel), buffer);
    await this.prisma.invoice.update({ where: { id: inv.id }, data: { pdfFile: rel } });
    return buffer;
  }

  /** Render, store and e-mail the invoice to the buyer's billing e-mail (copy to the accounts e-mail when set). */
  async deliver(invoiceId: string): Promise<void> {
    const inv = await this.prisma.invoice.findUnique({ where: { id: invoiceId } });
    if (!inv) return;
    const pdf = await this.pdf(inv);
    const snap = inv.lines as unknown as InvoiceSnapshot;
    const s = await this.settings.get();
    const to = snap.buyer.email;
    const subject = `Invoice ${inv.number} from ${snap.supplier.name || 'VeeTrax'}`;
    const text = [
      `Dear ${snap.buyer.name},`,
      '',
      `Thank you for your payment. Please find attached tax invoice ${inv.number} dated ${invoiceDate(inv.issuedAt.toISOString())} for ₹${formatInr(inv.totalPaise)} (GST inclusive) for your VeeTrax licences.`,
      '',
      `Regards,`,
      snap.supplier.name || 'VeeTrax',
    ].join('\n');
    const html = text
      .split('\n')
      .map((l) => (l ? `<p style="margin:0 0 8px">${l.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</p>` : ''))
      .join('');
    const attachments = [{ filename: this.fileName(inv), content: pdf, contentType: 'application/pdf' }];
    const errors: string[] = [];
    for (const recipient of [to ?? '', s.accountsEmail].filter((r, i, all) => !!r && all.indexOf(r) === i)) {
      try {
        await this.mailer.send({ to: recipient, subject, html, text, attachments });
      } catch (e) {
        errors.push(`${recipient}: ${(e as Error).message}`);
        this.logger.warn(`Invoice ${inv.number} e-mail to ${recipient} failed: ${(e as Error).message}`);
      }
    }
    await this.prisma.invoice.update({
      where: { id: inv.id },
      data: errors.length && errors.length >= (s.accountsEmail ? 2 : 1) ? { emailError: errors.join('; ').slice(0, 500) } : { emailedAt: new Date(), emailError: errors.join('; ') || null },
    });
  }

  async find(id: string, scope: { companyId?: string; partnerId?: string } = {}): Promise<Invoice> {
    const inv = await this.prisma.invoice.findFirst({ where: { id, ...scope } });
    if (!inv) throw new NotFoundException('Invoice not found');
    return inv;
  }

  private where(f: InvoiceFilter): Prisma.InvoiceWhereInput {
    const range = f.from || f.to ? { issuedAt: { ...(f.from ? { gte: new Date(`${f.from}T00:00:00+05:30`) } : {}), ...(f.to ? { lte: new Date(`${f.to}T23:59:59.999+05:30`) } : {}) } } : {};
    return { ...(f.companyId ? { companyId: f.companyId } : {}), ...(f.partnerId ? { partnerId: f.partnerId } : {}), ...range };
  }

  async list(f: InvoiceFilter, take = 500): Promise<InvoiceDto[]> {
    const rows = await this.prisma.invoice.findMany({ where: this.where(f), orderBy: { issuedAt: 'desc' }, take, include: { creditNotes: { select: { totalPaise: true } } } });
    return rows.map(invoiceDto);
  }

  /** GST summary for the accountant: one row per invoice and per credit note (negative) of the month (YYYY-MM, India time). */
  async gstCsv(month: string): Promise<{ file: Buffer; name: string }> {
    if (!/^\d{4}-\d{2}$/.test(month)) throw new BadRequestException('Month must be YYYY-MM');
    const [y, m] = month.split('-').map(Number);
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const range = this.where({ from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` });
    const issuedAt = range.issuedAt as Prisma.DateTimeFilter;
    const [invoices, credits] = await Promise.all([
      this.prisma.invoice.findMany({ where: range, orderBy: [{ fy: 'asc' }, { seq: 'asc' }] }),
      this.prisma.creditNote.findMany({ where: { issuedAt }, orderBy: [{ fy: 'asc' }, { seq: 'asc' }], include: { invoice: { select: { number: true } } } }),
    ]);
    const rows = [...invoices.map(invoiceGstRow), ...credits.map(creditNoteGstRow)];
    return { file: Buffer.from(toCsv(rows, GST_CSV), 'utf8'), name: `gst-summary-${month}.csv` };
  }
}

import { BadRequestException, ForbiddenException, Injectable, NotFoundException, StreamableFile } from '@nestjs/common';
import { amountInWords, formatInr, gstLine, taxKind, type StockDocDto, type TaxKind } from '@veetracer/shared';
import pdfmake from 'pdfmake';
import type { Content, TableCell, TDocumentDefinitions } from 'pdfmake/interfaces';
import { AuthContext } from '../access/auth-context';
import { AuditService } from '../audit/audit.service';
import { LicenceSettingsService } from '../licences/licence-settings.service';
import { invoiceDate, partyBlock, rs, stateText, type InvoiceLogo, type InvoiceParty } from '../licences/invoice-pdf';
import { PrismaService } from '../prisma/prisma.service';
import { setupPdf } from '../reports/report-files';
import { fyOf } from './stock-logic';
import { StockService } from './stock.service';

/** One printed line: per-item HSN and GST rate (devices, SIMs and accessories can differ). */
interface StockInvoiceLine {
  description: string;
  hsnCode: string;
  qty: number;
  unit: string;
  ratePaise: number;
  amountPaise: number;
  gstRatePct: number;
  taxablePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  serials: string[];
}

/**
 * Sales invoices (for a done SALE) and credit notes (for a done customer return) from the platform owner's details
 * (Platform Settings → billing), numbered in their own gap-free series "<prefix>/<FY>/<0001>". Prices are GST
 * inclusive like licences; tax is split per line at the item's rate (CGST + SGST / UTGST, or IGST across states).
 * Issued documents are not edited: a mistake on an invoice is corrected with a customer return and its credit note.
 */
@Injectable()
export class StockInvoicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly settings: LicenceSettingsService,
    private readonly stock: StockService,
  ) {}

  private async nextSeq(tx: { $queryRaw: PrismaService['$queryRaw'] }, key: string): Promise<number> {
    const rows = await tx.$queryRaw<{ lastSeq: number }[]>`
      INSERT INTO "StockCounter" ("key", "lastSeq") VALUES (${key}, 1)
      ON CONFLICT ("key") DO UPDATE SET "lastSeq" = "StockCounter"."lastSeq" + 1
      RETURNING "lastSeq"`;
    return Number(rows[0].lastSeq);
  }

  async issue(ctx: AuthContext, docId: string): Promise<StockDocDto> {
    const scope = await this.stock.scope(ctx);
    if (scope.kind !== 'PLATFORM') throw new ForbiddenException('Invoices are issued by the platform');
    const doc = await this.prisma.stockDoc.findUnique({ where: { id: docId }, include: { lines: { orderBy: { sort: 'asc' }, include: { item: true } } } });
    if (!doc) throw new NotFoundException('Document not found');
    if (doc.partnerId) throw new BadRequestException('This sale was made by a reseller; resellers invoice their own customers');
    if (doc.status !== 'DONE' || (doc.kind !== 'SALE' && doc.kind !== 'SALES_RETURN')) throw new BadRequestException('Invoices are made for completed sales; credit notes for completed customer returns');
    if (doc.kind === 'SALE' && doc.saleTo === 'OWN') throw new BadRequestException('Own use is not invoiced');
    if (await this.prisma.stockInvoice.findUnique({ where: { docId } })) throw new BadRequestException('Already issued');

    const s = await this.settings.get();
    if (!s.gstin || !s.stateCode || !s.legalName) throw new BadRequestException('Fill in the platform billing details first (Platform Settings → Billing)');
    const supplier: InvoiceParty = { name: s.legalName, addressLines: s.addressLines, city: s.city, stateCode: s.stateCode, pin: s.pin, gstin: s.gstin || null, pan: s.pan, phone: s.phone, email: s.email, website: s.website };
    const buyer = await this.buyerOf(doc);
    if (!buyer.stateCode) throw new BadRequestException("Add the customer's state (it decides CGST + SGST or IGST)");
    const kind: TaxKind = taxKind(s.stateCode, buyer.stateCode);
    const lines: StockInvoiceLine[] = doc.lines.map((l) => {
      const qty = Math.abs(l.qty);
      const g = gstLine(qty * l.ratePaise, l.gstRatePct, kind);
      return { description: l.item.name, hsnCode: l.item.hsnCode, qty, unit: l.item.unit, ratePaise: l.ratePaise, amountPaise: g.totalPaise, gstRatePct: l.gstRatePct, taxablePaise: g.taxablePaise, cgstPaise: g.cgstPaise, sgstPaise: g.sgstPaise, igstPaise: g.igstPaise, serials: l.serials };
    });
    const sum = (k: keyof StockInvoiceLine) => lines.reduce((t, l) => t + (l[k] as number), 0);
    const ut = kind === 'CGST_UTGST';
    // A credit note reduces the invoice of the sale the goods came back from.
    const source = doc.kind === 'SALES_RETURN' && doc.sourceId ? await this.prisma.stockInvoice.findUnique({ where: { docId: doc.sourceId } }) : null;
    const isCn = doc.kind === 'SALES_RETURN';
    const fy = fyOf(doc.docDate);
    const row = await this.prisma.$transaction(async (tx) => {
      const seq = await this.nextSeq(tx, `${isCn ? 'SCN' : 'INV'}:${fy}`);
      return tx.stockInvoice.create({
        data: {
          kind: isCn ? 'CREDIT_NOTE' : 'INVOICE',
          number: `${isCn ? s.stockCreditNotePrefix : s.stockInvoicePrefix}/${fy}/${String(seq).padStart(4, '0')}`,
          fy,
          seq,
          docId,
          invoiceId: source?.id ?? null,
          supplier: { ...supplier, bank: { bankName: s.bankName, bankAccountName: s.bankAccountName, bankAccountNo: s.bankAccountNo, bankIfsc: s.bankIfsc, bankBranch: s.bankBranch, upiId: s.upiId }, terms: s.terms, footerNote: s.footerNote } as object,
          buyer: buyer as object,
          lines: lines as unknown as object,
          taxKind: kind,
          taxablePaise: sum('taxablePaise'),
          cgstPaise: sum('cgstPaise'),
          sgstPaise: ut ? 0 : sum('sgstPaise'),
          utgstPaise: ut ? sum('sgstPaise') : 0,
          igstPaise: sum('igstPaise'),
          totalPaise: sum('amountPaise'),
          paymentStatus: isCn ? 'PAID' : 'UNPAID',
          createdById: ctx.userId,
        },
      });
    });
    await this.audit.record(ctx, { action: 'CREATE', entity: 'StockInvoice', entityId: row.id, after: { number: row.number, docId, totalPaise: row.totalPaise } });
    return this.stock.getDoc(ctx, docId);
  }

  /** Bill-to: what was typed on the document, else the reseller's / customer company's billing profile. */
  private async buyerOf(doc: { customerName: string; customerGstin: string | null; customerStateCode: string; customerAddress: string; customerEmail: string; customerPhone: string; customerPartnerId: string | null; customerCompanyId: string | null }): Promise<InvoiceParty> {
    const profile = doc.customerPartnerId
      ? await this.prisma.billingProfile.findUnique({ where: { partnerId: doc.customerPartnerId } })
      : doc.customerCompanyId
        ? await this.prisma.billingProfile.findUnique({ where: { companyId: doc.customerCompanyId } })
        : null;
    return {
      name: doc.customerName || profile?.billingName || 'Customer',
      addressLines: [doc.customerAddress || profile?.address || ''].filter(Boolean),
      city: profile?.city ?? '',
      stateCode: doc.customerStateCode || profile?.stateCode || '',
      pin: profile?.pin ?? '',
      gstin: doc.customerGstin || profile?.gstin || null,
      email: doc.customerEmail || profile?.email || undefined,
      phone: doc.customerPhone || undefined,
    };
  }

  async payment(ctx: AuthContext, invoiceId: string, b: { paidPaise: number; paymentMode?: string; paymentReference?: string }): Promise<StockDocDto> {
    const scope = await this.stock.scope(ctx);
    if (scope.kind !== 'PLATFORM') throw new ForbiddenException('Only the platform records payments');
    const inv = await this.prisma.stockInvoice.findUnique({ where: { id: invoiceId } });
    if (!inv || inv.kind !== 'INVOICE') throw new NotFoundException('Invoice not found');
    const paid = Math.min(Math.max(0, b.paidPaise), inv.totalPaise);
    await this.prisma.stockInvoice.update({ where: { id: invoiceId }, data: { paidPaise: paid, paymentStatus: paid >= inv.totalPaise ? 'PAID' : paid > 0 ? 'PART' : 'UNPAID', paymentMode: b.paymentMode ?? null, paymentReference: b.paymentReference ?? null, paidAt: paid > 0 ? new Date() : null } });
    await this.audit.record(ctx, { action: 'UPDATE', entity: 'StockInvoice', entityId: invoiceId, before: { paidPaise: inv.paidPaise }, after: { paidPaise: paid, paymentMode: b.paymentMode } });
    return this.stock.getDoc(ctx, inv.docId);
  }

  async pdf(ctx: AuthContext, invoiceId: string): Promise<StreamableFile> {
    const inv = await this.prisma.stockInvoice.findUnique({ where: { id: invoiceId } });
    if (!inv) throw new NotFoundException('Invoice not found');
    await this.stock.getDoc(ctx, inv.docId);
    const src = inv.invoiceId ? await this.prisma.stockInvoice.findUnique({ where: { id: inv.invoiceId }, select: { number: true } }) : null;
    setupPdf();
    const buffer = await pdfmake.createPdf(stockInvoiceDocument(inv as unknown as PrintableInvoice, src?.number ?? null, await this.settings.logo())).getBuffer();
    return new StreamableFile(buffer, { type: 'application/pdf', length: buffer.length, disposition: `inline; filename="${inv.number.replace(/\//g, '-')}.pdf"` });
  }
}

interface PrintableInvoice {
  kind: 'INVOICE' | 'CREDIT_NOTE';
  number: string;
  issuedAt: Date;
  supplier: InvoiceParty & { bank: Record<string, string>; terms: string; footerNote: string };
  buyer: InvoiceParty;
  lines: StockInvoiceLine[];
  taxKind: TaxKind;
  taxablePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  utgstPaise: number;
  igstPaise: number;
  totalPaise: number;
  paymentStatus: string;
  paidPaise: number;
}

/** Tax invoice / credit note for goods: HSN and GST % per line, IMEIs / SIM numbers printed under each line. */
export function stockInvoiceDocument(inv: PrintableInvoice, againstNumber: string | null, logo: InvoiceLogo | null): TDocumentDefinitions {
  const cn = inv.kind === 'CREDIT_NOTE';
  const th = (text: string, alignment: 'left' | 'right' = 'left'): TableCell => ({ text, style: 'th', alignment });
  const body: TableCell[][] = [
    [th('#'), th('Item'), th('HSN'), th('Qty', 'right'), th('Rate (incl. GST)', 'right'), th('GST %', 'right'), th('Taxable value', 'right'), th('Amount', 'right')],
    ...inv.lines.map((l, i): TableCell[] => [
      String(i + 1),
      { stack: [{ text: l.description }, ...(l.serials.length ? [{ text: l.serials.join(', '), fontSize: 7, color: '#475569' }] : [])] },
      l.hsnCode || '—',
      { text: `${l.qty} ${l.unit}`, alignment: 'right' },
      { text: formatInr(l.ratePaise), alignment: 'right' },
      { text: `${l.gstRatePct}%`, alignment: 'right' },
      { text: formatInr(l.taxablePaise), alignment: 'right' },
      { text: formatInr(l.amountPaise), alignment: 'right' },
    ]),
  ];
  const taxRows: [string, number][] =
    inv.taxKind === 'IGST'
      ? [['IGST', inv.igstPaise]]
      : inv.taxKind === 'CGST_UTGST'
        ? [['CGST', inv.cgstPaise], ['UTGST', inv.utgstPaise]]
        : [['CGST', inv.cgstPaise], ['SGST', inv.sgstPaise]];
  const totals: TableCell[][] = [
    ['Taxable value', { text: rs(inv.taxablePaise), alignment: 'right' }],
    ...taxRows.map(([label, v]): TableCell[] => [label, { text: rs(v), alignment: 'right' }]),
    [{ text: cn ? 'Credit (GST inclusive)' : 'Total (GST inclusive)', bold: true }, { text: rs(inv.totalPaise), bold: true, alignment: 'right' }],
  ];
  const b = inv.supplier.bank ?? {};
  const bankBits = [b.bankName && `Bank: ${b.bankName}`, b.bankAccountName && `A/c name: ${b.bankAccountName}`, b.bankAccountNo && `A/c no: ${b.bankAccountNo}`, b.bankIfsc && `IFSC: ${b.bankIfsc}`, b.upiId && `UPI: ${b.upiId}`].filter(Boolean) as string[];
  const header: Content[] = logo ? [logo.mime === 'image/svg+xml' ? { svg: logo.data.toString('utf8'), fit: [140, 56] } : { image: `data:${logo.mime};base64,${logo.data.toString('base64')}`, fit: [140, 56] }] : [];
  const status = cn ? null : inv.paymentStatus === 'PAID' ? { text: 'PAID', color: '#15803d' } : inv.paymentStatus === 'PART' ? { text: `PART PAID ${rs(inv.paidPaise)}`, color: '#b45309' } : null;
  const content: Content[] = [
    {
      columns: [
        { stack: [...header, partyBlock('', inv.supplier, true)], width: '*' },
        {
          width: 200,
          stack: [
            { text: cn ? 'CREDIT NOTE' : 'TAX INVOICE', fontSize: 16, bold: true, color: '#0e5e57', alignment: 'right' },
            { text: `${cn ? 'Credit note' : 'Invoice'} no: ${inv.number}`, alignment: 'right', bold: true, margin: [0, 6, 0, 0] },
            { text: `Date: ${invoiceDate(new Date(inv.issuedAt).toISOString())}`, alignment: 'right' },
            ...(againstNumber ? [{ text: `Against invoice: ${againstNumber}`, alignment: 'right' } as Content] : []),
            { text: `Place of supply: ${stateText(inv.buyer.stateCode)}`, alignment: 'right' },
            ...(status ? [{ text: status.text, alignment: 'right', fontSize: 18, bold: true, color: status.color, margin: [0, 8, 0, 0] } as Content] : []),
          ],
        },
      ],
    },
    { canvas: [{ type: 'line', x1: 0, y1: 6, x2: 539, y2: 6, lineWidth: 0.6, lineColor: '#cbd5e1' }], margin: [0, 4, 0, 8] },
    partyBlock(cn ? 'Credit to' : 'Bill to', inv.buyer, false),
    {
      margin: [0, 12, 0, 0],
      table: { headerRows: 1, widths: [14, '*', 40, 40, 58, 32, 60, 60], body },
      layout: { fillColor: (row: number) => (row === 0 ? '#0e5e57' : row % 2 === 0 ? '#f1f5f9' : null), hLineColor: () => '#e2e8f0', vLineColor: () => '#e2e8f0' },
    },
    {
      columns: [
        {
          width: '*',
          stack: [
            { text: 'Amount in words', style: 'label', margin: [0, 10, 0, 0] },
            { text: amountInWords(inv.totalPaise), bold: true },
            ...(bankBits.length && !cn ? [{ text: 'Bank details', style: 'label', margin: [0, 8, 0, 0] } as Content, { text: bankBits.join('  ·  ') } as Content] : []),
          ],
        },
        { width: 210, margin: [0, 10, 0, 0], table: { widths: ['*', 90], body: totals }, layout: 'lightHorizontalLines' },
      ],
    },
    ...(inv.supplier.terms && !cn ? [{ text: 'Terms', style: 'label', margin: [0, 14, 0, 0] } as Content, { text: inv.supplier.terms } as Content] : []),
    ...(inv.supplier.footerNote ? [{ text: inv.supplier.footerNote, margin: [0, 10, 0, 0], color: '#475569' } as Content] : []),
    { text: 'This is a computer-generated document and does not require a signature.', italics: true, color: '#64748b', margin: [0, 16, 0, 0], alignment: 'center' },
  ];
  return {
    pageSize: 'A4',
    pageMargins: [28, 28, 28, 34],
    info: { title: `${cn ? 'Credit note' : 'Invoice'} ${inv.number}`, creator: 'VeeTrax' },
    defaultStyle: { font: 'NotoSans', fontSize: 8.5, color: '#0f172a' },
    styles: { label: { fontSize: 7.5, color: '#64748b', bold: true }, th: { bold: true, color: '#ffffff', fontSize: 8 } },
    footer: (current: number, count: number) => ({
      columns: [
        { text: `${inv.supplier.name} · ${inv.number}`, fontSize: 7, color: '#94a3b8' },
        { text: `Page ${current} of ${count}`, alignment: 'right', fontSize: 7, color: '#94a3b8' },
      ],
      margin: [28, 10, 28, 0],
    }),
    content,
  };
}

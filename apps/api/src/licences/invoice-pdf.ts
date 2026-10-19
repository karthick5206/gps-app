import { amountInWords, formatInr, LICENCE_TYPE_LABELS, LicenceType, PAYMENT_MODE_LABELS, PaymentMode, stateByCode, TaxKind } from '@veetracer/shared';
import pdfmake from 'pdfmake';
import type { Content, TableCell, TDocumentDefinitions } from 'pdfmake/interfaces';
import { setupPdf } from '../reports/report-files';

export interface InvoiceParty {
  name: string;
  addressLines: string[];
  city: string;
  stateCode: string;
  pin: string;
  gstin: string | null;
  pan?: string;
  phone?: string;
  email?: string;
  website?: string;
}

export interface InvoiceLineSnapshot {
  type: LicenceType;
  kind: 'NEW' | 'RENEWAL';
  quantity: number;
  periodFrom: string;
  periodTo: string;
  unitPaise: number;
  amountPaise: number;
  taxablePaise: number;
}

/** Everything printed on the invoice (stored with the invoice so it can be re-rendered identically). */
export interface InvoiceSnapshot {
  number: string;
  issuedAt: string;
  supplier: InvoiceParty;
  buyer: InvoiceParty;
  sacCode: string;
  lines: InvoiceLineSnapshot[];
  taxKind: TaxKind;
  gstRatePct: number;
  taxablePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  utgstPaise: number;
  igstPaise: number;
  totalPaise: number;
  paymentMode: PaymentMode;
  paymentReference: string | null;
  paidAt: string;
  bank: { bankName: string; bankAccountName: string; bankAccountNo: string; bankIfsc: string; bankBranch: string; upiId: string };
  terms: string;
  footerNote: string;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "19-Oct-2026" in India time. */
export function invoiceDate(isoDate: string): string {
  const d = new Date(Date.parse(isoDate) + 330 * 60_000);
  return `${String(d.getUTCDate()).padStart(2, '0')}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
}

/** "₹1,180.00" (Indian digit grouping; Noto Sans has the Rupee sign). */
export const rs = (paise: number) => `${paise < 0 ? '-' : ''}₹${formatInr(Math.abs(paise))}`;
export const stateText = (code: string) => `${stateByCode(code)?.name ?? code} (${code})`;

export function partyBlock(title: string, p: InvoiceParty, withContact: boolean): Content {
  const lines: Content[] = [
    { text: title, style: 'label' },
    { text: p.name, bold: true, fontSize: 10 },
    ...p.addressLines.filter(Boolean).map((l) => ({ text: l })),
    { text: [p.city, `${stateByCode(p.stateCode)?.name ?? ''}${p.pin ? ` ${p.pin}` : ''}`].filter((s) => s.trim()).join(', ') },
    { text: `State: ${stateText(p.stateCode)}` },
  ];
  if (p.gstin) lines.push({ text: `GSTIN: ${p.gstin}`, bold: true });
  if (p.pan) lines.push({ text: `PAN: ${p.pan}` });
  if (withContact) {
    const contact = [p.phone, p.email, p.website].filter(Boolean).join('  ·  ');
    if (contact) lines.push({ text: contact, color: '#475569' });
  } else if (p.email) {
    lines.push({ text: p.email, color: '#475569' });
  }
  return { stack: lines };
}

export interface InvoiceLogo {
  data: Buffer;
  mime: string;
}

export function invoiceDocument(inv: InvoiceSnapshot, logo: InvoiceLogo | null): TDocumentDefinitions {
  const header: Content[] = [];
  if (logo) {
    header.push(logo.mime === 'image/svg+xml' ? { svg: logo.data.toString('utf8'), fit: [140, 56] } : { image: `data:${logo.mime};base64,${logo.data.toString('base64')}`, fit: [140, 56] });
  }
  const th = (text: string, alignment: 'left' | 'right' | 'center' = 'left'): TableCell => ({ text, style: 'th', alignment });
  const body: TableCell[][] = [
    [th('#'), th('Description'), th('SAC'), th('Qty', 'right'), th('Period'), th('Rate (incl. GST)', 'right'), th('Amount', 'right'), th('Taxable value', 'right')],
    ...inv.lines.map((l, i): TableCell[] => [
      String(i + 1),
      `${LICENCE_TYPE_LABELS[l.type]} licence — ${l.kind === 'RENEWAL' ? 'renewal' : 'new'} (12 months)`,
      inv.sacCode,
      { text: String(l.quantity), alignment: 'right' },
      `${invoiceDate(l.periodFrom)} to ${invoiceDate(l.periodTo)}`,
      { text: formatInr(l.unitPaise), alignment: 'right' },
      { text: formatInr(l.amountPaise), alignment: 'right' },
      { text: formatInr(l.taxablePaise), alignment: 'right' },
    ]),
  ];
  const half = inv.gstRatePct / 2;
  const taxRows: [string, number][] =
    inv.taxKind === 'IGST'
      ? [[`IGST @ ${inv.gstRatePct}%`, inv.igstPaise]]
      : inv.taxKind === 'CGST_UTGST'
        ? [[`CGST @ ${half}%`, inv.cgstPaise], [`UTGST @ ${half}%`, inv.utgstPaise]]
        : [[`CGST @ ${half}%`, inv.cgstPaise], [`SGST @ ${half}%`, inv.sgstPaise]];
  const totals: TableCell[][] = [
    ['Taxable value', { text: rs(inv.taxablePaise), alignment: 'right' }],
    ...taxRows.map(([label, v]): TableCell[] => [label, { text: rs(v), alignment: 'right' }]),
    [{ text: 'Total (GST inclusive)', bold: true }, { text: rs(inv.totalPaise), bold: true, alignment: 'right' }],
  ];
  const bankBits = [
    inv.bank.bankName && `Bank: ${inv.bank.bankName}`,
    inv.bank.bankAccountName && `A/c name: ${inv.bank.bankAccountName}`,
    inv.bank.bankAccountNo && `A/c no: ${inv.bank.bankAccountNo}`,
    inv.bank.bankIfsc && `IFSC: ${inv.bank.bankIfsc}`,
    inv.bank.bankBranch && `Branch: ${inv.bank.bankBranch}`,
    inv.bank.upiId && `UPI: ${inv.bank.upiId}`,
  ].filter(Boolean) as string[];

  const content: Content[] = [
    {
      columns: [
        { stack: [...header, partyBlock('', inv.supplier, true)], width: '*' },
        {
          width: 190,
          stack: [
            { text: 'TAX INVOICE', fontSize: 16, bold: true, color: '#0e5e57', alignment: 'right' },
            { text: `Invoice no: ${inv.number}`, alignment: 'right', bold: true, margin: [0, 6, 0, 0] },
            { text: `Invoice date: ${invoiceDate(inv.issuedAt)}`, alignment: 'right' },
            { text: `Place of supply: ${stateText(inv.buyer.stateCode)}`, alignment: 'right' },
            { text: 'PAID', alignment: 'right', fontSize: 22, bold: true, color: '#15803d', margin: [0, 10, 0, 0] },
          ],
        },
      ],
    },
    { canvas: [{ type: 'line', x1: 0, y1: 6, x2: 539, y2: 6, lineWidth: 0.6, lineColor: '#cbd5e1' }], margin: [0, 4, 0, 8] },
    partyBlock('Bill to', inv.buyer, false),
    {
      margin: [0, 12, 0, 0],
      table: { headerRows: 1, widths: [14, '*', 36, 24, 92, 58, 56, 58], body },
      layout: { fillColor: (row: number) => (row === 0 ? '#0e5e57' : row % 2 === 0 ? '#f1f5f9' : null), hLineColor: () => '#e2e8f0', vLineColor: () => '#e2e8f0' },
    },
    {
      columns: [
        {
          width: '*',
          stack: [
            { text: 'Amount in words', style: 'label', margin: [0, 10, 0, 0] },
            { text: amountInWords(inv.totalPaise), bold: true },
            { text: 'Payment', style: 'label', margin: [0, 8, 0, 0] },
            { text: `${PAYMENT_MODE_LABELS[inv.paymentMode]}${inv.paymentReference ? ` — ref. ${inv.paymentReference}` : ''} on ${invoiceDate(inv.paidAt)}` },
            ...(bankBits.length ? [{ text: 'Bank details', style: 'label', margin: [0, 8, 0, 0] } as Content, { text: bankBits.join('  ·  ') } as Content] : []),
          ],
        },
        { width: 210, margin: [0, 10, 0, 0], table: { widths: ['*', 90], body: totals }, layout: 'lightHorizontalLines' },
      ],
    },
    ...(inv.terms ? [{ text: 'Terms', style: 'label', margin: [0, 14, 0, 0] } as Content, { text: inv.terms } as Content] : []),
    ...(inv.footerNote ? [{ text: inv.footerNote, margin: [0, 10, 0, 0], color: '#475569' } as Content] : []),
    { text: 'This is a computer-generated invoice and does not require a signature.', italics: true, color: '#64748b', margin: [0, 16, 0, 0], alignment: 'center' },
  ];

  return {
    pageSize: 'A4',
    pageMargins: [28, 28, 28, 34],
    info: { title: `Invoice ${inv.number}`, creator: 'VeeTrax' },
    defaultStyle: { font: 'NotoSans', fontSize: 8.5, color: '#0f172a' },
    styles: { label: { fontSize: 7.5, color: '#64748b', bold: true }, th: { bold: true, color: '#ffffff', fontSize: 8 } },
    footer: (current: number, count: number) => ({
      columns: [
        { text: `${inv.supplier.name} · Invoice ${inv.number}`, fontSize: 7, color: '#94a3b8' },
        { text: `Page ${current} of ${count}`, alignment: 'right', fontSize: 7, color: '#94a3b8' },
      ],
      margin: [28, 10, 28, 0],
    }),
    content,
  };
}

export async function renderInvoicePdf(inv: InvoiceSnapshot, logo: InvoiceLogo | null): Promise<Buffer> {
  setupPdf();
  return pdfmake.createPdf(invoiceDocument(inv, logo)).getBuffer();
}

import { amountInWords, formatInr, REFUND_MODE_LABELS, RefundMode, TaxKind } from '@veetracer/shared';
import pdfmake from 'pdfmake';
import type { Content, TableCell, TDocumentDefinitions } from 'pdfmake/interfaces';
import { setupPdf } from '../reports/report-files';
import { CreditNoteLineSnapshot } from './credit-logic';
import { invoiceDate, InvoiceLogo, InvoiceParty, lineDescription, partyBlock, rs, stateText } from './invoice-pdf';

/** Everything printed on a credit note (stored with it so it re-renders identically). */
export interface CreditNoteSnapshot {
  number: string;
  issuedAt: string;
  invoiceNumber: string;
  invoiceIssuedAt: string;
  reason: string;
  supplier: InvoiceParty;
  buyer: InvoiceParty;
  sacCode: string;
  lines: CreditNoteLineSnapshot[];
  /** Mirrors the original invoice. */
  taxKind: TaxKind;
  gstRatePct: number;
  taxablePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  utgstPaise: number;
  igstPaise: number;
  totalPaise: number;
  refundMode: RefundMode;
  refundReference: string | null;
  keepSeatsActive: boolean;
  footerNote: string;
}

/** Credit note: same layout family as the invoice; credited amounts are shown negative. */
export function creditNoteDocument(cn: CreditNoteSnapshot, logo: InvoiceLogo | null): TDocumentDefinitions {
  const header: Content[] = [];
  if (logo) {
    header.push(logo.mime === 'image/svg+xml' ? { svg: logo.data.toString('utf8'), fit: [140, 56] } : { image: `data:${logo.mime};base64,${logo.data.toString('base64')}`, fit: [140, 56] });
  }
  const th = (text: string, alignment: 'left' | 'right' = 'left'): TableCell => ({ text, style: 'th', alignment });
  const neg = (p: number) => formatInr(-p);
  const body: TableCell[][] = [
    [th('#'), th('Description'), th('SAC'), th('Qty', 'right'), th('Period'), th('Credited (incl. GST)', 'right'), th('Taxable value', 'right')],
    ...cn.lines.map((l, i): TableCell[] => [
      String(i + 1),
      `${lineDescription(l)}${l.quantity ? '' : ' — price adjustment'}`,
      cn.sacCode,
      { text: String(l.quantity), alignment: 'right' },
      `${invoiceDate(l.periodFrom)} to ${invoiceDate(l.periodTo)}`,
      { text: neg(l.amountPaise), alignment: 'right' },
      { text: neg(l.taxablePaise), alignment: 'right' },
    ]),
  ];
  const half = cn.gstRatePct / 2;
  const taxRows: [string, number][] =
    cn.taxKind === 'IGST'
      ? [[`IGST @ ${cn.gstRatePct}%`, cn.igstPaise]]
      : cn.taxKind === 'CGST_UTGST'
        ? [[`CGST @ ${half}%`, cn.cgstPaise], [`UTGST @ ${half}%`, cn.utgstPaise]]
        : [[`CGST @ ${half}%`, cn.cgstPaise], [`SGST @ ${half}%`, cn.sgstPaise]];
  const totals: TableCell[][] = [
    ['Taxable value', { text: rs(-cn.taxablePaise), alignment: 'right' }],
    ...taxRows.map(([label, v]): TableCell[] => [label, { text: rs(-v), alignment: 'right' }]),
    [{ text: 'Total credit (GST inclusive)', bold: true }, { text: rs(-cn.totalPaise), bold: true, alignment: 'right' }],
  ];
  const refund = cn.refundMode === 'NONE' ? REFUND_MODE_LABELS.NONE : `${REFUND_MODE_LABELS[cn.refundMode]}${cn.refundReference ? ` — ref. ${cn.refundReference}` : ''}`;

  const content: Content[] = [
    {
      columns: [
        { stack: [...header, partyBlock('', cn.supplier, true)], width: '*' },
        {
          width: 200,
          stack: [
            { text: 'CREDIT NOTE', fontSize: 16, bold: true, color: '#b91c1c', alignment: 'right' },
            { text: `Credit note no: ${cn.number}`, alignment: 'right', bold: true, margin: [0, 6, 0, 0] },
            { text: `Date: ${invoiceDate(cn.issuedAt)}`, alignment: 'right' },
            { text: `Against invoice: ${cn.invoiceNumber}`, alignment: 'right', bold: true },
            { text: `Invoice date: ${invoiceDate(cn.invoiceIssuedAt)}`, alignment: 'right' },
            { text: `Place of supply: ${stateText(cn.buyer.stateCode)}`, alignment: 'right' },
          ],
        },
      ],
    },
    { canvas: [{ type: 'line', x1: 0, y1: 6, x2: 539, y2: 6, lineWidth: 0.6, lineColor: '#cbd5e1' }], margin: [0, 4, 0, 8] },
    partyBlock('Credit to', cn.buyer, false),
    { text: 'Reason', style: 'label', margin: [0, 10, 0, 0] },
    { text: cn.reason },
    {
      margin: [0, 10, 0, 0],
      table: { headerRows: 1, widths: [14, '*', 36, 24, 100, 70, 64], body },
      layout: { fillColor: (row: number) => (row === 0 ? '#7f1d1d' : row % 2 === 0 ? '#f1f5f9' : null), hLineColor: () => '#e2e8f0', vLineColor: () => '#e2e8f0' },
    },
    {
      columns: [
        {
          width: '*',
          stack: [
            { text: 'Amount in words (credit)', style: 'label', margin: [0, 10, 0, 0] },
            { text: amountInWords(cn.totalPaise), bold: true },
            { text: 'Refund', style: 'label', margin: [0, 8, 0, 0] },
            { text: refund },
            { text: cn.keepSeatsActive ? 'The licences on this invoice stay active.' : 'The credited licences end on the date of this credit note.', margin: [0, 6, 0, 0], color: '#475569' },
          ],
        },
        { width: 220, margin: [0, 10, 0, 0], table: { widths: ['*', 90], body: totals }, layout: 'lightHorizontalLines' },
      ],
    },
    ...(cn.footerNote ? [{ text: cn.footerNote, margin: [0, 10, 0, 0], color: '#475569' } as Content] : []),
    { text: 'This is a computer-generated credit note and does not require a signature.', italics: true, color: '#64748b', margin: [0, 16, 0, 0], alignment: 'center' },
  ];

  return {
    pageSize: 'A4',
    pageMargins: [28, 28, 28, 34],
    info: { title: `Credit note ${cn.number}`, creator: 'VeeTrax' },
    defaultStyle: { font: 'NotoSans', fontSize: 8.5, color: '#0f172a' },
    styles: { label: { fontSize: 7.5, color: '#64748b', bold: true }, th: { bold: true, color: '#ffffff', fontSize: 8 } },
    footer: (current: number, count: number) => ({
      columns: [
        { text: `${cn.supplier.name} · Credit note ${cn.number}`, fontSize: 7, color: '#94a3b8' },
        { text: `Page ${current} of ${count}`, alignment: 'right', fontSize: 7, color: '#94a3b8' },
      ],
      margin: [28, 10, 28, 0],
    }),
    content,
  };
}

export async function renderCreditNotePdf(cn: CreditNoteSnapshot, logo: InvoiceLogo | null): Promise<Buffer> {
  setupPdf();
  return pdfmake.createPdf(creditNoteDocument(cn, logo)).getBuffer();
}

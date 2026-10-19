import { formatInvoiceNumber } from '@veetracer/shared';
import { creditableLines, pickSeatsToRevoke, planCredit, revokedExpiry } from './credit-logic';
import { creditNoteDocument, CreditNoteSnapshot, renderCreditNotePdf } from './credit-note-pdf';
import { CreditNotesService } from './credit-notes.service';
import { nextCreditNoteSeq } from './invoice-numbering';
import { InvoiceLineSnapshot } from './invoice-pdf';
import { creditNoteGstRow, GST_CSV, invoiceGstRow } from './invoices.service';
import { toCsv } from '../common/csv';

const NOW = Date.parse('2026-10-19T06:00:00Z');
const YEAR = '2027-10-19T06:00:00.000Z';
const lines: InvoiceLineSnapshot[] = [
  { type: 'GPS_DEVICE', kind: 'NEW', quantity: 3, periodFrom: '2026-10-19T06:00:00.000Z', periodTo: YEAR, unitPaise: 118_000, amountPaise: 354_000, taxablePaise: 300_000, seatIds: ['s1', 's2', 's3'] },
  { type: 'USER', kind: 'RENEWAL', quantity: 1, periodFrom: '2026-12-01T00:00:00.000Z', periodTo: '2027-12-01T00:00:00.000Z', unitPaise: 59_000, amountPaise: 59_000, taxablePaise: 50_000, seatIds: ['u1'] },
];
const TOTAL = 413_000;

describe('credit notes: amounts and GST', () => {
  it('a full credit equals the invoice and mirrors its tax type (CGST + SGST)', () => {
    const p = planCredit(lines, [], [{ lineIndex: 0, quantity: 3 }, { lineIndex: 1, quantity: 1 }], 'CGST_SGST', 18, TOTAL);
    expect(p.totalPaise).toBe(TOTAL);
    expect(p).toMatchObject({ taxablePaise: 350_000, cgstPaise: 31_500, sgstPaise: 31_500, utgstPaise: 0, igstPaise: 0 });
    expect(p.taxablePaise + p.cgstPaise + p.sgstPaise).toBe(p.totalPaise);
  });

  it('partial credit by quantity; IGST and UTGST invoices stay IGST / UTGST', () => {
    const igst = planCredit(lines, [], [{ lineIndex: 0, quantity: 1 }], 'IGST', 18, TOTAL);
    expect(igst).toMatchObject({ totalPaise: 118_000, taxablePaise: 100_000, igstPaise: 18_000, cgstPaise: 0 });
    const ut = planCredit(lines, [], [{ lineIndex: 0, quantity: 1 }], 'CGST_UTGST', 18, TOTAL);
    expect(ut).toMatchObject({ cgstPaise: 9_000, sgstPaise: 0, utgstPaise: 9_000 });
  });

  it('a price correction credits an amount without seats (quantity 0)', () => {
    const p = planCredit(lines, [], [{ lineIndex: 0, quantity: 0, amountPaise: 11_800 }], 'CGST_SGST', 18, TOTAL);
    expect(p.lines[0]).toMatchObject({ quantity: 0, amountPaise: 11_800, taxablePaise: 10_000 });
    expect(() => planCredit(lines, [], [{ lineIndex: 0, quantity: 0 }], 'CGST_SGST', 18, TOTAL)).toThrow(/amount/);
  });

  it('never credits more than is left (per line, in quantity and in total)', () => {
    const prior = [{ lineIndex: 0, quantity: 2, amountPaise: 236_000 }];
    expect(creditableLines(lines, prior)[0]).toMatchObject({ creditedQuantity: 2, remainingQuantity: 1, remainingPaise: 118_000 });
    expect(() => planCredit(lines, prior, [{ lineIndex: 0, quantity: 2 }], 'IGST', 18, TOTAL)).toThrow(/only 1/);
    expect(() => planCredit(lines, prior, [{ lineIndex: 0, quantity: 1, amountPaise: 118_001 }], 'IGST', 18, TOTAL)).toThrow(/at most/);
    expect(() => planCredit(lines, [], [{ lineIndex: 0, quantity: 1 }, { lineIndex: 0, quantity: 1 }], 'IGST', 18, TOTAL)).toThrow(/twice/);
    expect(() => planCredit(lines, [], [{ lineIndex: 5, quantity: 1 }], 'IGST', 18, TOTAL)).toThrow(/does not exist/);
    expect(() => planCredit(lines, [], [], 'IGST', 18, TOTAL)).toThrow(/at least one/);
  });
});

describe('credit notes: seats', () => {
  it('a credited new seat expires now; a renewal falls back to its earlier expiry; a later renewal is kept', () => {
    expect(revokedExpiry(new Date(YEAR), lines[0].periodFrom, YEAR, NOW).getTime()).toBe(NOW);
    expect(revokedExpiry(new Date('2027-12-01T00:00:00Z'), lines[1].periodFrom, lines[1].periodTo, NOW).toISOString()).toBe('2026-12-01T00:00:00.000Z');
    // Renewed once more after the credited purchase: only the credited year comes off.
    expect(revokedExpiry(new Date('2028-10-19T06:00:00Z'), lines[0].periodFrom, YEAR, NOW).toISOString()).toBe(YEAR);
  });

  it('revokes unassigned seats first and never the same seat twice', () => {
    const seats = [
      { id: 's1', assigned: true },
      { id: 's2', assigned: false },
      { id: 's3', assigned: true },
    ];
    expect(pickSeatsToRevoke(seats, 2, new Set()).map((s) => s.id)).toEqual(['s2', 's1']);
    expect(pickSeatsToRevoke(seats, 2, new Set(['s2'])).map((s) => s.id)).toEqual(['s1', 's3']);
  });

  it('only a Super Admin can issue a credit note', async () => {
    const svc = new CreditNotesService({} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never);
    await expect(svc.create({ isSuperAdmin: false } as never, 'i1', { lines: [{ lineIndex: 0, quantity: 1 }], reason: 'Refund', refundMode: 'UPI', keepSeatsActive: false })).rejects.toMatchObject({ status: 403 });
  });
});

describe('credit note numbering and GST summary', () => {
  it('uses its own gap-free counter and prefix: VTX/CN/2026-27/0001', async () => {
    const queries: string[] = [];
    const tx = { $queryRaw: jest.fn(async (strings: TemplateStringsArray) => (queries.push(strings.join('?')), [{ lastSeq: 1 }])) };
    expect(await nextCreditNoteSeq(tx as never, '2026-27')).toBe(1);
    expect(queries[0]).toContain('"CreditNoteCounter"');
    expect(formatInvoiceNumber('VTX/CN', '2026-27', 1)).toBe('VTX/CN/2026-27/0001');
  });

  it('lists credit notes as negative CN rows with the original invoice', () => {
    const base = { buyerName: 'Acme', buyerGstin: null, buyerStateCode: '29', issuedAt: new Date(NOW), paymentReference: null };
    const inv = invoiceGstRow({ ...base, number: 'VTX/2026-27/0001', taxablePaise: 100_000, cgstPaise: 0, sgstPaise: 0, utgstPaise: 0, igstPaise: 18_000, totalPaise: 118_000, paymentMode: 'UPI' } as never);
    const cn = creditNoteGstRow({ ...base, number: 'VTX/CN/2026-27/0001', invoice: { number: 'VTX/2026-27/0001' }, taxablePaise: 100_000, cgstPaise: 0, sgstPaise: 0, utgstPaise: 0, igstPaise: 18_000, totalPaise: 118_000, refundMode: 'UPI', refundReference: 'UTR9' } as never);
    const csv = toCsv([inv, cn], GST_CSV).split(/\r?\n/);
    expect(csv[0].replace(/^﻿/, '')).toMatch(/^Document type,Document no,Document date,Original invoice/);
    expect(csv[1]).toMatch(/^INV,VTX\/2026-27\/0001,19-Oct-2026,,/);
    expect(csv[2]).toMatch(/^CN,VTX\/CN\/2026-27\/0001,19-Oct-2026,VTX\/2026-27\/0001,.*-1000\.00,0\.00,0\.00,-180\.00,-1180\.00,REFUND:UPI,UTR9/);
  });
});

describe('credit note PDF', () => {
  const p = planCredit(lines, [], [{ lineIndex: 0, quantity: 1 }], 'IGST', 18, TOTAL);
  const party = { name: 'Acme Logistics', addressLines: ['12 Main Road'], city: 'Bengaluru', stateCode: '29', pin: '560001', gstin: null, email: 'a@acme.test' };
  const snap: CreditNoteSnapshot = {
    number: 'VTX/CN/2026-27/0001',
    issuedAt: '2026-10-20T06:00:00.000Z',
    invoiceNumber: 'VTX/2026-27/0001',
    invoiceIssuedAt: '2026-10-19T06:00:00.000Z',
    reason: 'Device returned',
    supplier: { ...party, name: 'VIBHAV ENTERPRISE SOLUTIONS', stateCode: '33', gstin: '33ANRPP5546L1ZB' },
    buyer: party,
    sacCode: '998314',

    taxKind: 'IGST',
    gstRatePct: 18,
    ...p,
    refundMode: 'BANK_TRANSFER',
    refundReference: 'UTR1',
    keepSeatsActive: false,
    footerNote: '',
  };

  it('prints CREDIT NOTE, the original invoice, the reason and negative ₹ amounts', () => {
    const json = JSON.stringify(creditNoteDocument(snap, null).content);
    expect(json).toContain('CREDIT NOTE');
    expect(json).toContain('Against invoice: VTX/2026-27/0001');
    expect(json).toContain('Invoice date: 19-Oct-2026');
    expect(json).toContain('Device returned');
    expect(json).toContain('-₹1,180.00');
    expect(json).toContain('IGST @ 18%');
    expect(json).toContain('Rupees One Thousand One Hundred Eighty Only');
  });

  it('renders a PDF', async () => {
    const pdf = await renderCreditNotePdf(snap, null);
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
  });
});

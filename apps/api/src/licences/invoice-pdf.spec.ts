import { InvoiceSnapshot, renderInvoicePdf, invoiceDate, invoiceDocument, rs } from './invoice-pdf';

const snapshot: InvoiceSnapshot = {
  number: 'VTX/2026-27/0001',
  issuedAt: '2026-10-19T06:00:00.000Z',
  supplier: { name: 'VIBHAV ENTERPRISE SOLUTIONS', addressLines: ['No. 7, Ragavendra Nagar Extension', 'Perungulathur'], city: '', stateCode: '33', pin: '600063', gstin: '33ANRPP5546L1ZB', pan: 'ANRPP5546L' },
  buyer: { name: 'Acme Logistics', addressLines: ['12 Main Road'], city: 'Bengaluru', stateCode: '29', pin: '560001', gstin: null, email: 'accounts@acme.test' },
  sacCode: '998314',
  lines: [{ type: 'GPS_DEVICE', kind: 'NEW', quantity: 2, periodFrom: '2026-10-19T06:00:00.000Z', periodTo: '2027-10-19T06:00:00.000Z', unitPaise: 118000, amountPaise: 236000, taxablePaise: 200000 }],
  taxKind: 'IGST',
  gstRatePct: 18,
  taxablePaise: 200000,
  cgstPaise: 0,
  sgstPaise: 0,
  utgstPaise: 0,
  igstPaise: 36000,
  totalPaise: 236000,
  paymentMode: 'BANK_TRANSFER',
  paymentReference: 'UTR123',
  paidAt: '2026-10-19T06:00:00.000Z',
  bank: { bankName: 'Bank', bankAccountName: 'VES', bankAccountNo: '123', bankIfsc: 'ABCD0123456', bankBranch: '', upiId: 'ves@upi' },
  terms: 'Licences are non-refundable.',
  footerNote: 'Thank you for your business.',
};

describe('invoice PDF', () => {
  it('renders a PDF (with an SVG logo)', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="#0e5e57"/></svg>');
    const pdf = await renderInvoicePdf(snapshot, { data: svg, mime: 'image/svg+xml' });
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
    expect(pdf.length).toBeGreaterThan(2000);
  });

  it('prints dates as DD-Mon-YYYY in India time', () => {
    expect(invoiceDate('2026-10-18T20:00:00.000Z')).toBe('19-Oct-2026');
  });
});

describe('invoice PDF amounts', () => {
  it('prints the Rupee sign with Indian digit grouping, in Noto Sans', () => {
    const doc = invoiceDocument({ ...snapshot, totalPaise: 12345670 }, null);
    const json = JSON.stringify(doc.content);
    expect(json).toContain('₹1,23,456.70');
    expect(json).toContain('₹2,000.00');
    expect(json).not.toContain('Rs.');
    expect(doc.defaultStyle?.font).toBe('NotoSans');
  });

  it('formats negative amounts as -₹', () => {
    expect(rs(-118000)).toBe('-₹1,180.00');
    expect(rs(118000)).toBe('₹1,180.00');
  });
});

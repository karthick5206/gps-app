import {
  addYears,
  amountInWords,
  financialYear,
  formatInr,
  formatInvoiceNumber,
  gstBreakdown,
  gstinError,
  INDIAN_STATES,
  numberToIndianWords,
  renewedExpiry,
  seatLocked,
  seatStatus,
  taxKind,
} from '@veetracer/shared';

describe('GST split (GST-inclusive prices)', () => {
  it('same state → CGST + SGST, half each', () => {
    const g = gstBreakdown([118_000], 18, '33', '33');
    expect(g.kind).toBe('CGST_SGST');
    expect(g).toMatchObject({ totalPaise: 118_000, taxablePaise: 100_000, cgstPaise: 9_000, sgstPaise: 9_000, igstPaise: 0, taxPaise: 18_000 });
  });

  it('other state → IGST', () => {
    const g = gstBreakdown([118_000], 18, '33', '29');
    expect(g.kind).toBe('IGST');
    expect(g).toMatchObject({ taxablePaise: 100_000, cgstPaise: 0, sgstPaise: 0, igstPaise: 18_000 });
  });

  it('union territory without legislature (same territory) → CGST + UTGST', () => {
    expect(taxKind('04', '04')).toBe('CGST_UTGST');
    expect(taxKind('38', '38')).toBe('CGST_UTGST');
    expect(taxKind('07', '07')).toBe('CGST_SGST'); // Delhi has a legislature
    expect(taxKind('33', '04')).toBe('IGST');
  });

  it('rounding: each line and the totals add up exactly to the inclusive amount', () => {
    const g = gstBreakdown([9_999], 18, '33', '33');
    expect(g.taxablePaise).toBe(8_474);
    expect(g.cgstPaise + g.sgstPaise).toBe(1_525);
    expect(g.cgstPaise - g.sgstPaise).toBe(1);
    const amounts = [9_999, 33_333, 1, 250_000, 117_999];
    for (const kind of [['33', '33'], ['33', '27'], ['04', '04']] as const) {
      const b = gstBreakdown(amounts, 18, kind[0], kind[1]);
      expect(b.totalPaise).toBe(amounts.reduce((a, x) => a + x, 0));
      expect(b.taxablePaise + b.cgstPaise + b.sgstPaise + b.igstPaise).toBe(b.totalPaise);
      for (const l of b.lines) expect(l.taxablePaise + l.cgstPaise + l.sgstPaise + l.igstPaise).toBe(l.totalPaise);
    }
  });

  it('formats Indian digit grouping', () => {
    expect(formatInr(123_456_789)).toBe('12,34,567.89');
    expect(formatInr(100)).toBe('1.00');
    expect(formatInr(10_000_000_00)).toBe('1,00,00,000.00');
  });
});

describe('amount in words (Indian numbering)', () => {
  it('handles thousand / lakh / crore and paise', () => {
    expect(amountInWords(118_000)).toBe('Rupees One Thousand One Hundred Eighty Only');
    expect(amountInWords(10_000_000)).toBe('Rupees One Lakh Only');
    expect(amountInWords(1_234_567_890)).toBe('Rupees One Crore Twenty Three Lakh Forty Five Thousand Six Hundred Seventy Eight and Ninety Paise Only');
    expect(amountInWords(50)).toBe('Rupees Zero and Fifty Paise Only');
    expect(amountInWords(2_100_000_005)).toBe('Rupees Two Crore Ten Lakh and Five Paise Only');
    expect(numberToIndianWords(1_000_000_000)).toBe('One Hundred Crore');
    expect(numberToIndianWords(19)).toBe('Nineteen');
  });
});

describe('invoice numbering', () => {
  it('uses the Indian financial year (Apr–Mar, India time)', () => {
    expect(financialYear(new Date('2026-03-31T18:29:59Z'))).toBe('2025-26');
    expect(financialYear(new Date('2026-03-31T18:30:00Z'))).toBe('2026-27');
    expect(financialYear(new Date('2027-01-15T10:00:00Z'))).toBe('2026-27');
    expect(financialYear(new Date('2099-12-01T00:00:00Z'))).toBe('2099-00');
  });

  it('formats VTX/2026-27/0001', () => {
    expect(formatInvoiceNumber('VTX', '2026-27', 1)).toBe('VTX/2026-27/0001');
    expect(formatInvoiceNumber('VTX', '2026-27', 12345)).toBe('VTX/2026-27/12345');
    expect(formatInvoiceNumber('', '2026-27', 7)).toBe('2026-27/0007');
  });
});

describe('GSTIN validation', () => {
  it('accepts a valid GSTIN in its own state', () => {
    expect(gstinError('33ANRPP5546L1ZB', '33')).toBeNull();
    expect(gstinError('33anrpp5546l1zb', '33')).toBeNull();
  });
  it('rejects a bad format or a state mismatch', () => {
    expect(gstinError('33ANRPP5546L1XB', '33')).toMatch(/format/);
    expect(gstinError('3ANRPP5546L1ZB', '33')).toMatch(/format/);
    expect(gstinError('33ANRPP5546L0ZB', '33')).toMatch(/format/);
    expect(gstinError('33ANRPP5546L1ZB', '29')).toMatch(/state/);
  });
  it('has every state / UT with a unique 2-digit code', () => {
    const codes = INDIAN_STATES.map((s) => s.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes.every((c) => /^\d{2}$/.test(c))).toBe(true);
    expect(INDIAN_STATES.filter((s) => s.utWithoutLegislature).map((s) => s.code).sort()).toEqual(['04', '26', '31', '35', '38']);
  });
});

describe('seat dates', () => {
  const DAY = 86_400_000;
  it('renewal extends from the current expiry while running, else from the payment date', () => {
    const expiry = new Date('2026-12-01T00:00:00Z');
    expect(renewedExpiry(expiry, new Date('2026-11-20T00:00:00Z')).toISOString()).toBe('2027-12-01T00:00:00.000Z');
    expect(renewedExpiry(expiry, new Date('2027-01-10T05:00:00Z')).toISOString()).toBe('2028-01-10T05:00:00.000Z');
  });
  it('a year after 29 Feb is 28 Feb', () => {
    expect(addYears(new Date('2028-02-29T10:00:00Z')).toISOString()).toBe('2029-02-28T10:00:00.000Z');
  });
  it('status: active → expiring (30 d) → grace → expired (locked)', () => {
    const now = Date.parse('2026-10-19T00:00:00Z');
    expect(seatStatus(new Date(now + 40 * DAY), now, 15)).toBe('ACTIVE');
    expect(seatStatus(new Date(now + 10 * DAY), now, 15)).toBe('EXPIRING');
    expect(seatStatus(new Date(now - 10 * DAY), now, 15)).toBe('GRACE');
    expect(seatStatus(new Date(now - 16 * DAY), now, 15)).toBe('EXPIRED');
    expect(seatLocked(new Date(now - 10 * DAY), now, 15)).toBe(false);
    expect(seatLocked(new Date(now - 16 * DAY), now, 15)).toBe(true);
    expect(seatLocked(null, now, 15)).toBe(true);
  });
});

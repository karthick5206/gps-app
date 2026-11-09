import { adminBlockMessage, blockedAuditDetails, countFinancialRecords, describeFinancial, FinancialRecordsException, financialTotal, selfBlockMessage } from './financial-guard';

const CO = 'aaaaaaaa-1111-2222-3333-444444444444';
const PA = 'bbbbbbbb-1111-2222-3333-444444444444';

/** Prisma stand-in that records every where clause it is asked to count. */
function db(n: { invoices?: number; creditNotes?: number; payments?: number; upiClaims?: number; partner?: string | null } = {}) {
  return {
    partner: { findUnique: jest.fn(async () => (n.partner ? { id: n.partner } : null)) },
    invoice: { count: jest.fn(async (_a: unknown) => n.invoices ?? 0) },
    creditNote: { count: jest.fn(async (_a: unknown) => n.creditNotes ?? 0) },
    licenceOrder: { count: jest.fn(async (_a: unknown) => n.payments ?? 0) },
    upiPaymentClaim: { count: jest.fn(async (_a: unknown) => n.upiClaims ?? 0) },
  };
}

describe('financial guard (R-36 stop-gap)', () => {
  it('counts invoices, credit notes, paid orders and kept UPI claims of the company', async () => {
    const d = db({ invoices: 3, creditNotes: 1, payments: 2, upiClaims: 1 });
    const c = await countFinancialRecords(d as never, CO);
    expect(c).toEqual({ invoices: 3, creditNotes: 1, payments: 2, upiClaims: 1, partnerId: null });
    expect(financialTotal(c)).toBe(7);
    expect(d.invoice.count).toHaveBeenCalledWith({ where: { companyId: CO } });
    expect(d.creditNote.count).toHaveBeenCalledWith({ where: { companyId: CO } });
    // Only payment records: PAID, a paid date or a Razorpay payment id (unpaid checkout attempts don't count).
    expect(d.licenceOrder.count).toHaveBeenCalledWith({
      where: { AND: [{ companyId: CO }, { OR: [{ status: 'PAID' }, { paidAt: { not: null } }, { razorpayPaymentId: { not: null } }] }] },
    });
    expect(d.upiPaymentClaim.count).toHaveBeenCalledWith({ where: { OR: [{ ownerKind: 'COMPANY', ownerId: CO }], status: { in: ['CONFIRMED', 'PENDING'] } } });
  });

  it("includes the partner's own records when the company is a reseller's home company", async () => {
    const d = db({ partner: PA, invoices: 1 });
    const c = await countFinancialRecords(d as never, CO);
    expect(c.partnerId).toBe(PA);
    expect(d.partner.findUnique).toHaveBeenCalledWith({ where: { homeCompanyId: CO }, select: { id: true } });
    expect(d.invoice.count).toHaveBeenCalledWith({ where: { OR: [{ companyId: CO }, { partnerId: PA }] } });
    expect(d.upiPaymentClaim.count).toHaveBeenCalledWith({
      where: { OR: [{ ownerKind: 'COMPANY', ownerId: CO }, { ownerKind: 'PARTNER', ownerId: PA }], status: { in: ['CONFIRMED', 'PENDING'] } },
    });
    expect(adminBlockMessage(c)).toContain('reseller partner');
  });

  it('a company without financial records has a total of 0', async () => {
    expect(financialTotal(await countFinancialRecords(db() as never, CO))).toBe(0);
  });

  it('explains the refusal to the administrator and to the account holder', () => {
    const c = { invoices: 3, creditNotes: 1, payments: 1, upiClaims: 1, partnerId: null };
    expect(describeFinancial(c)).toBe('3 GST invoices, 1 credit note and 2 payment records');
    expect(adminBlockMessage(c)).toBe(
      'This company has 3 GST invoices, 1 credit note and 2 payment records, which must be kept for the legal retention period, so it cannot be deleted. ' +
        'Nothing was deleted. Suspend the company instead; archiving with retention is planned.',
    );
    const self = selfBlockMessage({ invoices: 1, creditNotes: 0, payments: 1, upiClaims: 0, partnerId: null });
    expect(self).toContain("Your account can't be deleted completely yet: it has 1 tax invoice and 1 payment record");
    expect(self).toContain('Nothing was deleted.');
  });

  it('is a 409 carrying only the counts', () => {
    const e = new FinancialRecordsException('msg', { invoices: 2, creditNotes: 0, payments: 1, upiClaims: 1, partnerId: null });
    expect(e.getStatus()).toBe(409);
    expect(e.message).toBe('msg');
    expect(e.getResponse()).toMatchObject({ code: 'FINANCIAL_RECORDS', counts: { invoices: 2, creditNotes: 0, payments: 2 } });
  });

  it('audit details: reason and counts', () => {
    expect(blockedAuditDetails({ invoices: 1, creditNotes: 0, payments: 0, upiClaims: 0, partnerId: null }, { path: 'purge' })).toEqual({
      permanent: true,
      blocked: true,
      reason: 'FINANCIAL_RECORDS',
      invoices: 1,
      creditNotes: 0,
      payments: 0,
      upiClaims: 0,
      partnerId: null,
      path: 'purge',
    });
  });
});

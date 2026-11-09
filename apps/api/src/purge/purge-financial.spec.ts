import type { AuthContext } from '../access/auth-context';
import { FinancialRecordsException } from './financial-guard';
import { PurgeService } from './purge.service';

const CO = 'aaaaaaaa-1111-2222-3333-444444444444';
const HOME = 'ffffffff-1111-2222-3333-444444444444';
const ctx = { userId: 'u-sa', homeCompanyId: HOME, companyId: HOME, isSuperAdmin: true, ip: '10.0.0.1' } as unknown as AuthContext;

/** Super Admin company purge with the SQL execution stubbed: is it refused, audited, or run as before? */
function setup(fin: { invoices?: number; creditNotes?: number; payments?: number; upiClaims?: number } = {}) {
  const prisma = {
    company: { findUnique: jest.fn(async () => ({ name: 'Acme Logistics' })) },
    user: { count: jest.fn(async () => 0) },
    trackedObject: { findMany: jest.fn(async () => [{ id: 'o1' }]) },
    partner: { findUnique: jest.fn(async () => null) },
    invoice: { count: jest.fn(async () => fin.invoices ?? 0) },
    creditNote: { count: jest.fn(async () => fin.creditNotes ?? 0) },
    licenceOrder: { count: jest.fn(async () => fin.payments ?? 0) },
    upiPaymentClaim: { count: jest.fn(async () => fin.upiClaims ?? 0) },
  };
  const audit = { recordSystem: jest.fn(async () => undefined) };
  const svc = new PurgeService(prisma as never, {} as never, audit as never);
  const execute = jest.fn(async () => 1234);
  (svc as unknown as { execute: typeof execute }).execute = execute;
  return { svc, execute, audit };
}

describe('Super Admin company purge: financial records (R-36 stop-gap)', () => {
  it.each([
    [{ invoices: 1 }, '1 GST invoice'],
    [{ creditNotes: 1 }, '1 credit note'],
    [{ payments: 2 }, '2 payment records'],
    [{ upiClaims: 1 }, '1 payment record'],
    [{ invoices: 3, creditNotes: 1, payments: 2 }, '3 GST invoices, 1 credit note and 2 payment records'],
  ])('refuses %o with a 409, deletes nothing and audits the attempt', async (fin, text) => {
    const { svc, execute, audit } = setup(fin);
    const err = await svc.purge(ctx, 'company', CO, 'Acme Logistics').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FinancialRecordsException);
    expect((err as FinancialRecordsException).getStatus()).toBe(409);
    expect((err as Error).message).toBe(
      `This company has ${text}, which must be kept for the legal retention period, so it cannot be deleted. Nothing was deleted. Suspend the company instead; archiving with retention is planned.`,
    );
    expect(execute).not.toHaveBeenCalled();
    expect(audit.recordSystem).toHaveBeenCalledTimes(1);
    expect(audit.recordSystem).toHaveBeenCalledWith(
      { companyId: HOME, userId: 'u-sa', ip: '10.0.0.1' },
      {
        action: 'DELETE',
        entity: 'company',
        entityId: CO,
        details: expect.objectContaining({ permanent: true, blocked: true, reason: 'FINANCIAL_RECORDS', label: 'Acme Logistics', by: 'Super Admin', path: 'purge' }),
      },
    );
  });

  it('refuses even before the confirmation text is checked', async () => {
    const { svc, execute } = setup({ invoices: 1 });
    await expect(svc.purge(ctx, 'company', CO, 'wrong')).rejects.toBeInstanceOf(FinancialRecordsException);
    expect(execute).not.toHaveBeenCalled();
  });

  it('the preview already shows the refusal (not audited: nothing attempted)', async () => {
    const { svc, audit } = setup({ invoices: 1 });
    await expect(svc.preview(ctx, 'company', CO)).rejects.toThrow('cannot be deleted');
    expect(audit.recordSystem).not.toHaveBeenCalled();
  });

  it('a company without financial records is purged as before', async () => {
    const { svc, execute, audit } = setup();
    await expect(svc.purge(ctx, 'company', CO, 'acme logistics')).resolves.toEqual({ ok: true, deletedRows: 1234 });
    expect(execute).toHaveBeenCalledWith('company', CO, expect.objectContaining({ label: 'Acme Logistics' }), { companyId: HOME, userId: 'u-sa', ip: '10.0.0.1' }, 'Super Admin');
    expect(audit.recordSystem).not.toHaveBeenCalled();
  });
});

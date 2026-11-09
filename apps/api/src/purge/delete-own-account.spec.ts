import type { AuthContext } from '../access/auth-context';
import { FinancialRecordsException } from './financial-guard';
import { PurgeService } from './purge.service';

const ME = 'u-demo';
const CO = 'c-veeramani';

/** deleteOwnAccount with the purge itself stubbed: which kind (whole account or own login) and which id it purges. */
function setup(accountType: 'BUSINESS' | 'INDIVIDUAL' | 'FAMILY', otherUsers: number, fin: { invoices?: number; payments?: number } = {}) {
  const prisma = {
    user: {
      findUnique: jest.fn(async () => ({ email: 'demouser@example.com', mobile: null, name: 'Demo', companyId: CO, company: { accountType, name: 'Veeramani sekar', isPlatform: false } })),
      count: jest.fn(async () => otherUsers),
    },
    trackedObject: { findMany: jest.fn(async () => [{ id: 'o1' }]) },
    partner: { findUnique: jest.fn(async () => null) },
    invoice: { count: jest.fn(async () => fin.invoices ?? 0) },
    creditNote: { count: jest.fn(async () => 0) },
    licenceOrder: { count: jest.fn(async () => fin.payments ?? 0) },
    upiPaymentClaim: { count: jest.fn(async () => 0) },
  };
  const audit = { recordSystem: jest.fn(async () => undefined) };
  const svc = new PurgeService(prisma as never, {} as never, audit as never);
  const execute = jest.fn(async () => 42);
  (svc as unknown as { execute: typeof execute }).execute = execute;
  return { svc, execute, audit, prisma };
}
const ctx = { userId: ME, companyId: CO, isSuperAdmin: false, ip: null } as unknown as AuthContext;

describe('Delete my account', () => {
  it('an extra user of a personal account deletes only their own login (seen 7 Nov: the whole account went)', async () => {
    const { svc, execute } = setup('FAMILY', 1);
    await expect(svc.deleteOwnAccount(ctx, 'demouser@example.com')).resolves.toMatchObject({ scope: 'user' });
    expect(execute).toHaveBeenCalledWith('user', ME, expect.anything(), expect.anything(), expect.anything());
  });

  it('the last user of a personal account deletes the whole account', async () => {
    const { svc, execute } = setup('INDIVIDUAL', 0);
    await expect(svc.deleteOwnAccount(ctx, 'demouser@example.com')).resolves.toMatchObject({ scope: 'account' });
    expect(execute).toHaveBeenCalledWith('company', CO, expect.anything(), expect.anything(), expect.anything());
  });

  it('a business user always deletes only their own login, and the e-mail must be typed', async () => {
    const { svc, execute } = setup('BUSINESS', 0);
    await expect(svc.deleteOwnAccount(ctx, 'wrong')).rejects.toThrow('to confirm');
    await expect(svc.deleteOwnAccount(ctx, 'DemoUser@Example.com')).resolves.toMatchObject({ scope: 'user' });
    expect(execute).toHaveBeenCalledWith('user', ME, expect.anything(), expect.anything(), expect.anything());
  });

  it('R-36: the last user of a personal account with tax invoices is refused, nothing is deleted, the attempt is audited', async () => {
    const { svc, execute, audit } = setup('FAMILY', 0, { invoices: 2, payments: 1 });
    const err = await svc.deleteOwnAccount(ctx, 'demouser@example.com').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FinancialRecordsException);
    expect((err as FinancialRecordsException).getStatus()).toBe(409);
    expect((err as Error).message).toMatch(/^Your account can't be deleted completely yet: it has 2 tax invoices and 1 payment record/);
    expect(execute).not.toHaveBeenCalled();
    expect(audit.recordSystem).toHaveBeenCalledWith(
      { companyId: CO, userId: ME, ip: null },
      expect.objectContaining({
        action: 'DELETE',
        entity: 'company',
        entityId: CO,
        details: expect.objectContaining({ blocked: true, reason: 'FINANCIAL_RECORDS', invoices: 2, payments: 1, path: 'delete-account', by: 'self (demouser@example.com)' }),
      }),
    );
  });

  it('R-36: an extra user (own login only) is not affected by the account invoices', async () => {
    const { svc, execute, prisma } = setup('INDIVIDUAL', 1, { invoices: 2 });
    await expect(svc.deleteOwnAccount(ctx, 'demouser@example.com')).resolves.toMatchObject({ scope: 'user' });
    expect(execute).toHaveBeenCalledWith('user', ME, expect.anything(), expect.anything(), expect.anything());
    expect(prisma.invoice.count).not.toHaveBeenCalled();
  });
});

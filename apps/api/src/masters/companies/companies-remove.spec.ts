import type { AuthContext } from '../../access/auth-context';
import { FinancialRecordsException } from '../../purge/financial-guard';
import { CompaniesService } from './companies.service';

const CO = 'aaaaaaaa-1111-2222-3333-444444444444';
const ctx = { userId: 'u-sa', companyId: 'home', isSuperAdmin: true, ip: null, permissions: {} } as unknown as AuthContext;

function setup(invoices: number) {
  const prisma = {
    company: { findFirst: jest.fn(async () => ({ id: CO, name: 'Acme' })), delete: jest.fn(async () => ({})) },
    partner: { findUnique: jest.fn(async () => null) },
    invoice: { count: jest.fn(async () => invoices) },
    creditNote: { count: jest.fn(async () => 0) },
    licenceOrder: { count: jest.fn(async () => 0) },
    upiPaymentClaim: { count: jest.fn(async () => 0) },
  };
  const audit = { record: jest.fn(async () => undefined) };
  return { svc: new CompaniesService(prisma as never, audit as never, {} as never), prisma, audit };
}

describe('DELETE /admin/companies/:id: financial records (R-36 stop-gap)', () => {
  it('refuses a company with invoices with the explanation, and audits the attempt', async () => {
    const { svc, prisma, audit } = setup(2);
    await expect(svc.remove(ctx, CO)).rejects.toBeInstanceOf(FinancialRecordsException);
    expect(prisma.company.delete).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(ctx, expect.objectContaining({ action: 'DELETE', entity: 'company', entityId: CO, details: expect.objectContaining({ blocked: true, invoices: 2, path: 'company-delete' }) }));
  });

  it('bulk remove reports the refusal per company', async () => {
    const { svc } = setup(1);
    const r = await svc.bulk({ ...ctx, permissions: { sa_companies: ['view', 'edit', 'delete'] } } as unknown as AuthContext, { ids: [CO], action: 'delete' });
    expect(r.failed).toEqual([{ id: CO, message: expect.stringContaining('1 GST invoice') }]);
  });

  it('a company without financial records is deleted as before', async () => {
    const { svc, prisma } = setup(0);
    await svc.remove(ctx, CO);
    expect(prisma.company.delete).toHaveBeenCalledWith({ where: { id: CO } });
  });
});

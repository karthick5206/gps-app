import type { AuthContext } from '../access/auth-context';
import { PurgeService } from './purge.service';

const ME = 'u-demo';
const CO = 'c-veeramani';

/** deleteOwnAccount with the purge itself stubbed: which kind (whole account or own login) and which id it purges. */
function setup(accountType: 'BUSINESS' | 'INDIVIDUAL' | 'FAMILY', otherUsers: number) {
  const prisma = {
    user: {
      findUnique: jest.fn(async () => ({ email: 'demouser@example.com', mobile: null, name: 'Demo', companyId: CO, company: { accountType, name: 'Veeramani sekar', isPlatform: false } })),
      count: jest.fn(async () => otherUsers),
    },
    trackedObject: { findMany: jest.fn(async () => [{ id: 'o1' }]) },
  };
  const svc = new PurgeService(prisma as never, {} as never, {} as never);
  const execute = jest.fn(async () => 42);
  (svc as unknown as { execute: typeof execute }).execute = execute;
  return { svc, execute };
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
});

import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { hashPassword, verifyPassword } from '../common/secrets';
import { MeService } from './me.service';

describe('MeService profile & password', () => {
  const ctx = { userId: 'u1', companyId: 'c1' } as never;
  function setup(user: Record<string, unknown>) {
    const update = jest.fn().mockResolvedValue({});
    const prisma = { user: { findUniqueOrThrow: jest.fn().mockResolvedValue(user), update } };
    const svc = new MeService(prisma as never);
    jest.spyOn(svc, 'build').mockResolvedValue({} as never);
    return { svc, update };
  }

  it('updates name / email / mobile but keeps at least one sign-in method', async () => {
    const { svc, update } = setup({ email: 'a@x.com', mobile: null });
    await svc.updateProfile(ctx, { name: ' Arun ', email: 'NEW@X.COM' });
    expect(update).toHaveBeenCalledWith({ where: { id: 'u1' }, data: { name: 'Arun', email: 'new@x.com' } });
    await expect(svc.updateProfile(ctx, { email: null })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('requires the current password when one is set, then stores the new hash', async () => {
    const { svc, update } = setup({ passwordHash: await hashPassword('Old12345') });
    await expect(svc.changePassword(ctx, 'wrong123', 'New12345')).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(svc.changePassword(ctx, undefined, 'New12345')).rejects.toBeInstanceOf(UnauthorizedException);
    await svc.changePassword(ctx, 'Old12345', 'New12345');
    const stored = update.mock.calls[0][0].data.passwordHash as string;
    expect(await verifyPassword('New12345', stored)).toBe(true);
  });

  it('lets an OTP-only account set a first password', async () => {
    const { svc, update } = setup({ passwordHash: null });
    await svc.changePassword(ctx, undefined, 'First123');
    expect(update).toHaveBeenCalledTimes(1);
  });
});

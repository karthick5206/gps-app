import { ConflictException, HttpException, UnauthorizedException } from '@nestjs/common';
import { SignupService } from './signup.service';

function setup(opts: { userCount?: number; recent?: Date[]; code?: { id: string; codeHash: string; attempts: number } | null } = {}) {
  const sent: { to: string; subject: string }[] = [];
  const created: unknown[] = [];
  const updates: unknown[] = [];
  const prisma = {
    user: { count: jest.fn(async () => opts.userCount ?? 0) },
    signupCode: {
      findMany: jest.fn(async () => (opts.recent ?? []).map((createdAt) => ({ createdAt }))),
      create: jest.fn(async (a: unknown) => (created.push(a), { id: 'c1' })),
      delete: jest.fn(async () => ({})),
      findFirst: jest.fn(async () => opts.code ?? null),
      update: jest.fn(async (a: unknown) => (updates.push(a), {})),
    },
  };
  const mailer = { send: jest.fn(async (m: { to: string; subject: string }) => (sent.push(m), 'x')) };
  const licences = { get: jest.fn(async () => ({ overrideDays: 30 })) };
  const svc = new SignupService(prisma as never, mailer as never, licences as never);
  return { svc, sent, created, updates };
}

describe('SignupService', () => {
  it('emails a 6-digit code (lower-cased address) and stores only its hash', async () => {
    const { svc, sent, created } = setup();
    const r = await svc.requestCode('  Ravi@Example.COM ', '1.2.3.4');
    expect(r).toMatchObject({ ok: true, email: 'ravi@example.com', expiresInSec: 600 });
    expect(sent[0].to).toBe('ravi@example.com');
    const code = /(\d{6})/.exec(sent[0].subject)![1];
    expect(JSON.stringify(created)).not.toContain(code);
  });

  it('a mail failure (e.g. sender not verified) becomes a clear 503 and the code is discarded', async () => {
    const s = setup();
    (s.svc as unknown as { mailer: { send: jest.Mock } }).mailer.send.mockRejectedValueOnce(new Error('Zoho mail HTTP 401: Sender address not verified'));
    await expect(s.svc.requestCode('a@b.in', null)).rejects.toThrow("We couldn't send the email");
  });

  it('refuses an email that already has an account, a resend within 30 s and more than 10 codes a day', async () => {
    await expect(setup({ userCount: 1 }).svc.requestCode('a@b.in', null)).rejects.toBeInstanceOf(ConflictException);
    await expect(setup({ recent: [new Date()] }).svc.requestCode('a@b.in', null)).rejects.toBeInstanceOf(HttpException);
    const old = Array.from({ length: 10 }, () => new Date(Date.now() - 3600_000));
    await expect(setup({ recent: old }).svc.requestCode('a@b.in', null)).rejects.toThrow(/Too many codes/);
  });

  it('a wrong or missing code is refused and counted', async () => {
    const details = { email: 'a@b.in', code: '000000', name: 'Ravi', password: 'abc12345', stateCode: '33' };
    await expect(setup({ code: null }).svc.complete(details)).rejects.toBeInstanceOf(UnauthorizedException);
    const s = setup({ code: { id: 'c1', codeHash: 'nope', attempts: 0 } });
    await expect(s.svc.complete(details)).rejects.toThrow('Wrong code.');
    expect(s.updates).toHaveLength(1);
    await expect(setup({ code: { id: 'c1', codeHash: 'nope', attempts: 5 } }).svc.complete(details)).rejects.toThrow(/Too many wrong/);
  });
});

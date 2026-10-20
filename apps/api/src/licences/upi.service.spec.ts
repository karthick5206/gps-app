import { BadRequestException, ConflictException } from '@nestjs/common';
import { upiPayUri } from '@veetracer/shared';
import { qrSvg, UpiService } from './upi.service';

describe('UPI payments', () => {
  it('builds the upi:// link with amount and note, and a QR SVG for it', () => {
    const uri = upiPayUri('parthanbdl-3@okicici', 'Vibhav Enterprise Solutions', 236000, 'VeeTrax Ravi');
    expect(uri).toBe('upi://pay?pa=parthanbdl-3%40okicici&pn=Vibhav%20Enterprise%20Solutions&cu=INR&am=2360.00&tn=VeeTrax%20Ravi');
    const svg = qrSvg(uri);
    expect(svg.startsWith('<svg')).toBe(true);
    expect((svg.match(/<rect/g) ?? []).length).toBeGreaterThan(100);
  });

  function service(existing = 0) {
    const created: Record<string, unknown>[] = [];
    const prisma = {
      upiPaymentClaim: { count: jest.fn(async () => existing), create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => (created.push(data), { ...data, id: 'u1', status: 'PENDING', createdAt: new Date(), decidedAt: null, note: null })) },
      company: { findMany: jest.fn(async () => [{ id: 'c1', name: 'Ravi' }]) },
      partner: { findMany: jest.fn(async () => []) },
      user: { findMany: jest.fn(async () => []) },
    };
    const billing = { quote: jest.fn(async () => ({ gst: { totalPaise: 236000 } })) };
    const settings = { get: jest.fn(async () => ({ upiId: 'parthanbdl-3@okicici', bankAccountName: '', legalName: 'Vibhav Enterprise Solutions', upiQrFile: 'x.jpg' })) };
    return { svc: new UpiService(prisma as never, settings as never, billing as never), created };
  }
  const ctx = { userId: 'u' } as never;
  const owner = { kind: 'COMPANY', id: 'c1', name: 'Ravi', partnerId: null } as never;
  const buy = { items: [{ type: 'GPS_DEVICE', quantity: 1 }], renewSeatIds: [], paidOn: '2026-10-21' } as never as Parameters<UpiService['claim']>[2];

  it('"I\'ve paid": amount comes from the server quote; UTR validated and not reusable', async () => {
    const s = service();
    const dto = await s.svc.claim(ctx, owner, { ...buy, utr: ' 412345678901 ' });
    expect(s.created[0]).toMatchObject({ amountPaise: 236000, utr: '412345678901', ownerKind: 'COMPANY' });
    expect(dto).toMatchObject({ status: 'PENDING', ownerName: 'Ravi' });
    await expect(service().svc.claim(ctx, owner, { ...buy, utr: 'abc' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service(1).svc.claim(ctx, owner, { ...buy, utr: '412345678901' })).rejects.toBeInstanceOf(ConflictException);
  });

  it('info: link + QR only when an amount is asked for', async () => {
    const s = service();
    await expect(s.svc.info()).resolves.toMatchObject({ enabled: true, vpa: 'parthanbdl-3@okicici', hasImage: true });
    const withAmount = await s.svc.info(236000, 'VeeTrax Ravi');
    expect(withAmount.uri).toContain('am=2360.00');
    expect(withAmount.svg).toContain('<svg');
  });
});

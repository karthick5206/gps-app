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
    return { svc: new UpiService(prisma as never, settings as never, billing as never, { record: jest.fn() } as never), created };
  }

  /** In-memory claim row with Prisma's conditional updateMany semantics, to exercise concurrent decisions (R-17). */
  function decisionHarness(opts: { failFulfil?: boolean } = {}) {
    const row = { id: 'u1', status: 'PENDING' as string, decidedAt: null as Date | null, decidedById: null as string | null, ownerKind: 'COMPANY', ownerId: 'c1', method: 'UPI', utr: '412345678901', paidOn: new Date('2026-10-21'), amountPaise: 236000, purchase: { items: [{ type: 'GPS_DEVICE', quantity: 1 }], renewSeatIds: [] }, note: null as string | null };
    const matches = (where: Record<string, unknown>) => Object.entries(where).every(([k, v]) => (v instanceof Date ? (row as Record<string, unknown>)[k] instanceof Date && ((row as Record<string, unknown>)[k] as Date).getTime() === v.getTime() : (row as Record<string, unknown>)[k] === v));
    const prisma = {
      upiPaymentClaim: {
        findUnique: jest.fn(async () => ({ ...row })),
        updateMany: jest.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          await new Promise((r) => setImmediate(r)); // let concurrent callers interleave
          if (!matches(where)) return { count: 0 };
          Object.assign(row, data);
          return { count: 1 };
        }),
      },
    };
    const billing = {
      recordOffline: jest.fn(async () => {
        await new Promise((r) => setTimeout(r, 5));
        if (opts.failFulfil) throw new BadRequestException('The price changed since the claim');
        return { orderId: 'o1', invoiceId: 'i1' };
      }),
    };
    const audit = { record: jest.fn(async () => undefined) };
    const svc = new UpiService(prisma as never, {} as never, billing as never, audit as never);
    const owner = jest.fn(async () => ({ kind: 'COMPANY', id: 'c1', name: 'Ravi', partnerId: null }) as never);
    return { svc, row, billing, audit, owner };
  }

  it('R-17: two concurrent confirms fulfil exactly once (one invoice), the other gets 409', async () => {
    const h = decisionHarness();
    const results = await Promise.allSettled([h.svc.confirm(ctx, 'u1', h.owner), h.svc.confirm(ctx, 'u1', h.owner)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected').map((r) => (r as PromiseRejectedResult).reason)).toEqual([expect.any(ConflictException)]);
    expect(h.billing.recordOffline).toHaveBeenCalledTimes(1);
    expect(h.row.status).toBe('CONFIRMED');
    expect(h.audit.record).toHaveBeenCalledWith(ctx, expect.objectContaining({ entity: 'UpiPaymentClaim', after: expect.objectContaining({ status: 'CONFIRMED' }) }));
  });

  it('R-17: a confirm racing a reject: exactly one decision wins', async () => {
    const h = decisionHarness();
    const results = await Promise.allSettled([h.svc.confirm(ctx, 'u1', h.owner), h.svc.reject(ctx, 'u1', 'UTR not on statement')]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(h.billing.recordOffline.mock.calls.length).toBe(h.row.status === 'CONFIRMED' ? 1 : 0);
  });

  it('R-17: failed fulfilment hands the claim back to PENDING (can be retried or rejected)', async () => {
    const h = decisionHarness({ failFulfil: true });
    await expect(h.svc.confirm(ctx, 'u1', h.owner)).rejects.toBeInstanceOf(BadRequestException);
    expect(h.row.status).toBe('PENDING');
    expect(h.row.decidedAt).toBeNull();
    await h.svc.reject(ctx, 'u1', 'price changed');
    expect(h.row.status).toBe('REJECTED');
  });

  it('reject is audited', async () => {
    const h = decisionHarness();
    await h.svc.reject(ctx, 'u1', '  wrong UTR  ');
    expect(h.audit.record).toHaveBeenCalledWith(ctx, expect.objectContaining({ entity: 'UpiPaymentClaim', after: { status: 'REJECTED', note: 'wrong UTR' } }));
  });
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

  it('cash: no UTR needed, note kept, confirmed later as a CASH payment', async () => {
    const s = service();
    const dto = await s.svc.claim(ctx, owner, { ...buy, method: 'CASH', customerNote: 'Collect at my shop, Monday' });
    expect(s.created[0]).toMatchObject({ method: 'CASH', utr: null, customerNote: 'Collect at my shop, Monday', amountPaise: 236000 });
    expect(dto.method).toBe('CASH');
  });

  it('info: link + QR only when an amount is asked for', async () => {
    const s = service();
    await expect(s.svc.info()).resolves.toMatchObject({ enabled: true, vpa: 'parthanbdl-3@okicici', hasImage: true });
    const withAmount = await s.svc.info(236000, 'VeeTrax Ravi');
    expect(withAmount.uri).toContain('am=2360.00');
    expect(withAmount.svg).toContain('<svg');
  });
});

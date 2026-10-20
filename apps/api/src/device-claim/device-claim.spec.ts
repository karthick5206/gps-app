import { BadRequestException, ConflictException } from '@nestjs/common';
import { formatClaimCode, newClaimCode, normalizeClaimCode, setupSteps } from './claim-logic';
import { DeviceClaimService } from './device-claim.service';
import { renderHelpSheet } from './help-sheet-pdf';

const ctx = { userId: 'u1', companyId: 'c1', homeCompanyId: 'c1', isSuperAdmin: false, permissions: {}, dataScope: 'COMPANY', branchIds: [], objectIds: [], ip: null } as never;

function service(device: Record<string, unknown> | null, unknown: { lastSeenAt: Date; protocol: string } | null = null, me = { email: 'ravi@x.in', mobile: '+919876543210' }) {
  const tx = { device: { update: jest.fn(async () => ({})), create: jest.fn(async () => ({ id: 'new' })) }, unknownDevice: { delete: jest.fn(async () => ({})) } };
  const prisma = {
    user: { findUnique: jest.fn(async () => me) },
    device: { findUnique: jest.fn(async () => device) },
    unknownDevice: { findUnique: jest.fn(async () => unknown) },
    deviceModel: { findUnique: jest.fn(async () => ({ id: 'm1', protocol: 'GT06' })) },
    $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const seats = { ensureDevice: jest.fn(async () => undefined) };
  const svc = new DeviceClaimService(prisma as never, seats as never, { record: jest.fn() } as never, { invalidateCache: jest.fn() } as never);
  return { svc, tx, seats };
}

describe('claim codes and setup text', () => {
  it('codes are 6 unambiguous characters; typing is forgiving', () => {
    const c = newClaimCode();
    expect(c).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
    expect(normalizeClaimCode(` ${formatClaimCode(c).toLowerCase()} `)).toBe(c);
    expect(normalizeClaimCode('12')).toBeNull();
    expect(setupSteps('GT06', 'Concox GT06N').join(' ')).toContain('SERVER,1,track.mintplus.co.in,5023,0#');
  });
});

describe('DeviceClaimService.claim', () => {
  const stock = { id: 'd1', companyId: null, claimCode: '7K4Q2M', reservedEmail: 'ravi@x.in', reservedMobile: null };

  it('shipped device: right code + reserved customer → moves into the account and takes a seat', async () => {
    const { svc, tx, seats } = service(stock);
    await expect(svc.claim(ctx, { uniqueId: '868120000000001', claimCode: '7k4-q2m' })).resolves.toMatchObject({ deviceId: 'd1' });
    expect(tx.device.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ companyId: 'c1' }) }));
    expect(seats.ensureDevice).toHaveBeenCalled();
  });

  it('wrong code, another customer, or another account → refused', async () => {
    await expect(service(stock).svc.claim(ctx, { uniqueId: '868120000000001', claimCode: 'AAAAAA' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service(stock, null, { email: 'other@x.in', mobile: '+919000000000' }).svc.claim(ctx, { uniqueId: '868120000000001', claimCode: '7K4Q2M' })).rejects.toBeInstanceOf(ConflictException);
    await expect(service({ ...stock, companyId: 'c2' }).svc.claim(ctx, { uniqueId: '868120000000001' })).rejects.toThrow(/another account/);
  });

  it('own tracker: only if it connected in the last 24 h, with a model chosen', async () => {
    await expect(service(null, null).svc.claim(ctx, { uniqueId: '868120000000002', modelId: 'm1' })).rejects.toThrow(/not heard/);
    await expect(service(null, { lastSeenAt: new Date(Date.now() - 2 * 86_400_000), protocol: 'gt06' }).svc.claim(ctx, { uniqueId: '868120000000002', modelId: 'm1' })).rejects.toThrow(/not heard/);
    const fresh = service(null, { lastSeenAt: new Date(), protocol: 'gt06' });
    await expect(fresh.svc.claim(ctx, { uniqueId: '868120000000002' })).rejects.toThrow(/model/);
    await expect(fresh.svc.claim(ctx, { uniqueId: '868120000000002', modelId: 'm1' })).resolves.toMatchObject({ deviceId: 'new' });
  });
});

describe('help sheet', () => {
  it('renders a PDF with one page per device', async () => {
    const row = { deviceId: 'd1', uniqueId: '868120000000001', modelName: 'Concox GT06N', protocol: 'GT06', claimCode: '7K4-Q2M', reservedName: 'Ravi', reservedEmail: 'ravi@x.in', reservedMobile: '+919876543210', shipmentNote: 'DTDC D123', shippedAt: new Date().toISOString(), claimedAt: null, companyName: null, lastSeenAt: null };
    const pdf = await renderHelpSheet([row, { ...row, uniqueId: '868120000000009' }], 'https://gps.mintplus.co.in', { name: 'Vibhav Enterprise Solutions', phone: '+91 90000 00000', email: 'info@vaidhika.in', website: null }, null);
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
  });
});

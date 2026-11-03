import { createHash } from 'node:crypto';
import { isDifferentPhone } from './mobile-tracker.logic';
import { MobileTrackerService } from './mobile-tracker.service';

const TOKEN = 'token';
const auth = `Bearer ${TOKEN}`;
const hash = createHash('sha256').update(TOKEN).digest('hex');

function build(session: { revokedAt: Date | null; status?: string; objectActive?: boolean }, results: [Error | null, unknown][] = []) {
  const xadd = jest.fn();
  const exec = jest.fn(async () => results);
  const pipeline = { xadd, exec };
  const prisma = {
    mobileTrackerSession: {
      findUnique: jest.fn(async ({ where }: { where: { tokenHash: string } }) =>
        where.tokenHash === hash ? { id: 's1', revokedAt: session.revokedAt, deviceId: 'd1', device: { uniqueId: '919000000000', isActive: true, companyId: 'c1', trackingRequired: false, company: { status: session.status ?? 'ACTIVE' }, assignments: session.objectActive === undefined ? [] : [{ object: { isActive: session.objectActive } }] } } : null,
      ),
      update: jest.fn(async () => ({})),
    },
    device: { update: jest.fn(async () => ({})) },
    trackerEvent: { createMany: jest.fn(async () => ({ count: 0 })) },
    rawPacket: { createMany: jest.fn(async () => ({ count: 0 })) },
  };
  const redis = { client: { pipeline: () => pipeline } };
  const service = new (MobileTrackerService as unknown as new (...a: unknown[]) => MobileTrackerService)(prisma, redis, {}, {}, {}, {}, {});
  return { service, xadd, prisma };
}

const point = (t: number) => ({ t, lat: 12.9, lng: 80.2 });
const NOW = Date.now();

describe('tracker upload never confirms what it did not keep', () => {
  it('confirms saved points', async () => {
    const { service, xadd } = build({ revokedAt: null }, [[null, '1-0']]);
    await expect(service.upload(auth, [point(NOW - 1000)])).resolves.toMatchObject({ ok: true, accepted: 1 });
    expect(xadd).toHaveBeenCalledTimes(1);
  });

  it('answers an error when Redis could not save them, so the phone keeps and retries them', async () => {
    const { service } = build({ revokedAt: null }, [[null, '1-0'], [new Error('OOM'), null]]);
    await expect(service.upload(auth, [point(NOW - 2000), point(NOW - 1000)])).rejects.toMatchObject({ status: 503 });
  });

  it('a number moved to another phone: an app that can drain delivers only what it recorded before the move', async () => {
    const { service, xadd, prisma } = build({ revokedAt: new Date(NOW - 5000) }, [[null, '1-0']]);
    await expect(service.upload(auth, [point(NOW - 9000), point(NOW - 1000)], { drain: true, locBg: true })).resolves.toMatchObject({ accepted: 1, revoked: true, required: false });
    expect(xadd).toHaveBeenCalledTimes(1);
    expect(prisma.device.update).not.toHaveBeenCalled();
  });

  it('a number moved to another phone: older apps still get 401 REVOKED', async () => {
    const { service, xadd } = build({ revokedAt: new Date(NOW - 5000) });
    await expect(service.upload(auth, [point(NOW - 9000)])).rejects.toMatchObject({ status: 401 });
    expect(xadd).not.toHaveBeenCalled();
  });
});

describe('points the server would discard', () => {
  it.each([
    ['a suspended company', { status: 'SUSPENDED' }],
    ['an inactive vehicle', { objectActive: false }],
  ])('%s: refused with INACTIVE, so the phone keeps its queue', async (_name, blocked) => {
    const { service, xadd } = build({ revokedAt: null, ...blocked });
    await expect(service.upload(auth, [point(NOW - 1000)])).rejects.toMatchObject({ status: 403 });
    expect(xadd).not.toHaveBeenCalled();
  });

  it('a blocked number that moved away: also INACTIVE, not a 401 that would delete the queue', async () => {
    const { service } = build({ revokedAt: new Date(NOW - 5000), status: 'SUSPENDED' });
    await expect(service.upload(auth, [point(NOW - 9000)], { drain: true })).rejects.toMatchObject({ status: 403 });
  });

  it('keeps rejected points with their reason and records it for the phone history', async () => {
    const { service, prisma } = build({ revokedAt: null }, [[null, '1-0']]);
    await service.upload(auth, [point(NOW - 1000), { t: NOW - 40 * 86_400_000, lat: 1, lng: 1 }, { t: NOW, lat: 0, lng: 0 }]);
    const raw = (prisma.rawPacket.createMany.mock.calls as unknown as [{ data: { protocol: string; hex: string }[] }][])[0][0].data;
    expect(raw.map((r) => r.protocol)).toEqual(['mobile-rejected', 'mobile-rejected']);
    expect(JSON.parse(raw[0].hex).reason).toBe('older than 30 days');
    const event = (prisma.trackerEvent.createMany.mock.calls as unknown as [{ data: { kind: string; why: string }[] }][])[0][0].data[0];
    expect(event).toMatchObject({ kind: 'discard', why: 'server rejected 2: 1 older than 30 days, 1 bad coordinates' });
  });

  it('records points from after the number moved as rejected, not silently', async () => {
    const { service, prisma } = build({ revokedAt: new Date(NOW - 5000) }, [[null, '1-0']]);
    await service.upload(auth, [point(NOW - 9000), point(NOW - 1000)], { drain: true });
    const event = (prisma.trackerEvent.createMany.mock.calls as unknown as [{ data: { why: string }[] }][])[0][0].data[0];
    expect(event.why).toBe('server rejected 1: 1 after moving to another phone');
  });
});

describe('isDifferentPhone', () => {
  it('compares install ids when both are known', () => {
    expect(isDifferentPhone({ installIdHash: 'a', deviceName: 'X' }, { installIdHash: 'b', deviceName: 'X' })).toBe(true);
    expect(isDifferentPhone({ installIdHash: 'a', deviceName: 'X' }, { installIdHash: 'a', deviceName: 'Y' })).toBe(false);
  });
  it('falls back to the phone name, and needs both to compare', () => {
    expect(isDifferentPhone({ installIdHash: null, deviceName: 'X' }, { installIdHash: 'b', deviceName: 'Y' })).toBe(true);
    expect(isDifferentPhone({ installIdHash: null, deviceName: 'X' }, { installIdHash: 'b', deviceName: 'X' })).toBe(false);
    expect(isDifferentPhone({ installIdHash: null, deviceName: null }, { installIdHash: 'b', deviceName: 'Y' })).toBe(false);
  });
  it('the first activation is not a change', () => {
    expect(isDifferentPhone(null, { installIdHash: 'b', deviceName: 'Y' })).toBe(false);
  });
});

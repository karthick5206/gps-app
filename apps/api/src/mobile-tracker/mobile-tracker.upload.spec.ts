import { createHash } from 'node:crypto';
import { isDifferentPhone } from './mobile-tracker.logic';
import { MobileTrackerService } from './mobile-tracker.service';

const TOKEN = 'token';
const auth = `Bearer ${TOKEN}`;
const hash = createHash('sha256').update(TOKEN).digest('hex');

function build(session: { revokedAt: Date | null }, results: [Error | null, unknown][] = []) {
  const xadd = jest.fn();
  const exec = jest.fn(async () => results);
  const pipeline = { xadd, exec };
  const prisma = {
    mobileTrackerSession: {
      findUnique: jest.fn(async ({ where }: { where: { tokenHash: string } }) =>
        where.tokenHash === hash ? { id: 's1', revokedAt: session.revokedAt, deviceId: 'd1', device: { uniqueId: '919000000000', isActive: true, companyId: 'c1', trackingRequired: false } } : null,
      ),
      update: jest.fn(async () => ({})),
    },
    device: { update: jest.fn(async () => ({})) },
    trackerEvent: { createMany: jest.fn(async () => ({ count: 0 })) },
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

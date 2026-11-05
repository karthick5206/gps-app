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
    trackerEvent: { createMany: jest.fn(async () => ({ count: 0 })), createManyAndReturn: jest.fn(async () => []), findFirst: jest.fn(async () => null) },
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

describe('tracking switched off / on alerts', () => {
  const flush = () => new Promise((done) => setImmediate(done));
  const withAlerts = (added: { kind: string; at: Date; why: string }[]) => {
    const built = build({ revokedAt: null }, [[null, '1-0']]);
    const svc = built.service as unknown as { alerts: { trackerSwitched: jest.Mock }; prisma: { device: { findUnique: jest.Mock }; trackerEvent: { createManyAndReturn: jest.Mock } } };
    svc.alerts = { trackerSwitched: jest.fn(async () => undefined) };
    svc.prisma.device.findUnique = jest.fn(async () => ({ companyId: 'c1', assignments: [{ object: { id: 'o1', name: 'Parthan', branchId: null, plateNumber: null, speedLimitKph: null } }] }));
    svc.prisma.trackerEvent.createManyAndReturn = jest.fn(async () => added);
    return { service: built.service, trackerSwitched: svc.alerts.trackerSwitched };
  };
  const health = (k: string, why: string) => ({ events: [{ k, at: NOW - 60_000, why }] });

  it('alerts when the person stopped tracking, at the time it happened', async () => {
    const { service, trackerSwitched } = withAlerts([{ kind: 'stop', at: new Date(NOW - 60_000), why: 'user tapped Stop' }]);
    await service.upload(auth, [], health('stop', 'user tapped Stop'));
    await flush();
    await flush();
    expect(trackerSwitched).toHaveBeenCalledTimes(1);
    expect(trackerSwitched.mock.calls[0][0]).toMatchObject({ on: false, why: 'user tapped Stop', companyId: 'c1' });
    expect(trackerSwitched.mock.calls[0][1]).toBe(NOW - 60_000);
  });

  it('does not alert again for an event the phone sent before', async () => {
    const { service, trackerSwitched } = withAlerts([]);
    await service.upload(auth, [], health('stop', 'user tapped Stop'));
    await flush();
    await flush();
    expect(trackerSwitched).not.toHaveBeenCalled();
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

describe('activating on a number that was active before', () => {
  const object = { id: 'o1', name: 'Ravi', branchId: null, plateNumber: null, speedLimitKph: null };
  const device = { id: 'd1', uniqueId: '919000000000', companyId: 'c1', company: { name: 'Acme' }, assignments: [{ object }] };
  const INSTALL = 'android-id';
  const flush = () => new Promise((done) => setImmediate(done));

  async function activate(previous: { sameInstall: boolean; revokedAt: Date | null; lastUsedAt: Date | null } | null, signedOutEvents = 0) {
    const { service, prisma } = build({ revokedAt: null });
    const hashInstallIdOf = async () => {
      // The stored hash of this phone: captured from a first activation, so the test doesn't repeat how it is made.
      const p = prisma as unknown as { mobileTrackerSession: Record<string, unknown>; $transaction: unknown };
      let stored: string | null = null;
      p.$transaction = jest.fn(async () => []);
      p.mobileTrackerSession.findFirst = jest.fn(async () => null);
      p.mobileTrackerSession.updateMany = jest.fn(() => ({}));
      p.mobileTrackerSession.create = jest.fn(({ data }: { data: { installIdHash: string } }) => ((stored = data.installIdHash), {}));
      await (service as unknown as { startSession: (d: unknown, b: unknown) => Promise<unknown> }).startSession(device, { installId: INSTALL, deviceName: 'Pixel 8' });
      return stored;
    };
    const svc = service as unknown as { alerts: unknown; startSession: (d: unknown, b: unknown) => Promise<unknown> };
    const alerts = { trackerDeviceChanged: jest.fn(async () => undefined), trackerReactivated: jest.fn(async () => undefined) };
    svc.alerts = alerts;
    const installIdHash = await hashInstallIdOf();
    await flush();
    alerts.trackerReactivated.mockClear();
    const p = prisma as unknown as { mobileTrackerSession: { findFirst: unknown }; trackerEvent: { count: unknown } };
    p.trackerEvent.count = jest.fn(async () => signedOutEvents);
    p.mobileTrackerSession.findFirst = jest.fn(async () => previous && { installIdHash: previous.sameInstall ? installIdHash : 'another', deviceName: 'Pixel 8', revokedAt: previous.revokedAt, lastUsedAt: previous.lastUsedAt });
    await svc.startSession(device, { installId: INSTALL, deviceName: 'Pixel 8' });
    await flush();
    return alerts;
  }

  it('first activation: no alert', async () => {
    const alerts = await activate(null);
    expect(alerts.trackerReactivated).not.toHaveBeenCalled();
    expect(alerts.trackerDeviceChanged).not.toHaveBeenCalled();
  });

  it('the app lost its token on the same phone: reinstalled', async () => {
    const alerts = await activate({ sameInstall: true, revokedAt: null, lastUsedAt: new Date(NOW - 7_200_000) });
    expect(alerts.trackerReactivated).toHaveBeenCalledTimes(1);
    expect(alerts.trackerReactivated.mock.calls[0]).toEqual([expect.objectContaining({ how: 'REINSTALLED', companyId: 'c1', message: expect.stringContaining('reinstalled') }), expect.any(Number)]);
    expect(alerts.trackerDeviceChanged).not.toHaveBeenCalled();
  });

  it('signed out, then activated on the same phone', async () => {
    const alerts = await activate({ sameInstall: true, revokedAt: new Date(NOW - 7_200_000), lastUsedAt: new Date(NOW - 7_300_000) }, 1);
    expect(alerts.trackerReactivated.mock.calls[0]).toEqual([expect.objectContaining({ how: 'SIGNED_OUT', message: expect.stringContaining('after it was signed out') }), expect.any(Number)]);
  });

  it('stopped from the Devices page, then activated on the same phone', async () => {
    const alerts = await activate({ sameInstall: true, revokedAt: new Date(NOW - 7_200_000), lastUsedAt: null }, 0);
    expect(alerts.trackerReactivated.mock.calls[0]).toEqual([expect.objectContaining({ how: 'STOPPED' }), expect.any(Number)]);
  });

  it('another phone: only the device-changed alert', async () => {
    const alerts = await activate({ sameInstall: false, revokedAt: null, lastUsedAt: new Date(NOW - 1000) });
    expect(alerts.trackerDeviceChanged).toHaveBeenCalledTimes(1);
    expect(alerts.trackerReactivated).not.toHaveBeenCalled();
  });
});

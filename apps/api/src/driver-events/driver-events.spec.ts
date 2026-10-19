import { DRIVER_EVENT_DEFAULTS, driverEventSettings, driverScore, SYSTEM_ROLES, snapshotChannel } from '@veetracer/shared';
import { mkdtemp, mkdir, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RedisKeys } from '../redis/keys';
import { driverAt, MEDIA_RETRY_ATTEMPTS, mediaRejection, pickEvent } from './driver-event-logic';
import { DriverEventWorkerService } from './driver-event-worker.service';
import { DriverEventsService } from './driver-events.service';
import { purgeDriverEvents, sweepIncoming } from './media-retention';
import { DriverMediaMessage } from './media-store';
import { signMediaToken, verifyMediaToken } from './media-token';

jest.mock('./media-store', () => {
  const actual = jest.requireActual('./media-store');
  return { ...actual, linkIncoming: jest.fn(async (_p: string, c: string, e: string) => `${c}/2026-10/${e}-x.jpg`), removeMedia: jest.fn(async () => undefined) };
});
// eslint-disable-next-line @typescript-eslint/no-require-imports
const store = require('./media-store') as { linkIncoming: jest.Mock; removeMedia: jest.Mock };

const T0 = new Date('2026-10-19T06:30:00Z');
const COMPANY = '00000000-0000-0000-0000-00000000000c';

describe('driver event logic', () => {
  it('picks the closest event inside the match window', () => {
    const events = [
      { id: 'a', occurredAt: new Date(T0.getTime() - 10 * 60_000) },
      { id: 'b', occurredAt: new Date(T0.getTime() - 20_000) },
      { id: 'c', occurredAt: new Date(T0.getTime() + 30_000) },
    ];
    expect(pickEvent(events, T0)?.id).toBe('b');
    expect(pickEvent(events, new Date(T0.getTime() + 25_000))?.id).toBe('c');
    expect(pickEvent([events[0]], T0)).toBeNull();
  });

  it('enforces per-event photo / clip limits and the company quota', () => {
    const s = { maxPhotos: 3, quotaMb: 1 };
    expect(mediaRejection({ kind: 'PHOTO', size: 1000, photos: 2, videos: 0, usedBytes: 0 }, s)).toBeNull();
    expect(mediaRejection({ kind: 'PHOTO', size: 1000, photos: 3, videos: 0, usedBytes: 0 }, s)).toMatch(/3 photo/);
    expect(mediaRejection({ kind: 'VIDEO', size: 1000, photos: 0, videos: 2, usedBytes: 0 }, s)).toMatch(/clip/);
    expect(mediaRejection({ kind: 'PHOTO', size: 2000, photos: 0, videos: 0, usedBytes: 1024 * 1024 - 1000 }, s)).toMatch(/quota/);
  });

  it('finds the driver assigned at the event time', () => {
    const rows = [
      { driverId: 'd2', fromTime: new Date(T0.getTime() - 60_000), toTime: null },
      { driverId: 'd1', fromTime: new Date(T0.getTime() - 3600_000), toTime: new Date(T0.getTime() - 60_000) },
    ];
    expect(driverAt(rows, T0)).toBe('d2');
    expect(driverAt(rows, new Date(T0.getTime() - 120_000))).toBe('d1');
    expect(driverAt(rows, new Date(T0.getTime() - 7200_000))).toBeNull();
  });

  it('normalises settings, picks the camera and scores drivers', () => {
    expect(driverEventSettings({ cabinChannel: 3, maxPhotos: 99, retentionDays: 30 })).toEqual({ ...DRIVER_EVENT_DEFAULTS, cabinChannel: 3, retentionDays: 30 });
    expect(snapshotChannel('DRIVER_PHONE', DRIVER_EVENT_DEFAULTS)).toBe(2);
    expect(snapshotChannel('LANE_DEPARTURE', DRIVER_EVENT_DEFAULTS)).toBe(1);
    expect(driverScore([{ type: 'DRIVER_PHONE', level: 2 }, { type: 'CRASH', level: null }, { type: 'DRIVER_FATIGUE', level: 3, status: 'DISMISSED' }])).toBe(100 - 8 - 10);
  });

  it('gives the driver_events menu to Admin / Manager (review) and User (view)', () => {
    const role = (n: string) => SYSTEM_ROLES.find((r) => r.name === n)!.permissions.driver_events;
    expect(role('Admin')).toEqual(['view', 'edit', 'export']);
    expect(role('Manager')).toEqual(['view', 'edit', 'export']);
    expect(role('User')).toEqual(['view']);
    expect(role('Viewer')).toBeUndefined();
  });

  it('signs short-lived media tokens bound to one file', () => {
    const t = signMediaToken({ u: 'u1', c: COMPANY, m: 'm1' }, 'x'.repeat(32), T0.getTime());
    expect(verifyMediaToken(t, 'm1', 'x'.repeat(32), T0.getTime())?.c).toBe(COMPANY);
    expect(verifyMediaToken(t, 'm2', 'x'.repeat(32), T0.getTime())).toBeNull();
    expect(verifyMediaToken(t, 'm1', 'y'.repeat(32), T0.getTime())).toBeNull();
    expect(verifyMediaToken(t, 'm1', 'x'.repeat(32), T0.getTime() + 3 * 3600_000)).toBeNull();
  });
});

function workerHarness() {
  const prisma = {
    driverEvent: {
      findUnique: jest.fn(async (): Promise<unknown> => null),
      findFirst: jest.fn(async (): Promise<unknown> => null),
      findMany: jest.fn(async (): Promise<unknown[]> => []),
      create: jest.fn(async () => ({ id: 'ev-1' })),
    },
    driverAssignment: { findMany: jest.fn(async () => [{ driverId: 'drv-1', fromTime: new Date(T0.getTime() - 3600_000), toTime: null }]) },
    company: { findUnique: jest.fn(async (): Promise<unknown> => ({ settings: { driverEvents: { cabinChannel: 3 } } })) },
    device: {
      findUnique: jest.fn(async (args: { where: { id?: string; uniqueId?: string } }): Promise<unknown> =>
        args.where.uniqueId ? { id: 'dev-1', companyId: COMPANY } : { uniqueId: '13912345678', model: { protocol: 'jt808', capabilities: ['video', 'dms'] } },
      ),
    },
    driverEventMedia: {
      groupBy: jest.fn(async (): Promise<unknown[]> => []),
      aggregate: jest.fn(async () => ({ _sum: { fileSize: 0 } })),
      create: jest.fn(async () => ({})),
    },
  };
  const redis = { client: { get: jest.fn(async () => 'gw-1'), publish: jest.fn(async (_c: string, _m: string) => 1) } };
  const worker = new DriverEventWorkerService(prisma as never, redis as never);
  return { prisma, redis, worker };
}

const alert = (type: string) =>
  ({
    id: 'al-1', companyId: COMPANY, objectId: 'obj-1', deviceId: 'dev-1', type, severity: 'WARNING', message: 'm', lat: 13.08, lng: 80.27, address: 'Anna Salai',
    geofenceId: null, data: { level: 2, speedKph: 48, source: 'dms' }, occurredAt: T0, createdAt: T0, status: 'NEW', ackById: null, ackAt: null, ackNote: null,
  }) as never;

const media = (over: Partial<DriverMediaMessage> = {}): DriverMediaMessage => ({
  path: 'incoming/2026-10-19/a.jpg', uniqueId: '13912345678', source: 'SNAPSHOT', kind: 'PHOTO', mime: 'image/jpeg', size: 5000,
  channel: 2, capturedAt: new Date(T0.getTime() + 15_000).toISOString(), lat: null, lng: null, eventId: null, ref: '9', ...over,
});

describe('DriverEventWorkerService', () => {
  afterEach(() => jest.clearAllMocks());

  it('creates the event with the current driver and asks the dashcam gateway for a cabin snapshot', async () => {
    const { prisma, redis, worker } = workerHarness();
    await expect(worker.onAlert(alert('DRIVER_PHONE'))).resolves.toBe('ev-1');
    expect(prisma.driverEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ alertId: 'al-1', driverId: 'drv-1', type: 'DRIVER_PHONE', level: 2, speedKph: 48, address: 'Anna Salai', occurredAt: T0 }),
    }));
    expect(redis.client.get).toHaveBeenCalledWith(RedisKeys.connection('13912345678'));
    expect(redis.client.publish).toHaveBeenCalledWith(RedisKeys.snapshotChannel('gw-1'), JSON.stringify({ uniqueId: '13912345678', eventId: 'ev-1', channel: 3 }));
  });

  it('uses the road camera for ADAS events, skips other alert types and is idempotent', async () => {
    const { prisma, redis, worker } = workerHarness();
    await worker.onAlert(alert('TAILGATING'));
    expect(JSON.parse(redis.client.publish.mock.calls[0][1]).channel).toBe(1);
    await expect(worker.onAlert(alert('OVERSPEED'))).resolves.toBeNull();
    prisma.driverEvent.findUnique.mockResolvedValueOnce({ id: 'ev-old' });
    await expect(worker.onAlert(alert('CRASH'))).resolves.toBe('ev-old');
    expect(prisma.driverEvent.create).toHaveBeenCalledTimes(1);
  });

  it('does not request snapshots for non-dashcam devices or when disabled', async () => {
    const { prisma, redis, worker } = workerHarness();
    prisma.device.findUnique.mockResolvedValueOnce({ uniqueId: '3586', model: { protocol: 'gt06', capabilities: [] } });
    await worker.onAlert(alert('CRASH'));
    prisma.company.findUnique.mockResolvedValueOnce({ settings: { driverEvents: { snapshot: false } } });
    await worker.onAlert(alert('DRIVER_FATIGUE'));
    expect(redis.client.publish).not.toHaveBeenCalled();
  });

  it('links a snapshot to the event it was requested for', async () => {
    const { prisma, worker } = workerHarness();
    prisma.driverEvent.findFirst.mockResolvedValueOnce({ id: 'ev-1', occurredAt: T0 });
    await expect(worker.handleMedia(media({ eventId: 'ev-1' }))).resolves.toBe('linked');
    expect(store.linkIncoming).toHaveBeenCalledWith('incoming/2026-10-19/a.jpg', COMPANY, 'ev-1', 'image/jpeg', expect.any(Date));
    expect(prisma.driverEventMedia.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ eventId: 'ev-1', companyId: COMPANY, kind: 'PHOTO', source: 'SNAPSHOT', channel: 2, fileSize: 5000, filePath: `${COMPANY}/2026-10/ev-1-x.jpg` }),
    });
  });

  it('matches attachments by device and time, and drops files over the limits', async () => {
    const { prisma, worker } = workerHarness();
    prisma.driverEvent.findMany.mockResolvedValue([{ id: 'ev-9', occurredAt: T0 }]);
    await expect(worker.handleMedia(media({ source: 'ATTACHMENT' }))).resolves.toBe('linked');
    expect(prisma.driverEvent.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ deviceId: 'dev-1' }) }));
    prisma.driverEventMedia.groupBy.mockResolvedValueOnce([{ kind: 'PHOTO', _count: { _all: 3 } }]);
    await expect(worker.handleMedia(media())).resolves.toBe('dropped');
    expect(store.removeMedia).toHaveBeenCalledWith('incoming/2026-10-19/a.jpg');
  });

  it('retries media that arrived before its event, then gives up', async () => {
    const { worker } = workerHarness();
    await expect(worker.handleMedia(media())).resolves.toBe('retry');
    await expect(worker.handleMedia(media(), MEDIA_RETRY_ATTEMPTS - 1)).resolves.toBe('dropped');
    worker.stop();
  });

  it('drops media from unknown devices', async () => {
    const { prisma, worker } = workerHarness();
    prisma.device.findUnique.mockResolvedValueOnce(null);
    await expect(worker.handleMedia(media())).resolves.toBe('dropped');
  });
});

describe('driver event retention', () => {
  it('deletes old files before their rows, per company retention', async () => {
    const order: string[] = [];
    const oldMedia = jest.fn().mockResolvedValueOnce([{ id: 'm1', filePath: 'c/a.jpg' }]).mockResolvedValue([]);
    const deps = {
      oldMedia,
      deleteMedia: jest.fn(async (ids: string[]) => {
        order.push(`rows:${ids.join(',')}`);
        return ids.length;
      }),
      deleteEvents: jest.fn(async (_c: string, _cutoff: Date, _take: number) => 1),
      removeFile: jest.fn(async (p: string) => {
        order.push(`file:${p}`);
      }),
    };
    const counts: Record<string, number> = {};
    const now = T0.getTime();
    const companies = [{ id: COMPANY, settings: { driverEvents: { retentionDays: 30 } } }, { id: 'c2', settings: {} }];
    const done = await purgeDriverEvents(deps, companies, now, Date.now() + 60_000, (k, n) => (counts[k] = (counts[k] ?? 0) + n));
    expect(done).toBe(true);
    expect(order).toEqual(['file:c/a.jpg', 'rows:m1']);
    expect(oldMedia.mock.calls[0][1]).toEqual(new Date(now - 30 * 86_400_000));
    expect(deps.deleteEvents.mock.calls[1][1]).toEqual(new Date(now - 90 * 86_400_000));
    expect(counts).toEqual({ driverEventMedia: 1, driverEvents: 2 });
  });

  it('sweeps unclaimed incoming files after two days', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vt-media-'));
    for (const d of ['2026-10-15', '2026-10-18', '2026-10-19', 'junk']) {
      await mkdir(join(dir, d));
      await writeFile(join(dir, d, 'x.jpg'), 'x');
    }
    await expect(sweepIncoming(T0.getTime(), dir)).resolves.toBe(1);
    expect((await readdir(dir)).sort()).toEqual(['2026-10-18', '2026-10-19', 'junk']);
  });
});

describe('DriverEventsService scope', () => {
  it('limits events to the caller scope and licence-viewable vehicles', async () => {
    const licences = { viewableWhere: jest.fn(async () => ({ OR: [{ assignments: { none: { toTime: null } } }] })) };
    const service = new DriverEventsService({} as never, {} as never, {} as never, { jwtSecret: 'x'.repeat(32) } as never, licences as never);
    const ctx = { companyId: COMPANY, dataScope: 'ASSIGNED', branchIds: ['b1'], objectIds: ['o1'], isSuperAdmin: false, userId: 'u1', permissions: {} } as never;
    const where = await service.where(ctx, { type: ['DRIVER_PHONE', 'BOGUS'], hasPhoto: true, status: ['NEW'] });
    expect(where).toEqual({
      AND: [
        { companyId: COMPANY, object: { AND: [{ companyId: COMPANY, OR: [{ branchId: { in: ['b1'] } }, { id: { in: ['o1'] } }] }, { OR: [{ assignments: { none: { toTime: null } } }] }] } },
        { type: { in: ['DRIVER_PHONE'] } },
        { status: { in: ['NEW'] } },
        { media: { some: { kind: 'PHOTO' } } },
      ],
    });
  });
});

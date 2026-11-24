import { VideoService } from './video.service';

const CTX = { userId: 'u-1', companyId: 'co-1', isSuperAdmin: true } as never;

/** A vehicle whose current device is a Jimi camera (GT06 + video) or a JT/T 808 dashcam. */
function harness(protocol: 'GT06' | 'JT808', connected = true) {
  const prisma = {
    trackedObject: {
      findFirst: jest.fn(async () => ({ id: 'obj-1', companyId: 'co-1', name: 'TN 07 DS 4591', assignments: [{ device: { uniqueId: '864993060658300', model: { protocol, capabilities: ['video'] } } }] })),
    },
    device: { findUnique: jest.fn(async () => ({ id: 'dev-1' })) },
    driverEvent: { create: jest.fn(async () => ({ id: 'ev-1' })), delete: jest.fn(async () => ({})) },
  };
  const redis = { client: { get: jest.fn(async () => (connected ? 'gw-1' : null)), set: jest.fn(async () => 'OK'), publish: jest.fn(async () => 1) } };
  const commands = { sendInternal: jest.fn(async () => connected) };
  const svc = new VideoService(prisma as never, redis as never, { jwtSecret: 'x'.repeat(40), mediaHttpPort: 4110 } as never, undefined, commands as never, async () => []);
  return { svc, prisma, redis, commands };
}

describe('video capture and extend', () => {
  it('Jimi: photo / 10 s clip commands for the road (out) and driver (in) camera, with a manual capture event', async () => {
    const { svc, prisma, commands } = harness('GT06');
    await expect(svc.capture(CTX, 'obj-1', { channel: 1, kind: 'photo' })).resolves.toEqual({ eventId: 'ev-1' });
    expect(commands.sendInternal).toHaveBeenLastCalledWith(CTX, 'obj-1', 'Picture,out');
    await svc.capture(CTX, 'obj-1', { channel: 2, kind: 'video', seconds: 30 });
    expect(commands.sendInternal).toHaveBeenLastCalledWith(CTX, 'obj-1', 'Video,in,10s');
    expect(prisma.driverEvent.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ type: 'MANUAL_CAPTURE', objectId: 'obj-1', deviceId: 'dev-1' }) }));
  });

  it('JT/T 808: photo through the gateway snapshot channel with the event id; clips refused', async () => {
    const { svc, redis } = harness('JT808');
    await svc.capture(CTX, 'obj-1', { channel: 2, kind: 'photo' });
    expect(redis.client.publish).toHaveBeenCalledWith('vt:snap:gw:gw-1', JSON.stringify({ uniqueId: '864993060658300', eventId: 'ev-1', channel: 2 }));
    await expect(svc.capture(CTX, 'obj-1', { channel: 1, kind: 'video' })).rejects.toThrow(/Jimi/);
  });

  it('offline camera: the event is removed again and DEVICE_OFFLINE returned', async () => {
    const { svc, prisma } = harness('GT06', false);
    await expect(svc.capture(CTX, 'obj-1', { channel: 1, kind: 'photo' })).rejects.toMatchObject({ response: { code: 'DEVICE_OFFLINE' } });
    expect(prisma.driverEvent.delete).toHaveBeenCalledWith({ where: { id: 'ev-1' } });
  });

  it('extend: resends RTMP,ON for RTMP cameras only', async () => {
    const jimi = harness('GT06');
    const r = await jimi.svc.extend(CTX, 'obj-1', 2);
    expect(jimi.commands.sendInternal).toHaveBeenCalledWith(CTX, 'obj-1', 'RTMP,ON,IN,15');
    expect(Date.parse(r.streamEndsAt)).toBeGreaterThan(Date.now() + 14 * 60_000);
    await expect(harness('JT808').svc.extend(CTX, 'obj-1', 1)).rejects.toThrow(/nothing to extend/);
  });
});

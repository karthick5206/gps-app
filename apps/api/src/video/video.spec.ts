import { HttpException } from '@nestjs/common';
import { MENUS, SYSTEM_ROLES } from '@veetracer/shared';
import { signVideoToken, verifyVideoToken, VIDEO_TOKEN_TTL_SEC } from './video-token';
import { VideoService } from './video.service';

const SECRET = 'x'.repeat(40);

describe('video stream tokens', () => {
  it('signs and verifies a token bound to user, company and session', () => {
    const now = Date.UTC(2026, 9, 19, 6, 0, 0);
    const { token, expiresAt } = signVideoToken({ u: 'user-1', c: 'co-1', s: 'lAbc123' }, SECRET, now);
    expect(expiresAt.getTime()).toBe(now + VIDEO_TOKEN_TTL_SEC * 1000);
    expect(verifyVideoToken(token, 'lAbc123', SECRET, now + 1000)).toMatchObject({ u: 'user-1', c: 'co-1', s: 'lAbc123' });
    // Another session, another secret, a tampered payload or after expiry: rejected.
    expect(verifyVideoToken(token, 'lOther', SECRET, now)).toBeNull();
    expect(verifyVideoToken(token, 'lAbc123', 'y'.repeat(40), now)).toBeNull();
    const [payload, sig] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ u: 'admin', c: 'co-1', s: 'lAbc123', exp: 9e9 })).toString('base64url');
    expect(verifyVideoToken(`${forged}.${sig}`, 'lAbc123', SECRET, now)).toBeNull();
    expect(verifyVideoToken(`${payload}.`, 'lAbc123', SECRET, now)).toBeNull();
    expect(verifyVideoToken('garbage', 'lAbc123', SECRET, now)).toBeNull();
    expect(verifyVideoToken(token, 'lAbc123', SECRET, now + VIDEO_TOKEN_TTL_SEC * 1000)).toBeNull();
  });
});

describe('video permissions', () => {
  it('adds a video menu viewable by Admin and Manager', () => {
    expect(MENUS.find((m) => m.key === 'video')?.actions).toEqual(['view']);
    expect(SYSTEM_ROLES.find((r) => r.name === 'Admin')?.permissions.video).toEqual(['view']);
    expect(SYSTEM_ROLES.find((r) => r.name === 'Manager')?.permissions.video).toEqual(['view']);
    expect(SYSTEM_ROLES.find((r) => r.name === 'Viewer')?.permissions.video).toBeUndefined();
  });
});

describe('VideoService gateway requests', () => {
  function service(gatewayId: string | null, receivers: number) {
    const client = { get: jest.fn().mockResolvedValue(gatewayId), publish: jest.fn().mockResolvedValue(receivers), set: jest.fn() };
    let onMessage: (channel: string, message: string) => void = () => undefined;
    const redis = { client, subscribe: (_c: string[], fn: typeof onMessage) => (onMessage = fn) };
    const svc = new VideoService({} as never, redis as never, { jwtSecret: SECRET, mediaHttpPort: 4110 } as never);
    svc.onModuleInit();
    return { svc, client, reply: (m: unknown) => onMessage('vt:video:replies', JSON.stringify(m)) };
  }
  const code = async (p: Promise<unknown>) => {
    try {
      await p;
      return 'resolved';
    } catch (e) {
      return ((e as HttpException).getResponse() as { code: string }).code;
    }
  };

  it('reports offline devices and gateways without video', async () => {
    expect(await code(service(null, 0).svc.ask('1', { op: 'attributes' }))).toBe('DEVICE_OFFLINE');
    expect(await code(service('gw1', 0).svc.ask('1', { op: 'attributes' }))).toBe('VIDEO_DISABLED');
  });

  it('matches replies by reqId and maps gateway errors (stream limit)', async () => {
    const { svc, client, reply } = service('gw1', 1);
    const pending = svc.ask('13912345678', { op: 'live', channel: 1, stream: 'sub' });
    await new Promise((r) => setImmediate(r));
    const sent = JSON.parse(client.publish.mock.calls[0][1] as string) as { reqId: string; op: string; uniqueId: string };
    expect(client.publish.mock.calls[0][0]).toBe('vt:video:gw:gw1');
    expect(sent).toMatchObject({ op: 'live', uniqueId: '13912345678', channel: 1, stream: 'sub' });
    reply({ reqId: 'other', ok: true });
    reply({ reqId: sent.reqId, ok: false, error: { code: 'STREAM_LIMIT', message: 'full' } });
    expect(await code(pending)).toBe('STREAM_LIMIT');
  });
});

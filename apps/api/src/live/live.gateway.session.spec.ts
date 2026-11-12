/**
 * R-14 / D6 G5: live sockets are bound to the session that opened them.
 * Unit tests drive the gateway internals with fake sockets; the last block runs a real socket.io server and client
 * in-process (no database, no Valkey: fakes stand in for both) and logs out through TokenService.
 */
import { createServer, Server as HttpServer } from 'node:http';
import { AddressInfo } from 'node:net';
import { Server } from 'socket.io';
import { io as connect, Socket as ClientSocket } from 'socket.io-client';
import { AuthContext } from '../access/auth-context';
import { sha256 } from '../common/secrets';
import { TokenService } from '../auth/token.service';
import { RedisKeys } from '../redis/keys';
import { LiveGateway } from './live.gateway';

const COMPANY = '22222222-2222-4222-8222-222222222222';
const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '77777777-7777-4777-8777-777777777777';
const S1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const S2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const S3 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OBJ = '33333333-3333-4333-8333-333333333333';

const ctxOf = (userId: string, sessionId: string | null): AuthContext => ({
  userId,
  homeCompanyId: COMPANY,
  companyId: COMPANY,
  isSuperAdmin: false,
  permissions: { live_map: ['view'], alerts: ['view'] },
  dataScope: 'COMPANY',
  branchIds: [],
  objectIds: [],
  ip: null,
  sessionId,
});

type FakeSocket = { id: string; connected: boolean; data: Record<string, unknown>; emit: jest.Mock; disconnect: jest.Mock };
type Internals = {
  clients: Map<string, unknown>;
  byCompany: Map<string, Set<unknown>>;
  handleConnection(s: FakeSocket): Promise<void>;
  onSessionsRevoked(m: string): void;
  onUpdate(m: string): void;
  flush(): void;
  refreshAll(): Promise<void>;
};

let seq = 0;
function fakeSocket(userId: string, sessionId: string | null, authStartedAt?: number): FakeSocket {
  const id = `sock-${++seq}`;
  const s: FakeSocket = {
    id,
    connected: true,
    data: { ctx: ctxOf(userId, sessionId), ...(authStartedAt !== undefined ? { authStartedAt } : {}) },
    emit: jest.fn(),
    disconnect: jest.fn(() => {
      s.connected = false;
    }),
  };
  return s;
}

function gateway(sessions: { id: string; revokedAt: Date | null; expiresAt: Date }[] = []) {
  const contexts = { forUser: jest.fn(async (userId: string) => ctxOf(userId, null)) };
  const findMany = jest.fn(async ({ where }: { where: { id: { in: string[] } } }) => sessions.filter((s) => where.id.in.includes(s.id)));
  const prisma = { session: { findMany } };
  const gw = new LiveGateway(contexts as never, prisma as never, {} as never);
  return { gw, internals: gw as unknown as Internals, contexts, findMany };
}

const future = () => new Date(Date.now() + 3600_000);
const revoked = (body: object) => JSON.stringify({ ...body, at: Date.now() });

describe('LiveGateway session binding (unit)', () => {
  it('stores the session id on connect', async () => {
    const { internals } = gateway();
    const s = fakeSocket(U1, S1);
    await internals.handleConnection(s);
    expect((internals.clients.get(s.id) as { sessionId: string }).sessionId).toBe(S1);
  });

  it('a revoked message disconnects the matching socket only', async () => {
    const { internals } = gateway();
    const a = fakeSocket(U1, S1);
    const b = fakeSocket(U1, S2);
    const c = fakeSocket(U2, S3);
    for (const s of [a, b, c]) await internals.handleConnection(s);
    internals.onSessionsRevoked(revoked({ sessionIds: [S1] }));
    expect(a.disconnect).toHaveBeenCalledWith(true);
    expect(b.disconnect).not.toHaveBeenCalled();
    expect(c.disconnect).not.toHaveBeenCalled();
    expect(internals.clients.has(a.id)).toBe(false);
    expect([...(internals.byCompany.get(COMPANY) ?? [])]).toHaveLength(2);
  });

  it('a revoked socket gets no queued live:batch after the message', async () => {
    const { internals } = gateway();
    const a = fakeSocket(U1, S1);
    await internals.handleConnection(a);
    internals.onUpdate(JSON.stringify({ companyId: COMPANY, live: { objectId: OBJ } }));
    internals.onSessionsRevoked(revoked({ sessionIds: [S1] }));
    internals.onUpdate(JSON.stringify({ companyId: COMPANY, live: { objectId: OBJ } }));
    internals.flush();
    expect(a.emit).not.toHaveBeenCalled();
  });

  it('revokeOthers (userId + allExcept) keeps the current session', async () => {
    const { internals } = gateway();
    const current = fakeSocket(U1, S1);
    const other = fakeSocket(U1, S2);
    const legacy = fakeSocket(U1, null);
    const otherUser = fakeSocket(U2, S3);
    for (const s of [current, other, legacy, otherUser]) await internals.handleConnection(s);
    internals.onSessionsRevoked(revoked({ userId: U1, allExcept: S1 }));
    expect(current.disconnect).not.toHaveBeenCalled();
    expect(other.disconnect).toHaveBeenCalledWith(true);
    expect(legacy.disconnect).toHaveBeenCalledWith(true);
    expect(otherUser.disconnect).not.toHaveBeenCalled();
  });

  it('userId without allExcept (password reset, deactivation) disconnects every socket of the user', async () => {
    const { internals } = gateway();
    const a = fakeSocket(U1, S1);
    const b = fakeSocket(U1, S2);
    for (const s of [a, b]) await internals.handleConnection(s);
    internals.onSessionsRevoked(revoked({ userId: U1 }));
    expect(a.disconnect).toHaveBeenCalled();
    expect(b.disconnect).toHaveBeenCalled();
  });

  it('ignores malformed messages', async () => {
    const { internals } = gateway();
    const a = fakeSocket(U1, S1);
    await internals.handleConnection(a);
    internals.onSessionsRevoked('garbage');
    internals.onSessionsRevoked('{}');
    expect(a.disconnect).not.toHaveBeenCalled();
  });

  it('a socket still in the handshake when the revocation arrived is dropped on registration', async () => {
    const { internals } = gateway();
    const started = Date.now() - 50;
    internals.onSessionsRevoked(revoked({ sessionIds: [S1] }));
    const raced = fakeSocket(U1, S1, started);
    await internals.handleConnection(raced);
    expect(raced.disconnect).toHaveBeenCalledWith(true);
    expect(internals.clients.has(raced.id)).toBe(false);
  });

  it('a new login that starts after a user-wide revocation is not dropped', async () => {
    const { internals } = gateway();
    internals.onSessionsRevoked(revoked({ userId: U1 }));
    const fresh = fakeSocket(U1, S2, Date.now() + 1);
    await internals.handleConnection(fresh);
    expect(fresh.disconnect).not.toHaveBeenCalled();
  });

  describe('refreshAll (fallback when pub/sub is lost)', () => {
    it('disconnects sockets whose session is revoked, expired or missing; keeps live ones', async () => {
      const { internals, findMany } = gateway([
        { id: S1, revokedAt: new Date(), expiresAt: future() },
        { id: S2, revokedAt: null, expiresAt: new Date(Date.now() - 1000) },
        { id: S3, revokedAt: null, expiresAt: future() },
      ]);
      const rev = fakeSocket(U1, S1);
      const exp = fakeSocket(U1, S2);
      const ok = fakeSocket(U2, S3);
      const gone = fakeSocket(U2, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd');
      for (const s of [rev, exp, ok, gone]) await internals.handleConnection(s);
      await internals.refreshAll();
      expect(findMany).toHaveBeenCalledTimes(1);
      expect(rev.disconnect).toHaveBeenCalledWith(true);
      expect(exp.disconnect).toHaveBeenCalledWith(true);
      expect(gone.disconnect).toHaveBeenCalledWith(true);
      expect(ok.disconnect).not.toHaveBeenCalled();
    });

    it('preserves sessionId on the refreshed context (forUser drops it)', async () => {
      const { internals, contexts } = gateway([{ id: S3, revokedAt: null, expiresAt: future() }]);
      const ok = fakeSocket(U2, S3);
      await internals.handleConnection(ok);
      await internals.refreshAll();
      expect(contexts.forUser).toHaveBeenCalled();
      const client = internals.clients.get(ok.id) as { ctx: AuthContext; sessionId: string };
      expect(client.ctx.sessionId).toBe(S3);
      expect(client.sessionId).toBe(S3);
      // A second tick still checks the same session.
      await internals.refreshAll();
      expect(ok.disconnect).not.toHaveBeenCalled();
    });

    it('a failing session query does not disconnect everyone', async () => {
      const { internals, findMany } = gateway();
      findMany.mockRejectedValueOnce(new Error('db down') as never);
      const ok = fakeSocket(U2, S3);
      await internals.handleConnection(ok);
      await internals.refreshAll();
      expect(ok.disconnect).not.toHaveBeenCalled();
    });

    it('security review L2: a socket holding only Incidents & SOS survives the refresh; one with nothing left is dropped', async () => {
      const { internals, contexts } = gateway([{ id: S3, revokedAt: null, expiresAt: future() }]);
      const sosOnly = fakeSocket(U2, S3);
      await internals.handleConnection(sosOnly);
      contexts.forUser.mockImplementationOnce(async (userId: string) => ({ ...ctxOf(userId, null), permissions: { etms_incidents: ['view'] } }));
      await internals.refreshAll();
      expect(sosOnly.disconnect).not.toHaveBeenCalled();
      contexts.forUser.mockImplementationOnce(async (userId: string) => ({ ...ctxOf(userId, null), permissions: {} }));
      await internals.refreshAll();
      expect(sosOnly.disconnect).toHaveBeenCalledWith(true);
    });

    it('legacy sockets without a session id are not queried', async () => {
      const { internals, findMany } = gateway();
      await internals.handleConnection(fakeSocket(U1, null));
      await internals.refreshAll();
      expect(findMany).not.toHaveBeenCalled();
    });
  });
});

describe('LiveGateway + socket.io client: logout closes the live socket (in-process integration)', () => {
  jest.setTimeout(20_000);
  let http: HttpServer;
  let ioServer: Server;
  let gw: LiveGateway;
  let url: string;
  let onChannel: (channel: string, message: string) => void = () => undefined;
  const sessions = new Map<string, { id: string; userId: string; revokedAt: Date | null; expiresAt: Date; refreshTokenHash: string }>();
  const clients: ClientSocket[] = [];

  // Fake Valkey: publish is delivered to the gateway's subscriber like a real pub/sub round trip.
  const redis = {
    subscribe: (_channels: string[], handler: (c: string, m: string) => void) => {
      onChannel = handler;
      return {} as never;
    },
    client: { publish: jest.fn(async (channel: string, message: string) => (setImmediate(() => onChannel(channel, message)), 1)) },
  };
  // Fake Prisma with just the session calls TokenService and the gateway make.
  const prisma = {
    session: {
      findUnique: jest.fn(async ({ where }: { where: { refreshTokenHash: string } }) => [...sessions.values()].find((s) => s.refreshTokenHash === where.refreshTokenHash) ?? null),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: { revokedAt: Date } }) => Object.assign(sessions.get(where.id)!, data)),
      updateMany: jest.fn(async ({ where, data }: { where: { userId: string; id?: { not: string } }; data: { revokedAt: Date } }) => {
        let count = 0;
        for (const s of sessions.values()) {
          if (s.userId !== where.userId || s.revokedAt || (where.id && s.id === where.id.not)) continue;
          s.revokedAt = data.revokedAt;
          count++;
        }
        return { count };
      }),
      findMany: jest.fn(async ({ where }: { where: { id: { in: string[] } } }) => [...sessions.values()].filter((s) => where.id.in.includes(s.id))),
    },
  };
  // The access "token" is `<userId>:<sessionId>`; fromToken rejects ended sessions like the real one.
  const contexts = {
    fromToken: jest.fn(async (token: string) => {
      const [userId, sid] = token.split(':');
      const s = sessions.get(sid);
      if (!s || s.revokedAt || s.userId !== userId) throw new Error('Session ended');
      return ctxOf(userId, sid);
    }),
    forUser: jest.fn(async (userId: string) => ctxOf(userId, null)),
  };
  const tokens = new TokenService(prisma as never, {} as never, {} as never, redis as never);

  const addSession = (id: string, userId: string, refresh: string) =>
    sessions.set(id, { id, userId, revokedAt: null, expiresAt: future(), refreshTokenHash: sha256(refresh) });

  function open(token: string) {
    const socket = connect(`${url}/live`, { transports: ['websocket'], auth: { token }, reconnection: false, forceNew: true });
    clients.push(socket);
    const batches: number[] = [];
    socket.on('live:batch', () => batches.push(Date.now()));
    const disconnected = new Promise<{ reason: string; at: number }>((res) => socket.on('disconnect', (reason) => res({ reason, at: Date.now() })));
    const connected = new Promise<void>((res, rej) => {
      socket.on('connect', () => res());
      socket.on('connect_error', rej);
    });
    return { socket, batches, disconnected, connected };
  }

  const pushPosition = () => onChannel(RedisKeys.liveUpdates, JSON.stringify({ companyId: COMPANY, live: { objectId: OBJ } }));
  const waitRegistered = async (n: number) => {
    const internals = gw as unknown as Internals;
    for (let i = 0; i < 100 && internals.clients.size < n; i++) await new Promise((r) => setTimeout(r, 10));
  };

  beforeEach(async () => {
    sessions.clear();
    http = createServer();
    ioServer = new Server(http);
    gw = new LiveGateway(contexts as never, prisma as never, redis as never);
    const ns = ioServer.of('/live');
    gw.afterInit(ns);
    ns.on('connection', (socket) => {
      socket.on('disconnect', () => gw.handleDisconnect(socket));
      void gw.handleConnection(socket);
    });
    await new Promise<void>((res) => http.listen(0, '127.0.0.1', res));
    url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    clients.splice(0).forEach((c) => c.close());
    gw.onModuleDestroy();
    await new Promise<void>((res) => ioServer.close(() => res()));
  });

  it('logout disconnects with "io server disconnect" and no event arrives afterwards', async () => {
    addSession(S1, U1, 'rt-1');
    const c = open(`${U1}:${S1}`);
    await c.connected;
    await waitRegistered(1);
    pushPosition();
    await new Promise((r) => setTimeout(r, 1200));
    expect(c.batches.length).toBeGreaterThan(0);

    const t0 = Date.now();
    await expect(tokens.revoke('rt-1')).resolves.toBe(U1);
    const { reason, at } = await c.disconnected;
    expect(reason).toBe('io server disconnect');
    expect(at - t0).toBeLessThan(5000);
    const seen = c.batches.length;
    pushPosition();
    await new Promise((r) => setTimeout(r, 1500));
    expect(c.batches.length).toBe(seen);
  });

  it('reconnecting with the revoked session token is rejected at the handshake', async () => {
    addSession(S1, U1, 'rt-1');
    await tokens.revoke('rt-1');
    const c = open(`${U1}:${S1}`);
    await expect(c.connected).rejects.toThrow('Session ended');
  });

  it('revokeOthers disconnects the other sessions and keeps the current one', async () => {
    addSession(S1, U1, 'rt-1');
    addSession(S2, U1, 'rt-2');
    const current = open(`${U1}:${S1}`);
    const other = open(`${U1}:${S2}`);
    await Promise.all([current.connected, other.connected]);
    await waitRegistered(2);
    await expect(tokens.revokeOthers(U1, S1)).resolves.toBe(1);
    expect((await other.disconnected).reason).toBe('io server disconnect');
    await new Promise((r) => setTimeout(r, 300));
    expect(current.socket.connected).toBe(true);
  });

  it('with pub/sub lost, the periodic re-check disconnects the revoked session', async () => {
    addSession(S1, U1, 'rt-1');
    const c = open(`${U1}:${S1}`);
    await c.connected;
    await waitRegistered(1);
    redis.client.publish.mockImplementationOnce(async () => 1); // message dropped
    await tokens.revoke('rt-1');
    await new Promise((r) => setTimeout(r, 200));
    expect(c.socket.connected).toBe(true);
    await (gw as unknown as Internals).refreshAll(); // the 60 s tick
    expect((await c.disconnected).reason).toBe('io server disconnect');
  });
});

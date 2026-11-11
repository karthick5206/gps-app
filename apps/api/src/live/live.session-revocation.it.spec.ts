/**
 * R-14 / D6 G5 integration evidence. Both blocks are skipped unless their env var is set (never production).
 *
 * 1. SESSION_IT_REDIS_URL — real Valkey pub/sub between two in-process API "instances" (two socket.io servers, two
 *    LiveGateways, one TokenService). Logout on instance A must close the socket held by instance B. 20 runs.
 *    Only db 1 of a local Valkey is accepted (test instance), e.g.
 *      SESSION_IT_REDIS_URL=redis://127.0.0.1:6379/1 npx jest src/live/live.session-revocation.it
 *    Note: Valkey pub/sub is not database-scoped; the messages carry random session ids that match nothing else.
 *
 * 2. SESSION_IT_BASE_URL — the running test API (:4100) end to end: log in, open /live, POST /api/auth/logout, expect
 *    `io server disconnect` and no event after 5 s, 20 runs; then sign-out-others keeps the current socket.
 *      SESSION_IT_BASE_URL=http://localhost:4100/api [SESSION_IT_EMAIL=… SESSION_IT_PASS=…] npx jest src/live/live.session-revocation.it
 */
import { randomUUID } from 'node:crypto';
import { createServer, Server as HttpServer } from 'node:http';
import { AddressInfo } from 'node:net';
import { Server } from 'socket.io';
import { io as connect, Socket as ClientSocket } from 'socket.io-client';
import { AuthContext } from '../access/auth-context';
import { sha256 } from '../common/secrets';
import { TokenService } from '../auth/token.service';
import { RedisService } from '../redis/redis.service';
import { LiveGateway } from './live.gateway';

const RUNS = Number(process.env.SESSION_IT_RUNS ?? 20);
const REDIS_URL = process.env.SESSION_IT_REDIS_URL;
const BASE_URL = process.env.SESSION_IT_BASE_URL;
const redisOk = !!REDIS_URL && /^redis:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/1$/.test(REDIS_URL);
const apiOk = !!BASE_URL && !/:4000(\/|$)/.test(BASE_URL);

const COMPANY = '22222222-2222-4222-8222-222222222222';
const ctxOf = (userId: string, sessionId: string): AuthContext => ({
  userId,
  homeCompanyId: COMPANY,
  companyId: COMPANY,
  isSuperAdmin: false,
  permissions: { live_map: ['view'] },
  dataScope: 'COMPANY',
  branchIds: [],
  objectIds: [],
  ip: null,
  sessionId,
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(redisOk ? describe : describe.skip)('session revocation across API instances (real Valkey pub/sub)', () => {
  jest.setTimeout(120_000);
  const sessions = new Map<string, { id: string; userId: string; revokedAt: Date | null; expiresAt: Date; refreshTokenHash: string }>();
  const prisma = {
    session: {
      findUnique: async ({ where }: { where: { refreshTokenHash: string } }) => [...sessions.values()].find((s) => s.refreshTokenHash === where.refreshTokenHash) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: { revokedAt: Date } }) => Object.assign(sessions.get(where.id)!, data),
      findMany: async ({ where }: { where: { id: { in: string[] } } }) => [...sessions.values()].filter((s) => where.id.in.includes(s.id)),
    },
  };
  const contexts = {
    fromToken: async (token: string) => {
      const [userId, sid] = token.split(':');
      const s = sessions.get(sid);
      if (!s || s.revokedAt) throw new Error('Session ended');
      return ctxOf(userId, sid);
    },
    forUser: async (userId: string) => ctxOf(userId, ''),
  };
  const env = { redisUrl: REDIS_URL! } as never;
  const instances: { http: HttpServer; io: Server; gw: LiveGateway; redis: RedisService; url: string }[] = [];
  let tokens: TokenService;

  beforeAll(async () => {
    for (let i = 0; i < 2; i++) {
      const redis = new RedisService(env);
      const http = createServer();
      const io = new Server(http);
      const gw = new LiveGateway(contexts as never, prisma as never, redis);
      const ns = io.of('/live');
      gw.afterInit(ns);
      ns.on('connection', (socket) => {
        socket.on('disconnect', () => gw.handleDisconnect(socket));
        void gw.handleConnection(socket);
      });
      await new Promise<void>((res) => http.listen(0, '127.0.0.1', res));
      instances.push({ http, io, gw, redis, url: `http://127.0.0.1:${(http.address() as AddressInfo).port}` });
    }
    tokens = new TokenService(prisma as never, {} as never, {} as never, instances[0].redis);
    await sleep(500); // subscribers ready
  });

  afterAll(async () => {
    for (const x of instances) {
      x.gw.onModuleDestroy();
      await new Promise<void>((res) => x.io.close(() => res()));
      await x.redis.onModuleDestroy();
    }
  });

  it(`logout on instance A closes the socket held by instance B (${RUNS} runs)`, async () => {
    const times: number[] = [];
    for (let run = 0; run < RUNS; run++) {
      const userId = randomUUID();
      const sid = randomUUID();
      const refresh = `rt-${sid}`;
      sessions.set(sid, { id: sid, userId, revokedAt: null, expiresAt: new Date(Date.now() + 3600_000), refreshTokenHash: sha256(refresh) });
      const socket: ClientSocket = connect(`${instances[1].url}/live`, { transports: ['websocket'], auth: { token: `${userId}:${sid}` }, reconnection: false, forceNew: true });
      await new Promise<void>((res, rej) => (socket.on('connect', () => res()), socket.on('connect_error', rej)));
      await sleep(50);
      const disconnected = new Promise<string>((res) => socket.on('disconnect', res));
      const t0 = Date.now();
      await tokens.revoke(refresh);
      const reason = await Promise.race([disconnected, sleep(5000).then(() => 'timeout')]);
      times.push(Date.now() - t0);
      socket.close();
      expect(reason).toBe('io server disconnect');
    }
    // Evidence line for the sign-off log.
    console.log(`G5 cross-instance: ${times.length}/${RUNS} disconnected; ms min=${Math.min(...times)} max=${Math.max(...times)} runs=[${times.join(',')}]`);
    expect(Math.max(...times)).toBeLessThan(5000);
  });
});

(apiOk ? describe : describe.skip)('session revocation against the running test API', () => {
  jest.setTimeout(30 * 60_000);
  const email = process.env.SESSION_IT_EMAIL ?? 'demo.admin@veetracer.local';
  const pass = process.env.SESSION_IT_PASS ?? 'Demo@12345';
  const origin = (BASE_URL ?? '').replace(/\/api$/, '');

  async function login(): Promise<{ accessToken: string; refreshToken: string }> {
    const r = await fetch(`${BASE_URL}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: pass }) });
    if (r.status !== 200) throw new Error(`login ${r.status}`);
    return (await r.json()) as { accessToken: string; refreshToken: string };
  }
  function open(token: string) {
    const socket = connect(`${origin}/live`, { transports: ['websocket'], auth: { token }, reconnection: false, forceNew: true });
    const events: number[] = [];
    socket.onAny(() => events.push(Date.now()));
    const disconnected = new Promise<{ reason: string; at: number }>((res) => socket.on('disconnect', (reason) => res({ reason, at: Date.now() })));
    const connected = new Promise<void>((res, rej) => (socket.on('connect', () => res()), socket.on('connect_error', rej)));
    return { socket, events, disconnected, connected };
  }

  it(`POST /auth/logout closes the socket; no event after 5 s (${RUNS} runs)`, async () => {
    const log: string[] = [];
    for (let run = 1; run <= RUNS; run++) {
      const t = await login();
      const c = open(t.accessToken);
      await c.connected;
      await sleep(1500);
      const t0 = Date.now();
      const r = await fetch(`${BASE_URL}/auth/logout`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken: t.refreshToken }) });
      expect(r.status).toBe(200);
      const d = await Promise.race([c.disconnected, sleep(5000).then(() => ({ reason: 'timeout', at: Date.now() }))]);
      await sleep(5000);
      const late = c.events.filter((at) => at > t0 + 5000).length;
      const last = c.events.length ? Math.max(...c.events) - t0 : null;
      log.push(`run ${run}: reason=${d.reason} disconnectMs=${d.at - t0} lastEventMs=${last} eventsAfter5s=${late}`);
      c.socket.close();
      expect(d.reason).toBe('io server disconnect');
      expect(late).toBe(0);
      // Reconnecting with the same access token is refused at the handshake.
      const again = open(t.accessToken);
      await expect(again.connected).rejects.toThrow();
      again.socket.close();
    }
    console.log(`G5 live API loop:\n${log.join('\n')}`);
  });

  it('sign out other sessions keeps the current socket and closes the others', async () => {
    const mine = await login();
    const other = await login();
    const a = open(mine.accessToken);
    const b = open(other.accessToken);
    await Promise.all([a.connected, b.connected]);
    const r = await fetch(`${BASE_URL}/auth/sessions/revoke-others`, { method: 'POST', headers: { Authorization: `Bearer ${mine.accessToken}` } });
    expect(r.status).toBe(200);
    const d = await Promise.race([b.disconnected, sleep(5000).then(() => ({ reason: 'timeout', at: 0 }))]);
    expect(d.reason).toBe('io server disconnect');
    await sleep(1000);
    expect(a.socket.connected).toBe(true);
    a.socket.close();
    b.socket.close();
    await fetch(`${BASE_URL}/auth/logout`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken: mine.refreshToken }) });
  });
});

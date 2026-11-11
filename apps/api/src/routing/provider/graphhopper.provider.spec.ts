import { RedisService } from '../../redis/redis.service';
import { RoutingService } from '../routing.service';
import { A, B, C, D, GH_ERROR, GH_INFO, GH_MATCH, GH_ROUTE } from './graphhopper.fixtures';
import { GraphHopperProvider } from './graphhopper.provider';
import { matrixEngineSource } from '../matrix/matrix.factory';
import { readRouterConfig, requireGraphHopper, RoutingEngineConfigError } from './router-config';
import { Pt } from './routing-provider';

const BASE = 'http://graphhopper.internal:8989';
type Reply = { status: number; body: unknown } | 'network' | 'timeout';

const key = (pts: Pt[]) => pts.map((p) => `${p.lat},${p.lng}`).join('|');

/** Precision-5 polyline encoder (synthesised answers for point sets without a fixture). */
function encode(pts: Pt[]): string {
  let out = '';
  let pl = 0;
  let pg = 0;
  const one = (v: number) => {
    let n = v < 0 ? ~(v << 1) : v << 1;
    let s = '';
    while (n >= 0x20) {
      s += String.fromCharCode((0x20 | (n & 0x1f)) + 63);
      n >>= 5;
    }
    return s + String.fromCharCode(n + 63);
  };
  for (const p of pts) {
    const a = Math.round(p.lat * 1e5);
    const b = Math.round(p.lng * 1e5);
    out += one(a - pl) + one(b - pg);
    pl = a;
    pg = b;
  }
  return out;
}

const synth = (pts: Pt[]): Reply => ({
  status: 200,
  body: { paths: [{ distance: 1000.4 * pts.length + pts[0].lat, time: 90_250 * pts.length, points: encode(pts), points_encoded_multiplier: 1e5 }] },
});

/** Fake GraphHopper: `/route` answers by point list, `/match`, `/info`, `/health`. Records every URL. */
function installFakeGh(routes: Record<string, Reply>, extra: { match?: Reply; info?: Reply; health?: Reply; fallback?: boolean } = {}) {
  const calls: string[] = [];
  global.fetch = jest.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    calls.push(url.toString());
    let reply: Reply | undefined;
    if (url.pathname === '/route') {
      const pts = url.searchParams.getAll('point').map((s) => {
        const [lat, lng] = s.split(',').map(Number);
        return { lat, lng };
      });
      reply = routes[key(pts)] ?? (extra.fallback ? synth(pts) : { status: 400, body: GH_ERROR.noConnection });
    } else if (url.pathname === '/match') reply = extra.match;
    else if (url.pathname === '/info') reply = extra.info;
    else if (url.pathname === '/health') reply = extra.health;
    if (!reply) return new Response('{"message":"not found"}', { status: 404 });
    if (reply === 'network') throw new TypeError('fetch failed');
    if (reply === 'timeout') throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return calls;
}

const ok = (body: unknown): Reply => ({ status: 200, body });
const fakeRedis = () => ({ client: { get: jest.fn(async () => null), set: jest.fn(async () => 'OK') } }) as unknown as RedisService;

describe('GraphHopperProvider', () => {
  const realFetch = global.fetch;
  const env = { ...process.env };
  let legacy: RoutingService;
  let provider: GraphHopperProvider;

  beforeEach(() => {
    process.env.ROUTER_URL = `${BASE}/`;
    process.env.ROUTER_ENGINE = 'graphhopper';
    legacy = new RoutingService(fakeRedis());
    provider = new GraphHopperProvider(readRouterConfig(process.env));
  });
  afterEach(() => {
    global.fetch = realFetch;
    process.env = { ...env };
  });

  describe('identical outputs to RoutingService (recorded GraphHopper answers)', () => {
    it('route: same metres, seconds, path and request as RoutingService.route', async () => {
      const calls = installFakeGh({ [key([A, B])]: ok(GH_ROUTE.AB) });
      const old = await legacy.route(A, B);
      const legacyCalls = calls.splice(0);
      const r = await provider.route(A, B);
      expect(old).not.toBeNull();
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value).toEqual({ path: old!.shape, distanceM: old!.m, durationS: old!.s });
      expect(r.value.distanceM).toBe(3456.789);
      expect(r.value.durationS).toBe(512.345);
      expect(r.value.path[0]).toEqual([A.lng, A.lat]);
      expect(calls).toEqual(legacyCalls);
      expect(r.eta).toEqual({ source: 'engine_free_flow', calibrated: false, liveTraffic: false, graphVersion: null });
    });

    it('routeVia: same path, totals and legs (all legs routed)', async () => {
      installFakeGh({
        [key([A, B, C, D])]: ok(GH_ROUTE.ABCD),
        [key([A, B])]: ok(GH_ROUTE.AB),
        [key([B, C])]: ok(GH_ROUTE.BC),
        [key([C, D])]: ok(GH_ROUTE.CD),
      });
      const old = await legacy.routeVia([A, B, C, D]);
      const r = await provider.routeVia([A, B, C, D]);
      expect(old).not.toBeNull();
      expect(r.ok && r.value).toEqual({ ...old, estimatedLegs: [] });
      expect(old!.legs).toEqual([
        { distanceM: 3457, durationSec: 512 },
        { distanceM: 2810, durationSec: 401 },
        { distanceM: 4123, durationSec: 499 },
      ]);
    });

    it('routeVia: a failed leg is filled exactly as v1.8 does and flagged as estimated', async () => {
      installFakeGh({
        [key([A, B, C, D])]: ok(GH_ROUTE.ABCD),
        [key([A, B])]: ok(GH_ROUTE.AB),
        [key([B, C])]: 'network',
        [key([C, D])]: { status: 400, body: GH_ERROR.noConnection },
      });
      const old = await legacy.routeVia([A, B, C, D]);
      const r = await provider.routeVia([A, B, C, D]);
      expect(r.ok && r.value).toEqual({ ...old, estimatedLegs: [1, 2] });
    });

    it('routeVia: two points and many points (leg batches of 6) match', async () => {
      installFakeGh({ [key([A, B])]: ok(GH_ROUTE.AB) }, { fallback: true });
      expect((await provider.routeVia([A, B])) as unknown).toMatchObject({ ok: true, value: { ...(await legacy.routeVia([A, B])), estimatedLegs: [] } });
      const many = Array.from({ length: 9 }, (_, i) => ({ lat: 13 + i * 0.01, lng: 80.2 + i * 0.005 }));
      const old = await legacy.routeVia(many);
      const r = await provider.routeVia(many);
      expect(old?.legs).toHaveLength(8);
      expect(r.ok && r.value).toEqual({ ...old, estimatedLegs: [] });
    });

    it.each([
      ['no route (400)', { status: 400, body: GH_ERROR.noConnection } as Reply, 'NO_ROUTE'],
      ['point not on a road (400)', { status: 400, body: GH_ERROR.pointNotFound } as Reply, 'POINT_NOT_ON_ROAD'],
      ['engine error (500)', { status: 500, body: GH_ERROR.server } as Reply, 'ENGINE_UNREACHABLE'],
      ['engine down', 'network' as Reply, 'ENGINE_UNREACHABLE'],
      ['timeout', 'timeout' as Reply, 'ENGINE_TIMEOUT'],
      ['unusable 200 answer', ok({ paths: [] }), 'NO_ROUTE'],
    ])('%s: RoutingService gives null, the provider a typed reason and no numbers', async (_name, reply, reason) => {
      installFakeGh({ [key([A, B])]: reply, [key([A, B, C])]: reply });
      expect(await legacy.route(A, B)).toBeNull();
      expect(await legacy.routeVia([A, B, C])).toBeNull();
      for (const r of [await provider.route(A, B), await provider.routeVia([A, B, C])]) {
        expect(r.ok).toBe(false);
        expect(Object.keys(r).sort()).toEqual(['degraded', 'message', 'ok']);
        expect(!r.ok && r.degraded).toBe(reason);
      }
    });
  });

  describe('degraded mode', () => {
    const everything = async (p: GraphHopperProvider) => [
      await p.route(A, B),
      await p.routeVia([A, B, C]),
      await p.matrix({ sources: [A], targets: [B], profile: 'car' }),
      await p.mapMatch([
        { ...A, t: 0 },
        { ...B, t: 60_000 },
        { ...C, t: 120_000 },
      ]),
      await p.locate([A]),
      await p.capabilities(),
    ];

    it('ROUTER_URL unset: ENGINE_DISABLED everywhere, no engine call', async () => {
      const calls = installFakeGh({});
      const p = new GraphHopperProvider(readRouterConfig({}));
      expect(p.enabled).toBe(false);
      for (const r of await everything(p)) expect(r).toEqual({ ok: false, degraded: 'ENGINE_DISABLED', message: expect.any(String) });
      expect(await p.health()).toMatchObject({ reachable: false, degraded: 'ENGINE_DISABLED' });
      expect(calls).toEqual([]);
    });

    it.each([['valhalla'], ['osrm'], [undefined]])('ROUTER_ENGINE=%s is refused with a clear error, no engine call', async (engine) => {
      const calls = installFakeGh({ [key([A, B])]: ok(GH_ROUTE.AB) });
      const cfg = readRouterConfig({ ROUTER_URL: BASE, ...(engine ? { ROUTER_ENGINE: engine } : {}) });
      expect(cfg.state).toBe('refused');
      const p = new GraphHopperProvider(cfg);
      for (const r of await everything(p)) {
        expect(r).toEqual({ ok: false, degraded: 'ENGINE_NOT_SUPPORTED', message: expect.stringContaining('ROUTER_ENGINE=graphhopper') });
      }
      expect(await p.health()).toMatchObject({ reachable: false, degraded: 'ENGINE_NOT_SUPPORTED' });
      expect(calls).toEqual([]);
      expect(() => requireGraphHopper({ ROUTER_URL: BASE, ...(engine ? { ROUTER_ENGINE: engine } : {}) })).toThrow(RoutingEngineConfigError);
    });

    it('L3: a public ROUTER_URL is refused (no engine call); loopback / private / ROUTING_ALLOW_PUBLIC_ENGINE=1 pass', async () => {
      const calls = installFakeGh({ [key([A, B])]: ok(GH_ROUTE.AB) });
      for (const url of ['https://graphhopper.com/api/1', 'http://8.8.8.8:8989', 'http://maps.example.com:8989', 'http://user:pw@127.0.0.1:8989', 'ftp://127.0.0.1']) {
        const cfg = readRouterConfig({ ROUTER_URL: url, ROUTER_ENGINE: 'graphhopper' });
        expect(cfg).toMatchObject({ state: 'refused', message: expect.stringMatching(/^ROUTER_URL refused: /) });
        const p = new GraphHopperProvider(cfg);
        expect(p.enabled).toBe(false);
        expect(await p.route(A, B)).toMatchObject({ ok: false, degraded: 'ENGINE_NOT_SUPPORTED' });
        expect(() => requireGraphHopper({ ROUTER_URL: url, ROUTER_ENGINE: 'graphhopper' })).toThrow(RoutingEngineConfigError);
      }
      expect(calls).toEqual([]);
      // production (loopback), dev (localhost), a private network host, a single-label service name, the test-rig hatch
      for (const url of ['http://127.0.0.1:8989', 'http://localhost:8989', 'http://10.0.0.5:8989', 'http://graphhopper:8989']) {
        expect(readRouterConfig({ ROUTER_URL: url, ROUTER_ENGINE: 'graphhopper' })).toEqual({ state: 'graphhopper', baseUrl: url });
      }
      expect(readRouterConfig({ ROUTER_URL: 'http://maps.example.com:8989', ROUTER_ENGINE: 'graphhopper', ROUTING_ALLOW_PUBLIC_ENGINE: '1' })).toEqual({ state: 'graphhopper', baseUrl: 'http://maps.example.com:8989' });
      expect(readRouterConfig({ ROUTER_URL: 'http://maps.example.com:8989', ROUTER_ENGINE: 'graphhopper', ROUTING_ALLOW_PUBLIC_ENGINE: '0' }).state).toBe('refused');
      // the matrix builder takes the same config: no engine for a refused URL
      expect(matrixEngineSource(readRouterConfig({ ROUTER_URL: 'http://8.8.8.8:8989', ROUTER_ENGINE: 'graphhopper' }))).toMatchObject({ engine: null, reason: 'ENGINE_NOT_SUPPORTED' });
    });

    it('config: GraphHopper accepted case-insensitively, trailing slash trimmed', () => {
      expect(readRouterConfig({ ROUTER_URL: `${BASE}//`, ROUTER_ENGINE: ' GraphHopper ' })).toEqual({ state: 'graphhopper', baseUrl: BASE });
      expect(requireGraphHopper({ ROUTER_URL: BASE, ROUTER_ENGINE: 'graphhopper' })).toBe(BASE);
      expect(() => requireGraphHopper({})).toThrow(/ROUTER_URL is not set/);
    });

    it('profiles other than car are not available on this graph', async () => {
      const calls = installFakeGh({});
      for (const profile of ['bus', 'van', 'foot'] as const) {
        expect(await provider.route(A, B, { profile })).toMatchObject({ ok: false, degraded: 'PROFILE_NOT_AVAILABLE' });
      }
      expect(calls).toEqual([]);
    });

    it('matrix and locate are typed NOT_IMPLEMENTED, never numbers', async () => {
      const calls = installFakeGh({});
      expect(await provider.matrix({ sources: [A, B], targets: [C, D], profile: 'car' })).toEqual({ ok: false, degraded: 'NOT_IMPLEMENTED', message: expect.any(String) });
      expect(await provider.locate([A])).toMatchObject({ ok: false, degraded: 'NOT_IMPLEMENTED' });
      expect(calls).toEqual([]);
    });

    it('routeVia with fewer than two points is INVALID_INPUT', async () => {
      expect(await provider.routeVia([A])).toMatchObject({ ok: false, degraded: 'INVALID_INPUT' });
    });

    it('health reports reachability and the failure reason', async () => {
      installFakeGh({}, { health: ok('OK') });
      expect(await provider.health()).toMatchObject({ reachable: true, latencyMs: expect.any(Number) });
      installFakeGh({}, { health: 'timeout' });
      expect(await provider.health()).toMatchObject({ reachable: false, degraded: 'ENGINE_TIMEOUT' });
      installFakeGh({}, { health: 'network' });
      expect(await provider.health()).toMatchObject({ reachable: false, degraded: 'ENGINE_UNREACHABLE' });
    });
  });

  describe('capabilities and map matching', () => {
    it('capabilities come from /info; graph version then labels results', async () => {
      installFakeGh({ [key([A, B])]: ok(GH_ROUTE.AB) }, { info: ok(GH_INFO) });
      const caps = await provider.capabilities();
      expect(caps).toMatchObject({
        ok: true,
        value: { engine: 'graphhopper', engineVersion: '11.1', graphVersion: 'gh-11.1/2026-11-08T21:20:02Z', profiles: ['car'], mapMatching: true, matrix: { native: false, maxSyncCells: 0 } },
      });
      const r = await provider.route(A, B);
      expect(r.ok && r.eta.graphVersion).toBe('gh-11.1/2026-11-08T21:20:02Z');
      installFakeGh({}, { info: 'network' });
      expect(await new GraphHopperProvider(provider.config).capabilities()).toMatchObject({ ok: false, degraded: 'ENGINE_UNREACHABLE' });
    });

    it('mapMatch delegates to point-quality matchSegment and labels off-road fixes', async () => {
      const calls = installFakeGh({}, { match: ok(GH_MATCH) });
      const trace = [
        { lat: 13.08268, lng: 80.27072, t: 0, acc: 8 },
        { lat: 13.07902, lng: 80.26811, t: 30_000, acc: 8 },
        { lat: 13.0759, lng: 80.2672, t: 60_000, acc: 10 }, // ~400 m off the matched road
        { lat: 13.06811, lng: 80.25677, t: 90_000, acc: 8 },
      ];
      const r = await provider.mapMatch(trace);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.path).toEqual(GH_MATCH.paths[0].points.coordinates);
      expect(r.value.offRoadIndexes).toEqual([2]);
      expect(r.value.matchedDistanceM).toBeGreaterThan(1500);
      expect(calls[0]).toMatch(/^http:\/\/graphhopper\.internal:8989\/match\?profile=car&points_encoded=false/);
    });

    it('mapMatch failures are typed', async () => {
      const trace = [A, B, C].map((p, i) => ({ ...p, t: i * 60_000 }));
      installFakeGh({}, { match: { status: 400, body: GH_ERROR.noConnection } });
      expect(await provider.mapMatch(trace)).toMatchObject({ ok: false, degraded: 'NO_ROUTE' });
      installFakeGh({}, { match: 'network' });
      expect(await provider.mapMatch(trace)).toMatchObject({ ok: false, degraded: 'ENGINE_UNREACHABLE' });
      expect(await provider.mapMatch(trace.slice(0, 2))).toMatchObject({ ok: false, degraded: 'INVALID_INPUT' });
    });
  });
});

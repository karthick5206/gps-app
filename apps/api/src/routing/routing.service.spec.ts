import { RoutingService } from './routing.service';

/**
 * ETMS QA R2: route() caches a genuine "no route" answer (engine 400) for 60 s, but a timeout, connection error or
 * engine error is "unavailable" — never cached as a "no route" miss, only as a short-lived unavailable marker.
 */
describe('RoutingService.routeStatus (QA R2)', () => {
  const env = { url: process.env.ROUTER_URL, engine: process.env.ROUTER_ENGINE };
  const a = { lat: 13.0067, lng: 80.2206 };
  const b = { lat: 12.9516, lng: 80.2405 };
  let fetchSpy: jest.SpyInstance;

  function service() {
    const store = new Map<string, { v: string; ttl: number }>();
    const redis = {
      client: {
        get: async (k: string) => store.get(k)?.v ?? null,
        set: async (k: string, v: string, _ex: string, ttl: number) => (store.set(k, { v, ttl }), 'OK'),
      },
    };
    process.env.ROUTER_URL = 'http://router.test:8989';
    process.env.ROUTER_ENGINE = 'graphhopper';
    return { svc: new RoutingService(redis as never), store };
  }
  const answer = (status: number, body: unknown = {}) => fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
  // A GraphHopper path at precision 5 (two points).
  const ok = { paths: [{ distance: 4200, time: 600_000, points: '_p~iF~ps|U_ulLnnqC', points_encoded_multiplier: 1e5 }] };

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch');
  });
  afterEach(() => {
    fetchSpy.mockRestore();
    process.env.ROUTER_URL = env.url;
    process.env.ROUTER_ENGINE = env.engine;
    if (env.url === undefined) delete process.env.ROUTER_URL;
    if (env.engine === undefined) delete process.env.ROUTER_ENGINE;
  });

  it('a road route is returned and cached 60 s', async () => {
    const { svc, store } = service();
    answer(200, ok);
    expect(await svc.routeStatus(a, b)).toMatchObject({ m: 4200, s: 600 });
    expect([...store.values()]).toEqual([{ v: expect.stringContaining('"m":4200'), ttl: 60 }]);
    expect(await svc.route(a, b)).toMatchObject({ m: 4200 }); // from the cache
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('engine 400 (no route) → NO_ROUTE, cached 60 s as a miss; route() null', async () => {
    const { svc, store } = service();
    answer(400, { message: 'Cannot find point' });
    expect(await svc.routeStatus(a, b)).toBe('NO_ROUTE');
    expect([...store.values()]).toEqual([{ v: '', ttl: 60 }]);
    expect(await svc.routeStatus(a, b)).toBe('NO_ROUTE');
    expect(await svc.route(a, b)).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a timeout', () => fetchSpy.mockRejectedValueOnce(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }))],
    ['a connection error', () => fetchSpy.mockRejectedValueOnce(new TypeError('fetch failed'))],
    ['an engine error (500)', () => answer(500, { message: 'boom' })],
    ['an engine error (503)', () => answer(503)],
  ])('%s → UNAVAILABLE, never cached as a "no route" miss', async (_name, arrange) => {
    const { svc, store } = service();
    arrange();
    expect(await svc.routeStatus(a, b)).toBe('UNAVAILABLE');
    const cached = [...store.values()];
    expect(cached).toHaveLength(1);
    expect(cached[0].v).not.toBe('');
    expect(cached[0].ttl).toBeLessThanOrEqual(10);
    // While the marker lives the answer stays "unavailable" (not "no route"); route() is null for its callers.
    expect(await svc.routeStatus(a, b)).toBe('UNAVAILABLE');
    expect(await svc.route(a, b)).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // Once it expires the engine is asked again and a real route is used.
    store.clear();
    answer(200, ok);
    expect(await svc.routeStatus(a, b)).toMatchObject({ m: 4200 });
  });

  it('routing not configured → UNAVAILABLE without a call', async () => {
    const { svc } = service();
    delete process.env.ROUTER_URL;
    const off = new RoutingService({ client: { get: async () => null, set: async () => 'OK' } } as never);
    expect(await off.routeStatus(a, b)).toBe('UNAVAILABLE');
    expect(await off.route(a, b)).toBeNull();
    expect(svc.enabled).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

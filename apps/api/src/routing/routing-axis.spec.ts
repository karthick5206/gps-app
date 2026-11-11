import { RedisService } from '../redis/redis.service';
import { GraphHopperProvider } from './provider/graphhopper.provider';
import { readRouterConfig } from './provider/router-config';
import { RoutingService } from './routing.service';

/**
 * RR-14 axis-order guard, ported from the routing branch's routing-axis.spec.ts (doc 17 §5.1). The branch tested a
 * Valhalla shape; this tests GraphHopper, the only engine (D3). Every route shape leaves the API in GeoJSON
 * [lng, lat] order, which the share page and the maps use as is.
 */
const FROM = { lat: 13.0827, lng: 80.2757 };
const TO = { lat: 12.981, lng: 80.1645 };

/** Standard precision-5 polyline, latitude first, as GraphHopper encodes it. */
function encode(pts: { lat: number; lng: number }[]): string {
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

const answer = () =>
  new Response(JSON.stringify({ paths: [{ distance: 24_200, time: 1_500_000, points: encode([FROM, TO]), points_encoded_multiplier: 1e5 }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

function expectLngLat(shape: [number, number][]): void {
  const [first, last] = [shape[0], shape[shape.length - 1]];
  expect(first[0]).toBeCloseTo(FROM.lng, 4); // lng first
  expect(first[1]).toBeCloseTo(FROM.lat, 4);
  expect(last[0]).toBeCloseTo(TO.lng, 4);
  expect(last[1]).toBeCloseTo(TO.lat, 4);
}

describe('route shapes are [lng, lat] (RR-14)', () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
    jest.restoreAllMocks();
  });

  it('RoutingService.route (GraphHopper)', async () => {
    process.env.ROUTER_URL = 'http://gh.test:8989';
    process.env.ROUTER_ENGINE = 'graphhopper';
    jest.spyOn(global, 'fetch').mockImplementation(async () => answer());
    const redis = { client: { get: async () => null, set: async () => 'OK' } } as unknown as RedisService;
    const r = await new RoutingService(redis).route(FROM, TO);
    expect(r).not.toBeNull();
    expectLngLat(r!.shape);
  });

  it('GraphHopperProvider.route', async () => {
    jest.spyOn(global, 'fetch').mockImplementation(async () => answer());
    const r = await new GraphHopperProvider(readRouterConfig({ ROUTER_URL: 'http://gh.internal:8989', ROUTER_ENGINE: 'graphhopper' })).route(FROM, TO);
    expect(r.ok).toBe(true);
    if (r.ok) expectLngLat(r.value.path);
  });
});

import { decodePolyline } from '../../routing/route-estimate';
import { parseGraphHopperRoute } from '../../routing/route-via';
import { RoutingService } from '../../routing/routing.service';
import { haversineMeters } from '../../tracking/geo';
import { planCounts, planE3Synthetic, prng, standardE3Plan, US_SHIFTS } from './e3-synthetic';
import { encodePolyline, GraphHopperStub, STUB_ROAD_FACTOR, stubRoute } from './graphhopper-stub';

/** WP 3.8 harness building blocks: the synthetic tenant generator and the GraphHopper stub (no database needed). */

describe('E3 synthetic generator', () => {
  it('is deterministic for a seed apart from the random ids', () => {
    const a = standardE3Plan('e3h-unit', 50, 7);
    const b = standardE3Plan('e3h-unit', 50, 7);
    const strip = (p: typeof a) => JSON.stringify(p, (k, v) => (k === 'id' || k.endsWith('Id') ? undefined : v));
    expect(strip(a)).toBe(strip(b));
    expect(a.companies[0].id).not.toBe(b.companies[0].id);
    expect(prng(1)()).toBe(prng(1)());
  });

  it('builds the T3 functional shape (16 §4.3): IST customer with 2 branches, US DST customer, control and etms-off tenants', () => {
    const plan = standardE3Plan('e3h-unit');
    expect(planCounts(plan)).toEqual({
      IST: { passengers: 200, consented: 200, logins: 4, vehicles: 9, drivers: 4, shifts: 3, branches: 2, sites: 2 },
      US: { passengers: 200, consented: 200, logins: 0, vehicles: 6, drivers: 2, shifts: 3, branches: 0, sites: 1 },
      CTRL: { passengers: 5, consented: 5, logins: 0, vehicles: 1, drivers: 1, shifts: 1, branches: 0, sites: 1 },
      OFF: { passengers: 0, consented: 0, logins: 0, vehicles: 1, drivers: 0, shifts: 0, branches: 0, sites: 1 },
    });
    const [ist, us, , off] = plan.companies;
    expect(us.timezone).toBe('America/Chicago');
    expect(us.shifts.map((s) => [s.key, s.overnight, s.timeZone])).toEqual([
      ['day', false, 'America/Chicago'],
      ['swing', true, 'America/Chicago'],
      ['night', true, 'America/Chicago'],
    ]);
    expect(off.features).toEqual([]);
    expect(ist.features).toEqual(['etms']);
    // Passengers alternate branches; vehicles carry the non-issued plate series and the seat mix incl. "no seats set".
    expect(new Set(ist.passengers.slice(0, 2).map((p) => p.branchId)).size).toBe(2);
    expect(ist.vehicles.map((v) => v.seats)).toEqual([4, 6, 12, 26, 40, null, 3, 4, 6]);
    expect(ist.vehicles.every((v) => /^TN 00 TS \d{4}$/.test(v.plateNumber))).toBe(true);
    expect(us.vehicles.every((v) => /^SYN \d{4}$/.test(v.plateNumber))).toBe(true);
    // Every name is tagged synthetic; homes within ~8 km of the city centre.
    for (const c of plan.companies) for (const p of c.passengers) expect(p.displayName.startsWith('e3h-unit ')).toBe(true);
    for (const p of ist.passengers) expect(haversineMeters(p.homeLat, p.homeLng, 13.0067, 80.2206)).toBeLessThan(8_500);
    for (const p of us.passengers) expect(haversineMeters(p.homeLat, p.homeLng, 41.8781, -87.6298)).toBeLessThan(8_500);
  });

  it('withholds consent from every n-th passenger and refuses unsafe tags', () => {
    const plan = planE3Synthetic({ tag: 'e3h-unit', companies: [{ key: 'A', kind: 'CUSTOMER', timezone: 'Asia/Kolkata', passengers: 10, noConsentEvery: 5, shifts: US_SHIFTS }] });
    expect(plan.companies[0].passengers.filter((p) => !p.consent).map((p) => p.employeeCode)).toEqual(['E3H-A-00005', 'E3H-A-00010']);
    expect(() => planE3Synthetic({ tag: "x'; DROP", companies: [] })).toThrow(/tag/);
  });
});

describe('GraphHopper stub', () => {
  const stub = new GraphHopperStub();
  const env = { url: process.env.ROUTER_URL, engine: process.env.ROUTER_ENGINE };
  const redis = { client: { get: async () => null, set: async () => 'OK' } };
  const routing = () => {
    process.env.ROUTER_URL = stub.url;
    process.env.ROUTER_ENGINE = 'graphhopper';
    return new RoutingService(redis as never);
  };
  afterAll(async () => {
    await stub.stop();
    process.env.ROUTER_URL = env.url;
    process.env.ROUTER_ENGINE = env.engine;
    if (env.url === undefined) delete process.env.ROUTER_URL;
    if (env.engine === undefined) delete process.env.ROUTER_ENGINE;
  });

  it('encodes polylines the way the API decodes them', () => {
    const pts: [number, number][] = [
      [13.0067, 80.2206],
      [12.9516, 80.2405],
      [41.8781, -87.6298],
    ];
    const back = decodePolyline(encodePolyline(pts), 5);
    expect(back).toHaveLength(3);
    back.forEach(([lng, lat], i) => {
      expect(lat).toBeCloseTo(pts[i][0], 5);
      expect(lng).toBeCloseTo(pts[i][1], 5);
    });
    const r = stubRoute(pts.slice(0, 2));
    expect(parseGraphHopperRoute({ paths: [r] })).toMatchObject({ distanceM: r.distance, durationSec: Math.round(r.time / 1000) });
    expect(r.distance).toBe(Math.round(haversineMeters(13.0067, 80.2206, 12.9516, 80.2405) * STUB_ROAD_FACTOR));
  });

  it('up → RoutingService gets a road route; noroute / error → null; stopped → null fast; hang → null after the client timeout', async () => {
    await stub.start(0);
    const a = { lat: 13.0067, lng: 80.2206 };
    const b = { lat: 12.9516, lng: 80.2405 };
    const r = await routing().route(a, b);
    expect(r).toMatchObject({ m: stubRoute([[a.lat, a.lng], [b.lat, b.lng]]).distance });
    const via = await routing().routeVia([a, b, a]);
    expect(via?.legs).toHaveLength(2);
    expect((await fetch(`${stub.url}/health`)).status).toBe(200);
    stub.mode = 'noroute';
    expect(await routing().route(a, b)).toBeNull();
    stub.mode = 'error';
    expect(await routing().route(a, b)).toBeNull();
    stub.mode = 'up';
    const port = stub.port;
    await stub.stop();
    const t0 = Date.now();
    expect(await routing().route(a, b)).toBeNull();
    expect(Date.now() - t0).toBeLessThan(2_000);
    await stub.start();
    expect(stub.port).toBe(port);
    expect(await routing().route(a, b)).not.toBeNull();
    stub.mode = 'hang';
    const before = stub.hits['/route'];
    expect(await routing().route(a, b)).toBeNull(); // the client's own timeout (RoutingService.route: 5 s today)
    expect(stub.hits['/route']).toBe(before + 1);
  }, 20_000);
});

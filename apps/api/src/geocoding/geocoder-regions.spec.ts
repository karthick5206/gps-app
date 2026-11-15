import { formatCoordinates, parseCoordinates } from '@veetracer/shared';
import { mapServiceTargets } from '../monitoring/map-services';
import { geocoderConfig, INDIA_BBOX, regionFor } from './geocoder-regions';
import { GeocodingService, mergeHits, privateGeocoderProblem, type GeocodeHit } from './geocoding.service';

const REGIONS = 'IN|http://127.0.0.1:2322|68,6,98,37;US|http://127.0.0.1:2323|-180,17,-65,72';

describe('parseCoordinates (packages/shared)', () => {
  it.each([
    ['12.97, 77.59', 12.97, 77.59],
    ['12.97 77.59', 12.97, 77.59],
    ['12.97,77.59', 12.97, 77.59],
    ['-33.8688; 151.2093', -33.8688, 151.2093],
    ['+40.7128, -74.006', 40.7128, -74.006],
    ['lat 12.97 lng 77.59', 12.97, 77.59],
    ['12.97N 77.59E', 12.97, 77.59],
    ['N12.97 E77.59', 12.97, 77.59],
    ['33.86 S, 151.2 E', -33.86, 151.2],
    ['40.7128N 74.006W', 40.7128, -74.006],
    ['77.59E 12.97N', 12.97, 77.59],
    [`12°58'17"N 77°35'40"E`, 12.971389, 77.594444],
    ['12°58′17″N 77°35′40″E', 12.971389, 77.594444],
    [`40° 42.768' N, 74° 0.36' W`, 40.7128, -74.006],
    ['0,0', 0, 0],
  ])('%s → %d, %d', (q, lat, lng) => {
    expect(parseCoordinates(q)).toMatchObject({ lat, lng });
  });

  it('reads "lng, lat" when the first value is out of the latitude range only', () => {
    expect(parseCoordinates('151.2093, -33.8688')).toEqual({ lat: -33.8688, lng: 151.2093, swapped: true });
    expect(parseCoordinates('-122.42 37.77')).toEqual({ lat: 37.77, lng: -122.42, swapped: true });
    expect(parseCoordinates('77.59, 12.97')).toEqual({ lat: 77.59, lng: 12.97, swapped: false });
  });

  it.each(['95.1, 200.5', '-91.0, 95.0', '12.5, 181.0', `12°60'N 77°E`, `12°30'61"N 77°E`, '12.97N 77.59N', '-12.9 S, 77 E', '12.97, 77.59, 3'])('rejects %s (range / contradiction)', (q) => {
    expect(parseCoordinates(q)).toBeNull();
  });

  it.each(['Anna Salai', 'New Delhi', 'Sector 5', '221B Baker Street', '12 77', '560001', '5th Main 2nd Cross', '', 'MG Road 12.9'])('%s is not coordinates', (q) => {
    expect(parseCoordinates(q)).toBeNull();
  });

  it('formats with 6 decimals', () => {
    expect(formatCoordinates(12.97, -0.5)).toBe('12.970000, -0.500000');
  });
});

describe('geocoder instances from the environment', () => {
  it('GEOCODER_REGIONS gives one instance per entry; GEOCODER_URL alone is the India instance', () => {
    expect(geocoderConfig({ GEOCODER: 'photon', GEOCODER_REGIONS: REGIONS, GEOCODER_URL: 'http://127.0.0.1:2322' })).toEqual({
      regions: [
        { code: 'IN', url: 'http://127.0.0.1:2322', bbox: [68, 6, 98, 37] },
        { code: 'US', url: 'http://127.0.0.1:2323', bbox: [-180, 17, -65, 72] },
      ],
      problems: [],
    });
    expect(geocoderConfig({ GEOCODER: 'photon', GEOCODER_URL: 'http://127.0.0.1:2322/' }).regions).toEqual([{ code: 'IN', url: 'http://127.0.0.1:2322', bbox: INDIA_BBOX }]);
    expect(geocoderConfig({ GEOCODER: 'none', GEOCODER_REGIONS: REGIONS }).regions).toEqual([]);
    expect(geocoderConfig({ GEOCODER: 'photon' }).regions).toEqual([]);
  });

  it('skips malformed entries and reports them', () => {
    const c = geocoderConfig({ GEOCODER: 'photon', GEOCODER_REGIONS: 'IN|http://127.0.0.1:2322|68,6,98,37;US|http://127.0.0.1:2323|-65,17,-180,72;BR|http://127.0.0.1:2325|1,2,3;|http://x|1,2,3,4;EU||1,2,3,4;IN|http://127.0.0.1:2324|68,6,98,37' });
    expect(c.regions.map((r) => r.url)).toEqual(['http://127.0.0.1:2322']);
    expect(c.problems).toHaveLength(5);
  });

  it('privateGeocoderProblem checks GEOCODER_URL and every GEOCODER_REGIONS URL', () => {
    expect(privateGeocoderProblem({ GEOCODER: 'photon', GEOCODER_REGIONS: REGIONS })).toBeNull();
    expect(privateGeocoderProblem({ GEOCODER: 'photon', GEOCODER_REGIONS: REGIONS, GEOCODER_URL: 'http://127.0.0.1:2322' })).toBeNull();
    expect(privateGeocoderProblem({ GEOCODER: 'photon', GEOCODER_REGIONS: 'IN|http://127.0.0.1:2322|68,6,98,37;US|https://photon.komoot.io|-180,17,-65,72' })).toMatch(
      /GEOCODER_REGIONS entry US host photon\.komoot\.io is not a loopback or private host/,
    );
    expect(privateGeocoderProblem({ GEOCODER: 'photon', GEOCODER_REGIONS: 'US|not a url|-180,17,-65,72' })).toBe('GEOCODER_REGIONS entry US is not a valid URL');
    // A malformed entry (bad bbox) is still checked: its URL is in the setting.
    expect(privateGeocoderProblem({ GEOCODER: 'photon', GEOCODER_REGIONS: 'US|http://8.8.8.8:2323|bad' })).toMatch(/not a loopback or private host/);
    // A public GEOCODER_URL left next to private regions still switches search off.
    expect(privateGeocoderProblem({ GEOCODER: 'photon', GEOCODER_REGIONS: REGIONS, GEOCODER_URL: 'https://photon.komoot.io' })).toMatch(/^GEOCODER_URL host photon\.komoot\.io/);
    expect(privateGeocoderProblem({ GEOCODER: 'none', GEOCODER_REGIONS: 'US|https://photon.komoot.io|-180,17,-65,72' })).toBeNull();
  });

  it('reverse geocoding picks the instance whose bbox contains the point', () => {
    const { regions } = geocoderConfig({ GEOCODER: 'photon', GEOCODER_REGIONS: REGIONS });
    expect(regionFor(regions, 13.06, 80.25)?.code).toBe('IN');
    expect(regionFor(regions, 40.71, -74.0)?.code).toBe('US');
    expect(regionFor(regions, 21.3, -157.85)?.code).toBe('US'); // Honolulu
    expect(regionFor(regions, 51.5, -0.12)).toBeNull(); // London
    expect(regionFor(regions, Number.NaN, 80)).toBeNull();
  });

  it('System Health probes every region (maps.photon.<code>)', () => {
    const t = mapServiceTargets({ GEOCODER: 'photon', GEOCODER_URL: 'http://127.0.0.1:2322', GEOCODER_REGIONS: REGIONS });
    expect(t.filter((x) => x.name === 'photon').map((x) => [x.id, x.label, x.probeUrl])).toEqual([
      ['photon.in', 'Addresses (Photon IN)', 'http://127.0.0.1:2322/status'],
      ['photon.us', 'Addresses (Photon US)', 'http://127.0.0.1:2323/status'],
    ]);
    expect(mapServiceTargets({ GEOCODER: 'photon', GEOCODER_URL: 'http://127.0.0.1:2322' }).filter((x) => x.name === 'photon').map((x) => x.id)).toEqual([undefined]);
  });
});

describe('multi-region search', () => {
  const saved = { g: process.env.GEOCODER, u: process.env.GEOCODER_URL, r: process.env.GEOCODER_REGIONS };
  const realFetch = global.fetch;
  let calls: string[];
  const feature = (lng: number, lat: number, props: Record<string, string>) => ({ geometry: { coordinates: [lng, lat] }, properties: props });

  beforeEach(() => {
    process.env.GEOCODER = 'photon';
    delete process.env.GEOCODER_URL;
    process.env.GEOCODER_REGIONS = REGIONS;
    calls = [];
  });
  afterEach(() => {
    global.fetch = realFetch;
    for (const [k, v] of [['GEOCODER', saved.g], ['GEOCODER_URL', saved.u], ['GEOCODER_REGIONS', saved.r]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('asks every instance with its own bbox, sends the bias to the containing one, merges by confidence then distance', async () => {
    global.fetch = (async (url: string) => {
      calls.push(String(url));
      if (String(url).startsWith('http://127.0.0.1:2322')) {
        return { ok: true, json: async () => ({ features: [feature(80.25, 13.06, { type: 'city', name: 'Springfield Nagar', city: 'Chennai' }), feature(77.6, 12.97, { type: 'street', street: 'Springfield Road', city: 'Bengaluru' })] }) };
      }
      return { ok: true, json: async () => ({ features: [feature(-89.65, 39.8, { type: 'city', name: 'Springfield', state: 'Illinois' }), feature(-72.59, 42.1, { type: 'street', street: 'Springfield Road', city: 'Springfield', state: 'Massachusetts' })] }) };
    }) as unknown as typeof fetch;
    const svc = new GeocodingService({} as never);
    const hits = await svc.search('Springfield', { lat: 13.0, lng: 80.0 });
    expect(calls).toHaveLength(2);
    const inUrl = new URL(calls.find((c) => c.includes(':2322'))!);
    const usUrl = new URL(calls.find((c) => c.includes(':2323'))!);
    expect(inUrl.searchParams.get('bbox')).toBe('68,6,98,37');
    expect(usUrl.searchParams.get('bbox')).toBe('-180,17,-65,72');
    expect(inUrl.searchParams.get('lat')).toBe('13');
    expect(usUrl.searchParams.get('lat')).toBeNull();
    // streets (0.6) before cities (0.25); within a confidence, nearer to the bias point first.
    expect(hits.map((h) => h.label)).toEqual(['Springfield Road, Bengaluru', 'Springfield Road, Springfield, Massachusetts', 'Springfield Nagar, Chennai', 'Springfield, Illinois']);
  });

  it('one failing instance does not fail the search (and the answer is not cached)', async () => {
    global.fetch = (async (url: string) => {
      calls.push(String(url));
      if (String(url).includes(':2323')) throw new Error('connect ECONNREFUSED');
      return { ok: true, json: async () => ({ features: [feature(80.25, 13.06, { type: 'street', street: 'Anna Salai', city: 'Chennai' })] }) };
    }) as unknown as typeof fetch;
    const svc = new GeocodingService({} as never);
    expect((await svc.search('Anna Salai')).map((h) => h.label)).toEqual(['Anna Salai, Chennai']);
    await svc.search('Anna Salai');
    expect(calls).toHaveLength(4);
  });

  it('coordinates: one exact hit, labelled by reverse geocoding of the containing instance; nothing sent to search', async () => {
    global.fetch = (async (url: string) => {
      calls.push(String(url));
      return { ok: true, json: async () => ({ features: [{ properties: { name: 'Empire State Building', city: 'New York', state: 'New York' } }] }) };
    }) as unknown as typeof fetch;
    const prisma = { addressCache: { findUnique: async () => null, upsert: async () => ({}) } };
    const svc = new GeocodingService(prisma as never);
    expect(await svc.search('40.7484N 73.9857W')).toEqual([{ label: 'Empire State Building, New York', lat: 40.7484, lng: -73.9857, confidence: 1, matchType: 'coordinates' }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/^http:\/\/127\.0\.0\.1:2323\/reverse\?lat=40\.7484&lon=-73\.9857/);
    // Outside every bbox: no request, the formatted coordinates.
    expect(await svc.search('51.5, -0.12')).toEqual([{ label: '51.500000, -0.120000', lat: 51.5, lng: -0.12, confidence: 1, matchType: 'coordinates' }]);
    expect(calls).toHaveLength(1);
  });

  it('mergeHits dedupes the same place found twice and keeps the limit', () => {
    const h = (label: string, lat: number, lng: number, confidence: number | null): GeocodeHit => ({ label, lat, lng, confidence, matchType: null });
    const merged = mergeHits([[h('A, X', 1, 1, 0.6), h('B', 2, 2, null)], [h('a, x', 1.0001, 1.0001, 0.6), h('C', 3, 3, 0.9)]], undefined, 3);
    expect(merged.map((m) => m.label)).toEqual(['C', 'A, X', 'B']);
  });
});

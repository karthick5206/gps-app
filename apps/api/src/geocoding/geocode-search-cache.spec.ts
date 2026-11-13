import { GEOCODE_LIMITS } from '@veetracer/shared';
import { GeocodeSearchCache, GeocodingService, geocodeCacheKey } from './geocoding.service';

/** v1.15.1 type-ahead: repeated searches (same normalised query, same near-point bucket) do not reach Photon again. */
describe('geocode search cache', () => {
  const saved = { g: process.env.GEOCODER, u: process.env.GEOCODER_URL };
  const realFetch = global.fetch;
  let calls: string[];

  beforeEach(() => {
    process.env.GEOCODER = 'photon';
    process.env.GEOCODER_URL = 'http://127.0.0.1:2322';
    calls = [];
    global.fetch = (async (url: string) => {
      calls.push(String(url));
      return { ok: true, json: async () => ({ features: [{ geometry: { coordinates: [80.25, 13.06] }, properties: { type: 'street', street: 'Anna Salai', city: 'Chennai' } }] }) };
    }) as unknown as typeof fetch;
  });
  afterEach(() => {
    global.fetch = realFetch;
    if (saved.g === undefined) delete process.env.GEOCODER;
    else process.env.GEOCODER = saved.g;
    if (saved.u === undefined) delete process.env.GEOCODER_URL;
    else process.env.GEOCODER_URL = saved.u;
  });

  it('keys on the normalised query and a coarse near-point bucket', () => {
    expect(geocodeCacheKey('  Anna   SALAI ')).toBe(geocodeCacheKey('anna salai'));
    expect(geocodeCacheKey('anna salai', { lat: 13.061, lng: 80.249 })).toBe(geocodeCacheKey('anna salai', { lat: 13.07, lng: 80.21 }));
    expect(geocodeCacheKey('anna salai', { lat: 13.061, lng: 80.249 })).not.toBe(geocodeCacheKey('anna salai', { lat: 12.9, lng: 77.6 }));
    expect(geocodeCacheKey('anna salai')).not.toBe(geocodeCacheKey('anna salai', { lat: 13.06, lng: 80.25 }));
  });

  it('a repeated search is answered from the cache; another bucket or query asks Photon', async () => {
    const svc = new GeocodingService({} as never);
    const first = await svc.search('Anna Salai');
    expect(first).toHaveLength(1);
    expect(await svc.search('  anna  salai ')).toEqual(first);
    expect(calls).toHaveLength(1);
    await svc.search('Anna Salai', { lat: 13.06, lng: 80.25 });
    await svc.search('Anna Sala');
    expect(calls).toHaveLength(3);
  });

  it('failed lookups are not cached', async () => {
    const svc = new GeocodingService({} as never);
    global.fetch = (async () => ({ ok: false, json: async () => ({}) })) as unknown as typeof fetch;
    expect(await svc.search('Anna Salai')).toEqual([]);
    global.fetch = (async (url: string) => {
      calls.push(String(url));
      return { ok: true, json: async () => ({ features: [] }) };
    }) as unknown as typeof fetch;
    await svc.search('Anna Salai');
    expect(calls).toHaveLength(1);
  });

  it('entries expire after the TTL and the cache keeps at most cacheMaxEntries (oldest evicted)', () => {
    const c = new GeocodeSearchCache(2, 1000);
    c.set('a', [], 0);
    c.set('b', [], 10);
    expect(c.get('a', 500)).toEqual([]);
    c.set('c', [], 20); // evicts the least recently used: b (a was just read)
    expect(c.get('b', 30)).toBeUndefined();
    expect(c.get('a', 999)).toEqual([]);
    expect(c.get('a', 1001)).toBeUndefined();
    expect(GEOCODE_LIMITS).toMatchObject({ perUserPerMinute: 60, minChars: 3, cacheTtlMs: 600_000 });
  });
});

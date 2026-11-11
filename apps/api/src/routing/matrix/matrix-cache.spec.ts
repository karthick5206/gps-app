import { decodeCell, decodeSnap, encodeCell, encodeSnap, MatrixCache, round5, roundPoint } from './matrix-cache';
import { MemoryCacheClient } from './testing/matrix-test-kit';

const A = { lat: 13.08271, lng: 80.27069 };
const B = { lat: 12.97161, lng: 77.59456 };

describe('cell / snap encoding', () => {
  it('round-trips numbers at ms / dm precision and no-route', () => {
    expect(decodeCell(encodeCell({ kind: 'ok', s: 123.4567, m: 4567.89 }))).toEqual({ kind: 'ok', s: 123.457, m: 4567.9 });
    expect(decodeCell(encodeCell({ kind: 'noroute' }))).toEqual({ kind: 'noroute' });
    expect(encodeCell({ kind: 'unknown', reason: 'ENGINE_TIMEOUT', message: 'x' })).toBeNull(); // never cached
    expect(decodeCell(null)).toBeNull();
    expect(decodeCell('garbage')).toBeNull();
  });

  it('round-trips snap answers', () => {
    for (const s of [{ kind: 'ok' as const, snapDistanceM: 12.3 }, { kind: 'ok' as const, snapDistanceM: null }, { kind: 'nopoint' as const }, { kind: 'outside' as const }]) {
      expect(decodeSnap(encodeSnap(s))).toEqual(s);
    }
    expect(decodeSnap('zz')).toBeNull();
    expect(decodeSnap(null)).toBeNull();
  });

  it('rounds coordinates to 5 decimals', () => {
    expect(round5(13.082714999)).toBe(13.08271);
    expect(roundPoint({ lat: 1.000004, lng: 2.000006 })).toEqual({ lat: 1, lng: 2.00001 });
  });
});

describe('MatrixCache keys', () => {
  const cache = new MatrixCache(new MemoryCacheClient(), 'secret-one', 60, 100);

  it('carries no coordinates or graph name in the clear', () => {
    const k = cache.cellKey('gh-11.1|2026-11-01|2026-11-10', 'car', A, B);
    expect(k).toMatch(/^vt:etms:mx:[A-Za-z0-9_-]{8}:c:[A-Za-z0-9_-]{20}$/);
    expect(k).not.toMatch(/13\.08|80\.27|gh-11/);
    expect(cache.snapKey('gv', 'car', A)).toMatch(/^vt:etms:mx:[A-Za-z0-9_-]{8}:s:[A-Za-z0-9_-]{20}$/);
  });

  it('is stable for the same input and differs by direction, graph version, profile and secret', () => {
    const k = cache.cellKey('gv1', 'car', A, B);
    expect(cache.cellKey('gv1', 'car', { lat: 13.082714, lng: 80.270694 }, B)).toBe(k); // same after rounding
    expect(cache.cellKey('gv1', 'car', B, A)).not.toBe(k);
    expect(cache.cellKey('gv2', 'car', A, B)).not.toBe(k);
    expect(cache.cellKey('gv1', 'foot', A, B)).not.toBe(k);
    expect(new MatrixCache(null, 'secret-two', 60, 100).cellKey('gv1', 'car', A, B)).not.toBe(k);
  });

  it('uses a random per-process key when no secret is configured', () => {
    const a = new MatrixCache(null, null, 60, 100);
    const b = new MatrixCache(null, null, 60, 100);
    expect(a.ephemeralKey).toBe(true);
    expect(a.cellKey('g', 'car', A, B)).not.toBe(b.cellKey('g', 'car', A, B));
  });
});

describe('MatrixCache storage', () => {
  it('stores with TTL, reads back, and counts hits', async () => {
    const client = new MemoryCacheClient();
    const cache = new MatrixCache(client, 's', 3600, 100);
    const k = cache.cellKey('g', 'car', A, B);
    expect(await cache.put('g', [[k, encodeCell({ kind: 'ok', s: 10, m: 100 })!]])).toBe(1);
    expect(client.ttl.get(k)).toBe(3600);
    expect(client.ttl.get(cache.counterKey('g'))).toBe(3600);
    expect(await cache.getCells([k, 'missing'])).toEqual([{ kind: 'ok', s: 10, m: 100 }, null]);
    expect(cache.counters.hits).toBe(1);
  });

  it('stops writing at the per-graph cell cap and flags it', async () => {
    const client = new MemoryCacheClient();
    const cache = new MatrixCache(client, 's', 60, 3);
    const entries: [string, string][] = Array.from({ length: 5 }, (_, i) => [`k${i}`, 'x']);
    expect(await cache.put('g', entries)).toBe(3);
    expect(cache.counters.full).toBe(true);
    expect(await cache.put('g', [['k9', 'x']])).toBe(0);
    expect(client.data.has('k9')).toBe(false);
    expect(await cache.put('other-graph', [['k9', 'x']])).toBe(1); // the cap is per graph version
  });

  it('turns every Valkey error into a miss / no write', async () => {
    const client = new MemoryCacheClient();
    client.fail = true;
    const cache = new MatrixCache(client, 's', 60, 10);
    expect(await cache.getCells(['a', 'b'])).toEqual([null, null]);
    expect(await cache.getSnaps(['a'])).toEqual([null]);
    expect(await cache.put('g', [['a', 'x']])).toBe(0);
    expect(cache.counters.errors).toBe(3);
  });

  it('is disabled without a client or with a zero cap', async () => {
    expect(new MatrixCache(null, 's', 60, 10).enabled).toBe(false);
    expect(new MatrixCache(new MemoryCacheClient(), 's', 60, 0).enabled).toBe(false);
    expect(await new MatrixCache(null, 's', 60, 10).getCells(['a'])).toEqual([null]);
  });
});

import type { CacheClient } from '../matrix-cache';
import { MatrixCache } from '../matrix-cache';
import { MatrixConfig, readMatrixConfig } from '../matrix-config';
import { GraphHopperMatrixEngine } from '../gh-matrix-client';
import { MatrixBuilder } from '../matrix-builder';
import { MatrixMetrics } from '../matrix-metrics';
import type { MatrixPoint } from '../matrix-types';

/** In-memory CacheClient (Valkey subset) with TTL bookkeeping and a failure switch. */
export class MemoryCacheClient implements CacheClient {
  readonly data = new Map<string, string>();
  readonly ttl = new Map<string, number>();
  fail = false;
  private check() {
    if (this.fail) throw new Error('valkey down');
  }
  async mget(keys: string[]) {
    this.check();
    return keys.map((k) => this.data.get(k) ?? null);
  }
  async setMany(entries: [string, string][], ttlSec: number) {
    this.check();
    for (const [k, v] of entries) {
      this.data.set(k, v);
      this.ttl.set(k, ttlSec);
    }
  }
  async incrby(key: string, n: number) {
    this.check();
    const v = Number(this.data.get(key) ?? 0) + n;
    this.data.set(key, String(v));
    return v;
  }
  async expire(key: string, sec: number) {
    this.check();
    this.ttl.set(key, sec);
    return 1;
  }
  async get(key: string) {
    this.check();
    return this.data.get(key) ?? null;
  }
}

export function testConfig(over: Partial<MatrixConfig> = {}): MatrixConfig {
  return {
    ...readMatrixConfig({ ETMS_ROUTING: 'on' }),
    budgetMs: 20_000,
    cacheSecret: 'test-secret-for-matrix-cache-keys',
    ...over,
  };
}

export function testBuilder(url: string, over: Partial<MatrixConfig> = {}, client: CacheClient | null = new MemoryCacheClient()) {
  const config = testConfig(over);
  const cache = new MatrixCache(client, config.cacheSecret, config.cacheTtlSec, config.cacheMaxCells);
  const builder = new MatrixBuilder(config, { engine: new GraphHopperMatrixEngine(url) }, cache, new MatrixMetrics());
  return { builder, cache, config, client };
}

/** Deterministic synthetic points around a centre (no real addresses): a jittered grid ~4 km wide. */
export function syntheticPoints(n: number, centre: MatrixPoint = { lat: 13.0827, lng: 80.2707 }, spanDeg = 0.04, seed = 7): MatrixPoint[] {
  let x = seed;
  const rnd = () => {
    x = (x * 1103515245 + 12345) % 2 ** 31;
    return x / 2 ** 31;
  };
  return Array.from({ length: n }, () => ({
    lat: Math.round((centre.lat + (rnd() - 0.5) * spanDeg) * 1e5) / 1e5,
    lng: Math.round((centre.lng + (rnd() - 0.5) * spanDeg) * 1e5) / 1e5,
  }));
}

/**
 * Graph-versioned Valkey cache for matrix cells and snap results.
 *
 * - Keys: `vt:etms:mx:<graph tag>:<c|s>:<hash>`. The graph tag and the hash are HMAC-SHA256 (keyed by
 *   ETMS_ROUTING_CACHE_SECRET, else derived from JWT_SECRET) truncated and base64url-encoded, so no coordinate, home
 *   location or graph name is readable from a key (doc 10: pickup points are personal data). A new graph version
 *   (re-import) gives new keys; old ones expire by TTL.
 * - Values: `<ms>,<dm>` (time in ms, distance in decimetres) or `x` (the engine answered: no route). Snap: `d<dm>`,
 *   `d` (snapped, distance unknown), `x` (not on road), `o` (outside the graph). Unknown answers (engine down, slow)
 *   are never cached.
 * - Memory cap: a per-graph-version counter of cells written; once it reaches ETMS_MATRIX_CACHE_MAX_CELLS the cache
 *   becomes read-only until keys expire (≈ 150 B per cell → 200k cells ≈ 30 MB).
 * - Every Valkey error is a cache miss: the cache can slow nothing down and fail nothing.
 */
import { createHmac, randomBytes } from 'crypto';
import type Redis from 'ioredis';
import type { RoutingProfile } from '../provider/routing-provider';
import type { CellOutcome, MatrixPoint } from './matrix-types';

export interface CacheClient {
  mget(keys: string[]): Promise<(string | null)[]>;
  setMany(entries: [string, string][], ttlSec: number): Promise<void>;
  incrby(key: string, n: number): Promise<number>;
  expire(key: string, sec: number): Promise<unknown>;
  get(key: string): Promise<string | null>;
}

export function redisCacheClient(redis: Redis): CacheClient {
  return {
    mget: (keys) => (keys.length ? redis.mget(keys) : Promise.resolve([])),
    setMany: async (entries, ttlSec) => {
      if (!entries.length) return;
      const p = redis.pipeline();
      for (const [k, v] of entries) p.set(k, v, 'EX', ttlSec);
      await p.exec();
    },
    incrby: (key, n) => redis.incrby(key, n),
    expire: (key, sec) => redis.expire(key, sec),
    get: (key) => redis.get(key),
  };
}

export type SnapCached = { kind: 'ok'; snapDistanceM: number | null } | { kind: 'nopoint' } | { kind: 'outside' };

export const CACHE_PREFIX = 'vt:etms:mx:';
const MGET_BATCH = 500;
const SET_BATCH = 500;

/** Coordinates are rounded to 5 decimals (≈ 1.1 m) for both the request and the key, so the key matches what was asked. */
export const round5 = (v: number): number => Math.round(v * 1e5) / 1e5;
export const roundPoint = (p: MatrixPoint): MatrixPoint => ({ lat: round5(p.lat), lng: round5(p.lng) });

export function encodeCell(o: CellOutcome): string | null {
  if (o.kind === 'noroute') return 'x';
  if (o.kind === 'ok') return `${Math.round(o.s * 1000)},${Math.round(o.m * 10)}`;
  return null;
}

export function decodeCell(v: string | null): CellOutcome | null {
  if (v === null) return null;
  if (v === 'x') return { kind: 'noroute' };
  const m = /^(\d+),(\d+)$/.exec(v);
  return m ? { kind: 'ok', s: Number(m[1]) / 1000, m: Number(m[2]) / 10 } : null;
}

export function encodeSnap(s: SnapCached): string {
  if (s.kind === 'nopoint') return 'x';
  if (s.kind === 'outside') return 'o';
  return s.snapDistanceM === null ? 'd' : `d${Math.round(s.snapDistanceM * 10)}`;
}

export function decodeSnap(v: string | null): SnapCached | null {
  if (v === null) return null;
  if (v === 'x') return { kind: 'nopoint' };
  if (v === 'o') return { kind: 'outside' };
  if (v === 'd') return { kind: 'ok', snapDistanceM: null };
  const m = /^d(\d+)$/.exec(v);
  return m ? { kind: 'ok', snapDistanceM: Number(m[1]) / 10 } : null;
}

export interface CacheCounters {
  hits: number;
  writes: number;
  full: boolean;
  errors: number;
}

export class MatrixCache {
  private readonly key: Buffer;
  /** True when no secret was configured: keys are per-process random, so nothing is shared or reused after restart. */
  readonly ephemeralKey: boolean;
  readonly counters: CacheCounters = { hits: 0, writes: 0, full: false, errors: 0 };

  constructor(
    private readonly client: CacheClient | null,
    secret: string | null,
    private readonly ttlSec: number,
    private readonly maxCells: number,
  ) {
    this.ephemeralKey = !secret;
    this.key = secret ? createHmac('sha256', secret).update('etms-matrix-cache-v1').digest() : randomBytes(32);
  }

  get enabled(): boolean {
    return this.client !== null && this.maxCells > 0;
  }

  private h(input: string, bytes: number): string {
    return createHmac('sha256', this.key).update(input).digest().subarray(0, bytes).toString('base64url');
  }

  graphTag(graphVersion: string): string {
    return this.h(`g|${graphVersion}`, 6);
  }

  cellKey(graphVersion: string, profile: RoutingProfile, a: MatrixPoint, b: MatrixPoint): string {
    return `${CACHE_PREFIX}${this.graphTag(graphVersion)}:c:${this.h(`${profile}|${round5(a.lat)},${round5(a.lng)}|${round5(b.lat)},${round5(b.lng)}`, 15)}`;
  }

  snapKey(graphVersion: string, profile: RoutingProfile, p: MatrixPoint): string {
    return `${CACHE_PREFIX}${this.graphTag(graphVersion)}:s:${this.h(`${profile}|${round5(p.lat)},${round5(p.lng)}`, 15)}`;
  }

  counterKey(graphVersion: string): string {
    return `${CACHE_PREFIX}${this.graphTag(graphVersion)}:n`;
  }

  private async mget(keys: string[]): Promise<(string | null)[]> {
    if (!this.client || !keys.length) return keys.map(() => null);
    const out: (string | null)[] = [];
    try {
      for (let i = 0; i < keys.length; i += MGET_BATCH) out.push(...(await this.client.mget(keys.slice(i, i + MGET_BATCH))));
      return out;
    } catch {
      this.counters.errors++;
      return keys.map(() => null);
    }
  }

  async getCells(keys: string[]): Promise<(CellOutcome | null)[]> {
    const raw = await this.mget(keys);
    const out = raw.map(decodeCell);
    this.counters.hits += out.filter(Boolean).length;
    return out;
  }

  async getSnaps(keys: string[]): Promise<(SnapCached | null)[]> {
    return (await this.mget(keys)).map(decodeSnap);
  }

  /** Stores entries unless the per-graph cap is reached; returns how many were written. */
  async put(graphVersion: string, entries: [string, string][]): Promise<number> {
    if (!this.client || !entries.length || this.maxCells <= 0) return 0;
    try {
      const counter = this.counterKey(graphVersion);
      const before = Number((await this.client.get(counter)) ?? 0);
      if (before >= this.maxCells) {
        this.counters.full = true;
        return 0;
      }
      const room = Math.min(entries.length, this.maxCells - before);
      if (room < entries.length) this.counters.full = true;
      const take = entries.slice(0, room);
      for (let i = 0; i < take.length; i += SET_BATCH) await this.client.setMany(take.slice(i, i + SET_BATCH), this.ttlSec);
      await this.client.incrby(counter, take.length);
      await this.client.expire(counter, this.ttlSec);
      this.counters.writes += take.length;
      return take.length;
    } catch {
      this.counters.errors++;
      return 0;
    }
  }
}

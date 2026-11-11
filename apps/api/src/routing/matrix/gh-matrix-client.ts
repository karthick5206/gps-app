/**
 * The GraphHopper requests the matrix builder needs (open-source GraphHopper 11 has no `/matrix`: that is the
 * commercial Directions API, doc 06 §2.2). Everything goes through `GET /route` with the car CH profile:
 *
 * - pair  `point=a&point=b&calc_points=false&instructions=false`: one cell; the cheapest single request.
 * - walk  `point=p0&…&point=pk&details=leg_time&details=leg_distance`: k cells in one request. With CH each leg
 *         between via points is its own shortest-path query, and GraphHopper reports per-leg time and distance as path
 *         details. Path details need `calc_points=true`. The builder checks a sample of walk legs against pair answers
 *         before it trusts walks for a graph version (matrix-builder.ts), and falls back to pairs when the details are
 *         missing or merged.
 * - snap  `point=p&point=p&calc_points=true&points_encoded=false`: a zero-length route that returns the snapped
 *         waypoint with the same profile and snap preventions as every matrix request (no separate `/nearest`
 *         semantics: `/nearest` ignores the profile).
 *
 * Error mapping (GraphHopper 11 JSON errors): 400 "Cannot find point N" (hints[].point_index) → point not on road;
 * 400 "Connection between locations not found" → no route; 400 "out of bounds" → outside coverage; other 400 →
 * unknown (never a no-route); 5xx / connection error → ENGINE_UNREACHABLE; timeout → ENGINE_TIMEOUT.
 */
import type { DegradedReason, RoutingProfile } from '../provider/routing-provider';
import type { MatrixPoint } from './matrix-types';
import { haversineMeters } from '../../tracking/geo';
import { transportErrorText } from '../engine-text';

export type EngineFailure = { kind: 'failure'; reason: DegradedReason; message: string; transport: boolean };

export type PairAnswer = { kind: 'ok'; s: number; m: number } | { kind: 'noroute' } | { kind: 'nopoint'; pointIndex: number | null } | EngineFailure;

export type WalkAnswer =
  | { kind: 'ok'; legs: { s: number; m: number }[] }
  /** The engine answered but without usable per-leg details (feature missing, merged entries): use pairs. */
  | { kind: 'nodetails'; message: string }
  | { kind: 'noroute' }
  | { kind: 'nopoint'; pointIndex: number | null }
  | EngineFailure;

export type SnapAnswer = { kind: 'ok'; snapDistanceM: number | null } | { kind: 'nopoint' } | { kind: 'outside' } | EngineFailure;

export interface EngineInfo {
  version: string | null;
  dataDate: string | null;
  importDate: string | null;
  profiles: string[];
}

export interface MatrixEngine {
  pair(a: MatrixPoint, b: MatrixPoint, profile: RoutingProfile, signal?: AbortSignal): Promise<PairAnswer>;
  walk(points: MatrixPoint[], profile: RoutingProfile, signal?: AbortSignal): Promise<WalkAnswer>;
  snap(p: MatrixPoint, profile: RoutingProfile, signal?: AbortSignal): Promise<SnapAnswer>;
  info(signal?: AbortSignal): Promise<EngineInfo | EngineFailure>;
  health(signal?: AbortSignal): Promise<{ ok: true; latencyMs: number } | EngineFailure>;
}

export const PAIR_TIMEOUT_MS = 3000;
export const SNAP_TIMEOUT_MS = 3000;
export const INFO_TIMEOUT_MS = 3000;
export const HEALTH_TIMEOUT_MS = 2000;
/** Walk timeout grows with its legs (CH ≈ 2–10 ms per leg, doc 06 §2.2 Estimate), capped. */
export const walkTimeoutMs = (legs: number): number => Math.min(20_000, 2000 + 100 * legs);

const pt = (p: MatrixPoint) => `${p.lat},${p.lng}`;

/**
 * Runs `fn` with a signal that aborts after `timeoutMs` or when `outer` aborts. One controller per request, and the
 * listener on `outer` is removed afterwards: `AbortSignal.any` with a long-lived build signal keeps every request's
 * composite signal as a dependent, which made a 200-point pairwise build CPU-bound (measured: 27 s of Node CPU).
 */
export async function withTimeout<T>(timeoutMs: number, outer: AbortSignal | undefined, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new DOMException('The operation timed out.', 'TimeoutError')), timeoutMs);
  const onAbort = () => ac.abort(outer?.reason);
  if (outer?.aborted) onAbort();
  else outer?.addEventListener('abort', onAbort, { once: true });
  try {
    return await fn(ac.signal);
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener('abort', onAbort);
  }
}

export function thrownFailure(error: unknown): EngineFailure {
  const name = (error as { name?: string } | null)?.name;
  if (name === 'TimeoutError') return { kind: 'failure', reason: 'ENGINE_TIMEOUT', message: 'GraphHopper did not answer in time', transport: true };
  if (name === 'AbortError') return { kind: 'failure', reason: 'LIMIT_EXCEEDED', message: 'Matrix build cancelled', transport: false };
  // L4: the error class / code only, never the error text (it may hold the request URL with its points).
  return { kind: 'failure', reason: 'ENGINE_UNREACHABLE', message: `GraphHopper unreachable (${transportErrorText(error)})`, transport: true };
}

type GhError = { message?: unknown; hints?: { message?: unknown; details?: unknown; point_index?: unknown }[] };

/** Classifies a non-2xx GraphHopper answer. */
export function classifyError(status: number, body: GhError | null): { kind: 'noroute' } | { kind: 'nopoint'; pointIndex: number | null } | { kind: 'outside' } | EngineFailure {
  const message = typeof body?.message === 'string' ? body.message : '';
  if (status === 400) {
    const hintIndex = body?.hints?.find((h) => typeof h?.point_index === 'number')?.point_index as number | undefined;
    const m = /cannot find point (\d+)/i.exec(message);
    if (m || /PointNotFound/.test(String(body?.hints?.[0]?.details ?? ''))) {
      return { kind: 'nopoint', pointIndex: hintIndex ?? (m ? Number(m[1]) : null) };
    }
    if (/out of bounds/i.test(message)) return { kind: 'outside' };
    if (/connection between locations not found/i.test(message) || /ConnectionNotFound/.test(String(body?.hints?.[0]?.details ?? ''))) {
      return { kind: 'noroute' };
    }
    // e.g. maximum visited nodes, too many points, points too far apart: not a proof that no route exists. L4: the
    // engine text is classified, never forwarded (it can quote a point: "… too far from Point 2: 13.08,80.26").
    return { kind: 'failure', reason: 'LIMIT_EXCEEDED', message: 'GraphHopper refused the request (engine limit or invalid request; HTTP 400)', transport: false };
  }
  return { kind: 'failure', reason: 'ENGINE_UNREACHABLE', message: `GraphHopper returned HTTP ${status}`, transport: true };
}

type GhPath = {
  distance?: unknown;
  time?: unknown;
  details?: Record<string, unknown>;
  snapped_waypoints?: { coordinates?: unknown };
};

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/** Per-leg values from a `leg_time` / `leg_distance` path detail; null when the entry count does not match. */
export function legDetail(detail: unknown, legs: number): number[] | null {
  if (!Array.isArray(detail) || detail.length !== legs) return null;
  const out: number[] = [];
  for (const e of detail) {
    if (!Array.isArray(e) || e.length < 3 || !num(e[2])) return null;
    out.push(e[2]);
  }
  return out;
}

export class GraphHopperMatrixEngine implements MatrixEngine {
  constructor(private readonly baseUrl: string) {}

  private query(profile: RoutingProfile, points: MatrixPoint[], extra: Record<string, string | string[]>): string {
    const q = new URLSearchParams({ profile });
    for (const p of points) q.append('point', pt(p));
    for (const [k, v] of Object.entries(extra)) for (const x of Array.isArray(v) ? v : [v]) q.append(k, x);
    return `${this.baseUrl}/route?${q.toString()}`;
  }

  private async get(url: string, timeoutMs: number, signal?: AbortSignal): Promise<{ ok: true; json: unknown } | { ok: false; status: number; body: GhError | null } | EngineFailure> {
    return withTimeout(timeoutMs, signal, async (s) => {
      let res: Response;
      try {
        res = await fetch(url, { signal: s });
      } catch (error) {
        return thrownFailure(error);
      }
      let json: unknown = null;
      try {
        json = await res.json();
      } catch (error) {
        const name = (error as { name?: string })?.name;
        if (name === 'TimeoutError' || name === 'AbortError') return thrownFailure(error);
        if (res.ok) return { kind: 'failure', reason: 'ENGINE_UNREACHABLE', message: 'GraphHopper answer is not JSON', transport: true } as EngineFailure;
      }
      if (!res.ok) return { ok: false as const, status: res.status, body: json as GhError | null };
      return { ok: true as const, json };
    });
  }

  async pair(a: MatrixPoint, b: MatrixPoint, profile: RoutingProfile, signal?: AbortSignal): Promise<PairAnswer> {
    const r = await this.get(this.query(profile, [a, b], { calc_points: 'false', instructions: 'false' }), PAIR_TIMEOUT_MS, signal);
    if ('kind' in r) return r;
    if (!r.ok) {
      const c = classifyError(r.status, r.body);
      return c.kind === 'outside' ? { kind: 'nopoint', pointIndex: null } : c;
    }
    const path = ((r.json as { paths?: GhPath[] } | null)?.paths ?? [])[0];
    if (!path || !num(path.distance) || !num(path.time)) return { kind: 'failure', reason: 'ENGINE_UNREACHABLE', message: 'GraphHopper answer has no path', transport: false };
    return { kind: 'ok', s: path.time / 1000, m: path.distance };
  }

  async walk(points: MatrixPoint[], profile: RoutingProfile, signal?: AbortSignal): Promise<WalkAnswer> {
    const legs = points.length - 1;
    const url = this.query(profile, points, {
      calc_points: 'true',
      points_encoded: 'true',
      instructions: 'false',
      details: ['leg_time', 'leg_distance'],
    });
    const r = await this.get(url, walkTimeoutMs(legs), signal);
    if ('kind' in r) return r;
    if (!r.ok) {
      const c = classifyError(r.status, r.body);
      return c.kind === 'outside' ? { kind: 'nopoint', pointIndex: null } : c;
    }
    const path = ((r.json as { paths?: GhPath[] } | null)?.paths ?? [])[0];
    if (!path) return { kind: 'failure', reason: 'ENGINE_UNREACHABLE', message: 'GraphHopper answer has no path', transport: false };
    const t = legDetail(path.details?.leg_time, legs);
    const d = legDetail(path.details?.leg_distance, legs);
    if (!t || !d) return { kind: 'nodetails', message: `leg_time / leg_distance details missing or not one entry per leg (${legs} legs)` };
    return { kind: 'ok', legs: t.map((ms, i) => ({ s: ms / 1000, m: d[i] })) };
  }

  async snap(p: MatrixPoint, profile: RoutingProfile, signal?: AbortSignal): Promise<SnapAnswer> {
    const url = this.query(profile, [p, p], { calc_points: 'true', points_encoded: 'false', instructions: 'false' });
    const r = await this.get(url, SNAP_TIMEOUT_MS, signal);
    if ('kind' in r) return r;
    if (!r.ok) {
      const c = classifyError(r.status, r.body);
      if (c.kind === 'nopoint') return { kind: 'nopoint' };
      if (c.kind === 'outside') return { kind: 'outside' };
      if (c.kind === 'noroute') return { kind: 'ok', snapDistanceM: null }; // snapped; a self-route is unusual but fine
      return c;
    }
    const coords = ((r.json as { paths?: GhPath[] } | null)?.paths ?? [])[0]?.snapped_waypoints?.coordinates;
    const first = Array.isArray(coords) ? coords[0] : null;
    if (!Array.isArray(first) || typeof first[0] !== 'number' || typeof first[1] !== 'number') return { kind: 'ok', snapDistanceM: null };
    return { kind: 'ok', snapDistanceM: Math.round(haversineMeters(p.lat, p.lng, first[1], first[0]) * 10) / 10 };
  }

  async info(signal?: AbortSignal): Promise<EngineInfo | EngineFailure> {
    const r = await this.get(`${this.baseUrl}/info`, INFO_TIMEOUT_MS, signal);
    if ('kind' in r) return r;
    if (!r.ok) return { kind: 'failure', reason: 'ENGINE_UNREACHABLE', message: `GraphHopper /info returned ${r.status}`, transport: true };
    const j = (r.json ?? {}) as { version?: unknown; data_date?: unknown; import_date?: unknown; profiles?: { name?: unknown }[] };
    const s = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
    return {
      version: s(j.version),
      dataDate: s(j.data_date),
      importDate: s(j.import_date),
      profiles: (Array.isArray(j.profiles) ? j.profiles : []).map((p) => p?.name).filter((n): n is string => typeof n === 'string'),
    };
  }

  async health(signal?: AbortSignal): Promise<{ ok: true; latencyMs: number } | EngineFailure> {
    const started = Date.now();
    return withTimeout(HEALTH_TIMEOUT_MS, signal, async (s): Promise<{ ok: true; latencyMs: number } | EngineFailure> => {
      try {
        const res = await fetch(`${this.baseUrl}/health`, { signal: s });
        await res.text().catch(() => '');
        if (res.ok) return { ok: true, latencyMs: Date.now() - started };
        return { kind: 'failure', reason: 'ENGINE_UNREACHABLE', message: `GraphHopper /health returned ${res.status}`, transport: true };
      } catch (error) {
        return thrownFailure(error);
      }
    });
  }
}

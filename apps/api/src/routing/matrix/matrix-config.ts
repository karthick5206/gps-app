/**
 * Matrix settings (env). Everything is off unless `ETMS_ROUTING=on` (and the ETMS master switch `ETMS` is not `off`).
 * Defaults are sized for the shared 6-vCPU production host (doc 17 R-5, doc 06 §7): GraphHopper answers one request
 * per Jetty thread on one core, so 3 matrix requests in flight use at most half the cores and leave the rest to the
 * tracker ETAs, map matching, PostgreSQL and the API.
 */

export type MatrixStrategy = 'auto' | 'walk' | 'pairwise';

export interface MatrixConfig {
  enabled: boolean;
  /** Max engine requests in flight for all matrix builds of this process (adaptive: lowered when the engine is slow). */
  concurrency: number;
  /** Matrix builds running at once in this process; more wait in a queue of `queue`, beyond that LIMIT_EXCEEDED. */
  maxBuilds: number;
  queue: number;
  /** Default total budget per build. */
  budgetMs: number;
  /** Legs per multi-point walk request. */
  legsPerRequest: number;
  strategy: MatrixStrategy;
  /** Per-leg latency above which the concurrency limit is halved, and below which it may grow again. */
  slowLegMs: number;
  fastLegMs: number;
  /** Consecutive engine failures (timeouts, connection errors, 5xx) that stop a build. */
  failLimit: number;
  maxPoints: number;
  maxSnapDistanceM: number;
  cacheTtlSec: number;
  /** Cap on cells stored per graph version (≈ 150 B each in Valkey → 200k ≈ 30 MB). */
  cacheMaxCells: number;
  /** Fixed graph version (else read from the engine's /info). */
  graphVersion: string | null;
  /** HMAC key for cache keys (coordinates are never stored in the clear). */
  cacheSecret: string | null;
}

const int = (v: string | undefined, def: number, min: number, max: number): number => {
  const n = Number.parseInt((v ?? '').trim(), 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};

export function etmsRoutingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if ((env.ETMS ?? '').trim().toLowerCase() === 'off') return false;
  return ['on', '1', 'true'].includes((env.ETMS_ROUTING ?? '').trim().toLowerCase());
}

export function readMatrixConfig(env: NodeJS.ProcessEnv = process.env): MatrixConfig {
  const strategy = (env.ETMS_MATRIX_STRATEGY ?? 'auto').trim().toLowerCase();
  return {
    enabled: etmsRoutingEnabled(env),
    concurrency: int(env.ETMS_MATRIX_CONCURRENCY, 3, 1, 8),
    maxBuilds: int(env.ETMS_MATRIX_MAX_BUILDS, 2, 1, 4),
    queue: int(env.ETMS_MATRIX_QUEUE, 8, 0, 64),
    budgetMs: int(env.ETMS_MATRIX_BUDGET_MS, 120_000, 1000, 900_000),
    legsPerRequest: int(env.ETMS_MATRIX_LEGS_PER_REQUEST, 50, 1, 200),
    strategy: strategy === 'walk' || strategy === 'pairwise' ? strategy : 'auto',
    slowLegMs: int(env.ETMS_MATRIX_SLOW_LEG_MS, 60, 5, 10_000),
    fastLegMs: int(env.ETMS_MATRIX_FAST_LEG_MS, 20, 1, 10_000),
    failLimit: int(env.ETMS_MATRIX_FAIL_LIMIT, 8, 1, 1000),
    maxPoints: int(env.ETMS_MATRIX_MAX_POINTS, 600, 2, 2000),
    maxSnapDistanceM: int(env.ETMS_MATRIX_MAX_SNAP_M, 500, 10, 50_000),
    cacheTtlSec: int(env.ETMS_MATRIX_CACHE_TTL_SEC, 30 * 86_400, 60, 400 * 86_400),
    cacheMaxCells: int(env.ETMS_MATRIX_CACHE_MAX_CELLS, 200_000, 0, 50_000_000),
    graphVersion: (env.ETMS_ROUTING_GRAPH_VERSION ?? '').trim() || null,
    cacheSecret: (env.ETMS_ROUTING_CACHE_SECRET ?? '').trim() || (env.JWT_SECRET ?? '').trim() || null,
  };
}

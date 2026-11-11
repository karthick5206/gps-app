import type { OptimizeUnassignedReason, RoutingProfile } from '@veetracer/shared';
import type { MatrixBuilder } from '../routing/matrix/matrix-builder';
import type { PointIssue } from '../routing/matrix/matrix-types';
import { kNearestPairs } from '../routing/matrix/sparse';
import type { DegradedReason, RoutingProvider } from '../routing/provider/routing-provider';
import type { JobErrorCode } from './job-state';

/**
 * What the optimisation worker needs from the travel-time matrix (E4-B `MatrixBuilder.buildMatrix`, WP 4.1b), as a
 * small port so the runner is testable with fakes.
 *
 * Rules (doc 06 §3, E4-B contract): only a COMPLETE build is ever solved on — there a null cell is a forbidden arc.
 * PARTIAL / UNAVAILABLE builds are never solved on: the job fails or is retried (computed cells come back from the
 * graph-versioned cache). Points the engine cannot use are excluded and reported per stop, never dropped or guessed.
 */
export interface MatrixPoint {
  lat: number;
  lng: number;
}

export interface BuiltMatrix {
  /** n × n over the given points; null = no route / excluded point / not requested (a forbidden arc). */
  durationsS: (number | null)[][];
  distancesM: (number | null)[][];
  /** Per point: distance to the road it snapped to (null when unknown); position when the engine reports it. */
  snapped: ({ snapDistanceM: number; lat?: number; lng?: number } | null)[];
  /** Points excluded from the matrix, with the reason (lower case: becomes the stop's unassigned reason). */
  invalid: { index: number; reason: OptimizeUnassignedReason }[];
  graphVersion: string | null;
  cells: { requested: number; computed: number; cached: number };
}

/** A failed build: `code` is the job error code (transient ones are retried by the worker). */
export type MatrixOutcome = { ok: true; value: BuiltMatrix } | { ok: false; degraded: JobErrorCode; message: string; retryAfterS?: number };

export interface MatrixBuildOptions {
  signal?: AbortSignal;
  /** done / total cells, for job progress. */
  onProgress?: (done: number, total: number) => Promise<void>;
  /** Indexes of depots / site (always fully connected in sparse mode). */
  depots?: number[];
}

export interface MatrixPort {
  build(points: MatrixPoint[], profile: RoutingProfile, opts?: MatrixBuildOptions): Promise<MatrixOutcome>;
}

/** Nest token of the matrix port in the worker module. */
export const MATRIX_PORT = Symbol('ROUTING_MATRIX_PORT');

/** Above this many points the matrix is sparse: k nearest neighbours per point + every depot / site leg. */
export const SPARSE_ABOVE_POINTS = 60;
export const SPARSE_K = 40;

/** Unassigned reason of an excluded point (E4-B `PointIssue`). */
export const POINT_ISSUE_REASON: Record<PointIssue, OptimizeUnassignedReason> = {
  INVALID_INPUT: 'invalid_location',
  OUTSIDE_COVERAGE: 'outside_coverage',
  POINT_NOT_ON_ROAD: 'not_on_road',
  FAR_FROM_ROAD: 'far_from_road',
  DISCONNECTED: 'unreachable_location',
  NOT_CHECKED: 'not_checked',
};

/**
 * Adapter over E4-B's MatrixBuilder. COMPLETE → the matrix; PARTIAL → MATRIX_INCOMPLETE (retried: the cache resumes);
 * UNAVAILABLE because the builder's own queue is full (LIMIT_EXCEEDED with retryAfterS) → MATRIX_BUSY (retried);
 * any other UNAVAILABLE → its degraded reason (ENGINE_UNREACHABLE / ENGINE_TIMEOUT are retried, the rest final).
 */
export function builderMatrixPort(builder: Pick<MatrixBuilder, 'buildMatrix'>): MatrixPort {
  return {
    async build(points, profile, opts = {}) {
      const pairs = points.length > SPARSE_ABOVE_POINTS ? kNearestPairs(points, SPARSE_K, opts.depots ?? [0]) : undefined;
      const b = await builder.buildMatrix(points, profile, { ...(pairs ? { pairs } : {}), signal: opts.signal, onProgress: opts.onProgress });
      if (opts.signal?.aborted) throw opts.signal.reason as Error;
      if (b.status !== 'COMPLETE') {
        const reason = b.degraded?.reason ?? 'ENGINE_UNREACHABLE';
        const message = b.degraded?.message ?? 'matrix not complete';
        if (b.status === 'PARTIAL') return { ok: false, degraded: 'MATRIX_INCOMPLETE', message: `${message} (${b.unknownCells.length} cell(s) unknown; retried, computed cells are cached)` };
        if (reason === 'LIMIT_EXCEEDED' && b.degraded?.retryAfterS !== undefined) return { ok: false, degraded: 'MATRIX_BUSY', message, retryAfterS: b.degraded.retryAfterS };
        return { ok: false, degraded: reason, message };
      }
      return {
        ok: true,
        value: {
          durationsS: b.durationsS,
          distancesM: b.distancesM,
          snapped: b.points.map((p) => (p.snapDistanceM === null ? null : { snapDistanceM: p.snapDistanceM })),
          invalid: b.points.filter((p) => p.excluded && p.issue).map((p) => ({ index: p.index, reason: POINT_ISSUE_REASON[p.issue!] })),
          graphVersion: b.graphVersion,
          cells: { requested: b.stats.requested, computed: b.stats.computed, cached: b.stats.cached },
        },
      };
    },
  };
}

const DEGRADED_REASON: Partial<Record<DegradedReason, OptimizeUnassignedReason>> = { OUTSIDE_COVERAGE: 'outside_coverage', POINT_NOT_ON_ROAD: 'not_on_road' };

/** Adapter over `RoutingProvider.matrix` (square, every pair; kept for providers without the builder). */
export function providerMatrixPort(provider: RoutingProvider): MatrixPort {
  return {
    async build(points, profile, opts) {
      const r = await provider.matrix({ sources: points, targets: points, profile }, opts?.onProgress);
      if (!r.ok) return { ok: false, degraded: r.degraded, message: r.message };
      const v = r.value;
      const invalid = new Map<number, OptimizeUnassignedReason>();
      for (const i of v.invalid) if (!invalid.has(i.index)) invalid.set(i.index, DEGRADED_REASON[i.reason] ?? 'unreachable_location');
      return {
        ok: true,
        value: {
          durationsS: v.durationsS,
          distancesM: v.distancesM,
          snapped: points.map(() => null),
          invalid: [...invalid].map(([index, reason]) => ({ index, reason })),
          graphVersion: r.eta.graphVersion,
          cells: v.cells,
        },
      };
    },
  };
}

/** Checks a matrix's shape (n × n of finite non-negative numbers or null). A malformed matrix is never used. */
export function matrixShapeProblem(m: BuiltMatrix, n: number): string | null {
  const ok = (rows: unknown) =>
    Array.isArray(rows) && rows.length === n && rows.every((row) => Array.isArray(row) && row.length === n && row.every((c) => c === null || (typeof c === 'number' && Number.isFinite(c) && c >= 0)));
  if (!ok(m.durationsS)) return 'durations are not an n × n matrix of seconds / null';
  if (!ok(m.distancesM)) return 'distances are not an n × n matrix of metres / null';
  return null;
}

import type { RoutingProfile } from '@veetracer/shared';
import type { DegradedReason, RoutingProvider } from '../routing/provider/routing-provider';

/**
 * What the optimisation worker needs from the matrix builder (E4-B, WP 4.1b, `buildMatrix(points, profile, opts)`
 * behind RoutingProvider). Kept as a small local port so the worker does not depend on the builder's internals:
 * `providerMatrixPort` adapts `RoutingProvider.matrix` today; the E4-B builder is plugged in here when it lands.
 *
 * Rules (doc 06 §3): a cell is the engine's own number or null (no road / not computed) — never an estimate; a
 * failed engine is a typed degraded reason with no numbers at all.
 */
export interface MatrixPoint {
  lat: number;
  lng: number;
}

export interface BuiltMatrix {
  /** n × n over the given points; null = no route (a forbidden arc for the solver). */
  durationsS: (number | null)[][];
  distancesM: (number | null)[][];
  /** Per point: the road-snapped position and distance, or null when unknown / not snapped. */
  snapped: ({ lat: number; lng: number; snapDistanceM: number } | null)[];
  /** Points the engine could not use (not on a road, outside coverage …). */
  invalid: { index: number; reason: DegradedReason }[];
  graphVersion: string | null;
  cells: { requested: number; computed: number; cached: number };
}

export type MatrixOutcome = { ok: true; value: BuiltMatrix } | { ok: false; degraded: DegradedReason; message: string };

export interface MatrixBuildOptions {
  signal?: AbortSignal;
  /** done / total cells, for job progress. */
  onProgress?: (done: number, total: number) => Promise<void>;
}

export interface MatrixPort {
  build(points: MatrixPoint[], profile: RoutingProfile, opts?: MatrixBuildOptions): Promise<MatrixOutcome>;
}

/** Nest token of the matrix port in the worker module. */
export const MATRIX_PORT = Symbol('ROUTING_MATRIX_PORT');

/**
 * Adapter over `RoutingProvider.matrix` (square matrix, every pair). Until E4-B's builder lands the GraphHopper
 * provider answers NOT_IMPLEMENTED, so an optimisation job fails with that reason instead of inventing numbers.
 */
export function providerMatrixPort(provider: RoutingProvider): MatrixPort {
  return {
    async build(points, profile, opts) {
      const r = await provider.matrix({ sources: points, targets: points, profile }, opts?.onProgress);
      if (!r.ok) return { ok: false, degraded: r.degraded, message: r.message };
      const v = r.value;
      const invalid = new Map<number, DegradedReason>();
      for (const i of v.invalid) if (!invalid.has(i.index)) invalid.set(i.index, i.reason);
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

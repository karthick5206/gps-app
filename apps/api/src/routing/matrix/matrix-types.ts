/**
 * Travel-time matrix types (ETMS E4 WP 4.1b, doc 17 §7 P7). Kept local to the matrix module on purpose: the shared
 * routing contracts (`packages/shared/src/routing.ts`) are written in parallel by E4-A and the Lead reconciles the two
 * when merging. Engine-neutral: nothing here names GraphHopper.
 */
import type { DegradedReason, RoutingProfile } from '../provider/routing-provider';

export interface MatrixPoint {
  lat: number;
  lng: number;
}

/** Why a point takes no part in the matrix (its row and column are null), or why it is suspicious. */
export type PointIssue =
  /** Not a finite WGS84 coordinate. */
  | 'INVALID_INPUT'
  /** Outside the India graph (check the lat/lng order). */
  | 'OUTSIDE_COVERAGE'
  /** The engine found no road near the point. */
  | 'POINT_NOT_ON_ROAD'
  /** Snapped, but farther from the road than `maxSnapDistanceM`: excluded so a wrong pickup pin is fixed, not routed. */
  | 'FAR_FROM_ROAD'
  /** Snapped, but no route to or from any other point (an island in the road graph). Row and column are null. */
  | 'DISCONNECTED'
  /** The engine did not answer the snap request (down, slow): the point is not known to be routable. */
  | 'NOT_CHECKED';

export interface PointReport {
  index: number;
  /** Distance from the input point to the road the engine snapped it to; null when not snapped. */
  snapDistanceM: number | null;
  /** null = fine. */
  issue: PointIssue | null;
  /** True when the point's row and column were not computed (all null) because of `issue`. */
  excluded: boolean;
  message?: string;
}

/** Cell value: duration in seconds (engine free-flow), distance in metres. */
export interface CellValue {
  s: number;
  m: number;
}

/** Outcome of one cell from the engine or the cache. `unknown` is never cached and never shown as a number. */
export type CellOutcome =
  | { kind: 'ok'; s: number; m: number }
  | { kind: 'noroute' }
  | { kind: 'unknown'; reason: DegradedReason; message: string };

export interface MatrixBuildOptions {
  /** Sparse mode: only these (from, to) index pairs; every other off-diagonal cell is null and `not requested`. */
  pairs?: [number, number][];
  /** Total wall-clock budget for the build; cells not computed in time are reported as unknown. */
  budgetMs?: number;
  /**
   * Absolute end (epoch ms) for the whole call, the wait for a build slot included (E4 review L3): the queue wait and
   * the build budget are both cut to it. The optimisation job passes its own deadline minus the solve's share, so a
   * queued build can no longer use up the job's time and end it with a final TIMEOUT.
   */
  deadlineAt?: number;
  /** Override of the configured snap limit (metres). */
  maxSnapDistanceM?: number;
  /** Cancels the build (e.g. job cancelled); remaining cells are unknown, reason LIMIT_EXCEEDED. */
  signal?: AbortSignal;
  /** Progress callback (cells settled / cells to settle); awaited, so keep it cheap. */
  onProgress?: (done: number, total: number) => Promise<void> | void;
  /** Skip the cache for reads (writes still happen). For benchmarks and accuracy checks. */
  noCacheRead?: boolean;
}

export type MatrixStatus =
  /** Every requested cell is a number or a confirmed no-route. */
  | 'COMPLETE'
  /** Some requested cells are unknown (engine down / slow / budget): see `unknownCells`. Safe to retry: the cache resumes. */
  | 'PARTIAL'
  /** Nothing could be computed (disabled, engine down before start, invalid input, limits). */
  | 'UNAVAILABLE';

export interface MatrixStats {
  points: number;
  /** Off-diagonal cells requested (pairs, or n × (n − 1)). */
  requested: number;
  /** Cells answered from the graph-versioned cache. */
  cached: number;
  /** Cells answered by the engine during this build (numbers and no-routes). */
  computed: number;
  /** No-route cells proven without a call: p cannot reach the anchor, which every q reaches (see matrix-builder.ts). */
  inferred: number;
  noRoute: number;
  unknown: number;
  /** Cells null because their point is excluded (not on road, outside coverage, …). */
  excluded: number;
  engineCalls: { snap: number; pair: number; walk: number };
  /** Legs answered by multi-point walk requests. */
  walkLegs: number;
  strategy: 'walk' | 'pairwise';
  cacheWrites: number;
  /** True when the cache cell cap was reached and new cells were not stored. */
  cacheFull: boolean;
  durationMs: number;
}

export interface MatrixBuild {
  status: MatrixStatus;
  /** Why the build is PARTIAL / UNAVAILABLE; null when COMPLETE. */
  degraded: { reason: DegradedReason; message: string; retryAfterS?: number } | null;
  graphVersion: string | null;
  profile: RoutingProfile;
  /**
   * n × n; diagonal 0 for included points. null = no route (engine-answered or proven), excluded point, not requested,
   * or unknown (listed in `unknownCells`). Never an estimate.
   */
  durationsS: (number | null)[][];
  distancesM: (number | null)[][];
  /** Cells that are null only because the engine did not answer: NOT forbidden arcs. Empty when COMPLETE. */
  unknownCells: [number, number][];
  points: PointReport[];
  stats: MatrixStats;
  /** Provenance (doc 06 §3): engine free-flow numbers, uncalibrated, no live traffic. */
  eta: { source: 'engine_free_flow'; calibrated: false; liveTraffic: false };
}

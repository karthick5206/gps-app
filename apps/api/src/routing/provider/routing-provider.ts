/**
 * Road-engine contract for ETMS planning, dispatch and tracking (doc 06 §3, doc 17 §7 P5). Business modules depend on
 * `RoutingProvider` only; `GraphHopperProvider` is the only implementation (README §5 D3: GraphHopper is the only road
 * engine, Valhalla is out of scope).
 *
 * Rules every implementation keeps:
 * - A failure is a typed `{ ok: false, degraded }` result. There is never a straight-line, default-speed or invented
 *   fallback number in a failed result, and no partial numbers.
 * - Every successful result carries its provenance (`EtaModel`): free-flow engine numbers, uncalibrated, no live
 *   traffic.
 * - Manual dispatch never waits on this provider; callers treat `ok: false` as "routing unavailable (reason)".
 *
 * Deviations from the doc 06 §3 sketch, kept small so the v1.8 `RoutingService` outputs stay identical:
 * - `route(from, to)` is point to point and returns the engine's raw metres / seconds (as `RoutingService.route`).
 * - `routeVia(points)` returns `RoutingService.routeVia`'s exact shape plus `estimatedLegs`, the indexes of legs that
 *   were split in proportion to straight-line length because their own `/route` call failed. ETMS must not show those
 *   legs as road numbers (doc 06 §3 degraded rule 1).
 * - `capabilities()` returns a `Result`, so a disabled or refused engine is reported instead of guessed.
 */
import type { RouteViaResult, ViaPoint } from '../route-via';

/** GeoJSON order everywhere: [lng, lat]. */
export type LngLat = [number, number];

export type Pt = ViaPoint;

export type RoutingProfile = 'car' | 'van' | 'bus' | 'foot';

/** Profiles the production GraphHopper graph has today (`ops/deploy/linux/maps/graphhopper.yml`: `car` only). */
export const AVAILABLE_PROFILES: readonly RoutingProfile[] = ['car'];

export type DegradedReason =
  | 'ENGINE_DISABLED'
  | 'ENGINE_NOT_SUPPORTED'
  | 'ENGINE_UNREACHABLE'
  | 'ENGINE_TIMEOUT'
  | 'GRAPH_REBUILDING'
  | 'PROFILE_NOT_AVAILABLE'
  | 'OUTSIDE_COVERAGE'
  | 'POINT_NOT_ON_ROAD'
  | 'NO_ROUTE'
  | 'LIMIT_EXCEEDED'
  | 'INVALID_INPUT'
  | 'NOT_IMPLEMENTED';

/** Provenance of every number a user may see. */
export interface EtaModel {
  source: 'engine_free_flow' | 'engine_calibrated' | 'live_heuristic';
  calibrated: boolean;
  liveTraffic: false;
  /** OSM extract date + engine version (e.g. "gh-11.1/2026-11-10"); null until `/info` has been read. */
  graphVersion: string | null;
}

export interface Unavailable {
  ok: false;
  degraded: DegradedReason;
  message: string;
  retryAfterS?: number;
}

export type Result<T> = { ok: true; value: T; eta: EtaModel; attribution: string } | Unavailable;

/** Point-to-point road route; numbers are the engine's own (not rounded), path is [lng, lat]. */
export interface PointRoute {
  path: LngLat[];
  distanceM: number;
  durationS: number;
}

/** `RoutingService.routeVia` output plus the legs that were proportionally estimated (never road numbers). */
export interface ViaRoute extends RouteViaResult {
  estimatedLegs: number[];
}

export interface MatrixRequest {
  sources: Pt[];
  targets: Pt[];
  profile: RoutingProfile;
  /** Sparse mode: only these (source, target) pairs; the rest are null (forbidden arc). */
  pairs?: [number, number][];
  departAt?: string;
}

export interface MatrixResult {
  /** null = no route / not requested; never estimated. */
  durationsS: (number | null)[][];
  distancesM: (number | null)[][];
  invalid: { side: 'source' | 'target'; index: number; reason: DegradedReason }[];
  cells: { requested: number; computed: number; cached: number };
}

export interface TracePoint {
  lat: number;
  lng: number;
  /** Epoch milliseconds. */
  t: number;
  /** GPS accuracy in metres, when known. */
  acc?: number | null;
}

export interface MapMatchResult {
  path: LngLat[];
  matchedDistanceM: number;
  /** Indexes into the input trace farther from the matched road than max(60 m, 2 × accuracy). */
  offRoadIndexes: number[];
}

export interface ProviderCapabilities {
  engine: 'graphhopper';
  engineVersion: string | null;
  graphVersion: string | null;
  profiles: RoutingProfile[];
  matrix: { native: boolean; maxSyncCells: number; maxAsyncCells: number };
  mapMatching: boolean;
  isochrone: boolean;
  coverage: 'india';
}

export interface ProviderHealth {
  reachable: boolean;
  latencyMs?: number;
  checkedAt: string;
  degraded?: DegradedReason;
  message?: string;
}

export interface RouteOptions {
  profile?: RoutingProfile;
}

export interface RoutingProvider {
  capabilities(): Promise<Result<ProviderCapabilities>>;
  health(): Promise<ProviderHealth>;
  route(from: Pt, to: Pt, opts?: RouteOptions): Promise<Result<PointRoute>>;
  routeVia(points: Pt[], opts?: RouteOptions): Promise<Result<ViaRoute>>;
  matrix(req: MatrixRequest, onProgress?: (done: number, total: number) => Promise<void>): Promise<Result<MatrixResult>>;
  mapMatch(trace: TracePoint[], profile?: RoutingProfile): Promise<Result<MapMatchResult>>;
  locate(points: Pt[], profile?: RoutingProfile): Promise<Result<{ onRoad: boolean; snapDistanceM: number }[]>>;
}

/** Nest injection token for the configured provider. */
export const ROUTING_PROVIDER = Symbol('ROUTING_PROVIDER');

export function unavailable(degraded: DegradedReason, message: string, retryAfterS?: number): Unavailable {
  return retryAfterS === undefined ? { ok: false, degraded, message } : { ok: false, degraded, message, retryAfterS };
}

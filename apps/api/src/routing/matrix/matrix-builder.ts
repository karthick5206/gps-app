/**
 * M1 travel-time matrix over the self-hosted road engine (ETMS E4 WP 4.1b, doc 17 §7 P7, doc 06 §2.2).
 *
 * Open-source GraphHopper has no matrix endpoint, so a matrix is built from `/route` requests (gh-matrix-client.ts):
 *
 *  1. Validate: finite WGS84, inside the India graph bbox, ≤ maxPoints. Bad points are reported and excluded (their
 *     row and column are null), never dropped silently and never moved.
 *  2. Snap every involved point once (zero-length route, same profile and snap preventions as the matrix). Points the
 *     engine cannot place on a road, or places farther than `maxSnapDistanceM`, are reported and excluded.
 *  3. Read the graph-versioned cache (matrix-cache.ts).
 *  4. Anchor probe: route anchor a ↔ every point. When p cannot reach a but q can, p cannot reach q either (else
 *     p → q → a would be a route), so those cells are proven no-route without a call; likewise for "a cannot reach p".
 *     The probe cells are matrix cells anyway (full matrix); points with a failed probe are routed pair by pair.
 *  5. The remaining cells between mutually reachable points are covered by an Euler cover of multi-point walks
 *     (walks.ts): each request answers up to `legsPerRequest` cells. Before walks are trusted for a graph version, a
 *     sample of walk legs is checked against single-pair answers (strategy `auto`); a mismatch or missing per-leg
 *     details switches the graph version to pairs. Every other cell is one pair request.
 *  6. All requests share one adaptive in-flight limit (limiter.ts), a total time budget and a failure breaker
 *     (`failLimit` consecutive transport failures). What is not computed is reported in `unknownCells` with the reason
 *     and the status is PARTIAL: an unknown cell is never a number and never a no-route. Re-running resumes from the
 *     cache.
 *
 * No straight-line, default-speed or symmetric (d(i,j) := d(j,i)) shortcut is ever used: one-way streets make urban
 * matrices asymmetric.
 */
import { Logger } from '@nestjs/common';
import { AVAILABLE_PROFILES, DegradedReason, RoutingProfile } from '../provider/routing-provider';
import { encodeCell, encodeSnap, MatrixCache, roundPoint, SnapCached } from './matrix-cache';
import { MatrixConfig } from './matrix-config';
import { EngineFailure, EngineInfo, MatrixEngine } from './gh-matrix-client';
import { AdaptiveLimiter, BuildGate } from './limiter';
import { MatrixMetrics } from './matrix-metrics';
import type { CellOutcome, MatrixBuild, MatrixBuildOptions, MatrixPoint, MatrixStats, PointReport } from './matrix-types';
import { Arc, chunkTrails, eulerTrails, legsOf } from './walks';
import { scrubCoordinates } from '../engine-text';

/** India graph bbox (Photon search uses the same, `geocoding.service.ts`): lng 68–98, lat 6–37. */
export const COVERAGE = { minLat: 6, maxLat: 37, minLng: 68, maxLng: 98 };

const INFO_TTL_MS = 5 * 60_000;
const INFO_FAIL_TTL_MS = 30_000;
const WALK_CHECK_LEGS = 3;
const PROGRESS_EVERY_MS = 250;
/** Attempts per single request when the engine fails transiently (5xx, timeout, connection). */
const ATTEMPTS = 3;

/** Cell codes in the working grid. */
const C = { NONE: 0, PENDING: 1, OK: 2, NOROUTE: 3, INFERRED: 4, UNKNOWN: 5, EXCLUDED: 6 } as const;

type WalkTrust = 'trusted' | 'rejected' | 'unsupported';

export type MatrixEngineSource = { engine: MatrixEngine } | { engine: null; reason: DegradedReason; message: string };

export function inCoverage(p: MatrixPoint): boolean {
  return p.lat >= COVERAGE.minLat && p.lat <= COVERAGE.maxLat && p.lng >= COVERAGE.minLng && p.lng <= COVERAGE.maxLng;
}

export function validPoint(p: MatrixPoint | null | undefined): boolean {
  return !!p && Number.isFinite(p.lat) && Number.isFinite(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180;
}

/** Graph version for cache keys and provenance: configured, else `gh-<version>|<data date>|<import date>` from /info. */
export function graphVersionOf(info: EngineInfo): string | null {
  if (!info.dataDate && !info.importDate) return null;
  return `gh-${info.version ?? '?'}|${info.dataDate ?? '-'}|${info.importDate ?? '-'}`;
}

/** Walk legs agree with pair answers: time within max(0.5 s, 1 %), distance within max(2 m, 1 %). */
export function legsAgree(a: { s: number; m: number }, b: { s: number; m: number }): boolean {
  return Math.abs(a.s - b.s) <= Math.max(0.5, 0.01 * Math.max(a.s, b.s)) && Math.abs(a.m - b.m) <= Math.max(2, 0.01 * Math.max(a.m, b.m));
}

class BuildState {
  readonly n: number;
  readonly code: Uint8Array;
  readonly s: Float64Array;
  readonly m: Float64Array;
  readonly unknownReason = new Map<number, DegradedReason>();
  settled = 0;
  constructor(n: number) {
    this.n = n;
    this.code = new Uint8Array(n * n);
    this.s = new Float64Array(n * n).fill(Number.NaN);
    this.m = new Float64Array(n * n).fill(Number.NaN);
  }
  idx(a: number, b: number): number {
    return a * this.n + b;
  }
  pending(a: number, b: number): boolean {
    return this.code[this.idx(a, b)] === C.PENDING;
  }
  requested(a: number, b: number): boolean {
    return this.code[this.idx(a, b)] !== C.NONE;
  }
  settle(a: number, b: number, code: number, v?: { s: number; m: number }): boolean {
    const k = this.idx(a, b);
    if (this.code[k] !== C.PENDING) return false;
    this.code[k] = code;
    if (v) {
      this.s[k] = v.s;
      this.m[k] = v.m;
    }
    this.settled++;
    return true;
  }
}

export class MatrixBuilder {
  private readonly logger = new Logger(MatrixBuilder.name);
  readonly limiter: AdaptiveLimiter;
  readonly gate: BuildGate;
  private info: { at: number; value: EngineInfo | null } | null = null;
  private readonly walkTrust = new Map<string, WalkTrust>();

  constructor(
    private readonly config: MatrixConfig,
    private readonly source: MatrixEngineSource,
    readonly cache: MatrixCache,
    readonly metrics: MatrixMetrics = new MatrixMetrics(),
  ) {
    this.limiter = new AdaptiveLimiter(config.concurrency, config.slowLegMs, config.fastLegMs);
    this.gate = new BuildGate(config.maxBuilds, config.queue);
  }

  get enabled(): boolean {
    return this.config.enabled && this.source.engine !== null;
  }

  /** Walk trust per graph version (for health / tests). */
  walkTrustOf(graphVersion: string): WalkTrust | undefined {
    return this.walkTrust.get(graphVersion);
  }

  /** Graph version (configured or from /info, memoised 5 min; a failed /info is retried after 30 s). */
  async graphVersion(engine: MatrixEngine, signal?: AbortSignal): Promise<string | null> {
    if (this.config.graphVersion) return this.config.graphVersion;
    const now = Date.now();
    if (this.info && now - this.info.at < (this.info.value ? INFO_TTL_MS : INFO_FAIL_TTL_MS)) {
      return this.info.value ? graphVersionOf(this.info.value) : null;
    }
    const r = await engine.info(signal);
    this.info = { at: now, value: 'kind' in r ? null : r };
    return this.info.value ? graphVersionOf(this.info.value) : null;
  }

  /**
   * Road check per point (RoutingProvider.locate): snapped by the same zero-length route as the matrix. `onRoad` is
   * false when the engine finds no road or the road is farther than `maxSnapDistanceM`. All or nothing: an engine
   * failure fails the call (no partial answers).
   */
  async snapPoints(
    input: MatrixPoint[],
    profile: RoutingProfile = 'car',
  ): Promise<{ ok: true; value: { onRoad: boolean; snapDistanceM: number }[] } | { ok: false; reason: DegradedReason; message: string }> {
    if (!this.config.enabled) return { ok: false, reason: 'ENGINE_DISABLED', message: 'ETMS routing is off (ETMS_ROUTING is not on).' };
    if (this.source.engine === null) return { ok: false, reason: this.source.reason, message: this.source.message };
    if (input.length > this.config.maxPoints) return { ok: false, reason: 'LIMIT_EXCEEDED', message: `${input.length} points; the limit is ${this.config.maxPoints}.` };
    if (input.some((p) => !validPoint(p))) return { ok: false, reason: 'INVALID_INPUT', message: 'Every point needs a valid latitude / longitude.' };
    const engine = this.source.engine;
    const out: { onRoad: boolean; snapDistanceM: number }[] = new Array(input.length);
    let failure: EngineFailure | null = null;
    const stop = () => failure !== null;
    await this.pool(
      input.map((p, i) => async () => {
        if (!inCoverage(p)) {
          out[i] = { onRoad: false, snapDistanceM: -1 };
          return;
        }
        const r = await this.limiter.run(1, () => engine.snap(roundPoint(p), profile)).catch((e: unknown) => this.aborted(e));
        if (r.kind === 'failure') failure = r;
        else if (r.kind === 'ok') {
          const d = r.snapDistanceM ?? 0;
          out[i] = { onRoad: d <= this.config.maxSnapDistanceM, snapDistanceM: d };
        } else out[i] = { onRoad: false, snapDistanceM: -1 };
      }),
      stop,
    );
    const f = failure as EngineFailure | null;
    if (f) return { ok: false, reason: f.reason, message: f.message };
    return { ok: true, value: out };
  }

  async buildMatrix(input: MatrixPoint[], profile: RoutingProfile = 'car', opts: MatrixBuildOptions = {}): Promise<MatrixBuild> {
    const started = Date.now();
    const n = input.length;
    const stats: MatrixStats = {
      points: n,
      requested: 0,
      cached: 0,
      computed: 0,
      inferred: 0,
      noRoute: 0,
      unknown: 0,
      excluded: 0,
      engineCalls: { snap: 0, pair: 0, walk: 0 },
      walkLegs: 0,
      strategy: 'pairwise',
      cacheWrites: 0,
      cacheFull: false,
      durationMs: 0,
    };
    const empty = (reason: DegradedReason, message: string, retryAfterS?: number): MatrixBuild => {
      stats.durationMs = Date.now() - started;
      const build: MatrixBuild = {
        status: 'UNAVAILABLE',
        degraded: retryAfterS === undefined ? { reason, message } : { reason, message, retryAfterS },
        graphVersion: null,
        profile,
        durationsS: input.map(() => input.map(() => null)),
        distancesM: input.map(() => input.map(() => null)),
        unknownCells: [],
        points: input.map((_, index) => ({ index, snapDistanceM: null, issue: null, excluded: false })),
        stats,
      eta: { source: 'engine_free_flow', calibrated: false, liveTraffic: false },
      };
      this.metrics.recordBuild(build);
      return build;
    };

    if (!this.config.enabled) return empty('ENGINE_DISABLED', 'ETMS routing is off (ETMS_ROUTING is not on); no matrix numbers are available.');
    if (this.source.engine === null) return empty(this.source.reason, this.source.message);
    const engine = this.source.engine;
    if (!AVAILABLE_PROFILES.includes(profile)) {
      return empty('PROFILE_NOT_AVAILABLE', `Routing profile "${profile}" is not available on this graph (only: ${AVAILABLE_PROFILES.join(', ')}).`);
    }
    if (n > this.config.maxPoints) return empty('LIMIT_EXCEEDED', `${n} points; the matrix limit is ${this.config.maxPoints} (split the planning window into zones).`);
    for (const [a, b] of opts.pairs ?? []) {
      if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0 || a >= n || b >= n) {
        return empty('INVALID_INPUT', `Pair (${a}, ${b}) is outside the ${n} points.`);
      }
    }

    const release = await this.gate.enter();
    if (!release) return empty('LIMIT_EXCEEDED', 'Too many matrix builds are running or queued; try again shortly.', 30);
    try {
      return await this.run(engine, input, profile, opts, stats, started, empty);
    } finally {
      release();
    }
  }

  private async run(
    engine: MatrixEngine,
    input: MatrixPoint[],
    profile: RoutingProfile,
    opts: MatrixBuildOptions,
    stats: MatrixStats,
    started: number,
    empty: (reason: DegradedReason, message: string, retryAfterS?: number) => MatrixBuild,
  ): Promise<MatrixBuild> {
    const n = input.length;
    const deadline = started + (opts.budgetMs ?? this.config.budgetMs);
    const maxSnap = opts.maxSnapDistanceM ?? this.config.maxSnapDistanceM;
    const budget = new AbortController();
    const budgetTimer = setTimeout(() => budget.abort(new DOMException('budget', 'TimeoutError')), Math.max(0, deadline - Date.now()));
    const signal = opts.signal ? AbortSignal.any([budget.signal, opts.signal]) : budget.signal;
    try {
      const health = await engine.health(signal);
      if ('kind' in health) {
        return empty(health.reason, `${health.message}. No matrix numbers are available; try again when the routing engine is back.`, 60);
      }
      const gv = await this.graphVersion(engine, signal);
      const useCache = this.cache.enabled && gv !== null;
      const points = input.map((p) => (validPoint(p) ? roundPoint(p) : p));
      const st = new BuildState(n);
      const reports: PointReport[] = input.map((_, index) => ({ index, snapDistanceM: null, issue: null, excluded: false }));
      const cacheOut: [string, string][] = [];
      const fail: { last: EngineFailure | null } = { last: null };
      let consecutive = 0;
      let breaker = false;

      // Requested cells.
      if (opts.pairs) for (const [a, b] of opts.pairs) if (a !== b && !st.requested(a, b)) st.code[st.idx(a, b)] = C.PENDING;
      if (!opts.pairs) for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) if (a !== b) st.code[st.idx(a, b)] = C.PENDING;
      for (let k = 0; k < n * n; k++) if (st.code[k] === C.PENDING) stats.requested++;
      const involved = new Set<number>();
      for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) if (st.pending(a, b)) involved.add(a).add(b);

      let lastProgress = 0;
      const progress = async (force = false) => {
        if (!opts.onProgress) return;
        const now = Date.now();
        if (!force && now - lastProgress < PROGRESS_EVERY_MS) return;
        lastProgress = now;
        await opts.onProgress(st.settled, stats.requested);
      };
      const stopped = () => breaker || signal.aborted;
      const noteFailure = (f: EngineFailure) => {
        fail.last = f;
        if (!f.transport) return;
        consecutive++;
        if (consecutive >= this.config.failLimit && !breaker) {
          breaker = true;
          this.logger.warn(`Matrix build stopped after ${consecutive} engine failures in a row: ${scrubCoordinates(f.message)}`);
        }
      };
      const noteSuccess = () => {
        consecutive = 0;
      };
      const exclude = (i: number, issue: PointReport['issue'], message: string, snapDistanceM: number | null = null) => {
        reports[i] = { index: i, snapDistanceM, issue, excluded: true, message };
      };

      // 1. Validate.
      for (const i of involved) {
        if (!validPoint(input[i])) exclude(i, 'INVALID_INPUT', 'Not a valid latitude / longitude.');
        else if (!inCoverage(points[i])) exclude(i, 'OUTSIDE_COVERAGE', 'Outside the India road graph (check the latitude / longitude order).');
      }

      // 2. Snap (cache first).
      const toSnap = [...involved].filter((i) => !reports[i].excluded);
      const snapKeys = useCache ? toSnap.map((i) => this.cache.snapKey(gv!, profile, points[i])) : [];
      const cachedSnaps = useCache && !opts.noCacheRead ? await this.cache.getSnaps(snapKeys) : toSnap.map(() => null);
      const applySnap = (i: number, s: SnapCached) => {
        if (s.kind === 'nopoint') exclude(i, 'POINT_NOT_ON_ROAD', 'The routing engine found no road near this point.');
        else if (s.kind === 'outside') exclude(i, 'OUTSIDE_COVERAGE', 'Outside the routing graph.');
        else if (s.snapDistanceM !== null && s.snapDistanceM > maxSnap) {
          exclude(i, 'FAR_FROM_ROAD', `The nearest road is ${Math.round(s.snapDistanceM)} m away (limit ${maxSnap} m); move the point onto the road.`, s.snapDistanceM);
        } else reports[i] = { index: i, snapDistanceM: s.snapDistanceM, issue: null, excluded: false };
      };
      const snapMiss: number[] = [];
      toSnap.forEach((i, k) => {
        const c = cachedSnaps[k];
        if (c) applySnap(i, c);
        else snapMiss.push(i);
      });
      await this.pool(
        snapMiss.map((i) => async () => {
          let r = await this.limiter.run(1, () => engine.snap(points[i], profile, signal), signal).catch((e: unknown) => this.aborted(e));
          stats.engineCalls.snap++;
          for (let attempt = 2; r.kind === 'failure' && r.transport && attempt <= ATTEMPTS && !stopped(); attempt++) {
            noteFailure(r);
            stats.engineCalls.snap++;
            r = await this.limiter.run(1, () => engine.snap(points[i], profile, signal), signal).catch((e: unknown) => this.aborted(e));
          }
          if (r.kind === 'failure') {
            noteFailure(r);
            reports[i] = { index: i, snapDistanceM: null, issue: 'NOT_CHECKED', excluded: false, message: r.message };
            return;
          }
          noteSuccess();
          applySnap(i, r);
          if (useCache) cacheOut.push([this.cache.snapKey(gv!, profile, points[i]), encodeSnap(r)]);
        }),
        stopped,
      );
      for (const i of snapMiss) {
        if (!reports[i].excluded && reports[i].issue === null && reports[i].snapDistanceM === null && stopped()) {
          reports[i] = { index: i, snapDistanceM: null, issue: 'NOT_CHECKED', excluded: false, message: 'Not checked: the build stopped.' };
        }
      }
      for (let a = 0; a < n; a++) {
        for (let b = 0; b < n; b++) {
          if (st.pending(a, b) && (reports[a].excluded || reports[b].excluded)) {
            st.settle(a, b, C.EXCLUDED);
            stats.excluded++;
          }
        }
      }

      // 3. Cache.
      const cellKey = (a: number, b: number) => this.cache.cellKey(gv!, profile, points[a], points[b]);
      if (useCache && !opts.noCacheRead) {
        const arcs: Arc[] = [];
        for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) if (st.pending(a, b)) arcs.push([a, b]);
        const hits = await this.cache.getCells(arcs.map(([a, b]) => cellKey(a, b)));
        arcs.forEach(([a, b], k) => {
          const h = hits[k];
          if (!h) return;
          if (h.kind === 'ok') st.settle(a, b, C.OK, h);
          else st.settle(a, b, C.NOROUTE);
          stats.cached++;
        });
      }
      await progress(true);

      const store = (a: number, b: number, o: CellOutcome) => {
        if (!useCache) return;
        const v = encodeCell(o);
        if (v !== null) cacheOut.push([cellKey(a, b), v]);
      };
      /** Records an engine answer for a cell (requested or probe-only). */
      const probe = new Map<number, CellOutcome>();
      const record = (a: number, b: number, o: CellOutcome) => {
        if (o.kind !== 'unknown') store(a, b, o);
        if (st.pending(a, b)) {
          if (o.kind === 'ok') {
            st.settle(a, b, C.OK, o);
            stats.computed++;
          } else if (o.kind === 'noroute') {
            st.settle(a, b, C.NOROUTE);
            stats.computed++;
          } else {
            st.settle(a, b, C.UNKNOWN);
            st.unknownReason.set(st.idx(a, b), o.reason);
          }
        } else if (!st.requested(a, b)) probe.set(st.idx(a, b), o);
      };
      const known = (a: number, b: number): CellOutcome | null => {
        const k = st.idx(a, b);
        const c = st.code[k];
        if (c === C.OK) return { kind: 'ok', s: st.s[k], m: st.m[k] };
        if (c === C.NOROUTE || c === C.INFERRED) return { kind: 'noroute' };
        return probe.get(k) ?? null;
      };

      // Pair runner (retried for a transport failure).
      const pairTask = (a: number, b: number, attempt = 1): (() => Promise<void>) => async () => {
        if (!st.pending(a, b) && st.requested(a, b)) return;
        stats.engineCalls.pair++;
        const r = await this.limiter.run(1, () => engine.pair(points[a], points[b], profile, signal), signal).catch((e: unknown) => this.aborted(e));
        if (r.kind === 'ok' || r.kind === 'noroute') {
          noteSuccess();
          record(a, b, r);
        } else if (r.kind === 'nopoint') {
          noteSuccess();
          record(a, b, { kind: 'unknown', reason: 'POINT_NOT_ON_ROAD', message: 'The engine could not place a point of this cell on a road.' });
        } else {
          noteFailure(r);
          if (attempt < ATTEMPTS && r.transport && !stopped()) extra.push(pairTask(a, b, attempt + 1));
          else record(a, b, { kind: 'unknown', reason: r.reason, message: r.message });
        }
        await progress();
      };
      const extra: (() => Promise<void>)[] = [];

      const trustKey = gv ?? '(unknown graph)';
      /** Walks are used when forced (`walk`), trusted for this graph, or for the one check walk of strategy `auto`. */
      const walksAllowed = (check: boolean) =>
        this.config.strategy === 'walk' || this.walkTrust.get(trustKey) === 'trusted' || (check && this.config.strategy === 'auto' && !this.walkTrust.has(trustKey));
      /** Runs a walk; on any non-success its legs go to pairs. Returns the legs' answers when ok. */
      const walkTask = (walk: number[], check = false): (() => Promise<void>) => async () => {
        const legs = legsOf(walk);
        const open = legs.filter(([a, b]) => !st.requested(a, b) || st.pending(a, b));
        if (!open.length) return;
        if (!walksAllowed(check) || stopped()) {
          for (const [a, b] of open) extra.push(pairTask(a, b));
          return;
        }
        stats.engineCalls.walk++;
        const r = await this.limiter.run(legs.length, () => engine.walk(walk.map((i) => points[i]), profile, signal), signal).catch((e: unknown) => this.aborted(e));
        if (r.kind === 'ok') {
          noteSuccess();
          if (check && this.config.strategy === 'auto' && !this.walkTrust.has(trustKey)) {
            const sample = sampleLegs(legs.length, WALK_CHECK_LEGS);
            let agree = true;
            for (const k of sample) {
              const [a, b] = legs[k];
              stats.engineCalls.pair++;
              const p = await this.limiter.run(1, () => engine.pair(points[a], points[b], profile, signal), signal).catch((e: unknown) => this.aborted(e));
              if (p.kind === 'failure') {
                noteFailure(p);
                for (const [x, y] of open) extra.push(pairTask(x, y)); // check not possible now; retry next build
                return;
              }
              if (p.kind !== 'ok') {
                agree = false;
                break;
              }
              if (!legsAgree(p, r.legs[k])) {
                agree = false;
                this.logger.warn(`Walk legs disagree with single routes on graph ${trustKey}; using single routes for this graph.`);
                break;
              }
            }
            this.walkTrust.set(trustKey, agree ? 'trusted' : 'rejected');
            if (!agree) {
              for (const [a, b] of open) extra.push(pairTask(a, b));
              return;
            }
          }
          stats.walkLegs += legs.length;
          legs.forEach(([a, b], k) => record(a, b, { kind: 'ok', ...r.legs[k] }));
        } else if (r.kind === 'nodetails') {
          noteSuccess();
          if (this.config.strategy === 'auto' && !this.walkTrust.has(trustKey)) {
            this.walkTrust.set(trustKey, 'unsupported');
            this.logger.warn(`Routing engine gives no per-leg details (${scrubCoordinates(r.message)}); using single routes for graph ${trustKey}.`);
          }
          for (const [a, b] of open) extra.push(pairTask(a, b));
        } else {
          if (r.kind === 'failure') noteFailure(r);
          else noteSuccess();
          for (const [a, b] of open) extra.push(pairTask(a, b));
        }
        await progress();
      };

      // 4. Anchor probe + inference.
      const included = [...involved].filter((i) => !reports[i].excluded).sort((x, y) => x - y);
      const good = new Set<number>();
      let anchor: number | null = null;
      if (included.length >= 3 && !stopped()) {
        let best: { a: number; good: Set<number> } | null = null;
        for (const a of included.slice(0, 3)) {
          const others = included.filter((x) => x !== a);
          const need: Arc[] = [];
          for (const x of others) {
            if (!known(a, x)) need.push([a, x]);
            if (!known(x, a)) need.push([x, a]);
          }
          await this.runArcs(need, walkTask, pairTask, extra, stopped);
          const g = new Set<number>([a]);
          for (const x of others) if (known(a, x)?.kind === 'ok' && known(x, a)?.kind === 'ok') g.add(x);
          if (!best || g.size > best.good.size) best = { a, good: g };
          if (g.size - 1 >= (included.length - 1) / 2 || stopped()) break;
        }
        if (best) {
          anchor = best.a;
          for (const x of best.good) good.add(x);
          for (const p of included) {
            if (good.has(p)) continue;
            const out = known(p, anchor);
            const inn = known(anchor, p);
            for (const q of good) {
              if (q === p) continue;
              if (out?.kind === 'noroute' && st.pending(p, q)) {
                st.settle(p, q, C.INFERRED);
                stats.inferred++;
                store(p, q, { kind: 'noroute' });
              }
              if (inn?.kind === 'noroute' && st.pending(q, p)) {
                st.settle(q, p, C.INFERRED);
                stats.inferred++;
                store(q, p, { kind: 'noroute' });
              }
            }
          }
        }
      } else for (const i of included) good.add(i);

      // 5. Remaining cells: walks between mutually reachable points, pairs for the rest.
      if (!stopped()) {
        const rest: Arc[] = [];
        for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) if (st.pending(a, b)) rest.push([a, b]);
        await this.runArcs(rest, walkTask, pairTask, extra, stopped, good);
      }
      stats.strategy = stats.walkLegs > 0 ? 'walk' : 'pairwise';

      // 6. Whatever is still pending is unknown (budget, cancel, breaker).
      const stopReason: { reason: DegradedReason; message: string } | null = opts.signal?.aborted
        ? { reason: 'LIMIT_EXCEEDED', message: 'The matrix build was cancelled.' }
        : budget.signal.aborted
          ? { reason: 'ENGINE_TIMEOUT', message: `The matrix time budget (${Math.round((deadline - started) / 1000)} s) ran out before every cell was computed.` }
          : breaker && fail.last
            ? { reason: fail.last.reason, message: `Stopped after ${this.config.failLimit} routing-engine failures in a row: ${scrubCoordinates(fail.last.message)}` }
            : null;
      for (let a = 0; a < n; a++) {
        for (let b = 0; b < n; b++) {
          if (st.pending(a, b)) {
            st.settle(a, b, C.UNKNOWN);
            st.unknownReason.set(st.idx(a, b), stopReason?.reason ?? 'ENGINE_UNREACHABLE');
          }
        }
      }

      // Cache writes (also for a partial build, so a retry resumes).
      if (useCache && cacheOut.length) {
        const fullBefore = this.cache.counters.full;
        stats.cacheWrites = await this.cache.put(gv!, cacheOut);
        stats.cacheFull = this.cache.counters.full && (!fullBefore || stats.cacheWrites < cacheOut.length);
      }

      // Disconnected points: every requested cell with an included partner is no-route, and something else routes.
      const anyOk = st.code.some((c) => c === C.OK);
      for (const p of included) {
        let cells = 0;
        let none = 0;
        for (let q = 0; q < n; q++) {
          if (q === p || reports[q].excluded) continue;
          for (const [a, b] of [
            [p, q],
            [q, p],
          ]) {
            const c = st.code[st.idx(a, b)];
            if (c === C.NONE) continue;
            cells++;
            if (c === C.NOROUTE || c === C.INFERRED) none++;
          }
        }
        if (anyOk && cells > 0 && none === cells) {
          reports[p] = { ...reports[p], issue: 'DISCONNECTED', excluded: true, message: 'No road route to or from the other points (separate road network).' };
        }
      }

      // Assemble.
      const durationsS: (number | null)[][] = [];
      const distancesM: (number | null)[][] = [];
      const unknownCells: [number, number][] = [];
      const reasons = new Map<DegradedReason, number>();
      for (let a = 0; a < n; a++) {
        const ds: (number | null)[] = [];
        const dm: (number | null)[] = [];
        for (let b = 0; b < n; b++) {
          const k = st.idx(a, b);
          const c = st.code[k];
          if (a === b) {
            const ok = involved.has(a) ? !reports[a].excluded : validPoint(input[a]);
            ds.push(ok ? 0 : null);
            dm.push(ok ? 0 : null);
            continue;
          }
          if (c === C.OK) {
            ds.push(st.s[k]);
            dm.push(st.m[k]);
            continue;
          }
          ds.push(null);
          dm.push(null);
          if (c === C.NOROUTE) stats.noRoute++;
          if (c === C.INFERRED) stats.noRoute++;
          if (c === C.UNKNOWN) {
            unknownCells.push([a, b]);
            const r = st.unknownReason.get(k) ?? 'ENGINE_UNREACHABLE';
            reasons.set(r, (reasons.get(r) ?? 0) + 1);
          }
        }
        durationsS.push(ds);
        distancesM.push(dm);
      }
      stats.unknown = unknownCells.length;
      stats.durationMs = Date.now() - started;
      await progress(true);

      let degraded: MatrixBuild['degraded'] = null;
      if (unknownCells.length) {
        const top = stopReason?.reason ?? [...reasons.entries()].sort((x, y) => y[1] - x[1])[0][0];
        degraded = {
          reason: top,
          message: `${unknownCells.length} of ${stats.requested} cells could not be computed${stopReason ? `: ${scrubCoordinates(stopReason.message).replace(/\.+$/, '')}` : fail.last ? `: ${scrubCoordinates(fail.last.message).replace(/\.+$/, '')}` : ''}. They are unknown, not unreachable; run the build again to resume from the cache.`,
          retryAfterS: 60,
        };
      }
      const build: MatrixBuild = {
        status: unknownCells.length ? (stats.computed + stats.cached + stats.inferred > 0 ? 'PARTIAL' : 'UNAVAILABLE') : 'COMPLETE',
        degraded,
        graphVersion: gv,
        profile,
        durationsS,
        distancesM,
        unknownCells,
        points: reports,
        stats,
        eta: { source: 'engine_free_flow', calibrated: false, liveTraffic: false },
      };
      this.metrics.recordBuild(build);
      return build;
    } finally {
      clearTimeout(budgetTimer);
    }
  }

  /**
   * Runs arcs: walks over `walkable` points (Euler cover, chunked) when walks are allowed, pairs otherwise; then the
   * fallback pairs the walks pushed into `extra`. The first walk is the check walk (strategy `auto`).
   */
  private async runArcs(
    arcs: Arc[],
    walkTask: (walk: number[], check?: boolean) => () => Promise<void>,
    pairTask: (a: number, b: number) => () => Promise<void>,
    extra: (() => Promise<void>)[],
    stopped: () => boolean,
    walkable?: Set<number>,
  ): Promise<void> {
    if (!arcs.length) return;
    const useWalks = this.config.strategy !== 'pairwise';
    const viaWalk = useWalks ? arcs.filter(([a, b]) => !walkable || (walkable.has(a) && walkable.has(b))) : [];
    const viaWalkSet = new Set(viaWalk.map(([a, b]) => `${a}:${b}`));
    const viaPair = arcs.filter(([a, b]) => !viaWalkSet.has(`${a}:${b}`));
    // A probe's arcs alternate anchor → x → anchor: an Euler cover makes exactly those walks.
    const chunks = viaWalk.length ? chunkTrails(eulerTrails(viaWalk), this.config.legsPerRequest) : [];
    const tasks: (() => Promise<void>)[] = [];
    if (chunks.length) {
      // The first walk runs alone so the walk check (auto strategy) settles before the rest.
      await this.pool([walkTask(chunks[0], true)], stopped);
      for (const c of chunks.slice(1)) tasks.push(walkTask(c));
    }
    for (const [a, b] of viaPair) tasks.push(pairTask(a, b));
    await this.pool(tasks, stopped);
    while (extra.length && !stopped()) await this.pool(extra.splice(0, extra.length), stopped);
  }

  /** Runs tasks with enough workers to fill the limiter; stops picking new tasks once `stopped()` is true. */
  private async pool(tasks: (() => Promise<void>)[], stopped: () => boolean): Promise<void> {
    let next = 0;
    const worker = async () => {
      while (next < tasks.length && !stopped()) await tasks[next++]();
    };
    await Promise.all(Array.from({ length: Math.min(tasks.length, this.limiter.max) }, worker));
  }

  private aborted(error: unknown): EngineFailure {
    const reason = (error as { name?: string } | null)?.name === 'TimeoutError' ? 'ENGINE_TIMEOUT' : 'LIMIT_EXCEEDED';
    return { kind: 'failure', reason, message: reason === 'ENGINE_TIMEOUT' ? 'Matrix time budget ran out' : 'Matrix build cancelled', transport: false };
  }
}

/** Up to `k` leg indexes spread over a walk of `legs` legs. */
export function sampleLegs(legs: number, k: number): number[] {
  if (legs <= k) return Array.from({ length: legs }, (_, i) => i);
  return Array.from({ length: k }, (_, i) => Math.floor(((i + 0.5) * legs) / k));
}

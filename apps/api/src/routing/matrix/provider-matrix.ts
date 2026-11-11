/**
 * `RoutingProvider.matrix(MatrixRequest)` on top of `MatrixBuilder.buildMatrix` (square). Sources and targets are
 * merged into one point list (same coordinates rounded to ~1.1 m share an index), the requested cells become `pairs`,
 * and the square result is cut back to sources × targets. Following the provider rule (routing-provider.ts: no partial
 * numbers in a failure), anything but a COMPLETE build is `{ ok: false }`; the cells already computed sit in the
 * cache, so a retry resumes. Callers that want the partial grid (the routing worker) call `buildMatrix` directly.
 */
import type { DegradedReason, MatrixRequest, MatrixResult, Unavailable } from '../provider/routing-provider';
import { unavailable } from '../provider/routing-provider';
import { round5 } from './matrix-cache';
import type { MatrixBuilder } from './matrix-builder';
import type { MatrixPoint, PointIssue } from './matrix-types';

export interface SquareRequest {
  points: MatrixPoint[];
  srcIndex: number[];
  tgtIndex: number[];
  pairs: [number, number][] | undefined;
}

export function squareOf(req: MatrixRequest): SquareRequest {
  const points: MatrixPoint[] = [];
  const seen = new Map<string, number>();
  const indexOf = (p: MatrixPoint) => {
    const key = Number.isFinite(p.lat) && Number.isFinite(p.lng) ? `${round5(p.lat)},${round5(p.lng)}` : `bad:${points.length}`;
    let i = seen.get(key);
    if (i === undefined) {
      i = points.length;
      points.push({ lat: p.lat, lng: p.lng });
      seen.set(key, i);
    }
    return i;
  };
  const srcIndex = req.sources.map(indexOf);
  const tgtIndex = req.targets.map(indexOf);
  const same = !req.pairs && srcIndex.length === points.length && tgtIndex.length === points.length && srcIndex.every((v, i) => v === i && tgtIndex[i] === i);
  if (same) return { points, srcIndex, tgtIndex, pairs: undefined };
  const pairs: [number, number][] = req.pairs
    ? req.pairs.filter(([s, t]) => s >= 0 && t >= 0 && s < srcIndex.length && t < tgtIndex.length).map(([s, t]) => [srcIndex[s], tgtIndex[t]])
    : srcIndex.flatMap((a) => tgtIndex.map((b) => [a, b] as [number, number]));
  return { points, srcIndex, tgtIndex, pairs };
}

const ISSUE_REASON: Record<PointIssue, DegradedReason> = {
  INVALID_INPUT: 'INVALID_INPUT',
  OUTSIDE_COVERAGE: 'OUTSIDE_COVERAGE',
  POINT_NOT_ON_ROAD: 'POINT_NOT_ON_ROAD',
  FAR_FROM_ROAD: 'POINT_NOT_ON_ROAD',
  DISCONNECTED: 'NO_ROUTE',
  NOT_CHECKED: 'ENGINE_UNREACHABLE',
};

export async function providerMatrix(
  builder: MatrixBuilder,
  req: MatrixRequest,
  onProgress?: (done: number, total: number) => Promise<void>,
): Promise<{ ok: true; value: MatrixResult; graphVersion: string | null } | Unavailable> {
  if (req.pairs?.some(([s, t]) => !Number.isInteger(s) || !Number.isInteger(t) || s < 0 || t < 0 || s >= req.sources.length || t >= req.targets.length)) {
    return unavailable('INVALID_INPUT', 'A requested pair is outside the sources / targets.');
  }
  const sq = squareOf(req);
  const b = await builder.buildMatrix(sq.points, req.profile, { pairs: sq.pairs, onProgress });
  if (b.status !== 'COMPLETE') {
    const d = b.degraded ?? { reason: 'ENGINE_UNREACHABLE' as DegradedReason, message: 'Matrix not available.' };
    return unavailable(d.reason, d.message, d.retryAfterS);
  }
  const requested = new Set((req.pairs ?? []).map(([s, t]) => `${s}:${t}`));
  const want = (s: number, t: number) => !req.pairs || requested.has(`${s}:${t}`);
  const durationsS = sq.srcIndex.map((a, s) => sq.tgtIndex.map((c, t) => (want(s, t) ? b.durationsS[a][c] : null)));
  const distancesM = sq.srcIndex.map((a, s) => sq.tgtIndex.map((c, t) => (want(s, t) ? b.distancesM[a][c] : null)));
  const invalid: MatrixResult['invalid'] = [];
  const side = (list: number[], name: 'source' | 'target') =>
    list.forEach((i, index) => {
      const r = b.points[i];
      if (r?.excluded && r.issue) invalid.push({ side: name, index, reason: ISSUE_REASON[r.issue] });
    });
  side(sq.srcIndex, 'source');
  side(sq.tgtIndex, 'target');
  return {
    ok: true,
    value: { durationsS, distancesM, invalid, cells: { requested: b.stats.requested, computed: b.stats.computed + b.stats.inferred, cached: b.stats.cached } },
    graphVersion: b.graphVersion,
  };
}

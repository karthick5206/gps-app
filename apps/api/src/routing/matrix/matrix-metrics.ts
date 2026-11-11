/**
 * Matrix numbers for System Health: per process, a rolling window of builds (latency per cell, degraded builds by
 * reason), published to Valkey (`vt:etms:mx:stats`, 1 h TTL) after every build so the API's System Health page can
 * read them whichever process (API or the future routing worker) built the matrix. `matrixHealthIssues` turns a
 * snapshot into `maps.etms-matrix*` issues (monitoring/checks.ts).
 */
import type { MatrixBuild } from './matrix-types';
import { percentile } from './limiter';

export const MATRIX_STATS_KEY = 'vt:etms:mx:stats';
export const MATRIX_STATS_TTL_SEC = 3600;
const WINDOW = 50;

export interface MatrixBuildSummary {
  at: number;
  status: MatrixBuild['status'];
  reason: string | null;
  points: number;
  requested: number;
  cached: number;
  computed: number;
  unknown: number;
  durationMs: number;
  /** Engine milliseconds per computed cell (build time / computed cells); null when nothing was computed. */
  msPerCell: number | null;
  strategy: 'walk' | 'pairwise';
}

export interface MatrixStatsSnapshot {
  at: number;
  builds: number;
  degraded: number;
  /** Degraded builds in the window by reason. */
  reasons: Record<string, number>;
  p50MsPerCell: number | null;
  p95MsPerCell: number | null;
  /** Cells answered from the cache / requested, over the window. */
  cacheHitRatio: number | null;
  last: MatrixBuildSummary | null;
  lastOkAt: number | null;
  lastDegradedAt: number | null;
}

export class MatrixMetrics {
  private readonly window: MatrixBuildSummary[] = [];
  private lastOkAt: number | null = null;
  private lastDegradedAt: number | null = null;
  /** Called after every build (wired to Valkey by the module); errors are swallowed. */
  publish: ((s: MatrixStatsSnapshot) => Promise<unknown>) | null = null;

  recordBuild(b: MatrixBuild, now = Date.now()): void {
    const s = b.stats;
    const summary: MatrixBuildSummary = {
      at: now,
      status: b.status,
      reason: b.degraded?.reason ?? null,
      points: s.points,
      requested: s.requested,
      cached: s.cached,
      computed: s.computed,
      unknown: s.unknown,
      durationMs: s.durationMs,
      msPerCell: s.computed > 0 ? Math.round((s.durationMs / s.computed) * 100) / 100 : null,
      strategy: s.strategy,
    };
    this.window.push(summary);
    if (this.window.length > WINDOW) this.window.shift();
    if (b.status === 'COMPLETE') this.lastOkAt = now;
    else this.lastDegradedAt = now;
    const pub = this.publish;
    if (pub) void pub(this.snapshot(now)).catch(() => undefined);
  }

  snapshot(now = Date.now()): MatrixStatsSnapshot {
    const per = this.window.map((w) => w.msPerCell).filter((v): v is number => v !== null);
    const requested = this.window.reduce((t, w) => t + w.requested, 0);
    const reasons: Record<string, number> = {};
    for (const w of this.window) if (w.reason) reasons[w.reason] = (reasons[w.reason] ?? 0) + 1;
    return {
      at: now,
      builds: this.window.length,
      degraded: this.window.filter((w) => w.status !== 'COMPLETE').length,
      reasons,
      p50MsPerCell: per.length ? percentile(per, 50) : null,
      p95MsPerCell: per.length ? percentile(per, 95) : null,
      cacheHitRatio: requested > 0 ? Math.round((this.window.reduce((t, w) => t + w.cached, 0) / requested) * 1000) / 1000 : null,
      last: this.window[this.window.length - 1] ?? null,
      lastOkAt: this.lastOkAt,
      lastDegradedAt: this.lastDegradedAt,
    };
  }
}

export function parseMatrixStats(raw: string | null): MatrixStatsSnapshot | null {
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as MatrixStatsSnapshot;
    return typeof s?.at === 'number' && typeof s.builds === 'number' ? s : null;
  } catch {
    return null;
  }
}

export interface MatrixHealthIssue {
  id: string;
  check: string;
  section: 'maps';
  severity: 'WARN' | 'CRITICAL';
  message: string;
}

/**
 * Issues from the last matrix snapshot (only when ETMS routing is on and a build ran in the last hour):
 * - `maps.etms-matrix`       the last build was not complete (WARN; the planner shows "routing unavailable (reason)");
 * - `maps.etms-matrix-slow`  p95 engine time per cell above `slowMsPerCell` (WARN; GraphHopper is overloaded).
 */
export function matrixHealthIssues(s: MatrixStatsSnapshot | null, now: number, slowMsPerCell = 50): MatrixHealthIssue[] {
  if (!s || !s.last || now - s.at > MATRIX_STATS_TTL_SEC * 1000) return [];
  const out: MatrixHealthIssue[] = [];
  if (s.last.status !== 'COMPLETE') {
    out.push({
      id: 'maps.etms-matrix',
      check: 'transport travel-time matrix',
      section: 'maps',
      severity: 'WARN',
      message:
        `The last travel-time matrix (${s.last.points} points) was ${s.last.status.toLowerCase()}` +
        `${s.last.reason ? ` (${s.last.reason})` : ''}: ${s.last.unknown} of ${s.last.requested} cells unknown. ` +
        `${s.degraded} of the last ${s.builds} builds were degraded. Check GraphHopper on System Health → Map services.`,
    });
  }
  if (s.p95MsPerCell !== null && s.p95MsPerCell > slowMsPerCell) {
    out.push({
      id: 'maps.etms-matrix-slow',
      check: 'transport travel-time matrix',
      section: 'maps',
      severity: 'WARN',
      message: `Travel-time matrices take ${s.p95MsPerCell} ms per cell (p95 of the last ${s.builds} builds; target ≤ ${slowMsPerCell} ms). GraphHopper is slow or overloaded.`,
    });
  }
  return out;
}

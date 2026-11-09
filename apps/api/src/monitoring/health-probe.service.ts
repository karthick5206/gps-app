import { Injectable } from '@nestjs/common';
import { GatewayMetrics, HealthStatus, ProcessorMetrics } from '@veetracer/shared';
import { hostname } from 'node:os';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { gatewaySpools, Issue, worst } from './checks';
import { Collected, SystemHealthService } from './system-health.service';
import { shortError, withTimeout } from './util';

const DB_TIMEOUT_MS = 2000;
const CACHE_TIMEOUT_MS = 1500;
/** /api/health/tracking runs the full System Health collection; concurrent / repeated calls share one result. */
const TRACKING_CACHE_MS = 5000;

export interface DependencyCheck {
  ok: boolean;
  latencyMs: number | null;
  error: string | null;
}

export interface ReadinessReport {
  ok: boolean;
  status: 'OK' | 'CRITICAL';
  checks: { database: DependencyCheck; cache: DependencyCheck };
  at: string;
}

export interface TrackingReport {
  ok: boolean;
  status: HealthStatus;
  at: string;
  issues: { id: string; severity: HealthStatus; message: string }[];
  cache: { reachable: boolean };
  database: { reachable: boolean };
  gateways: { instance: number; connections: number; positionsPerSec: number; spool: { mode: string; pendingEntries: number; oldestSpooledAt: string | null; notAcked: number } | null }[];
  processors: { instance: number; lastBatchAt: string | null; processedPerSec: number; duplicates: number | null }[];
  stream: { lag: number | null; pending: number; oldestPendingAgeSec: number | null } | null;
  lastPersistedAt: string | null;
  lastPersistedAgeSec: number | null;
}

/** Issue id prefixes that concern the GPS pipeline (gateway → stream → processor → PostgreSQL). */
const TRACKING_PREFIXES = ['valkey.', 'database.unreachable', 'process.gateway', 'process.processor', 'port.', 'queue.vt:positions', 'pipeline.no-positions', 'tracking.'];

export function trackingIssues(issues: Issue[]): Issue[] {
  return issues.filter((i) => TRACKING_PREFIXES.some((p) => i.id === p.replace(/\.$/, '') || i.id.startsWith(p)));
}

/** Builds the public tracking report from a System Health collection (pure apart from the host name; unit-tested). */
export function trackingReport(c: Collected, host = hostname()): TrackingReport {
  const input = c.input;
  const issues = trackingIssues(c.issues);
  const status = worst(issues.map((i) => i.severity));
  const scrub = (s: string) => s.split(`${host}-`).join('');
  const gateways = input.processes.find((p) => p.role === 'gateway')?.instances ?? [];
  const processors = input.processes.find((p) => p.role === 'processor')?.instances ?? [];
  const spools = new Map(gatewaySpools(input).map((s) => [s.instanceId, s.spool]));
  const q = input.queues.find((x) => x.key === 'vt:positions') ?? null;
  const persisted = input.lastPersistedAt ?? null;
  return {
    ok: status === 'OK',
    status,
    at: new Date(input.now).toISOString(),
    issues: issues.map((i) => ({ id: scrub(i.id), severity: i.severity, message: scrub(i.message) })),
    cache: { reachable: input.valkey.reachable },
    database: { reachable: input.database.reachable },
    gateways: gateways.map((g, i) => {
      const m = g.metrics as GatewayMetrics;
      const s = spools.get(g.instanceId);
      return {
        instance: i + 1,
        connections: (m.listeners ?? []).reduce((sum, l) => sum + l.connections, 0),
        positionsPerSec: Math.round((m.listeners ?? []).reduce((sum, l) => sum + l.positionsPerSec, 0) * 10) / 10,
        spool: s ? { mode: s.mode, pendingEntries: s.pendingEntries, oldestSpooledAt: s.oldestSpooledAt, notAcked: s.notAcked } : null,
      };
    }),
    processors: processors.map((p, i) => {
      const m = p.metrics as ProcessorMetrics;
      return { instance: i + 1, lastBatchAt: m.lastBatchAt, processedPerSec: m.processedPerSec, duplicates: m.duplicates ?? null };
    }),
    stream: q ? { lag: q.lag, pending: q.pending, oldestPendingAgeSec: q.oldestPendingAgeSec } : null,
    lastPersistedAt: persisted ? new Date(persisted).toISOString() : null,
    lastPersistedAgeSec: persisted ? Math.max(0, Math.round((input.now - persisted) / 1000)) : null,
  };
}

/** Readiness and tracking probes behind the public /api/health endpoints. */
@Injectable()
export class HealthProbeService {
  private trackingCache: { at: number; report: Promise<TrackingReport> } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly health: SystemHealthService,
  ) {}

  async readiness(): Promise<ReadinessReport> {
    const [database, cache] = await Promise.all([this.database(), this.cache()]);
    const ok = database.ok && cache.ok;
    return { ok, status: ok ? 'OK' : 'CRITICAL', checks: { database, cache }, at: new Date().toISOString() };
  }

  tracking(): Promise<TrackingReport> {
    const now = Date.now();
    if (!this.trackingCache || now - this.trackingCache.at > TRACKING_CACHE_MS) {
      const report = this.health.collect(now).then((c) => trackingReport(c));
      report.catch(() => (this.trackingCache = null));
      this.trackingCache = { at: now, report };
    }
    return this.trackingCache.report;
  }

  private async database(): Promise<DependencyCheck> {
    const started = performance.now();
    try {
      await withTimeout(this.prisma.$queryRaw`SELECT 1`, DB_TIMEOUT_MS, 'PostgreSQL SELECT 1');
      return { ok: true, latencyMs: Math.round((performance.now() - started) * 10) / 10, error: null };
    } catch (error) {
      return { ok: false, latencyMs: null, error: shortError(error) };
    }
  }

  /**
   * The cache must accept a write, not just answer PING: XADD fails the same way a SET does when the server refuses
   * writes (MISCONF after a failed snapshot, OOM, read-only replica).
   */
  private async cache(): Promise<DependencyCheck> {
    const client = this.redis.client;
    if (client.status !== 'ready') return { ok: false, latencyMs: null, error: `cache connection is ${client.status}` };
    const started = performance.now();
    try {
      const key = `vt:health:probe:${process.pid}`;
      const value = String(Date.now());
      const [, got] = await withTimeout(Promise.all([client.set(key, value, 'PX', 10_000), client.get(key)]), CACHE_TIMEOUT_MS, 'cache SET/GET');
      if (got !== value) throw new Error('cache returned a different value');
      return { ok: true, latencyMs: Math.round((performance.now() - started) * 10) / 10, error: null };
    } catch (error) {
      return { ok: false, latencyMs: null, error: shortError(error) };
    }
  }
}

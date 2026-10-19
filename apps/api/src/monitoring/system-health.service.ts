import { Inject, Injectable } from '@nestjs/common';
import {
  DatabaseDto,
  GatewayMetrics,
  HealthEvent,
  HealthIssue,
  HostDto,
  NotifierMetrics,
  PortDto,
  ProcessHeartbeat,
  ProcessInstanceDto,
  ProcessorMetrics,
  ProcessRoleDto,
  PROCESS_ROLES,
  QueueDto,
  SystemHealthDto,
  ThroughputPoint,
  ValkeyDto,
} from '@veetracer/shared';
import { statfs } from 'node:fs/promises';
import { cpus, freemem, hostname, loadavg, platform, totalmem, uptime } from 'node:os';
import { join } from 'node:path';
import { NOTIFY_STREAM_MAXLEN } from '../alerts/alert-dto';
import { APP_ENV } from '../config/config.module';
import { APP_ROOT, AppEnv } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { positionsStreamMaxLen, RedisKeys } from '../redis/keys';
import { RedisService } from '../redis/redis.service';
import { bufferSecondsLeft, CheckInput, evaluateChecks, Issue, statusOf, worst } from './checks';
import { HEARTBEAT_TTL_SEC } from './heartbeat';
import { HealthThresholds, loadMonitorConfig, loadThresholds, MonitorConfig } from './thresholds';
import { pairs, parseInfo, shortError, streamIdTime, toNumber, withTimeout } from './util';

const TIMEOUT_MS = 2000;
/** Samples kept in `vt:health:series` (10 s each → a bit over an hour). */
export const SERIES_MAX = 400;
const SERIES_POINTS = 360;
export const EVENTS_MAX = 50;
/** Missing heartbeats of other processes right after the API starts are not "not running" yet. */
const STARTUP_GRACE_MS = 30_000;

/** One 10-second sample written by the sampler (cumulative counters; the report diffs consecutive samples). */
export interface SeriesSample {
  t: number;
  posAdded: number | null;
  posDone: number | null;
  lag: number | null;
  backlog: number | null;
  notifyAdded: number | null;
  notifyDone: number | null;
  notifySent: number;
  notifyFailed: number;
  pgInserts: number | null;
}

interface StreamDef {
  key: string;
  group: string;
  maxLength: number;
}

/** Raw stream/group numbers (shared by the report and the sampler). */
export interface StreamStats {
  exists: boolean;
  length: number;
  entriesAdded: number | null;
  entriesRead: number | null;
  lag: number | null;
  pending: number;
  consumers: { name: string; pending: number; idleMs: number }[];
  oldestPendingId: string | null;
}

export interface Collected {
  input: CheckInput;
  issues: Issue[];
  throughput: ThroughputPoint[];
}

/** Builds the System Health report: heartbeats, ports, queues, PostgreSQL, Valkey, host and the checks. */
@Injectable()
export class SystemHealthService {
  readonly thresholds: HealthThresholds = loadThresholds();
  readonly config: MonitorConfig = loadMonitorConfig();
  private readonly startedAt = Date.now();

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    @Inject(APP_ENV) private readonly env: AppEnv,
  ) {}

  get streams(): StreamDef[] {
    return [
      { key: RedisKeys.positionsStream, group: RedisKeys.processorGroup, maxLength: positionsStreamMaxLen() },
      { key: RedisKeys.notifyStream, group: RedisKeys.notifierGroup, maxLength: NOTIFY_STREAM_MAXLEN },
    ];
  }

  private get valkey() {
    return this.redis.client;
  }

  // ── report ────────────────────────────────────────────────────────────────

  async collect(now = Date.now()): Promise<Collected> {
    const [valkey, heartbeats, series, streamStats, database, host] = await Promise.all([
      this.valkeyInfo(),
      this.heartbeats().catch(() => [] as ProcessHeartbeat[]),
      this.series().catch(() => [] as SeriesSample[]),
      Promise.all(this.streams.map((s) => this.streamStats(s).catch(() => null))),
      this.database(),
      this.host(),
    ]);
    const processes = this.processes(heartbeats, now);
    const ports = this.ports(heartbeats);
    const rates = this.rates(series);
    const queues = this.streams.map((def, i) => this.queue(def, streamStats[i], rates[def.key], heartbeats, now));
    database.insertsPerMin = insertsPerMin(series);
    const input: CheckInput = {
      now,
      expectedRoles: this.config.expectedRoles,
      processes,
      ports,
      queues,
      database,
      valkey,
      host,
      notifications: this.notificationWindow(series),
      startupGrace: now - this.startedAt < STARTUP_GRACE_MS,
    };
    const issues = evaluateChecks(input, this.thresholds);
    applyStatuses(input, issues);
    return { input, issues, throughput: throughput(series) };
  }

  /** Full DTO: current checks with since-times from the monitor's stored state. */
  toDto(c: Collected, stored: HealthIssue[], events: HealthEvent[]): SystemHealthDto {
    const since = new Map(stored.map((i) => [i.id, i]));
    const generatedAt = new Date(c.input.now).toISOString();
    const issues: HealthIssue[] = c.issues.map((i) => {
      const s = since.get(i.id);
      return { ...i, since: s && s.severity === i.severity ? s.since : generatedAt };
    });
    return {
      status: worst(issues.map((i) => i.severity)),
      generatedAt,
      issues,
      events,
      processes: c.input.processes,
      ports: c.input.ports,
      queues: c.input.queues,
      database: c.input.database,
      valkey: c.input.valkey,
      host: c.input.host,
      throughput: c.throughput,
    };
  }

  // ── stored monitor state ───────────────────────────────────────────────────

  async storedIssues(): Promise<HealthIssue[]> {
    const raw = await withTimeout(this.valkey.hvals(RedisKeys.healthIssues), TIMEOUT_MS, 'Valkey HVALS');
    return raw.map((v) => JSON.parse(v) as HealthIssue);
  }

  async events(): Promise<HealthEvent[]> {
    const raw = await withTimeout(this.valkey.lrange(RedisKeys.healthEvents, 0, EVENTS_MAX - 1), TIMEOUT_MS, 'Valkey LRANGE');
    return raw.map((v) => JSON.parse(v) as HealthEvent);
  }

  // ── processes ──────────────────────────────────────────────────────────────

  async heartbeats(): Promise<ProcessHeartbeat[]> {
    const now = Date.now();
    const index = RedisKeys.healthProcessIndex;
    await withTimeout(this.valkey.zremrangebyscore(index, '-inf', now - HEARTBEAT_TTL_SEC * 3000), TIMEOUT_MS, 'Valkey ZREMRANGEBYSCORE');
    const keys = await withTimeout(this.valkey.zrange(index, 0, -1), TIMEOUT_MS, 'Valkey ZRANGE');
    if (!keys.length) return [];
    const values = await withTimeout(this.valkey.mget(keys), TIMEOUT_MS, 'Valkey MGET');
    const out: ProcessHeartbeat[] = [];
    for (const v of values) {
      if (!v) continue;
      try {
        out.push(JSON.parse(v) as ProcessHeartbeat);
      } catch {
        // ignore a malformed heartbeat
      }
    }
    return out;
  }

  private processes(heartbeats: ProcessHeartbeat[], now: number): ProcessRoleDto[] {
    const roles = [...new Set([...PROCESS_ROLES, ...heartbeats.map((h) => h.role)])];
    return roles.map((role) => ({
      role,
      status: 'OK',
      instances: heartbeats
        .filter((h) => h.role === role)
        .sort((a, b) => a.instanceId.localeCompare(b.instanceId))
        .map((h): ProcessInstanceDto => {
          const ageSec = Math.max(0, (now - Date.parse(h.at)) / 1000);
          return { ...h, status: 'OK', ageSec: Math.round(ageSec * 10) / 10, stale: ageSec > this.thresholds.heartbeatStaleSec };
        }),
    }));
  }

  /** Every configured protocol port (API env + whatever gateways report), aggregated over gateway instances. */
  private ports(heartbeats: ProcessHeartbeat[]): PortDto[] {
    const configured: [string, number][] = [
      ['gt06', this.env.gt06Port],
      ['teltonika', this.env.teltonikaPort],
      ['jt808', this.env.jt808Port],
    ];
    const listeners = heartbeats.filter((h) => h.role === 'gateway').flatMap((h) => (h.metrics as GatewayMetrics).listeners ?? []);
    const keys = new Map<string, [string, number]>();
    for (const [protocol, port] of configured) if (port) keys.set(`${protocol}:${port}`, [protocol, port]);
    for (const l of listeners) keys.set(`${l.protocol}:${l.port}`, [l.protocol, l.port]);
    return [...keys.values()].map(([protocol, port]) => {
      const ls = listeners.filter((l) => l.protocol === protocol && l.port === port);
      const sum = (f: (l: (typeof ls)[number]) => number) => ls.reduce((s, l) => s + f(l), 0);
      const latest = ls.map((l) => l.lastPacketAt).filter((x): x is string => !!x).sort().pop() ?? null;
      const listening = ls.some((l) => l.listening);
      return {
        protocol,
        port,
        status: 'OK',
        listening,
        instances: ls.length,
        error: listening ? null : (ls.find((l) => l.error)?.error ?? (ls.length ? null : 'no gateway reports this port')),
        connections: sum((l) => l.connections),
        positionsPerSec: Math.round(sum((l) => l.positionsPerSec) * 10) / 10,
        framesPerSec: Math.round(sum((l) => l.framesPerSec) * 10) / 10,
        dropped: sum((l) => l.dropped),
        errors: sum((l) => l.errors),
        enqueueFailures: sum((l) => l.enqueueFailures),
        lastPacketAt: latest,
      };
    });
  }

  // ── queues ─────────────────────────────────────────────────────────────────

  async streamStats(def: StreamDef): Promise<StreamStats> {
    const empty: StreamStats = { exists: false, length: 0, entriesAdded: null, entriesRead: null, lag: null, pending: 0, consumers: [], oldestPendingId: null };
    const exists = await withTimeout(this.valkey.exists(def.key), TIMEOUT_MS, 'Valkey EXISTS');
    if (!exists) return empty;
    const [stream, groups, consumers, oldest] = await withTimeout(
      Promise.all([
        this.valkey.xinfo('STREAM', def.key),
        this.valkey.xinfo('GROUPS', def.key) as Promise<unknown[]>,
        (this.valkey.xinfo('CONSUMERS', def.key, def.group) as Promise<unknown[]>).catch(() => [] as unknown[]),
        (this.valkey.xpending(def.key, def.group, '-', '+', 1) as Promise<unknown[]>).catch(() => [] as unknown[]),
      ]),
      TIMEOUT_MS,
      `Valkey XINFO ${def.key}`,
    );
    const s = pairs(stream);
    const g = (groups as unknown[]).map(pairs).find((x) => x.name === def.group);
    const first = Array.isArray(oldest) && Array.isArray(oldest[0]) ? String((oldest[0] as unknown[])[0]) : null;
    return {
      exists: true,
      length: toNumber(s.length) ?? 0,
      entriesAdded: toNumber(s['entries-added']),
      entriesRead: g ? toNumber(g['entries-read']) : null,
      lag: g ? toNumber(g.lag) : null,
      pending: g ? (toNumber(g.pending) ?? 0) : 0,
      consumers: (consumers as unknown[]).map(pairs).map((c) => ({ name: String(c.name), pending: toNumber(c.pending) ?? 0, idleMs: toNumber(c.idle) ?? 0 })),
      oldestPendingId: first,
    };
  }

  private queue(def: StreamDef, s: StreamStats | null, rate: { input: number | null; output: number | null } | undefined, heartbeats: ProcessHeartbeat[], now: number): QueueDto {
    const lag = s?.lag ?? (def.key === RedisKeys.positionsStream ? fallbackLag(heartbeats) : null);
    const pending = s?.pending ?? 0;
    const backlog = (lag ?? 0) + pending;
    const oldestAt = s?.oldestPendingId ? streamIdTime(s.oldestPendingId) : null;
    return {
      key: def.key,
      group: def.group,
      status: 'OK',
      length: s?.length ?? 0,
      maxLength: def.maxLength,
      entriesAdded: s?.entriesAdded ?? null,
      lag,
      pending,
      backlog,
      oldestPendingAgeSec: oldestAt !== null ? Math.max(0, Math.round((now - oldestAt) / 1000)) : null,
      consumers: s?.consumers ?? [],
      inputPerSec: rate?.input ?? null,
      bufferSecondsLeft: bufferSecondsLeft(def.maxLength, backlog, rate?.input ?? null, rate?.output ?? null),
    };
  }

  // ── series (sampler) ───────────────────────────────────────────────────────

  async series(): Promise<SeriesSample[]> {
    const raw = await withTimeout(this.valkey.lrange(RedisKeys.healthSeries, 0, SERIES_MAX - 1), TIMEOUT_MS, 'Valkey LRANGE');
    return raw.map((v) => JSON.parse(v) as SeriesSample).reverse(); // oldest first
  }

  /** Builds one sample (called every 10 s by the monitor). */
  async sample(): Promise<SeriesSample> {
    const [pos, notify] = await Promise.all(this.streams.map((s) => this.streamStats(s).catch(() => null)));
    const heartbeats = await this.heartbeats().catch(() => [] as ProcessHeartbeat[]);
    const notifiers = heartbeats.filter((h) => h.role === 'notifier').map((h) => h.metrics as NotifierMetrics);
    const total = (r: Record<string, number> | undefined) => Object.values(r ?? {}).reduce((a, b) => a + b, 0);
    const pgInserts = await withTimeout(
      this.prisma.$queryRaw<{ n: bigint }[]>`SELECT n_tup_ins AS n FROM pg_stat_user_tables WHERE relname = 'Position' LIMIT 1`,
      TIMEOUT_MS,
      'PostgreSQL',
    )
      .then((rows) => toNumber(rows[0]?.n))
      .catch(() => null);
    const done = (s: StreamStats | null) => (s?.entriesRead !== null && s?.entriesRead !== undefined ? s.entriesRead - s.pending : null);
    return {
      t: Date.now(),
      posAdded: pos?.entriesAdded ?? null,
      posDone: done(pos) ?? sumProcessed(heartbeats),
      lag: pos?.lag ?? null,
      backlog: pos ? (pos.lag ?? 0) + pos.pending : null,
      notifyAdded: notify?.entriesAdded ?? null,
      notifyDone: done(notify),
      notifySent: notifiers.reduce((s, n) => s + total(n.sent), 0),
      notifyFailed: notifiers.reduce((s, n) => s + total(n.failed), 0),
      pgInserts,
    };
  }

  async pushSample(sample: SeriesSample): Promise<void> {
    await withTimeout(
      this.valkey.multi().lpush(RedisKeys.healthSeries, JSON.stringify(sample)).ltrim(RedisKeys.healthSeries, 0, SERIES_MAX - 1).exec(),
      TIMEOUT_MS,
      'Valkey LPUSH',
    );
  }

  /** Input/output rates per stream averaged over the last ~30 s of samples. */
  private rates(series: SeriesSample[]): Record<string, { input: number | null; output: number | null }> {
    const last = series[series.length - 1];
    const base = series[Math.max(0, series.length - 4)];
    const out: Record<string, { input: number | null; output: number | null }> = {};
    if (!last || !base || last === base || Date.now() - last.t > 60_000) return out;
    const sec = (last.t - base.t) / 1000;
    const rate = (a: number | null, b: number | null) => (a !== null && b !== null && a >= b ? Math.round(((a - b) / sec) * 10) / 10 : null);
    out[RedisKeys.positionsStream] = { input: rate(last.posAdded, base.posAdded), output: rate(last.posDone, base.posDone) };
    out[RedisKeys.notifyStream] = { input: rate(last.notifyAdded, base.notifyAdded), output: rate(last.notifyDone, base.notifyDone) };
    return out;
  }

  private notificationWindow(series: SeriesSample[]): { sent: number; failed: number } | null {
    const last = series[series.length - 1];
    if (!last) return null;
    const from = last.t - this.thresholds.notifyFailWindowMin * 60_000;
    const base = series.find((s) => s.t >= from) ?? last;
    // Counters restart with the notifier; a drop means a restart → count from zero.
    const sent = last.notifySent >= base.notifySent ? last.notifySent - base.notifySent : last.notifySent;
    const failed = last.notifyFailed >= base.notifyFailed ? last.notifyFailed - base.notifyFailed : last.notifyFailed;
    return { sent, failed };
  }

  // ── stores and host ────────────────────────────────────────────────────────

  async database(): Promise<DatabaseDto> {
    const dto: DatabaseDto = {
      status: 'OK',
      reachable: false,
      error: null,
      latencyMs: null,
      activeConnections: null,
      totalConnections: null,
      maxConnections: null,
      sizeBytes: null,
      topTables: [],
      insertsPerMin: null,
    };
    const started = performance.now();
    try {
      await withTimeout(this.prisma.$queryRaw`SELECT 1`, TIMEOUT_MS, 'SELECT 1');
      dto.latencyMs = Math.round((performance.now() - started) * 10) / 10;
      dto.reachable = true;
    } catch (error) {
      dto.error = shortError(error);
      return dto;
    }
    const q = <T>(p: Promise<T>) => withTimeout(p, TIMEOUT_MS, 'PostgreSQL').catch(() => null);
    const [conn, max, size, tables] = await Promise.all([
      q(this.prisma.$queryRaw<{ active: bigint; total: bigint }[]>`
        SELECT count(*) FILTER (WHERE state = 'active') AS active, count(*) AS total
        FROM pg_stat_activity WHERE datname = current_database()`),
      q(this.prisma.$queryRaw<{ max: string }[]>`SELECT current_setting('max_connections') AS max`),
      q(this.prisma.$queryRaw<{ bytes: bigint }[]>`SELECT pg_database_size(current_database()) AS bytes`),
      q(this.prisma.$queryRaw<{ name: string; bytes: bigint }[]>`
        SELECT c.relname AS name, pg_total_relation_size(c.oid) AS bytes
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r', 'p') AND n.nspname = 'public'
        ORDER BY 2 DESC LIMIT 5`),
    ]);
    dto.activeConnections = toNumber(conn?.[0]?.active);
    dto.totalConnections = toNumber(conn?.[0]?.total);
    dto.maxConnections = toNumber(max?.[0]?.max);
    dto.sizeBytes = toNumber(size?.[0]?.bytes);
    dto.topTables = (tables ?? []).map((t) => ({ name: t.name, bytes: toNumber(t.bytes) ?? 0 }));
    return dto;
  }

  async valkeyInfo(): Promise<ValkeyDto> {
    const dto: ValkeyDto = {
      status: 'OK',
      reachable: false,
      error: null,
      version: null,
      latencyMs: null,
      usedMemory: null,
      maxMemory: null,
      memoryPercent: null,
      aofEnabled: null,
      rdbLastSaveStatus: null,
      rdbLastSaveAt: null,
      connectedClients: null,
      evictedKeys: null,
    };
    try {
      const started = performance.now();
      await withTimeout(this.valkey.ping(), TIMEOUT_MS, 'PING');
      dto.latencyMs = Math.round((performance.now() - started) * 10) / 10;
      dto.reachable = true;
      const info = parseInfo(await withTimeout(this.valkey.info(), TIMEOUT_MS, 'INFO'));
      dto.version = info.valkey_version ?? info.redis_version ?? null;
      dto.usedMemory = toNumber(info.used_memory);
      dto.maxMemory = toNumber(info.maxmemory);
      dto.memoryPercent = dto.maxMemory && dto.usedMemory !== null ? Math.round((dto.usedMemory / dto.maxMemory) * 1000) / 10 : null;
      dto.aofEnabled = info.aof_enabled !== undefined ? info.aof_enabled === '1' : null;
      dto.rdbLastSaveStatus = info.rdb_last_bgsave_status ?? null;
      const saved = toNumber(info.rdb_last_save_time);
      dto.rdbLastSaveAt = saved ? new Date(saved * 1000).toISOString() : null;
      dto.connectedClients = toNumber(info.connected_clients);
      dto.evictedKeys = toNumber(info.evicted_keys);
    } catch (error) {
      dto.error = shortError(error);
    }
    return dto;
  }

  async host(): Promise<HostDto> {
    const dataDir = this.config.dataDir ?? join(APP_ROOT, 'var');
    let diskTotal: number | null = null;
    let diskFree: number | null = null;
    try {
      const s = await statfs(dataDir);
      diskTotal = s.blocks * s.bsize;
      diskFree = s.bavail * s.bsize;
    } catch {
      // directory missing / unsupported: leave unknown
    }
    return {
      status: 'OK',
      hostname: hostname(),
      platform: platform(),
      dataDir,
      diskTotal,
      diskFree,
      diskFreePercent: diskTotal && diskFree !== null ? Math.round((diskFree / diskTotal) * 1000) / 10 : null,
      loadAvg: loadavg().map((l) => Math.round(l * 100) / 100),
      cpus: cpus().length,
      memTotal: totalmem(),
      memFree: freemem(),
      uptimeSec: Math.round(uptime()),
    };
  }
}

function sumProcessed(heartbeats: ProcessHeartbeat[]): number | null {
  const ps = heartbeats.filter((h) => h.role === 'processor');
  return ps.length ? ps.reduce((s, h) => s + ((h.metrics as ProcessorMetrics).processed ?? 0), 0) : null;
}

function fallbackLag(heartbeats: ProcessHeartbeat[]): number | null {
  const lags = heartbeats.filter((h) => h.role === 'processor').map((h) => (h.metrics as ProcessorMetrics).lag);
  return lags.find((l): l is number => typeof l === 'number') ?? null;
}

/** Received vs processed per 10 s from consecutive samples (oldest first). */
export function throughput(series: SeriesSample[]): ThroughputPoint[] {
  const points: ThroughputPoint[] = [];
  for (let i = Math.max(1, series.length - SERIES_POINTS); i < series.length; i++) {
    const a = series[i - 1];
    const b = series[i];
    // A gap (API restarted, sampler down) is not one huge interval.
    if (b.t - a.t > 30_000) continue;
    const diff = (x: number | null, y: number | null) => (x !== null && y !== null && x >= y ? x - y : 0);
    points.push({ t: new Date(b.t).toISOString(), received: diff(b.posAdded, a.posAdded), processed: diff(b.posDone, a.posDone), lag: b.lag, backlog: b.backlog });
  }
  return points;
}

/** n_tup_ins delta over the last minute of samples. */
function insertsPerMin(series: SeriesSample[]): number | null {
  const last = series[series.length - 1];
  if (!last || last.pgInserts === null || Date.now() - last.t > 60_000) return null;
  const base = [...series].reverse().find((s) => s.pgInserts !== null && last.t - s.t >= 55_000);
  if (!base || base.pgInserts === null || last.pgInserts < base.pgInserts) return null;
  return Math.round(((last.pgInserts - base.pgInserts) * 60_000) / (last.t - base.t));
}

/** Writes each item's status from the issues that concern it. */
function applyStatuses(input: CheckInput, issues: Issue[]): void {
  for (const group of input.processes) {
    for (const p of group.instances) p.status = statusOf(issues, `process.${p.role}.${p.instanceId}`);
    group.status = statusOf(issues, `process.${group.role}`);
  }
  for (const port of input.ports) port.status = statusOf(issues, `port.${port.protocol}.${port.port}`);
  for (const q of input.queues) q.status = statusOf(issues, `queue.${q.key}`);
  input.database.status = statusOf(issues, 'database');
  input.valkey.status = statusOf(issues, 'valkey');
  input.host.status = statusOf(issues, 'host');
}

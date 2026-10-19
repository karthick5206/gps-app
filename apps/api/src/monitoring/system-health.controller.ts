import { Controller, ForbiddenException, Get, HttpCode, HttpException, Injectable, Post, Req, Res, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import {
  Action,
  GatewayMetrics,
  NotifierMetrics,
  ProcessorMetrics,
  SystemAlertTestResult,
  SystemHealthDto,
  SystemHealthSettingsDto,
  SystemHealthSummary,
} from '@veetracer/shared';
import { Request, Response } from 'express';
import { hasPermission } from '../access/access-rules';
import { AuthContextService } from '../access/auth-context.service';
import { Public } from '../access/decorators';
import { MailerService } from '../auth/mailer.service';
import { worst } from './checks';
import { SystemHealthService } from './system-health.service';
import { SystemMonitorService } from './system-monitor.service';
import { thresholdList } from './thresholds';
import { withTimeout } from './util';

/**
 * Super Admin access that keeps working while PostgreSQL is down: the normal guard needs the database (session and
 * user lookup); when that lookup fails for a reason other than a rejected token, the signed access token's Super
 * Admin claim (valid for 15 minutes) is accepted.
 */
@Injectable()
export class SuperAdminAccess {
  constructor(private readonly contexts: AuthContextService) {}

  async authorize(req: Request, action: Action | null): Promise<void> {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedException('Missing access token');
    const token = header.slice(7);
    const payload = this.contexts.verifyToken(token);
    try {
      const ctx = await withTimeout(this.contexts.fromToken(token, undefined, req.ip ?? null), 3000, 'Authentication');
      if (action ? !hasPermission(ctx, 'sa_system_health', action) : !ctx.isSuperAdmin) throw new ForbiddenException('Permission denied');
    } catch (error) {
      if (error instanceof HttpException) throw error;
      if (!payload.sa) throw new ServiceUnavailableException('Database unavailable');
    }
  }
}

@Controller('admin/system-health')
export class SystemHealthController {
  constructor(
    private readonly access: SuperAdminAccess,
    private readonly health: SystemHealthService,
    private readonly monitor: SystemMonitorService,
    private readonly mailer: MailerService,
  ) {}

  /** Full report: processes, ports, queues, PostgreSQL, Valkey, host, throughput, active issues and recent events. */
  @Public() @Get()
  async report(@Req() req: Request): Promise<SystemHealthDto> {
    await this.access.authorize(req, 'view');
    const [collected, stored] = await Promise.all([this.health.collect(), this.monitor.storedState()]);
    return this.health.toDto(collected, stored.issues, stored.events);
  }

  /** Last evaluation of the monitor (cheap; for the top-bar banner). */
  @Public() @Get('status')
  async status(@Req() req: Request): Promise<SystemHealthSummary> {
    await this.access.authorize(req, 'view');
    const { issues } = await this.monitor.storedState();
    return { status: worst(issues.map((i) => i.severity)), issues, at: new Date().toISOString() };
  }

  @Public() @Get('settings')
  async settings(@Req() req: Request): Promise<SystemHealthSettingsDto> {
    await this.access.authorize(req, 'view');
    await this.monitor.recipients();
    return {
      superAdminEmail: this.monitor.cachedSuperAdminEmail,
      extraRecipients: this.health.config.alertEmails,
      cooldownMin: this.health.config.cooldownMin,
      mailProvider: this.mailer.provider,
      thresholds: thresholdList(this.health.thresholds),
    };
  }

  @Public() @Post('test-alert') @HttpCode(200)
  async testAlert(@Req() req: Request): Promise<SystemAlertTestResult> {
    await this.access.authorize(req, 'edit');
    return this.monitor.sendTest();
  }
}

// ── Prometheus ─────────────────────────────────────────────────────────────

const label = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ');
const STATUS_VALUE = { OK: 0, WARN: 1, CRITICAL: 2 } as const;

class Exposition {
  private readonly lines: string[] = [];
  private readonly seen = new Set<string>();

  add(name: string, help: string, type: 'gauge' | 'counter', value: number | null | undefined, labels: Record<string, string | number> = {}): void {
    if (value === null || value === undefined || !Number.isFinite(value)) return;
    if (!this.seen.has(name)) {
      this.seen.add(name);
      this.lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    }
    const l = Object.entries(labels).map(([k, v]) => `${k}="${label(String(v))}"`);
    this.lines.push(`${name}${l.length ? `{${l.join(',')}}` : ''} ${value}`);
  }

  toString(): string {
    return `${this.lines.join('\n')}\n`;
  }
}

/**
 * `GET /api/metrics` in Prometheus text format (for Grafana). Authorization: `Bearer <METRICS_TOKEN>` or a Super
 * Admin access token.
 */
@Controller('metrics')
export class MetricsController {
  constructor(
    private readonly access: SuperAdminAccess,
    private readonly health: SystemHealthService,
  ) {}

  @Public() @Get()
  async metrics(@Req() req: Request, @Res() res: Response): Promise<void> {
    const token = this.health.config.metricsToken;
    if (!token || req.headers.authorization !== `Bearer ${token}`) await this.access.authorize(req, null);
    const collected = await this.health.collect();
    const c = collected.input;
    const issues = evaluateCount(collected.issues);
    const m = new Exposition();
    m.add('vt_health_status', 'Overall status (0 ok, 1 warn, 2 critical)', 'gauge', STATUS_VALUE[issues.status]);
    m.add('vt_health_issues', 'Active issues', 'gauge', issues.warn, { severity: 'warn' });
    m.add('vt_health_issues', 'Active issues', 'gauge', issues.critical, { severity: 'critical' });
    for (const group of c.processes) {
      m.add('vt_process_instances', 'Live instances per role', 'gauge', group.instances.length, { role: group.role });
      for (const p of group.instances) {
        const l = { role: p.role, instance: p.instanceId, host: p.host, version: p.version };
        m.add('vt_process_uptime_seconds', 'Process uptime', 'gauge', p.uptimeSec, l);
        m.add('vt_process_cpu_percent', 'CPU over the last heartbeat interval', 'gauge', p.cpuPercent, l);
        m.add('vt_process_rss_bytes', 'Resident memory', 'gauge', p.rssBytes, l);
        m.add('vt_process_heap_used_bytes', 'V8 heap used', 'gauge', p.heapUsed, l);
        m.add('vt_process_event_loop_lag_ms', 'Event-loop delay p99', 'gauge', p.eventLoopLagMs, l);
        m.add('vt_process_heartbeat_age_seconds', 'Seconds since the last heartbeat', 'gauge', p.ageSec, l);
        if (p.role === 'processor') {
          const pm = p.metrics as ProcessorMetrics;
          m.add('vt_processor_processed_total', 'Positions processed since start', 'counter', pm.processed, l);
          m.add('vt_processor_db_errors_total', 'Database write failures since start', 'counter', pm.dbErrors, l);
          m.add('vt_processor_avg_batch_ms', 'Average batch time', 'gauge', pm.avgBatchMs, l);
        }
        if (p.role === 'notifier') {
          const nm = p.metrics as NotifierMetrics;
          for (const [channel, n] of Object.entries(nm.sent)) m.add('vt_notifier_sent_total', 'Notifications sent since start', 'counter', n, { ...l, channel });
          for (const [channel, n] of Object.entries(nm.failed)) m.add('vt_notifier_failed_total', 'Notifications failed since start', 'counter', n, { ...l, channel });
        }
        if (p.role === 'gateway') {
          for (const g of (p.metrics as GatewayMetrics).listeners) {
            const gl = { ...l, protocol: g.protocol, port: g.port };
            m.add('vt_gateway_positions_total', 'Positions received since start', 'counter', g.positions, gl);
            m.add('vt_gateway_frames_total', 'Frames received since start', 'counter', g.frames, gl);
            m.add('vt_gateway_enqueue_failures_total', 'Positions not queued (not acknowledged)', 'counter', g.enqueueFailures, gl);
          }
        }
      }
    }
    for (const p of c.ports) {
      const l = { protocol: p.protocol, port: p.port };
      m.add('vt_port_listening', 'A gateway listens on the port', 'gauge', p.listening ? 1 : 0, l);
      m.add('vt_port_connections', 'Open device connections', 'gauge', p.connections, l);
      m.add('vt_port_positions_per_second', 'Positions per second', 'gauge', p.positionsPerSec, l);
      m.add('vt_port_dropped_total', 'Garbage / corrupt frames dropped', 'counter', p.dropped, l);
      m.add('vt_port_errors_total', 'Decode errors', 'counter', p.errors, l);
    }
    for (const q of c.queues) {
      const l = { stream: q.key, group: q.group };
      m.add('vt_queue_length', 'Stream length', 'gauge', q.length, l);
      m.add('vt_queue_max_length', 'Stream MAXLEN', 'gauge', q.maxLength, l);
      m.add('vt_queue_lag', 'Entries not yet delivered to the group', 'gauge', q.lag, l);
      m.add('vt_queue_pending', 'Delivered, not acknowledged', 'gauge', q.pending, l);
      m.add('vt_queue_oldest_pending_seconds', 'Age of the oldest pending entry', 'gauge', q.oldestPendingAgeSec, l);
      m.add('vt_queue_entries_added_total', 'Entries added since the stream was created', 'counter', q.entriesAdded, l);
      m.add('vt_queue_buffer_seconds_left', 'Seconds until unprocessed entries get trimmed', 'gauge', q.bufferSecondsLeft, l);
    }
    const db = c.database;
    m.add('vt_db_up', 'PostgreSQL reachable', 'gauge', db.reachable ? 1 : 0);
    m.add('vt_db_latency_ms', 'SELECT 1 latency', 'gauge', db.latencyMs);
    m.add('vt_db_connections', 'Connections to this database', 'gauge', db.activeConnections, { state: 'active' });
    m.add('vt_db_connections', 'Connections to this database', 'gauge', db.totalConnections, { state: 'total' });
    m.add('vt_db_max_connections', 'max_connections', 'gauge', db.maxConnections);
    m.add('vt_db_size_bytes', 'Database size', 'gauge', db.sizeBytes);
    m.add('vt_db_position_inserts_per_minute', 'Rows inserted into Position in the last minute', 'gauge', db.insertsPerMin);
    const v = c.valkey;
    m.add('vt_valkey_up', 'Valkey reachable', 'gauge', v.reachable ? 1 : 0);
    m.add('vt_valkey_latency_ms', 'PING latency', 'gauge', v.latencyMs);
    m.add('vt_valkey_used_memory_bytes', 'used_memory', 'gauge', v.usedMemory);
    m.add('vt_valkey_max_memory_bytes', 'maxmemory (0 = unlimited)', 'gauge', v.maxMemory);
    m.add('vt_valkey_aof_enabled', 'appendonly', 'gauge', v.aofEnabled === null ? null : v.aofEnabled ? 1 : 0);
    m.add('vt_valkey_connected_clients', 'Connected clients', 'gauge', v.connectedClients);
    m.add('vt_valkey_evicted_keys_total', 'Evicted keys', 'counter', v.evictedKeys);
    const h = c.host;
    m.add('vt_host_disk_free_bytes', 'Free disk space for the data directory', 'gauge', h.diskFree, { path: h.dataDir });
    m.add('vt_host_disk_total_bytes', 'Disk size for the data directory', 'gauge', h.diskTotal, { path: h.dataDir });
    m.add('vt_host_load1', '1-minute load average (API host)', 'gauge', h.loadAvg[0]);
    m.add('vt_host_memory_free_bytes', 'Free memory (API host)', 'gauge', h.memFree);
    m.add('vt_host_memory_total_bytes', 'Total memory (API host)', 'gauge', h.memTotal);
    res.type('text/plain; version=0.0.4').send(m.toString());
  }
}

function evaluateCount(issues: { severity: 'WARN' | 'CRITICAL' }[]) {
  const warn = issues.filter((i) => i.severity === 'WARN').length;
  const critical = issues.filter((i) => i.severity === 'CRITICAL').length;
  return { warn, critical, status: critical ? ('CRITICAL' as const) : warn ? ('WARN' as const) : ('OK' as const) };
}

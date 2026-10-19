import {
  DatabaseDto,
  HealthIssue,
  HealthStatus,
  HostDto,
  PortDto,
  ProcessInstanceDto,
  ProcessorMetrics,
  ProcessRole,
  ProcessRoleDto,
  QueueDto,
  ValkeyDto,
} from '@veetracer/shared';
import { HealthThresholds } from './thresholds';

/** Everything the checks look at (collected by SystemHealthService). */
export interface CheckInput {
  now: number;
  expectedRoles: ProcessRole[];
  processes: ProcessRoleDto[];
  ports: PortDto[];
  queues: QueueDto[];
  database: DatabaseDto;
  valkey: ValkeyDto;
  host: HostDto;
  /** Notification results summed over the failure window; null when unknown. */
  notifications: { sent: number; failed: number } | null;
  /** Shortly after the API started the other processes may not have written a heartbeat yet. */
  startupGrace: boolean;
}

export type Issue = Omit<HealthIssue, 'since'>;

const RANK: Record<HealthStatus, number> = { OK: 0, WARN: 1, CRITICAL: 2 };

export function worst(statuses: Iterable<HealthStatus>): HealthStatus {
  let w: HealthStatus = 'OK';
  for (const s of statuses) if (RANK[s] > RANK[w]) w = s;
  return w;
}

/** Status of everything under an id prefix (`process.gateway` covers `process.gateway.<instance>.stale`). */
export function statusOf(issues: Issue[], prefix: string): HealthStatus {
  return worst(issues.filter((i) => i.id === prefix || i.id.startsWith(`${prefix}.`)).map((i) => i.severity));
}

const fmt = (n: number) => Math.round(n).toLocaleString('en-IN');
const minutes = (sec: number) => (sec < 120 ? `${Math.round(sec)} s` : `${Math.round(sec / 60)} min`);

function processChecks(input: CheckInput, t: HealthThresholds, out: Issue[]): void {
  for (const role of input.expectedRoles) {
    const group = input.processes.find((p) => p.role === role);
    if (!group?.instances.length && !input.startupGrace) {
      out.push({ id: `process.${role}`, check: `${role} process`, section: 'processes', severity: 'CRITICAL', message: `No ${role} process is running (no heartbeat).` });
    }
  }
  for (const group of input.processes) {
    for (const p of group.instances) {
      const base = `process.${p.role}.${p.instanceId}`;
      if (p.ageSec > t.heartbeatStaleSec) {
        out.push({ id: `${base}.stale`, check: `${p.role} heartbeat`, section: 'processes', severity: 'CRITICAL', message: `${p.role} ${p.instanceId} has not reported for ${Math.round(p.ageSec)} s (hung or stopping).` });
      }
      if (p.eventLoopLagMs > t.eventLoopWarnMs) {
        out.push({ id: `${base}.eventloop`, check: `${p.role} event loop`, section: 'processes', severity: 'WARN', message: `${p.role} ${p.instanceId} event-loop lag p99 is ${fmt(p.eventLoopLagMs)} ms (> ${t.eventLoopWarnMs} ms).` });
      }
      if (p.role === 'processor') processorDb(p, input.now, t, base, out);
    }
  }
}

function processorDb(p: ProcessInstanceDto, now: number, t: HealthThresholds, base: string, out: Issue[]): void {
  const m = p.metrics as ProcessorMetrics;
  const err = m?.lastDbError;
  if (!err) return;
  const at = Date.parse(err.at);
  const ok = m.lastDbOkAt ? Date.parse(m.lastDbOkAt) : 0;
  if (at > ok && now - at <= t.dbErrorWindowSec * 1000) {
    out.push({
      id: `${base}.database`,
      check: 'processor database writes',
      section: 'processes',
      severity: 'CRITICAL',
      message: `Processor ${p.instanceId} cannot write to the database (${m.dbErrors} error(s) since start, retrying every ${Math.round((m.backoffMs || 1000) / 1000)} s): ${err.message}`,
    });
  }
}

function portChecks(input: CheckInput, t: HealthThresholds, out: Issue[]): void {
  for (const port of input.ports) {
    if (!port.listening) {
      out.push({
        id: `port.${port.protocol}.${port.port}`,
        check: `${port.protocol} port ${port.port}`,
        section: 'ports',
        severity: 'CRITICAL',
        message: `Nothing is listening on ${port.protocol} port ${port.port}${port.error ? ` (${port.error})` : ''}; devices of this protocol cannot connect.`,
      });
    }
  }
  // Devices are connected but no positions arrive: a decoder problem, or every device is parked (heartbeats only).
  const gateways = input.processes.find((p) => p.role === 'gateway')?.instances ?? [];
  const connections = input.ports.reduce((s, p) => s + p.connections, 0);
  if (!gateways.length || connections === 0) return;
  const lastPositions = gateways.flatMap((g) => (g.metrics as { listeners?: { lastPositionAt: string | null }[] }).listeners ?? []).map((l) => (l.lastPositionAt ? Date.parse(l.lastPositionAt) : 0));
  const since = Math.max(...lastPositions, Math.min(...gateways.map((g) => Date.parse(g.startedAt))));
  const idleSec = (input.now - since) / 1000;
  if (idleSec > t.noPositionsWarnMin * 60) {
    out.push({
      id: 'pipeline.no-positions',
      check: 'positions received',
      section: 'pipeline',
      severity: 'WARN',
      message: `No positions received for ${minutes(idleSec)} although ${fmt(connections)} device connection(s) are open.`,
    });
  }
}

function queueChecks(input: CheckInput, t: HealthThresholds, out: Issue[]): void {
  for (const q of input.queues) {
    const base = `queue.${q.key}`;
    if (q.key === 'vt:positions' && q.lag !== null) {
      const severity = q.lag > t.queueLagCrit ? 'CRITICAL' : q.lag > t.queueLagWarn ? 'WARN' : null;
      if (severity) {
        out.push({ id: `${base}.lag`, check: 'positions queue lag', section: 'queues', severity, message: `${fmt(q.lag)} positions are waiting for the processor (> ${fmt(severity === 'CRITICAL' ? t.queueLagCrit : t.queueLagWarn)}).` });
      }
    }
    if (q.oldestPendingAgeSec !== null && q.oldestPendingAgeSec > t.pendingAgeWarnSec) {
      out.push({
        id: `${base}.pending-age`,
        check: `${q.key} pending entries`,
        section: 'queues',
        severity: 'WARN',
        message: `The oldest unacknowledged entry in ${q.key} is ${minutes(q.oldestPendingAgeSec)} old (${fmt(q.pending)} pending).`,
      });
    }
    if (q.bufferSecondsLeft !== null) {
      const min = q.bufferSecondsLeft / 60;
      const severity = min < t.bufferCritMin ? 'CRITICAL' : min < t.bufferWarnMin ? 'WARN' : null;
      if (severity) {
        out.push({
          id: `${base}.buffer`,
          check: `${q.key} buffer`,
          section: 'queues',
          severity,
          message: `At the current rate ${q.key} reaches its cap of ${fmt(q.maxLength)} in ${minutes(q.bufferSecondsLeft)}; unprocessed entries would then be trimmed (lost).`,
        });
      }
    }
  }
}

function storeChecks(input: CheckInput, t: HealthThresholds, out: Issue[]): void {
  const { database: db, valkey: v, host } = input;
  if (!db.reachable) {
    out.push({ id: 'database.unreachable', check: 'database', section: 'database', severity: 'CRITICAL', message: `PostgreSQL is not reachable from the API: ${db.error ?? 'no response'}` });
  } else if (db.latencyMs !== null && db.latencyMs > t.dbLatencyWarnMs) {
    out.push({ id: 'database.latency', check: 'database latency', section: 'database', severity: 'WARN', message: `PostgreSQL answered SELECT 1 in ${fmt(db.latencyMs)} ms (> ${t.dbLatencyWarnMs} ms).` });
  }
  if (!v.reachable) {
    out.push({ id: 'valkey.unreachable', check: 'valkey', section: 'valkey', severity: 'CRITICAL', message: `Valkey is not reachable: ${v.error ?? 'no response'}. Devices' positions cannot be queued.` });
  } else {
    if (v.memoryPercent !== null) {
      const severity = v.memoryPercent > t.valkeyMemCritPct ? 'CRITICAL' : v.memoryPercent > t.valkeyMemWarnPct ? 'WARN' : null;
      if (severity) {
        out.push({ id: 'valkey.memory', check: 'valkey memory', section: 'valkey', severity, message: `Valkey uses ${v.memoryPercent.toFixed(1)}% of maxmemory.` });
      }
    }
    if (v.aofEnabled === false) {
      out.push({
        id: 'valkey.aof',
        check: 'valkey persistence',
        section: 'valkey',
        severity: 'WARN',
        message: 'Valkey appendonly is off: queued positions and live state since the last RDB snapshot are lost if Valkey restarts. Set appendonly yes in production.',
      });
    }
    if (v.rdbLastSaveStatus && v.rdbLastSaveStatus !== 'ok') {
      out.push({ id: 'valkey.rdb', check: 'valkey snapshot', section: 'valkey', severity: 'WARN', message: `The last Valkey RDB save failed (${v.rdbLastSaveStatus}).` });
    }
  }
  if (host.diskFreePercent !== null) {
    const severity = host.diskFreePercent < t.diskCritPct ? 'CRITICAL' : host.diskFreePercent < t.diskWarnPct ? 'WARN' : null;
    if (severity) {
      out.push({ id: 'host.disk', check: 'disk space', section: 'host', severity, message: `Only ${host.diskFreePercent.toFixed(1)}% disk space is free on ${host.dataDir}.` });
    }
  }
}

function notifierChecks(input: CheckInput, t: HealthThresholds, out: Issue[]): void {
  const n = input.notifications;
  if (!n) return;
  const attempts = n.sent + n.failed;
  if (attempts < t.notifyFailMinAttempts) return;
  const pct = (n.failed / attempts) * 100;
  if (pct > t.notifyFailWarnPct) {
    out.push({
      id: 'pipeline.notifier-failures',
      check: 'notification delivery',
      section: 'pipeline',
      severity: 'WARN',
      message: `${pct.toFixed(0)}% of notifications failed in the last ${t.notifyFailWindowMin} min (${n.failed} of ${attempts}).`,
    });
  }
}

/** All checks; returns the issues that are currently WARN or CRITICAL. Pure (unit-tested). */
export function evaluateChecks(input: CheckInput, t: HealthThresholds): Issue[] {
  const out: Issue[] = [];
  processChecks(input, t, out);
  portChecks(input, t, out);
  queueChecks(input, t, out);
  storeChecks(input, t, out);
  notifierChecks(input, t, out);
  return out.sort((a, b) => RANK[b.severity] - RANK[a.severity] || a.id.localeCompare(b.id));
}

/** (maxLength − backlog) / net fill rate: how long until unprocessed entries get trimmed; null when not filling. */
export function bufferSecondsLeft(maxLength: number, backlog: number, inputPerSec: number | null, outputPerSec: number | null): number | null {
  if (inputPerSec === null) return null;
  const net = inputPerSec - (outputPerSec ?? 0);
  if (net <= 0.5) return null;
  return Math.max(0, (maxLength - backlog) / net);
}

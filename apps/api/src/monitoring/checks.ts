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
  RoutingHealthDto,
  QueueDto,
  SpoolMetrics,
  ValkeyDto,
} from '@veetracer/shared';
import { isFailing, relayStatsFromHeartbeats } from '../relay/stats';
import { MapServiceState } from './map-services';
import { matrixHealthIssues, MatrixStatsSnapshot } from '../routing/matrix/matrix-metrics';
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
  /**
   * Epoch ms of the newest position batch committed to PostgreSQL (max Device.lastSeenAt, written in the same
   * transaction as the positions); null when unknown or there is none. Undefined: not collected.
   */
  lastPersistedAt?: number | null;
  /** Map-service probes (map-services.ts). Undefined: not collected. */
  maps?: MapServiceState[];
  /**
   * D6 G2 alert notification state from PostgreSQL (SystemHealthService.notifyBacklog). Undefined: not collected;
   * null: the database could not be asked (the database.* issues report that).
   */
  notify?: NotifyBacklog | null;
  /**
   * E5 security review L3: the ETMS transport notification relay (API process, every 30 s). Undefined: not collected
   * (ETMS or the relay switched off); null: Valkey could not be asked. lastOkAt null = no pass recorded yet.
   */
  etmsRelay?: { lastOkAt: number | null; hwm: number | null; full: boolean } | null;
  /** ETMS E4 routing worker / optimiser / job queue. Undefined: not collected; enabled false: nothing checked. */
  routing?: RoutingHealthDto;
  /**
   * E4 WP 4.1b: the last travel-time matrix builds (Valkey `vt:etms:mx:stats`, written by whichever process built
   * them). Undefined: ETMS_ROUTING off; null: nothing recorded or Valkey could not be asked.
   */
  etmsMatrix?: MatrixStatsSnapshot | null;
}

/** Alert types whose DEAD notification job is CRITICAL (D6 G2, owner decision: SOS / CRASH). */
export const CRITICAL_NOTIFY_TYPES: readonly string[] = ['SOS', 'CRASH'];

/** DEAD and un-notified alerts (D6 G2), two indexed counts on "Alert". */
export interface NotifyBacklog {
  /** Alerts whose notification job was declared DEAD ("notifyError") in the last notifyDeadWindowHours, per type. */
  dead: { type: string; count: number; latestId: string; latestError: string }[];
  /** Alerts without a finished job (notifiedAt / notifyError NULL, ≤ 24 h) older than notifyUnqueuedWarnMin. */
  unqueued: number;
  /** … of which older than notifyUnqueuedCritMin. */
  unqueuedCrit: number;
  /** Age of the oldest of them; null when there is none. */
  oldestUnqueuedSec: number | null;
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
    out.push({ id: 'valkey.unreachable', check: 'valkey', section: 'valkey', severity: 'CRITICAL', message: `Valkey is not reachable: ${v.error ?? 'no response'}. Gateways spool positions to disk and replay them when it is back; live map, alerts, notifications and commands are paused.` });
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

/**
 * D6 G2 (spec G2 Proposed change §5, acceptance #2):
 * - pipeline.notify-dead: an alert's notification job used up its 5 deliveries; its recipients were not notified and
 *   nothing retries it. CRITICAL when any of them is SOS / CRASH, else WARN.
 * - pipeline.notify-unqueued: alerts without a finished job after notifyUnqueuedWarnMin (WARN) / notifyUnqueuedCritMin
 *   (CRITICAL); the sweeper should have re-queued them within ~2 min, so the notifier or Valkey is not working.
 * Both come from PostgreSQL (survive notifier restarts), not from the heartbeat's in-memory counters.
 */
function notifyBacklogChecks(input: CheckInput, t: HealthThresholds, out: Issue[]): void {
  const n = input.notify;
  if (!n) return;
  const dead = n.dead.reduce((s, d) => s + d.count, 0);
  if (dead > 0) {
    const critical = n.dead.filter((d) => CRITICAL_NOTIFY_TYPES.includes(d.type));
    const criticalCount = critical.reduce((s, d) => s + d.count, 0);
    const latest = (critical[0] ?? n.dead[0])!;
    const types = n.dead.map((d) => `${d.type} ${d.count}`).join(', ');
    out.push({
      id: 'pipeline.notify-dead',
      check: 'alert notifications (DEAD)',
      section: 'pipeline',
      severity: criticalCount ? 'CRITICAL' : 'WARN',
      message:
        `${fmt(dead)} alert notification job(s) are DEAD in the last ${t.notifyDeadWindowHours} h${criticalCount ? ` (${fmt(criticalCount)} SOS / CRASH)` : ''}: ` +
        `their recipients were not notified and nothing retries them (${types}). Latest: alert ${latest.latestId} (${latest.type}): ${latest.latestError.slice(0, 160)}. ` +
        'Fix the cause, then set "notifyError" = NULL on the alert to let the sweeper retry it.',
    });
  }
  if (n.unqueued > 0) {
    const crit = n.unqueuedCrit > 0;
    out.push({
      id: 'pipeline.notify-unqueued',
      check: 'alert notifications (pending)',
      section: 'pipeline',
      severity: crit ? 'CRITICAL' : 'WARN',
      message:
        `${fmt(n.unqueued)} alert(s) have no finished notification job after ${t.notifyUnqueuedWarnMin} min` +
        `${n.oldestUnqueuedSec !== null ? ` (oldest ${minutes(n.oldestUnqueuedSec)})` : ''}${crit ? `, ${fmt(n.unqueuedCrit)} of them older than ${t.notifyUnqueuedCritMin} min` : ''}. ` +
        'The notifier re-queues them every 30 s: check that the notifier is running and Valkey is reachable.',
    });
  }
}

/**
 * E5 security review L3: the transport notification relay has not completed a pass for etmsRelayWarnMin (WARN) /
 * etmsRelayCritMin (CRITICAL), or its last pass left a backlog. Driver / passenger trip notifications are late meanwhile
 * (the relay catches up from its high-water mark, at most 24 h back).
 */
function etmsRelayChecks(input: CheckInput, t: HealthThresholds, out: Issue[]): void {
  const r = input.etmsRelay;
  if (r === undefined || r === null || input.startupGrace) return;
  const lagSec = r.lastOkAt === null ? null : Math.max(0, (input.now - r.lastOkAt) / 1000);
  if (lagSec === null || lagSec > t.etmsRelayWarnMin * 60) {
    const crit = lagSec !== null && lagSec > t.etmsRelayCritMin * 60;
    out.push({
      id: 'pipeline.etms-notify-relay',
      check: 'transport notification relay',
      section: 'pipeline',
      severity: crit ? 'CRITICAL' : 'WARN',
      message:
        (lagSec === null ? 'The transport notification relay has not completed a pass yet. ' : `The transport notification relay last completed a pass ${minutes(lagSec)} ago. `) +
        'Trip assignment, cancellation and delay notifications are not being created: check the API process, Valkey (relay lock) and ETMS_NOTIFY_JOB.',
    });
    return;
  }
  if (r.full) {
    out.push({
      id: 'pipeline.etms-notify-relay-backlog',
      check: 'transport notification relay',
      section: 'pipeline',
      severity: 'WARN',
      message: `The transport notification relay is behind: its last pass hit the per-pass limit${r.hwm !== null ? ` and has processed trip events up to ${minutes(Math.max(0, (input.now - r.hwm) / 1000))} ago` : ''}.`,
    });
  }
}

/** Data forwarding targets (from gateway / notifier heartbeats) failing for more than 5 minutes. */
function relayChecks(input: CheckInput, out: Issue[]): void {
  const instances = input.processes.flatMap((p) => p.instances);
  for (const [id, s] of relayStatsFromHeartbeats(instances)) {
    if (!isFailing(s, input.now)) continue;
    const since = Math.round((input.now - Date.parse(s.failingSince!)) / 1000);
    out.push({
      id: `relay.${id}`,
      check: `forwarding ${s.name}`,
      section: 'pipeline',
      severity: 'WARN',
      message: `Data forwarding target "${s.name}" has been failing for ${minutes(since)}${s.lastError ? ` (${s.lastError.message})` : ''}; ${fmt(s.queued)} ${s.type === 'RAW_TCP' ? 'bytes' : 'items'} queued, ${fmt(s.dropped)} dropped.`,
    });
  }
}

/** Gateway spool metrics from the gateway heartbeats. */
export function gatewaySpools(input: CheckInput): { instanceId: string; spool: SpoolMetrics }[] {
  const gateways = input.processes.find((p) => p.role === 'gateway')?.instances ?? [];
  return gateways.flatMap((g) => {
    const spool = (g.metrics as { spool?: SpoolMetrics } | undefined)?.spool;
    return spool ? [{ instanceId: g.instanceId, spool }] : [];
  });
}

/**
 * End-to-end tracking: positions buffered on a gateway's disk, positions refused by a gateway, and how long ago the
 * processor last committed positions to PostgreSQL while devices are connected.
 */
function trackingChecks(input: CheckInput, t: HealthThresholds, out: Issue[]): void {
  for (const { instanceId, spool } of gatewaySpools(input)) {
    const base = `tracking.spool.${instanceId}`;
    const errorAt = spool.lastErrorAt ? Date.parse(spool.lastErrorAt) : 0;
    if (spool.notAcked > 0 && input.now - errorAt <= t.dbErrorWindowSec * 1000) {
      out.push({
        id: `${base}.refused`,
        check: 'gateway positions refused',
        section: 'pipeline',
        severity: 'CRITICAL',
        message: `Gateway ${instanceId} could neither queue nor spool positions (${fmt(spool.notAcked)} since start); devices are not acknowledged and positions without device retransmission are lost. ${spool.lastError ?? ''}`.trim(),
      });
    }
    if (spool.pendingEntries > 0) {
      const oldest = spool.oldestSpooledAt ? Date.parse(spool.oldestSpooledAt) : input.now;
      const ageMin = (input.now - oldest) / 60_000;
      const stuck = spool.cacheReady && !spool.backpressure && ageMin > t.spoolStuckMin;
      out.push({
        id: `${base}.pending`,
        check: 'gateway spool',
        section: 'pipeline',
        severity: stuck ? 'CRITICAL' : 'WARN',
        message: stuck
          ? `${fmt(spool.pendingEntries)} positions have been waiting in the spool of gateway ${instanceId} for ${Math.round(ageMin)} min although the cache is up: replay is not progressing.`
          : `${fmt(spool.pendingEntries)} positions are buffered on disk at gateway ${instanceId} (${spool.backpressure ? 'processor backlog near the stream cap' : spool.cacheReady ? 'replaying' : 'cache unavailable'}); they are replayed in order automatically.`,
      });
    }
  }
  if (input.lastPersistedAt === undefined || !input.valkey.reachable) return;
  const connections = input.ports.reduce((s, p) => s + p.connections, 0);
  if (!connections || input.startupGrace) return;
  const ageSec = input.lastPersistedAt === null ? Number.POSITIVE_INFINITY : (input.now - input.lastPersistedAt) / 1000;
  const severity = ageSec > t.persistStaleCritSec ? 'CRITICAL' : ageSec > t.persistStaleWarnSec ? 'WARN' : null;
  if (severity) {
    out.push({
      id: 'tracking.persist-stale',
      check: 'positions persisted',
      section: 'pipeline',
      severity,
      message: Number.isFinite(ageSec)
        ? `No positions were written to PostgreSQL for ${minutes(ageSec)} although ${fmt(connections)} device connection(s) are open.`
        : `No positions have been written to PostgreSQL although ${fmt(connections)} device connection(s) are open.`,
    });
  }
}

/** A map service is reported only after this many failed probes in a row (~30 s at the 15 s evaluation). */
export const MAP_FAILS_BEFORE_ISSUE = 2;

/**
 * Severity and impact per map service (release-gate spec G6, owner decision O17): blank maps for every user are
 * CRITICAL; missing routing or addresses degrade features and are WARN. GraphHopper becomes CRITICAL once ETMS ETAs
 * depend on it.
 */
const MAP_IMPACT: Record<MapServiceState['name'], { severity: Issue['severity']; impact: string }> = {
  graphhopper: { severity: 'WARN', impact: 'routing, ETAs and road snapping are skipped' },
  photon: { severity: 'WARN', impact: 'addresses and place search unavailable' },
  martin: { severity: 'CRITICAL', impact: 'map tiles unavailable: web and mobile maps are blank' },
};

/** Self-hosted GraphHopper / Photon / Martin; services that are not configured are not checked. */
function mapChecks(input: CheckInput, out: Issue[]): void {
  for (const m of input.maps ?? []) {
    if (m.configured && m.misconfigured) {
      // A public host in the setting: never probed (map-services.ts isLocalHost), reported as a configuration WARN.
      out.push({ id: `maps.${m.name}`, check: m.label, section: 'maps', severity: 'WARN', message: `${m.label} at ${m.probeUrl}: ${m.misconfigured}.` });
      continue;
    }
    if (!m.configured || m.ok || m.consecutiveFailures < MAP_FAILS_BEFORE_ISSUE) continue;
    const { severity, impact } = MAP_IMPACT[m.name];
    out.push({
      id: `maps.${m.name}`,
      check: m.label,
      section: 'maps',
      severity,
      message: `${m.label} is not answering at ${m.probeUrl} (${m.error ?? 'failed'}; ${m.consecutiveFailures} checks in a row): ${impact}.`,
    });
  }
}

/** A QUEUED optimisation job older than this means no worker is taking jobs (WARN). */
export const ROUTING_QUEUE_WARN_SEC = 300;

/**
 * ETMS E4 planning (only while ETMS_ROUTING=on; "disabled" raises nothing):
 * - routing.worker CRITICAL: no routing worker heartbeat — optimisation jobs wait in the queue;
 * - routing.engine CRITICAL (chaos R5): GraphHopper not answering while planning is on — no road matrix, optimisation
 *   jobs fail with ENGINE_UNREACHABLE after their retries; no ETA is invented meanwhile;
 * - routing.optimizer WARN: the OR-Tools service is not answering (or refuses the token) — jobs fail with
 *   OPTIMIZER_UNAVAILABLE; manual dispatch is not affected;
 * - routing.queue WARN: the oldest queued job is older than ROUTING_QUEUE_WARN_SEC.
 */
function routingChecks(input: CheckInput, out: Issue[]): void {
  const r = input.routing;
  if (!r?.enabled) return;
  if (r.workers === 0 && !input.startupGrace && input.valkey.reachable) {
    out.push({ id: 'routing.worker', check: 'routing worker', section: 'routing', severity: 'CRITICAL', message: 'No routing worker is running (veetrax-routing-worker): optimisation jobs wait in the queue. Manual dispatch is not affected.' });
  }
  const gh = (input.maps ?? []).find((m) => m.name === 'graphhopper');
  if (!gh?.configured) {
    out.push({ id: 'routing.engine', check: 'routing engine', section: 'routing', severity: 'CRITICAL', message: 'ETMS planning is on but no road engine is configured (ROUTER_URL + ROUTER_ENGINE=graphhopper): every optimisation fails.' });
  } else if (!gh.ok && gh.consecutiveFailures >= MAP_FAILS_BEFORE_ISSUE) {
    out.push({
      id: 'routing.engine',
      check: 'routing engine',
      section: 'routing',
      severity: 'CRITICAL',
      message: `GraphHopper is not answering (${gh.error ?? 'failed'}): no road matrix, so optimisation jobs fail after their retries and no plan or ETA is computed. Manual dispatch keeps working.`,
    });
  }
  if (!r.optimizer.configured || !r.optimizer.ok) {
    out.push({
      id: 'routing.optimizer',
      check: 'route optimiser',
      section: 'routing',
      severity: 'WARN',
      message: `The route optimiser (veetrax-optimizer) is ${r.optimizer.configured ? `not answering (${r.optimizer.error ?? 'failed'})` : `not configured (${r.optimizer.error ?? 'OPTIMIZER_URL / OPTIMIZER_TOKEN'})`}: optimisation jobs fail; manual dispatch is not affected.`,
    });
  }
  if (r.jobs && r.jobs.oldestQueuedAgeSec !== null && r.jobs.oldestQueuedAgeSec > ROUTING_QUEUE_WARN_SEC) {
    out.push({ id: 'routing.queue', check: 'optimisation queue', section: 'routing', severity: 'WARN', message: `${r.jobs.queued} optimisation job(s) queued, the oldest for ${Math.round(r.jobs.oldestQueuedAgeSec / 60)} min.` });
  }
}

/** All checks; returns the issues that are currently WARN or CRITICAL. Pure (unit-tested). */
export function evaluateChecks(input: CheckInput, t: HealthThresholds): Issue[] {
  const out: Issue[] = [];
  // Heartbeats and gateway port reports live in the cache: while it is unreachable they are unknown, not missing, so
  // only the cache outage itself is reported (instead of every process and port looking dead).
  if (input.valkey.reachable) {
    processChecks(input, t, out);
    portChecks(input, t, out);
  }
  trackingChecks(input, t, out);
  queueChecks(input, t, out);
  storeChecks(input, t, out);
  notifierChecks(input, t, out);
  notifyBacklogChecks(input, t, out);
  relayChecks(input, out);
  etmsRelayChecks(input, t, out);
  if (input.etmsMatrix) out.push(...matrixHealthIssues(input.etmsMatrix, input.now));
  mapChecks(input, out);
  routingChecks(input, out);
  return out.sort((a, b) => RANK[b.severity] - RANK[a.severity] || a.id.localeCompare(b.id));
}

/** (maxLength − backlog) / net fill rate: how long until unprocessed entries get trimmed; null when not filling. */
export function bufferSecondsLeft(maxLength: number, backlog: number, inputPerSec: number | null, outputPerSec: number | null): number | null {
  if (inputPerSec === null) return null;
  const net = inputPerSec - (outputPerSec ?? 0);
  if (net <= 0.5) return null;
  return Math.max(0, (maxLength - backlog) / net);
}

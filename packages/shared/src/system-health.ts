import type { RelayTargetStats } from './relay';

/**
 * System Health (Super Admin): heartbeats written by every process, the report served by
 * `GET /api/admin/system-health` and the `system:health` socket event.
 */

/** Processes of the platform; each writes a heartbeat every 5 s. */
export const PROCESS_ROLES = ['api', 'gateway', 'processor', 'notifier', 'summarizer'] as const;
/**
 * Processes that run only when their feature is switched on (ETMS E4: the routing worker with ETMS_ROUTING=on). Not in
 * the default expected roles; listed on the page only while they write heartbeats.
 */
export const OPTIONAL_PROCESS_ROLES = ['routing-worker'] as const;
export type ProcessRole = (typeof PROCESS_ROLES)[number] | (typeof OPTIONAL_PROCESS_ROLES)[number];

/** OK = healthy, WARN = degraded, CRITICAL = data loss or outage likely. */
export type HealthStatus = 'OK' | 'WARN' | 'CRITICAL';
export type IssueSeverity = Exclude<HealthStatus, 'OK'>;

export interface HealthError {
  message: string;
  at: string;
}

// ── Heartbeats (Valkey `vt:health:proc:<role>:<instanceId>`, JSON, EX 20 s) ──

export interface GatewayListenerMetrics {
  protocol: string;
  port: number;
  listening: boolean;
  /** Why the listener is not listening (e.g. EADDRINUSE). */
  error: string | null;
  connections: number;
  frames: number;
  positions: number;
  framesPerSec: number;
  positionsPerSec: number;
  dropped: number;
  errors: number;
  /** Positions whose XADD to `vt:positions` failed (not acknowledged to the device). */
  enqueueFailures: number;
  lastPacketAt: string | null;
  lastPositionAt: string | null;
}

/** Gateway durable spool (positions kept on local disk while the cache is unavailable or the processor is far behind). */
export interface SpoolMetrics {
  enabled: boolean;
  /** direct = XADD straight to the stream; spooling = writing to disk; draining = replaying the spool into the stream. */
  mode: 'disabled' | 'direct' | 'spooling' | 'draining';
  /** The gateway's cache connection is ready. */
  cacheReady: boolean;
  /** Spooling because the processor backlog is close to the stream cap. */
  backpressure: boolean;
  pendingEntries: number;
  pendingBytes: number;
  oldestSpooledAt: string | null;
  /** Since start. */
  spooled: number;
  replayed: number;
  /** Refused by the spool (full / disk error). */
  rejected: number;
  /** Direct XADDs that failed (then spooled). */
  directFailed: number;
  /** Positions neither queued nor spooled: their device ACK was withheld. */
  notAcked: number;
  lastError: string | null;
  lastErrorAt: string | null;
}

export interface GatewayMetrics {
  listeners: GatewayListenerMetrics[];
  /** RAW_TCP data forwarding targets handled by this gateway. */
  relay?: RelayTargetStats[];
  /** Durable spool state (absent on gateways without the spool). */
  spool?: SpoolMetrics;
}

export interface ProcessorMetrics {
  /** Entries processed since start. */
  processed: number;
  processedPerSec: number;
  avgBatchMs: number;
  lastBatchAt: string | null;
  /** Failed database writes since start. */
  dbErrors: number;
  lastDbError: HealthError | null;
  lastDbOkAt: string | null;
  /** Current retry delay after consecutive failures (0 = healthy). */
  backoffMs: number;
  pending: number | null;
  lag: number | null;
  /** Stream entries dropped as duplicates (same gateway message id) since start. */
  duplicates?: number;
}

export interface NotifierMetrics {
  jobs: number;
  jobsPerSec: number;
  /** Since start, per channel (EMAIL, SMS, PUSH, …). */
  sent: Record<string, number>;
  failed: Record<string, number>;
  skipped: number;
  /** Last failure of any kind (overwritten by the next one; see lastDead for DEAD jobs). */
  lastError: HealthError | null;
  /** D6 G2: notification jobs declared DEAD (delivery budget used up) since start. */
  deadJobs?: number;
  /** D6 G2: the last DEAD job (kept apart from lastError, so later ordinary failures do not hide it). */
  lastDead?: HealthError | null;
  /**
   * D6 G2 sweeper (only on the instance that holds the sweep lock): alerts older than 60 s without a finished
   * notification job found by the last sweep (capped at the sweep batch, 500), when it ran, and re-queued since start.
   */
  unnotifiedAlerts?: number | null;
  lastSweepAt?: string | null;
  sweptAlerts?: number;
  /** HTTP_JSON data forwarding targets handled by this notifier. */
  relay?: RelayTargetStats[];
}

export interface SummarizerMetrics {
  runs: number;
  lastRunAt: string | null;
  lastRunMs: number | null;
  lastError: HealthError | null;
}

export interface ApiMetrics {
  sockets: number;
  sweeperLastRunAt: string | null;
}

/** ETMS E4 routing worker (optimisation jobs). */
export interface RoutingWorkerMetrics {
  slots: number;
  inflight: number;
  claimed: number;
  succeeded: number;
  failed: number;
  retried: number;
  cancelled: number;
  leaseLost: number;
  takenOver: number;
  lastError: { code: string; at: string } | null;
  /** Last optimiser /health probe of this worker (null = not probed yet). */
  optimizerOk: boolean | null;
}

export interface RoleMetrics {
  gateway: GatewayMetrics;
  processor: ProcessorMetrics;
  notifier: NotifierMetrics;
  summarizer: SummarizerMetrics;
  api: ApiMetrics;
  'routing-worker': RoutingWorkerMetrics;
}

/**
 * ETMS planning / optimisation health (E4): the routing worker processes, the OR-Tools optimiser service and the job
 * queue. `enabled: false` (ETMS_ROUTING off, the default) = status DISABLED, nothing probed, no issue raised.
 */
export interface RoutingHealthDto {
  enabled: boolean;
  status: HealthStatus | 'DISABLED';
  workers: number;
  optimizer: { configured: boolean; ok: boolean; probeUrl: string | null; latencyMs: number | null; error: string | null; checkedAt: string | null };
  /** null when the database could not be asked (or routing is disabled). */
  jobs: { queued: number; running: number; failed24h: number; oldestQueuedAgeSec: number | null } | null;
}

export interface ProcessHeartbeat<R extends ProcessRole = ProcessRole> {
  role: R;
  /** `<hostname>-<pid>` */
  instanceId: string;
  host: string;
  pid: number;
  version: string;
  startedAt: string;
  /** When this heartbeat was written. */
  at: string;
  uptimeSec: number;
  rssBytes: number;
  heapUsed: number;
  cpuPercent: number;
  /** Event-loop delay p99 over the last interval. */
  eventLoopLagMs: number;
  metrics: RoleMetrics[R];
}

// ── Report ──

export interface ProcessInstanceDto extends ProcessHeartbeat {
  status: HealthStatus;
  /** Seconds since the heartbeat was written. */
  ageSec: number;
  stale: boolean;
}

export interface ProcessRoleDto {
  role: ProcessRole;
  status: HealthStatus;
  instances: ProcessInstanceDto[];
}

export interface PortDto {
  protocol: string;
  port: number;
  status: HealthStatus;
  listening: boolean;
  /** Gateway instances reporting this listener. */
  instances: number;
  error: string | null;
  connections: number;
  positionsPerSec: number;
  framesPerSec: number;
  dropped: number;
  errors: number;
  enqueueFailures: number;
  lastPacketAt: string | null;
}

export interface StreamConsumerDto {
  name: string;
  pending: number;
  idleMs: number;
}

export interface QueueDto {
  key: string;
  group: string;
  status: HealthStatus;
  length: number;
  maxLength: number;
  /** Entries added since the stream was created (XINFO STREAM entries-added). */
  entriesAdded: number | null;
  /** Entries not yet delivered to the group. */
  lag: number | null;
  /** Delivered but not acknowledged. */
  pending: number;
  /** lag + pending: entries the consumers still have to finish. */
  backlog: number;
  oldestPendingAgeSec: number | null;
  consumers: StreamConsumerDto[];
  inputPerSec: number | null;
  /**
   * Seconds until unprocessed entries start being trimmed by MAXLEN if nothing consumes them:
   * (maxLength − backlog) / input rate. Null when there is no input.
   */
  bufferSecondsLeft: number | null;
}

export interface DatabaseDto {
  status: HealthStatus;
  reachable: boolean;
  error: string | null;
  latencyMs: number | null;
  activeConnections: number | null;
  totalConnections: number | null;
  maxConnections: number | null;
  sizeBytes: number | null;
  topTables: { name: string; bytes: number }[];
  /** Rows inserted into "Position" in the last minute (pg_stat_user_tables n_tup_ins delta). */
  insertsPerMin: number | null;
}

export interface ValkeyDto {
  status: HealthStatus;
  reachable: boolean;
  error: string | null;
  version: string | null;
  latencyMs: number | null;
  usedMemory: number | null;
  /** 0 = no limit. */
  maxMemory: number | null;
  memoryPercent: number | null;
  aofEnabled: boolean | null;
  rdbLastSaveStatus: string | null;
  rdbLastSaveAt: string | null;
  connectedClients: number | null;
  evictedKeys: number | null;
}

export interface HostDto {
  status: HealthStatus;
  hostname: string;
  platform: string;
  dataDir: string;
  diskTotal: number | null;
  diskFree: number | null;
  diskFreePercent: number | null;
  loadAvg: number[];
  cpus: number;
  memTotal: number;
  memFree: number;
  uptimeSec: number;
}

/** Self-hosted map services watched by System Health (see ops/deploy/linux/maps/README.md). */
export type MapServiceName = 'graphhopper' | 'photon' | 'martin';

/** Last health probe of one map service. A service whose URL is not set is not monitored (`configured: false`). */
export interface MapServiceDto {
  name: MapServiceName;
  /** "Routing (GraphHopper)" etc. */
  label: string;
  status: HealthStatus;
  configured: boolean;
  /** The URL probed (`<base>/health`, `<base>/status`); null when not configured. */
  probeUrl: string | null;
  /** Result of the last probe (true while not configured). */
  ok: boolean;
  latencyMs: number | null;
  error: string | null;
  /** Probes failed in a row; an issue is raised from 2 on. */
  consecutiveFailures: number;
  checkedAt: string | null;
}

/** One 10-second sample of the pipeline. */
export interface ThroughputPoint {
  t: string;
  /** Positions added to `vt:positions` in the interval. */
  received: number;
  /** Positions acknowledged by the processors in the interval. */
  processed: number;
  lag: number | null;
  backlog: number | null;
}

export interface HealthIssue {
  /** Stable check id, e.g. `queue.positions.lag`, `process.processor`. */
  id: string;
  /** Short label of the check. */
  check: string;
  section: 'processes' | 'ports' | 'queues' | 'database' | 'valkey' | 'host' | 'pipeline' | 'maps' | 'routing';
  severity: IssueSeverity;
  message: string;
  since: string;
}

export interface HealthEvent {
  at: string;
  id: string;
  check: string;
  from: HealthStatus;
  to: HealthStatus;
  message: string;
}

export interface SystemHealthDto {
  status: HealthStatus;
  generatedAt: string;
  issues: HealthIssue[];
  events: HealthEvent[];
  processes: ProcessRoleDto[];
  ports: PortDto[];
  queues: QueueDto[];
  database: DatabaseDto;
  valkey: ValkeyDto;
  host: HostDto;
  /** GraphHopper, Photon and Martin (not configured ones included, so the page can say "not monitored"). */
  maps: MapServiceDto[];
  /** ETMS E4 routing worker + optimiser (status DISABLED while ETMS_ROUTING is off). Absent on older APIs. */
  routing?: RoutingHealthDto;
  throughput: ThroughputPoint[];
}

/** Light-weight status for the top-bar banner (`GET /api/admin/system-health/status`) and the socket event. */
export interface SystemHealthSummary {
  status: HealthStatus;
  issues: HealthIssue[];
  at: string;
  /** Transitions of the evaluation that produced this event (socket only). */
  transitions?: HealthEvent[];
}

export interface HealthThresholdDto {
  key: string;
  label: string;
  value: number;
  unit: string;
  env: string;
}

export interface SystemHealthSettingsDto {
  superAdminEmail: string | null;
  extraRecipients: string[];
  cooldownMin: number;
  /** Real delivery channel of the mailer (zoho / smtp), null = written to var/mail only. */
  mailProvider: string | null;
  thresholds: HealthThresholdDto[];
}

export interface SystemAlertTestResult {
  recipients: string[];
  sent: number;
  errors: string[];
}

import { HealthThresholdDto, PROCESS_ROLES, ProcessRole } from '@veetracer/shared';

/** System Health thresholds; every value can be overridden with the env variable next to it (see .env.example). */
export interface HealthThresholds {
  queueLagWarn: number;
  queueLagCrit: number;
  pendingAgeWarnSec: number;
  bufferWarnMin: number;
  bufferCritMin: number;
  heartbeatStaleSec: number;
  dbLatencyWarnMs: number;
  dbErrorWindowSec: number;
  valkeyMemWarnPct: number;
  valkeyMemCritPct: number;
  diskWarnPct: number;
  diskCritPct: number;
  eventLoopWarnMs: number;
  noPositionsWarnMin: number;
  notifyFailWarnPct: number;
  notifyFailWindowMin: number;
  notifyFailMinAttempts: number;
}

interface Def {
  key: keyof HealthThresholds;
  env: string;
  label: string;
  unit: string;
  value: number;
}

export const THRESHOLD_DEFS: readonly Def[] = [
  { key: 'queueLagWarn', env: 'HEALTH_QUEUE_LAG_WARN', label: 'Positions queue lag — warning', unit: 'entries', value: 5000 },
  { key: 'queueLagCrit', env: 'HEALTH_QUEUE_LAG_CRIT', label: 'Positions queue lag — critical', unit: 'entries', value: 50_000 },
  { key: 'pendingAgeWarnSec', env: 'HEALTH_PENDING_AGE_WARN_SEC', label: 'Oldest pending entry — warning', unit: 's', value: 60 },
  { key: 'bufferWarnMin', env: 'HEALTH_BUFFER_WARN_MIN', label: 'Stream buffer time left — warning', unit: 'min', value: 30 },
  { key: 'bufferCritMin', env: 'HEALTH_BUFFER_CRIT_MIN', label: 'Stream buffer time left — critical', unit: 'min', value: 10 },
  { key: 'heartbeatStaleSec', env: 'HEALTH_HEARTBEAT_STALE_SEC', label: 'Heartbeat stale after', unit: 's', value: 15 },
  { key: 'dbLatencyWarnMs', env: 'HEALTH_DB_LATENCY_WARN_MS', label: 'Database latency — warning', unit: 'ms', value: 200 },
  { key: 'dbErrorWindowSec', env: 'HEALTH_DB_ERROR_WINDOW_SEC', label: 'Processor database error counts for', unit: 's', value: 120 },
  { key: 'valkeyMemWarnPct', env: 'HEALTH_VALKEY_MEM_WARN_PCT', label: 'Valkey memory — warning', unit: '%', value: 80 },
  { key: 'valkeyMemCritPct', env: 'HEALTH_VALKEY_MEM_CRIT_PCT', label: 'Valkey memory — critical', unit: '%', value: 90 },
  { key: 'diskWarnPct', env: 'HEALTH_DISK_WARN_PCT', label: 'Disk free — warning below', unit: '%', value: 15 },
  { key: 'diskCritPct', env: 'HEALTH_DISK_CRIT_PCT', label: 'Disk free — critical below', unit: '%', value: 5 },
  { key: 'eventLoopWarnMs', env: 'HEALTH_EVENT_LOOP_WARN_MS', label: 'Event-loop lag p99 — warning', unit: 'ms', value: 200 },
  { key: 'noPositionsWarnMin', env: 'HEALTH_NO_POSITIONS_WARN_MIN', label: 'No positions while devices are connected', unit: 'min', value: 5 },
  { key: 'notifyFailWarnPct', env: 'HEALTH_NOTIFY_FAIL_WARN_PCT', label: 'Notification failures — warning', unit: '%', value: 20 },
  { key: 'notifyFailWindowMin', env: 'HEALTH_NOTIFY_FAIL_WINDOW_MIN', label: 'Notification failure window', unit: 'min', value: 15 },
  { key: 'notifyFailMinAttempts', env: 'HEALTH_NOTIFY_FAIL_MIN_ATTEMPTS', label: 'Notification failure check needs at least', unit: 'sends', value: 5 },
];

function num(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return raw !== undefined && raw.trim() !== '' && Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function loadThresholds(env: NodeJS.ProcessEnv = process.env): HealthThresholds {
  return Object.fromEntries(THRESHOLD_DEFS.map((d) => [d.key, num(env[d.env], d.value)])) as unknown as HealthThresholds;
}

export function thresholdList(t: HealthThresholds): HealthThresholdDto[] {
  return THRESHOLD_DEFS.map((d) => ({ key: d.key, label: d.label, unit: d.unit, env: d.env, value: t[d.key] }));
}

/** Monitoring settings other than thresholds. */
export interface MonitorConfig {
  /** Roles that must have at least one live instance (SYSTEM_HEALTH_ROLES, default all). */
  expectedRoles: ProcessRole[];
  /** Extra recipients of system alerts (SYSTEM_ALERT_EMAILS, comma separated). */
  alertEmails: string[];
  cooldownMin: number;
  /** Directory whose file system is checked for free space (HEALTH_DATA_DIR). */
  dataDir: string | null;
  /** Bearer token for GET /api/metrics (besides a Super Admin access token). */
  metricsToken: string | null;
}

export function loadMonitorConfig(env: NodeJS.ProcessEnv = process.env): MonitorConfig {
  const roles = (env.SYSTEM_HEALTH_ROLES ?? '')
    .split(',')
    .map((r) => r.trim())
    .filter((r): r is ProcessRole => (PROCESS_ROLES as readonly string[]).includes(r));
  return {
    expectedRoles: roles.length ? roles : [...PROCESS_ROLES],
    alertEmails: (env.SYSTEM_ALERT_EMAILS ?? '')
      .split(',')
      .map((e) => e.trim())
      .filter((e) => /^[^\s@]+@[^\s@]+$/.test(e)),
    cooldownMin: num(env.SYSTEM_ALERT_COOLDOWN_MIN, 15),
    dataDir: env.HEALTH_DATA_DIR?.trim() || null,
    metricsToken: env.METRICS_TOKEN?.trim() || null,
  };
}

/** All Valkey keys and channels live under the `vt:` prefix. */
export const RedisKeys = {
  positionsStream: 'vt:positions',
  processorGroup: 'processor',
  live: (objectId: string) => `vt:live:${objectId}`,
  /** Processor-internal tracking state (last valid point, stop time) per object. */
  track: (objectId: string) => `vt:track:${objectId}`,
  liveCompany: (companyId: string) => `vt:live:company:${companyId}`,
  liveCompanyPattern: 'vt:live:company:*',
  liveUpdates: 'vt:live:updates',
  cacheInvalidate: 'vt:cache:invalidate',
  connection: (uniqueId: string) => `vt:conn:${uniqueId}`,
  // ── Device commands ──
  /** Pub/sub: commands for the devices connected to one gateway instance (`CommandDispatch`). */
  commandChannel: (gatewayId: string) => `vt:cmd:gw:${gatewayId}`,
  /** List of `CommandDispatch` waiting for a device that is offline; drained when it connects. */
  commandQueue: (uniqueId: string) => `vt:cmd:queue:${uniqueId}`,
  /** Pub/sub: delivery / acknowledgement updates from gateways (`CommandUpdate`). */
  commandUpdates: 'vt:cmd:updates',
  /** Last update per command (JSON, 7 days), so the API can reconcile updates it missed while restarting. */
  commandState: (commandId: string) => `vt:cmd:state:${commandId}`,
  loginFailures: (email: string) => `vt:auth:fail:${email}`,
  // ── M2a ──
  /** Pub/sub: new alert `{ companyId, alert: AlertDto }` for realtime fan-out. */
  alertsChannel: 'vt:alerts',
  /** Stream of notification jobs consumed by the notifier process. */
  notifyStream: 'vt:notify',
  notifierGroup: 'notifier',
  /** Pub/sub: alert settings / geofences / snoozes / templates changed for `{ companyId }`. */
  rulesInvalidate: 'vt:rules:invalidate',
  /** Rules-engine state per object: geofence membership, overspeed/idle episodes, cooldowns. */
  alertState: (objectId: string) => `vt:alertstate:${objectId}`,
  // ── System health ──
  /** Heartbeat of one process instance (JSON `ProcessHeartbeat`, EX 20 s). */
  healthProcess: (role: string, instanceId: string) => `vt:health:proc:${role}:${instanceId}`,
  /** Sorted set of heartbeat keys scored by last write (epoch ms), so readers don't SCAN. */
  healthProcessIndex: 'vt:health:procs',
  /** Capped list of 10-second pipeline samples (newest first). */
  healthSeries: 'vt:health:series',
  /** Hash check id → active issue JSON (WARN/CRITICAL) with its since-time. */
  healthIssues: 'vt:health:issues',
  /** Capped list of status transitions (newest first). */
  healthEvents: 'vt:health:events',
  /** Hash check id → epoch ms of the last alert e-mail (cooldown). */
  healthAlertSent: 'vt:health:alert-sent',
  /** Only one API instance evaluates checks / samples per interval. */
  healthMonitorLock: 'vt:health:lock:monitor',
  healthSamplerLock: 'vt:health:lock:sampler',
  /** Cached Super Admin e-mail so system alerts go out while PostgreSQL is down. */
  healthSuperAdminEmail: 'vt:health:sa-email',
  /** Pub/sub: `SystemHealthSummary` after each evaluation that changed something. */
  healthUpdates: 'vt:health:updates',
} as const;

export const DEFAULT_POSITIONS_STREAM_MAXLEN = 2_000_000;

/**
 * Cap of `vt:positions` (XADD MAXLEN ~), env POSITIONS_STREAM_MAXLEN. Read lazily: `.env` is loaded by loadEnv(),
 * after this module is imported.
 */
export function positionsStreamMaxLen(): number {
  return positiveInt(process.env.POSITIONS_STREAM_MAXLEN, DEFAULT_POSITIONS_STREAM_MAXLEN);
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return raw && Number.isInteger(n) && n > 0 ? n : fallback;
}

/** SET key to ARGV[2] only if its current value is still ARGV[1] (lets the offline sweeper avoid clobbering fresh data). */
export const COMPARE_AND_SET_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  redis.call('SET', KEYS[1], ARGV[2])
  return 1
end
return 0`;

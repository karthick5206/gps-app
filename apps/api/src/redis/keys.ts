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
} as const;

export const POSITIONS_STREAM_MAXLEN = 2_000_000;

/** SET key to ARGV[2] only if its current value is still ARGV[1] (lets the offline sweeper avoid clobbering fresh data). */
export const COMPARE_AND_SET_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  redis.call('SET', KEYS[1], ARGV[2])
  return 1
end
return 0`;

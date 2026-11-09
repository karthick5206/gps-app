import {
  CRITICAL_DISPATCH_MAX_AGE_SEC,
  criticalDispatchRejection,
  ENGINE_STOP_MAX_FIX_AGE_SEC,
  ENGINE_STOP_MAX_SPEED_KPH,
  engineStopBlockReason,
  isSafetyCriticalDispatch,
  PROTOCOL_COMMANDS,
} from '@veetracer/shared';

/** Decision Q-01 (docs/modernization/decision-log.md): engine stop needs fresh telemetry and is never delivered late. */
describe('engine stop safety rules', () => {
  const now = Date.parse('2026-11-09T10:00:00Z');
  const ago = (sec: number) => new Date(now - sec * 1000).toISOString();
  const live = (over: Partial<{ status: string; speedKph: number; fixTime: string | null; serverTime: string | null }> = {}) => ({
    status: 'OFF',
    speedKph: 0,
    fixTime: ago(5),
    serverTime: ago(5),
    ...over,
  });

  describe('engineStopBlockReason', () => {
    it('allows a stationary, online vehicle with fresh telemetry', () => {
      expect(engineStopBlockReason(live(), now)).toBeNull();
      expect(engineStopBlockReason(live({ status: 'IDLE', speedKph: ENGINE_STOP_MAX_SPEED_KPH }), now)).toBeNull();
    });

    it('refuses when there is no live state at all (unknown is never assumed safe)', () => {
      expect(engineStopBlockReason(undefined, now)).toMatch(/fresh telemetry/);
      expect(engineStopBlockReason(null, now)).toMatch(/fresh telemetry/);
      expect(engineStopBlockReason(live({ fixTime: null, serverTime: null }), now)).toMatch(/fresh telemetry/);
    });

    it('refuses an OFFLINE or NO_DATA vehicle even if it reported speed 0 (previously the speed check was skipped)', () => {
      expect(engineStopBlockReason(live({ status: 'OFFLINE' }), now)).toMatch(/offline/);
      expect(engineStopBlockReason(live({ status: 'NO_DATA' }), now)).toMatch(/offline/);
    });

    it('refuses stale telemetry older than the window', () => {
      const stale = ago(ENGINE_STOP_MAX_FIX_AGE_SEC + 1);
      expect(engineStopBlockReason(live({ fixTime: stale, serverTime: stale }), now)).toMatch(/s old/);
    });

    it('uses the newest of the GPS fix and the server receive time', () => {
      expect(engineStopBlockReason(live({ fixTime: ago(600), serverTime: ago(10) }), now)).toBeNull();
      expect(engineStopBlockReason(live({ fixTime: ago(10), serverTime: null }), now)).toBeNull();
    });

    it('refuses above the speed limit', () => {
      expect(engineStopBlockReason(live({ status: 'RUNNING', speedKph: ENGINE_STOP_MAX_SPEED_KPH + 1 }), now)).toMatch(/moving at/);
    });

    it('refuses unparseable timestamps', () => {
      expect(engineStopBlockReason(live({ fixTime: 'not-a-date', serverTime: null }), now)).toMatch(/fresh telemetry|s old/);
    });
  });

  describe('isSafetyCriticalDispatch', () => {
    it('recognises flagged dispatches', () => {
      expect(isSafetyCriticalDispatch({ text: 'anything', critical: true })).toBe(true);
    });

    it('recognises legacy engine-stop queue entries by protocol text, for every protocol that supports it', () => {
      for (const texts of Object.values(PROTOCOL_COMMANDS)) {
        if (texts.engine_stop) expect(isSafetyCriticalDispatch({ text: ` ${texts.engine_stop.toUpperCase()} ` })).toBe(true);
      }
    });

    it('does not flag engine restore, locate or other commands', () => {
      expect(isSafetyCriticalDispatch({ text: PROTOCOL_COMMANDS.GT06.engine_resume! })).toBe(false);
      expect(isSafetyCriticalDispatch({ text: 'WHERE#' })).toBe(false);
    });
  });

  describe('criticalDispatchRejection', () => {
    it('sends a fresh critical dispatch', () => {
      expect(criticalDispatchRejection({ text: 'RELAY,1#', critical: true, issuedAt: ago(5) }, now)).toBeNull();
    });

    it('drops a critical dispatch older than the window', () => {
      expect(criticalDispatchRejection({ text: 'RELAY,1#', critical: true, issuedAt: ago(CRITICAL_DISPATCH_MAX_AGE_SEC + 1) }, now)).toMatch(/expired/);
      expect(criticalDispatchRejection({ text: 'RELAY,1#', critical: true, issuedAt: 'garbage' }, now)).toMatch(/expired/);
    });

    it('ignores non-critical dispatches whatever their age', () => {
      expect(criticalDispatchRejection({ text: 'WHERE#', issuedAt: ago(99999) }, now)).toBeNull();
    });
  });
});

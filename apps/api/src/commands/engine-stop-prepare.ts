import {
  CommandStatusValue,
  ENGINE_STOP_MAX_FIX_AGE_SEC,
  ENGINE_STOP_PREPARE_WAIT_SEC,
  EngineStopPrepareResponse,
  engineStopBlockReason,
  FreshPositionLiveState,
  freshPositionReason,
  LiveObject,
} from '@veetracer/shared';

/**
 * Engine-stop preparation ("request a fresh position, then confirm"): owner decision on
 * docs/modernization/anti-theft-immobilisation-proposal.md, Option 1. Kept in Valkey for PREPARE_STATE_TTL_SEC.
 * The preparation only sends a position request; it never sends, queues or authorises an engine stop by itself.
 */
export interface PrepareState {
  requestId: string;
  userId: string;
  objectId: string;
  companyId: string;
  uniqueId: string;
  /** DeviceCommand id of the position request. */
  commandId: string;
  /** When the position request was issued (before it was dispatched). */
  requestedAt: string;
  /** Latest outcome written to the audit trail (ready / blocked / timeout / not_connected; the last two are final). */
  outcome?: string;
}

export const PREPARE_STATE_TTL_SEC = 300;

export const PREPARE_NOT_CONNECTED =
  'The tracker is not connected right now, so no position request was sent. Engine stop is only sent to a vehicle that is online now and is never queued.';
export const PREPARE_DISCONNECTED = 'The tracker disconnected before it sent a new position. Nothing was sent or queued. Try again when the vehicle is online.';
export const PREPARE_TIMEOUT = `No new GPS position arrived within ${ENGINE_STOP_PREPARE_WAIT_SEC} s, so engine stop can't be confirmed. Nothing was sent or queued. You can request a fresh position again.`;
export const PREPARE_READY = 'Fresh position received. Check where the vehicle is and how fast it moves, then confirm with your password.';

/** Newest telemetry time + the engine-stop window: after this the server refuses the stop anyway. */
function confirmBy(live: FreshPositionLiveState): string | null {
  const times = [live.fixTime, live.serverTime].map((t) => (t ? Date.parse(t) : NaN)).filter(Number.isFinite);
  return times.length ? new Date(Math.max(...times) + ENGINE_STOP_MAX_FIX_AGE_SEC * 1000).toISOString() : null;
}

/**
 * Verdict of a preparation from the live state and the position request's delivery status. `ready` means a fresh
 * position (received after the request, valid GPS fix) exists AND the unchanged engineStopBlockReason allows a stop
 * right now; the final send re-checks everything regardless.
 */
export function prepareVerdict(state: PrepareState, live: LiveObject | FreshPositionLiveState | undefined | null, probeStatus: CommandStatusValue | null, nowMs: number): EngineStopPrepareResponse {
  const base = { requestId: state.requestId, requestedAt: state.requestedAt, freshPosition: null, confirmBy: null };
  const requestedAtMs = Date.parse(state.requestedAt);
  const waitReason = freshPositionReason(live, requestedAtMs, nowMs);
  if (!waitReason && live) {
    const blockReason = engineStopBlockReason(live, nowMs);
    return {
      ...base,
      status: blockReason ? 'blocked' : 'ready',
      message: blockReason ?? PREPARE_READY,
      blockReason,
      freshPosition: {
        lat: live.lat!,
        lng: live.lng!,
        speedKph: live.speedKph,
        status: live.status,
        ignition: 'ignition' in live ? (live.ignition ?? null) : null,
        satellites: 'satellites' in live ? (live.satellites ?? null) : null,
        fixTime: live.fixTime!,
        serverTime: live.serverTime!,
      },
      confirmBy: confirmBy(live),
    };
  }
  if (probeStatus === 'FAILED') return { ...base, status: 'not_connected', message: PREPARE_DISCONNECTED, blockReason: PREPARE_DISCONNECTED };
  if (!Number.isFinite(requestedAtMs) || nowMs - requestedAtMs > ENGINE_STOP_PREPARE_WAIT_SEC * 1000) {
    return { ...base, status: 'timeout', message: PREPARE_TIMEOUT, blockReason: PREPARE_TIMEOUT };
  }
  return { ...base, status: 'waiting', message: waitReason, blockReason: null };
}

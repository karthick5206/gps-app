import { ENGINE_STOP_PREPARE_WAIT_SEC, type EngineStopPrepareResponse } from '@veetracer/shared';

/** Poll interval while the tracker is asked for a fresh position. */
export const PREPARE_POLL_MS = 2000;

/** Whole seconds until the fresh position is too old for an engine stop (0 when past or unknown). */
export function secondsLeft(confirmBy: string | null | undefined, now: number): number {
  const t = confirmBy ? Date.parse(confirmBy) : NaN;
  return Number.isFinite(t) ? Math.max(0, Math.floor((t - now) / 1000)) : 0;
}

/** Seconds since a timestamp (0 for future / unknown). */
export function ageSec(iso: string | null | undefined, now: number): number {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? Math.max(0, Math.floor((now - t) / 1000)) : 0;
}

/** Seconds still allowed for the tracker to answer. */
export function waitLeft(requestedAt: string | null | undefined, now: number): number {
  return Math.max(0, ENGINE_STOP_PREPARE_WAIT_SEC - ageSec(requestedAt, now));
}

/**
 * The confirm (send) button is enabled only for a `ready` preparation whose fresh position is still within the
 * engine-stop window. The server re-checks every rule at send time anyway; this only avoids a pointless refusal.
 */
export function canConfirm(p: EngineStopPrepareResponse | null | undefined, now: number): boolean {
  return !!p && p.status === 'ready' && !!p.requestId && !!p.freshPosition && secondsLeft(p.confirmBy, now) > 0;
}

/** Keep polling while the tracker has not answered yet. */
export function shouldPoll(p: EngineStopPrepareResponse | null | undefined): boolean {
  return !!p?.requestId && p.status === 'waiting';
}

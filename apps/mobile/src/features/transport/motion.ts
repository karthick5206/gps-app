/**
 * In-motion lock for the driver screens (doc 09 §5.1). Pure, `node --test`.
 *
 * Motion = the bound vehicle's speed reported by the server (its GPS device is the tracker; the driver phone never
 * tracks). Moving above 10 km/h; released only after < 5 km/h for 10 s. A position older than 2 min is stale: with no
 * fresh speed the app assumes stationary (it cannot know better) and says so, as doc 09 §5.1 describes.
 *
 * While moving only Navigate, SOS, Call dispatcher and the read-only next-stop card are offered: no passenger list, no
 * text entry, no forms, and Arrived only once stationary.
 */

export const MOVING_KPH = 10;
export const STOPPED_KPH = 5;
export const RELEASE_MS = 10_000;
export const STALE_MS = 2 * 60_000;

export interface MotionState {
  moving: boolean;
  /** Since when the speed has been below STOPPED_KPH while still "moving" (release timer), else null. */
  slowSince: number | null;
  /** The last speed sample was fresh. */
  known: boolean;
}

export const INITIAL_MOTION: MotionState = { moving: false, slowSince: null, known: false };

/** Next motion state from a speed sample (km/h) taken at `fixAt` (ms), evaluated at `now` (ms). */
export function nextMotion(prev: MotionState, speedKph: number | null | undefined, fixAt: number | null | undefined, now: number): MotionState {
  const fresh = speedKph !== null && speedKph !== undefined && Number.isFinite(speedKph) && fixAt !== null && fixAt !== undefined && now - fixAt <= STALE_MS;
  if (!fresh) return { moving: false, slowSince: null, known: false };
  const v = speedKph as number;
  if (v > MOVING_KPH) return { moving: true, slowSince: null, known: true };
  if (!prev.moving) return { moving: false, slowSince: null, known: true };
  if (v < STOPPED_KPH) {
    const since = prev.slowSince ?? now;
    return now - since >= RELEASE_MS ? { moving: false, slowSince: null, known: true } : { moving: true, slowSince: since, known: true };
  }
  // Between 5 and 10 km/h while moving: still moving, release timer restarts.
  return { moving: true, slowSince: null, known: true };
}

/** Driver actions and whether each is allowed while the vehicle moves (doc 09 §5.1). */
export const ACTIONS_WHILE_MOVING = ['NAVIGATE', 'SOS', 'CALL_DISPATCHER', 'VIEW_NEXT_STOP'] as const;

export type DriverAction =
  | (typeof ACTIONS_WHILE_MOVING)[number]
  | 'ACKNOWLEDGE'
  | 'START_TRIP'
  | 'ARRIVED'
  | 'BOARDED'
  | 'NO_SHOW'
  | 'DROPPED'
  | 'DEPARTED'
  | 'COMPLETE_TRIP'
  | 'REPORT'
  | 'VIEW_MANIFEST';

export function allowedWhileMoving(action: DriverAction): boolean {
  return (ACTIONS_WHILE_MOVING as readonly string[]).includes(action);
}

export function actionAllowed(action: DriverAction, motion: Pick<MotionState, 'moving'>): boolean {
  return !motion.moving || allowedWhileMoving(action);
}

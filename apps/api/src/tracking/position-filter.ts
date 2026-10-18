import { MAX_PLAUSIBLE_SPEED_KPH, ObjectType, POSITION_FLAGS, StatusThresholds } from '@veetracer/shared';
import { haversineMeters } from './geo';

const FUTURE_TOLERANCE_MS = 5 * 60_000;
const MIN_SATELLITES = 3;
/** After this many consecutive jump-flagged points the new location is accepted (the old anchor was wrong). */
const JUMP_STREAK_ACCEPT = 3;

export interface TrackPoint {
  lat: number;
  lng: number;
  fixTime: number; // epoch ms
}

/** Per-object state the processor carries between positions. */
export interface TrackState {
  lastValid: TrackPoint | null;
  lastFixTime: number | null;
  stoppedSince: number | null;
  jumpStreak: number;
}

export const EMPTY_TRACK_STATE: TrackState = { lastValid: null, lastFixTime: null, stoppedSince: null, jumpStreak: 0 };

export interface FilterInput {
  fixTime: number;
  lat: number;
  lng: number;
  speedKph: number;
  valid: boolean;
  satellites: number | null;
  ignition: boolean | null;
}

export interface FilterContext {
  objectType: ObjectType;
  thresholds: StatusThresholds;
  now: number;
}

export interface FilterResult {
  flags: number;
  /** Coordinates to show on the map: the new point if usable, else the last valid one. */
  lat: number | null;
  lng: number | null;
  /** Speed to use for status: zero when the point is not trustworthy. */
  speedKph: number;
  /** False for LATE / FUTURE points: store them but leave live state untouched. */
  updatesLive: boolean;
  next: TrackState;
}

export function filterPosition(input: FilterInput, state: TrackState, ctx: FilterContext): FilterResult {
  let flags = 0;
  if (input.fixTime > ctx.now + FUTURE_TOLERANCE_MS) flags |= POSITION_FLAGS.FUTURE;
  if (state.lastFixTime !== null && input.fixTime < state.lastFixTime) flags |= POSITION_FLAGS.LATE;

  const invalid =
    !input.valid ||
    (input.lat === 0 && input.lng === 0) ||
    (input.satellites !== null && input.satellites < MIN_SATELLITES);
  if (invalid) flags |= POSITION_FLAGS.INVALID_FIX;

  const updatesLive = (flags & (POSITION_FLAGS.LATE | POSITION_FLAGS.FUTURE)) === 0;
  if (!updatesLive) {
    return {
      flags,
      lat: state.lastValid?.lat ?? null,
      lng: state.lastValid?.lng ?? null,
      speedKph: 0,
      updatesLive,
      next: state,
    };
  }

  let jumpStreak = 0;
  const anchor = state.lastValid;
  if (!invalid && anchor) {
    const distance = haversineMeters(anchor.lat, anchor.lng, input.lat, input.lng);
    const dtSec = Math.max((input.fixTime - anchor.fixTime) / 1000, 1);
    const impliedKph = (distance / dtSec) * 3.6;
    if (impliedKph > MAX_PLAUSIBLE_SPEED_KPH[ctx.objectType] && state.jumpStreak + 1 < JUMP_STREAK_ACCEPT) {
      flags |= POSITION_FLAGS.JUMP;
      jumpStreak = state.jumpStreak + 1;
    } else if (
      input.ignition !== true &&
      input.speedKph < ctx.thresholds.runningSpeedKph &&
      distance < ctx.thresholds.driftRadiusM
    ) {
      flags |= POSITION_FLAGS.DRIFT;
    }
  }

  const usable = (flags & (POSITION_FLAGS.INVALID_FIX | POSITION_FLAGS.JUMP | POSITION_FLAGS.DRIFT)) === 0;
  const lastValid = usable ? { lat: input.lat, lng: input.lng, fixTime: input.fixTime } : anchor;
  const trusted = (flags & (POSITION_FLAGS.INVALID_FIX | POSITION_FLAGS.JUMP)) === 0;
  return {
    flags,
    lat: lastValid?.lat ?? null,
    lng: lastValid?.lng ?? null,
    speedKph: trusted ? input.speedKph : 0,
    updatesLive,
    next: { ...state, lastValid, lastFixTime: input.fixTime, jumpStreak },
  };
}

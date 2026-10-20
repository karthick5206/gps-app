import { MAX_PLAUSIBLE_SPEED_KPH, ObjectType, POSITION_FLAGS, StatusThresholds } from '@veetracer/shared';
import { haversineMeters } from './geo';

const FUTURE_TOLERANCE_MS = 5 * 60_000;
const MIN_SATELLITES = 3;
/** At or below this many satellites a fix is weak: position can be off by tens of metres and the speed is noise. */
const WEAK_SATELLITES = 6;
/** While not driving (weak fix or ignition off), reported speeds below this are treated as GPS noise. */
const STATIONARY_NOISE_KPH = 15;
/** Drift radius for weak fixes (the normal radius comes from the company thresholds). */
const WEAK_FIX_DRIFT_RADIUS_M = 80;
/**
 * Phones: a fix that "moves" at this implied speed while the phone itself measures (Doppler) less than
 * PHONE_STILL_KPH is a multipath / Wi-Fi spike (seen: 180 m out and back in 20 s at a reported 0 km/h).
 */
const PHONE_SPIKE_IMPLIED_KPH = 25;
const PHONE_STILL_KPH = 5;
/** Accuracy is a ~68% radius; standing phones wobble within about twice it. */
const PHONE_DRIFT_ACCURACY_FACTOR = 2;
/** Phone fixes with a larger accuracy radius are weak (like a tracker with few satellites). */
const WEAK_ACCURACY_M = 25;
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
  /** Accuracy radius in metres when the source reports it (phones); no satellite count then. */
  accuracyM?: number | null;
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
    const acc = input.accuracyM ?? null;
    const phoneSpike = acc !== null && input.speedKph < PHONE_STILL_KPH && impliedKph > PHONE_SPIKE_IMPLIED_KPH && distance > acc;
    if ((impliedKph > MAX_PLAUSIBLE_SPEED_KPH[ctx.objectType] || phoneSpike) && state.jumpStreak + 1 < JUMP_STREAK_ACCEPT) {
      flags |= POSITION_FLAGS.JUMP;
      jumpStreak = state.jumpStreak + 1;
    } else if (input.ignition !== true) {
      // Parked / not driving: small moves are GPS drift. A weak fix (few satellites) or ignition off also reports
      // fake low speeds (seen: 6-9 km/h at identical coordinates), so those speeds don't count as movement.
      const weak = (input.satellites !== null && input.satellites <= WEAK_SATELLITES) || (acc !== null && acc > WEAK_ACCURACY_M);
      const noisySpeed = weak || input.ignition === false ? STATIONARY_NOISE_KPH : ctx.thresholds.runningSpeedKph;
      // A phone's reported accuracy is the radius its position wobbles in while standing still.
      const radius = Math.max(weak ? Math.max(ctx.thresholds.driftRadiusM, WEAK_FIX_DRIFT_RADIUS_M) : ctx.thresholds.driftRadiusM, (acc ?? 0) * PHONE_DRIFT_ACCURACY_FACTOR);
      if (input.speedKph < noisySpeed && distance < radius) flags |= POSITION_FLAGS.DRIFT;
    }
  }

  const usable = (flags & (POSITION_FLAGS.INVALID_FIX | POSITION_FLAGS.JUMP | POSITION_FLAGS.DRIFT)) === 0;
  const lastValid = usable ? { lat: input.lat, lng: input.lng, fixTime: input.fixTime } : anchor;
  const trusted = (flags & (POSITION_FLAGS.INVALID_FIX | POSITION_FLAGS.JUMP)) === 0;
  return {
    flags,
    lat: lastValid?.lat ?? null,
    lng: lastValid?.lng ?? null,
    // Drift is a parked vehicle: speed 0, so status never shows it as moving.
    speedKph: trusted && (flags & POSITION_FLAGS.DRIFT) === 0 ? input.speedKph : 0,
    updatesLive,
    next: { ...state, lastValid, lastFixTime: input.fixTime, jumpStreak },
  };
}

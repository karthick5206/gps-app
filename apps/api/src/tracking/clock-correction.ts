import { NormalizedPosition } from '@veetracer/shared';

/** GPS week-number rollover period (1024 weeks ≈ 19.6 years; last 2019-04-06, next 2038-11-20). */
export const GPS_ROLLOVER_MS = 1024 * 7 * 86_400_000;
const ROLLOVER_TOLERANCE_MS = 2 * 86_400_000;
/** Buffered history the tracker uploads late (after days without network) is still corrected for a rollover. */
const ROLLOVER_HISTORY_MS = 30 * 86_400_000;
/** No tracker reports real data from before this: a reset clock (1980 / 2000 / 2010 defaults). */
const EARLIEST_PLAUSIBLE = Date.UTC(2015, 0, 1);
/** Further ahead than this is a broken clock, not a time-zone mistake (those are flagged by CLOCK_ERROR). */
const MAX_AHEAD_MS = 86_400_000;

export type ClockCorrection = 'gps-week-rollover' | 'device-clock';

/**
 * Repairs impossible device times so live data (and alarms such as SOS) aren't dropped as "late":
 * - a GPS week rollover (the time is a whole number of 1024-week periods behind, give or take 2 days; or, for buffered
 *   history, shifted forward it lands within the last 30 days) → shifted forward. Firmware that has fixed the rollover
 *   sends correct dates, which are left alone, so no per-firmware logic is needed;
 * - a reset or wildly wrong clock (year 2000, decades ahead) → the server receive time. The GPS validity stays as the
 *   tracker reported it (seen: a Concox ID card sending real fixes stamped 2000-01-03 after a restart).
 * The original time is kept in `attributes.deviceTime`.
 */
export function correctClock(position: NormalizedPosition): { position: NormalizedPosition; correction: ClockCorrection | null } {
  const fix = Date.parse(position.fixTime);
  const received = Date.parse(position.receivedAt);
  if (!Number.isFinite(fix) || !Number.isFinite(received)) return { position, correction: null };
  const behind = received - fix;
  for (const k of [1, 2]) {
    const shiftedBehind = behind - k * GPS_ROLLOVER_MS;
    // History only when the raw date is impossible anyway: a reset clock (2000-01-01 + 1024 weeks = 2019) stays out.
    const history = fix < EARLIEST_PLAUSIBLE && shiftedBehind > 0 && shiftedBehind <= ROLLOVER_HISTORY_MS;
    if (Math.abs(shiftedBehind) <= ROLLOVER_TOLERANCE_MS || history) {
      return {
        position: { ...position, fixTime: new Date(fix + k * GPS_ROLLOVER_MS).toISOString(), attributes: { ...position.attributes, deviceTime: position.fixTime, timeCorrected: 'gps-week-rollover' } },
        correction: 'gps-week-rollover',
      };
    }
  }
  if (fix < EARLIEST_PLAUSIBLE || fix - received > MAX_AHEAD_MS) {
    return {
      position: { ...position, fixTime: position.receivedAt, attributes: { ...position.attributes, deviceTime: position.fixTime, timeCorrected: 'device-clock' } },
      correction: 'device-clock',
    };
  }
  return { position, correction: null };
}

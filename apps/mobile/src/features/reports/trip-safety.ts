/**
 * Trip safety & violations report (TRIP_SAFETY) helpers for the mobile Reports screen. Pure, `node --test`: no runtime
 * import from @veetracer/shared. Headers match the web report columns and the API export.
 */
import type { TripSafetyOccurrence, TripSafetyType } from '@veetracer/shared';

/** Short names of the violation types, in TRIP_SAFETY_TYPES order (same as the web / export column headers). */
export const TRIP_SAFETY_HEADERS: Record<TripSafetyType, string> = {
  SEATBELT_OFF: 'Seat belt',
  DRIVER_PHONE: 'Phone',
  DRIVER_FATIGUE: 'Fatigue',
  DRIVER_DISTRACTED: 'Distracted',
  DRIVER_SMOKING: 'Smoking',
  DRIVER_ABSENT: 'No driver',
  FORWARD_COLLISION_WARNING: 'Collision warning',
  LANE_DEPARTURE: 'Lane departure',
  TAILGATING: 'Too close',
  OVERSPEED: 'Overspeed',
  HARSH_BRAKING: 'Harsh braking',
  HARSH_ACCELERATION: 'Harsh accel.',
  HARSH_CORNERING: 'Harsh turn',
  SOS: 'SOS',
  CRASH: 'Crash',
};

/** Place of an occurrence: address, else "lat, lng", else null. */
export function occurrencePlace(o: Pick<TripSafetyOccurrence, 'address' | 'lat' | 'lng'>): string | null {
  if (o.address) return o.address;
  return typeof o.lat === 'number' && typeof o.lng === 'number' ? `${o.lat.toFixed(5)}, ${o.lng.toFixed(5)}` : null;
}

/** Maps link for an occurrence (opens the phone's maps app), or null without coordinates. Same pattern as attendance-day. */
export function occurrenceMapUrl(o: Pick<TripSafetyOccurrence, 'lat' | 'lng'>): string | null {
  return typeof o.lat === 'number' && typeof o.lng === 'number' && Number.isFinite(o.lat) && Number.isFinite(o.lng) ? `https://www.google.com/maps?q=${o.lat},${o.lng}` : null;
}

/** Non-zero violation counts in column order, e.g. [['SEATBELT_OFF', 2], ['OVERSPEED', 1]]. */
export function violationBreakdown(counts: Partial<Record<string, number>> | null | undefined): [TripSafetyType, number][] {
  if (!counts) return [];
  return (Object.keys(TRIP_SAFETY_HEADERS) as TripSafetyType[]).flatMap((type) => {
    const n = counts[type];
    return typeof n === 'number' && n > 0 ? [[type, n] as [TripSafetyType, number]] : [];
  });
}

/** Score colour band (same thresholds as the web report): good ≥ 90, fair ≥ 70, else poor. */
export function scoreBand(score: number): 'good' | 'fair' | 'poor' {
  return score >= 90 ? 'good' : score >= 70 ? 'fair' : 'poor';
}

/**
 * Pure helpers for the live map's marker motion and badges (no MapLibre import, so they are unit-testable).
 * Used by MapController: the halo layer is repainted from `haloState`, badges come from `markerBadge`.
 */

/** Statuses that get an animated halo under the marker. Off and offline stay still. */
export const HALO_STATUSES = ['RUNNING', 'OVERSPEED', 'IDLE'];

/**
 * Halo size (× the marker radius) and strength per status at time `t` (ms).
 * Running pulses outward every 2 s, overspeed every 0.9 s, idle breathes in and out over 3 s.
 * `still` gives a calm, fixed halo (reduced motion, hidden tab, very large fleets).
 */
export function haloState(t: number, still: boolean): { scale: Record<string, number>; opacity: Record<string, number> } {
  if (still) return { scale: { RUNNING: 1.45, OVERSPEED: 1.6, IDLE: 1.35 }, opacity: { RUNNING: 0.2, OVERSPEED: 0.28, IDLE: 0.22 } };
  const run = (t % 2000) / 2000;
  const fast = (t % 900) / 900;
  const breathe = (1 - Math.cos((2 * Math.PI * t) / 3000)) / 2;
  return {
    scale: { RUNNING: 1 + 1.3 * run, OVERSPEED: 1 + 1.5 * fast, IDLE: 1 + 0.45 * breathe },
    opacity: { RUNNING: 0.45 * (1 - run), OVERSPEED: 0.55 * (1 - fast), IDLE: 0.34 - 0.2 * breathe },
  };
}

/** Compact duration for map badges: 45 s → "1m", 18 min → "18m", 5 h → "5h", 3 days → "3d". */
export function shortAge(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  return h < 48 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

/**
 * Badge text beside a marker: the speed while overspeeding, how long a vehicle has idled, and how long an offline
 * device has been silent. Empty for everything else, so parked fleets don't fill the map with badges.
 */
export function markerBadge(status: string, speedKph: number, statusSince: string | null, now: number): string {
  if (status === 'OVERSPEED') return `${Math.round(speedKph)}`;
  if ((status === 'IDLE' || status === 'OFFLINE') && statusSince) {
    const since = Date.parse(statusSince);
    if (Number.isFinite(since) && now > since) return shortAge(now - since);
  }
  return '';
}

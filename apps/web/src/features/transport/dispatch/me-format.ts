/**
 * Passenger "My transport" helpers (pure, `node --test`; 05 §2.8, 10 §4.3). The vehicle position is shown only inside
 * the trip window, and only by polling `GET /api/me/transport/trips/:id/vehicle` every 15 s (no socket). The server
 * decides visibility; the client only decides when asking is worthwhile.
 */
import { ME_VEHICLE_WINDOW, type MeTripDto, type MeVehicleDto } from '@veetracer/shared';

const MIN = 60_000;

/** States after which the vehicle is never shown. */
const NEVER: readonly string[] = ['CANCELLED', 'DETACHED'];

/**
 * Whether to poll the vehicle of one of my trips now. Never for a cancelled / detached trip or when I am a no-show or
 * removed. Yes while the server says the trip is live-visible; otherwise, near my pickup (from planned pickup − 30 min,
 * or the booking window start − 30 min, until the window end + 10 min) so polling starts on its own when the window
 * opens without a reload. Outside that, no request at all.
 */
export function shouldPollVehicle(trip: Pick<MeTripDto, 'derivedState' | 'myStatus' | 'liveVisible' | 'window' | 'myStop'>, nowMs: number): boolean {
  if (NEVER.includes(trip.derivedState)) return false;
  if (trip.myStatus === 'NO_SHOW' || trip.myStatus === 'CANCELLED') return false;
  if (trip.liveVisible) return true;
  if (trip.myStatus === 'DROPPED' || trip.derivedState === 'COMPLETED' || trip.derivedState === 'INCOMPLETE') return false;
  const starts = [Date.parse(trip.window.start), trip.myStop ? Date.parse(trip.myStop.plannedAt) : Number.NaN].filter(Number.isFinite);
  const end = Date.parse(trip.window.end);
  if (!starts.length || !Number.isFinite(end)) return false;
  const open = Math.min(...starts) - ME_VEHICLE_WINDOW.beforeStartMin * MIN;
  const close = Math.max(end, ...starts) + ME_VEHICLE_WINDOW.afterEndMin * MIN;
  return nowMs >= open && nowMs <= close;
}

export const ME_POLL_MS = ME_VEHICLE_WINDOW.pollSeconds * 1000;

/** Text for a hidden vehicle. */
export function hiddenVehicleText(v: MeVehicleDto | undefined): string {
  if (!v || v.visible) return '';
  switch (v.reason) {
    case 'NO_FIX':
      return 'The vehicle has not reported a position yet.';
    case 'NOT_ON_TRIP':
      return 'You are no longer on this trip.';
    default:
      return 'The vehicle is shown from 30 minutes before your pickup until the trip ends.';
  }
}

/** Upcoming first, then the most recent past ones. */
export function sortMyTrips<T extends Pick<MeTripDto, 'window' | 'derivedState'>>(trips: T[], nowMs: number): T[] {
  const done = (t: T) => ['COMPLETED', 'INCOMPLETE', 'CANCELLED', 'DETACHED'].includes(t.derivedState) || Date.parse(t.window.end) < nowMs - 2 * 60 * MIN;
  const upcoming = trips.filter((t) => !done(t)).sort((a, b) => a.window.start.localeCompare(b.window.start));
  const past = trips.filter(done).sort((a, b) => b.window.start.localeCompare(a.window.start));
  return [...upcoming, ...past];
}

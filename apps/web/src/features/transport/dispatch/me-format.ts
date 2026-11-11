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
 * The vehicle window of a trip as the server computes it (05 §2.8): the trip's planned start − 30 min until its planned
 * end + 10 min. Older payloads without the trip times fall back to my pickup / booking window. Null when unknown.
 */
export function vehicleWindowOf(trip: Pick<MeTripDto, 'window' | 'myStop'> & Partial<Pick<MeTripDto, 'plannedStart' | 'plannedEnd'>>): { open: number; close: number } | null {
  const ps = trip.plannedStart ? Date.parse(trip.plannedStart) : Number.NaN;
  const pe = trip.plannedEnd ? Date.parse(trip.plannedEnd) : Number.NaN;
  if (Number.isFinite(ps) && Number.isFinite(pe)) return { open: ps - ME_VEHICLE_WINDOW.beforeStartMin * MIN, close: pe + ME_VEHICLE_WINDOW.afterEndMin * MIN };
  const starts = [Date.parse(trip.window.start), trip.myStop ? Date.parse(trip.myStop.plannedAt) : Number.NaN].filter(Number.isFinite);
  const end = Date.parse(trip.window.end);
  if (!starts.length || !Number.isFinite(end)) return null;
  return { open: Math.min(...starts) - ME_VEHICLE_WINDOW.beforeStartMin * MIN, close: Math.max(end, ...starts) + ME_VEHICLE_WINDOW.afterEndMin * MIN };
}

/**
 * Whether to poll the vehicle of one of my trips now. Never for a cancelled / detached trip or when I am a no-show or
 * removed. Yes while the server says the trip is live-visible; otherwise inside the trip's vehicle window
 * (vehicleWindowOf), so polling starts on its own when the window opens without a reload. Outside that, no request.
 */
export function shouldPollVehicle(trip: Pick<MeTripDto, 'derivedState' | 'myStatus' | 'liveVisible' | 'window' | 'myStop'> & Partial<Pick<MeTripDto, 'plannedStart' | 'plannedEnd'>>, nowMs: number): boolean {
  if (NEVER.includes(trip.derivedState)) return false;
  if (trip.myStatus === 'NO_SHOW' || trip.myStatus === 'CANCELLED') return false;
  if (trip.liveVisible) return true;
  if (trip.myStatus === 'DROPPED' || trip.derivedState === 'COMPLETED' || trip.derivedState === 'INCOMPLETE') return false;
  const w = vehicleWindowOf(trip);
  return !!w && nowMs >= w.open && nowMs <= w.close;
}

/** My own pickup / drop markers for the map (only what the server sent: my points, with my consent). */
export function myMapStops(trip: Pick<MeTripDto, 'myPickupPoint' | 'myDropPoint' | 'myStop' | 'myDrop'>): { seq: number; lat: number; lng: number; label: string; mine?: boolean }[] {
  const out: { seq: number; lat: number; lng: number; label: string; mine?: boolean }[] = [];
  if (trip.myPickupPoint) out.push({ seq: trip.myStop?.seq ?? 0, ...trip.myPickupPoint, label: trip.myStop?.label ?? 'My pickup', mine: true });
  if (trip.myDropPoint) out.push({ seq: trip.myDrop?.seq ?? 1, ...trip.myDropPoint, label: trip.myDrop?.label ?? 'My drop' });
  return out;
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

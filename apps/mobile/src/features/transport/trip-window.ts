/**
 * Passenger trip helpers (pure, `node --test`; doc 05 §2.8, doc 08 §5.3, doc 10 §4.3). Same rules as the web
 * `me-format.ts`: the vehicle position is shown only inside the trip window, and only by polling
 * `GET /api/me/transport/trips/:id/vehicle` every 15 s while the trip screen is open (no socket, no background work).
 * The server decides visibility; the client only decides when asking is worthwhile.
 */
import type { MeTripDto, MeVehicleDto } from '@veetracer/shared';

const MIN = 60_000;

/** Mirrors ME_VEHICLE_WINDOW in @veetracer/shared (kept literal so this module has no runtime import). */
export const VEHICLE_WINDOW = { beforeStartMin: 30, afterEndMin: 10, pollSeconds: 15 } as const;
export const ME_POLL_MS = VEHICLE_WINDOW.pollSeconds * 1000;

/** States after which the vehicle is never shown. */
const NEVER: readonly string[] = ['CANCELLED', 'DETACHED'];
const FINISHED: readonly string[] = ['COMPLETED', 'INCOMPLETE', 'CANCELLED', 'DETACHED'];

type WindowFields = Pick<MeTripDto, 'window' | 'myStop'> & Partial<Pick<MeTripDto, 'plannedStart' | 'plannedEnd'>>;

/**
 * The vehicle window as the server computes it: the trip's planned start − 30 min until its planned end + 10 min.
 * Without the trip times, my pickup / booking window. Null when unknown.
 */
export function vehicleWindowOf(trip: WindowFields): { open: number; close: number } | null {
  const ps = trip.plannedStart ? Date.parse(trip.plannedStart) : Number.NaN;
  const pe = trip.plannedEnd ? Date.parse(trip.plannedEnd) : Number.NaN;
  if (Number.isFinite(ps) && Number.isFinite(pe)) return { open: ps - VEHICLE_WINDOW.beforeStartMin * MIN, close: pe + VEHICLE_WINDOW.afterEndMin * MIN };
  const starts = [Date.parse(trip.window.start), trip.myStop ? Date.parse(trip.myStop.plannedAt) : Number.NaN].filter(Number.isFinite);
  const end = Date.parse(trip.window.end);
  if (!starts.length || !Number.isFinite(end)) return null;
  return { open: Math.min(...starts) - VEHICLE_WINDOW.beforeStartMin * MIN, close: Math.max(end, ...starts) + VEHICLE_WINDOW.afterEndMin * MIN };
}

/**
 * Whether to poll the vehicle now. Never for a cancelled / detached trip, a no-show or a removed passenger. Yes while
 * the server says the trip is live-visible; otherwise only inside the vehicle window, so polling starts by itself when
 * the window opens and stops when it closes. Outside it: no request at all.
 */
export function shouldPollVehicle(trip: Pick<MeTripDto, 'derivedState' | 'myStatus' | 'liveVisible'> & WindowFields, nowMs: number): boolean {
  if (NEVER.includes(trip.derivedState)) return false;
  if (trip.myStatus === 'NO_SHOW' || trip.myStatus === 'CANCELLED') return false;
  if (trip.liveVisible) return true;
  if (trip.myStatus === 'DROPPED' || trip.derivedState === 'COMPLETED' || trip.derivedState === 'INCOMPLETE') return false;
  const w = vehicleWindowOf(trip);
  return !!w && nowMs >= w.open && nowMs <= w.close;
}

/** Text for a hidden vehicle (English source string; translate where shown). */
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

/** My own pickup / drop markers (only what the server sent: my points, with my consent). */
export function myMapStops(trip: Pick<MeTripDto, 'myPickupPoint' | 'myDropPoint' | 'myStop' | 'myDrop'>): { kind: 'pickup' | 'drop'; lat: number; lng: number; label: string }[] {
  const out: { kind: 'pickup' | 'drop'; lat: number; lng: number; label: string }[] = [];
  if (trip.myPickupPoint) out.push({ kind: 'pickup', ...trip.myPickupPoint, label: trip.myStop?.label ?? 'My pickup' });
  if (trip.myDropPoint) out.push({ kind: 'drop', ...trip.myDropPoint, label: trip.myDrop?.label ?? 'My drop' });
  return out;
}

/** Trip states in which the vehicle is on its way (started, not completed). */
const RUNNING: readonly string[] = ['EN_ROUTE', 'AT_STOP', 'IN_PROGRESS'];
/** My own seat states after which the trip is over for me, whatever the trip itself still says. */
const SEAT_DONE: readonly string[] = ['DROPPED', 'NO_SHOW', 'CANCELLED'];
/** A trip not started is history 2 h after its end; a started one only 12 h after (the driver may complete it late). */
const PAST_AFTER_MS = 2 * 60 * MIN;
const RUNNING_PAST_AFTER_MS = 12 * 60 * MIN;

type ListFields = Pick<MeTripDto, 'window' | 'derivedState'> & Partial<Pick<MeTripDto, 'myStatus' | 'myStop' | 'plannedStart' | 'plannedEnd'>>;

/** Sort key (ms): my booking window start (as before, now as an instant), else the trip's planned start, else my pickup. */
function startMs(t: ListFields): number {
  for (const iso of [t.window.start, t.plannedStart, t.myStop?.plannedAt]) {
    const v = iso ? Date.parse(iso) : Number.NaN;
    if (Number.isFinite(v)) return v;
  }
  return Number.POSITIVE_INFINITY;
}

function endMs(t: ListFields): number {
  const ends = [t.window.end, t.plannedEnd].map((iso) => (iso ? Date.parse(iso) : Number.NaN)).filter(Number.isFinite);
  return ends.length ? Math.max(...ends) : Number.NaN;
}

/**
 * Over for me: the trip is completed / incomplete / cancelled / detached, or my own seat is dropped / no-show /
 * cancelled (the trip may still run for others), or it ended long ago. Compared as instants, so any ISO offset works.
 */
export function isFinished(trip: ListFields, nowMs: number): boolean {
  if (FINISHED.includes(trip.derivedState)) return true;
  if (trip.myStatus && SEAT_DONE.includes(trip.myStatus)) return true;
  const end = endMs(trip);
  if (!Number.isFinite(end)) return false;
  return end < nowMs - (RUNNING.includes(trip.derivedState) ? RUNNING_PAST_AFTER_MS : PAST_AFTER_MS);
}

/** Upcoming first (soonest first), then past ones (most recent first). */
export function sortMyTrips<T extends ListFields>(trips: readonly T[], nowMs: number): T[] {
  const upcoming = trips.filter((t) => !isFinished(t, nowMs)).sort((a, b) => startMs(a) - startMs(b));
  const past = trips.filter((t) => isFinished(t, nowMs)).sort((a, b) => startMs(b) - startMs(a));
  return [...upcoming, ...past];
}

/** YYYY-MM-DD of `nowMs` in `timeZone` (falls back to UTC for an unknown zone). */
export function dayIn(timeZone: string, nowMs: number): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(nowMs));
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
    return `${get('year')}-${get('month')}-${get('day')}`;
  } catch {
    return new Date(nowMs).toISOString().slice(0, 10);
  }
}

/**
 * Today / upcoming / past buckets for the passenger home. "Today" is the trip's service date in its own time zone
 * (overnight shifts: doc 08 §6.3), unless the trip is already finished.
 */
export function tripBuckets<T extends ListFields & Pick<MeTripDto, 'serviceDate' | 'timeZone'>>(trips: readonly T[], nowMs: number): { today: T[]; upcoming: T[]; past: T[] } {
  const sorted = sortMyTrips(trips, nowMs);
  const today: T[] = [];
  const upcoming: T[] = [];
  const past: T[] = [];
  for (const t of sorted) {
    if (isFinished(t, nowMs)) past.push(t);
    else if (t.serviceDate <= dayIn(t.timeZone, nowMs)) today.push(t);
    else upcoming.push(t);
  }
  return { today, upcoming, past };
}

/**
 * The trip for the home card (R1151 B5): the one under way for me (started, my seat not dropped / no-show / cancelled),
 * else one whose vehicle window is open, else the earliest not-finished one. A finished trip or a seat I already left
 * is never "next", even while its vehicle window is still open; those are under "Recent trips".
 */
export function nextTrip<T extends ListFields & Pick<MeTripDto, 'liveVisible'>>(trips: readonly T[], nowMs: number): T | null {
  const open = sortMyTrips(trips, nowMs).filter((t) => !isFinished(t, nowMs));
  return open.find((t) => RUNNING.includes(t.derivedState)) ?? open.find((t) => t.liveVisible) ?? open[0] ?? null;
}

/** "HH:mm" of an ISO time in the trip's zone (falls back to the device zone). */
export function clockIn(iso: string | null | undefined, timeZone: string, locale = 'en-IN'): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  try {
    return new Intl.DateTimeFormat(locale, { timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
  } catch {
    return d.toTimeString().slice(0, 5);
  }
}

/** Great-circle distance in km (for the text equivalent of the map: "about 1.2 km from your pickup"). */
export function distanceKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Self-cancel cut-off of a booking (`MeBookingDto.cutoffAt`, computed by the server). NONE: the booking has no cut-off
 * (a cancel is allowed until the trip starts); OPEN: before it; PASSED: from it on (the server answers AFTER_CUTOFF).
 */
export function cutoffState(cutoffAt: string | null | undefined, nowMs: number): 'NONE' | 'OPEN' | 'PASSED' {
  if (!cutoffAt) return 'NONE';
  const t = Date.parse(cutoffAt);
  if (!Number.isFinite(t)) return 'NONE';
  return nowMs < t ? 'OPEN' : 'PASSED';
}

/** Day and time of a cut-off in the booking's zone ("10 Nov, 22:00"); "—" when missing or invalid. */
export function cutoffText(iso: string | null | undefined, timeZone: string, locale = 'en-IN'): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  try {
    return new Intl.DateTimeFormat(locale, { timeZone, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
  } catch {
    return d.toISOString().slice(0, 16).replace('T', ' ');
  }
}

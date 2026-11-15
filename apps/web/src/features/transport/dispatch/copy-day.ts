/**
 * Copy yesterday's allocation (pure, `node --test`): rebuilds an earlier day's trips as new trips in today's draft —
 * same vehicle, same driver, same people in the same stop order, same clock time. Only people who have a waiting,
 * assignable booking today are seated; everyone else is reported (absent, on leave or already seated). Nothing is
 * published: the dispatcher reviews the draft, adjusts it and publishes.
 */
import type { TransportDirection } from '@veetracer/shared';
import type { AllocBooking, AllocTaken, AllocVehicle } from './auto-allocate';

/** One trip of the source day (from GET /transport/trips/:id). */
export interface SourceTrip {
  id: string;
  name: string;
  objectId: string | null;
  vehicleName: string | null;
  driverId: string | null;
  driverName: string | null;
  shiftId: string | null;
  plannedStart: string | null;
  cancelled: boolean;
  passengers: { profileId: string; name: string; pickupSeq: number; dropSeq: number; cancelled: boolean }[];
}

/** A waiting booking of today, with its passenger profile. */
export interface CopyBooking extends AllocBooking {
  profileId: string;
}

export interface CopiedTrip {
  sourceTripId: string;
  vehicle: { objectId: string; label: string; seats: number };
  driver: { id: string; label: string } | null;
  bookings: CopyBooking[];
  shiftId: string | null;
  startMs: number;
}

export interface CopyResult {
  trips: CopiedTrip[];
  /** Yesterday's passengers with no waiting booking today (absent, on leave, already seated, booking needs approval). */
  notWaiting: string[];
  /** Trips not copied, with why: the vehicle is gone, has no seats or is busy. Their people stay waiting. */
  skipped: { name: string; reason: 'NO_VEHICLE' | 'NO_SEATS' | 'BUSY' | 'NOBODY_WAITING' }[];
  /** Seats short: people who did not fit the vehicle today. */
  overflow: string[];
}

const DAY = 86_400_000;
const overlaps = (a0: number, a1: number, b0: number, b1: number) => a0 < b1 && b0 < a1;

/**
 * `dayShift` is the number of days from the source day to today (1 = yesterday). Bookings already used by the draft
 * must be left out of `waiting`; vehicle uses in the draft go in `taken`.
 */
export function copyDay(source: SourceTrip[], waiting: CopyBooking[], vehicles: AllocVehicle[], taken: AllocTaken[], direction: TransportDirection, dayShift = 1): CopyResult {
  const byProfile = new Map<string, CopyBooking[]>();
  for (const b of waiting) {
    const l = byProfile.get(b.profileId);
    if (l) l.push(b);
    else byProfile.set(b.profileId, [b]);
  }
  const usedBookings = new Set<string>();
  const used: AllocTaken[] = [...taken];
  const result: CopyResult = { trips: [], notWaiting: [], skipped: [], overflow: [] };

  const live = source.filter((t) => !t.cancelled).sort((a, b) => (a.plannedStart ?? '').localeCompare(b.plannedStart ?? ''));
  for (const t of live) {
    const seq = (p: SourceTrip['passengers'][number]) => (direction === 'IN' ? p.pickupSeq : p.dropSeq);
    const people = t.passengers.filter((p) => !p.cancelled).sort((a, b) => seq(a) - seq(b) || a.name.localeCompare(b.name));
    const matched: CopyBooking[] = [];
    for (const p of people) {
      const options = (byProfile.get(p.profileId) ?? []).filter((b) => !usedBookings.has(b.id) && (!t.shiftId || !b.shiftId || b.shiftId === t.shiftId));
      if (!options.length) {
        result.notWaiting.push(p.name);
        continue;
      }
      matched.push(options[0]);
    }
    if (!matched.length) {
      result.skipped.push({ name: t.vehicleName ?? t.name, reason: 'NOBODY_WAITING' });
      continue;
    }
    const vehicle = vehicles.find((v) => v.objectId === t.objectId);
    if (!vehicle) {
      result.skipped.push({ name: t.vehicleName ?? t.name, reason: 'NO_VEHICLE' });
      continue;
    }
    if (!vehicle.seats) {
      result.skipped.push({ name: vehicle.label, reason: 'NO_SEATS' });
      continue;
    }
    const startMs = t.plannedStart ? Date.parse(t.plannedStart) + dayShift * DAY : Math.min(...matched.map((b) => Date.parse(b.windowStart)));
    const endMs = Math.max(startMs + 1, ...matched.map((b) => Date.parse(b.windowEnd)));
    const busy = vehicle.busy.some((x) => overlaps(startMs, endMs, Date.parse(x.plannedStart), Date.parse(x.plannedEnd))) || used.some((x) => x.objectId === vehicle.objectId && overlaps(startMs, endMs, x.startMs, x.endMs));
    if (busy) {
      result.skipped.push({ name: vehicle.label, reason: 'BUSY' });
      continue;
    }
    const seated: CopyBooking[] = [];
    let left = vehicle.seats;
    for (const b of matched) {
      if (b.seats <= left) {
        seated.push(b);
        left -= b.seats;
      } else result.overflow.push(b.name);
    }
    for (const b of seated) usedBookings.add(b.id);
    used.push({ objectId: vehicle.objectId, startMs, endMs });
    result.trips.push({
      sourceTripId: t.id,
      vehicle: { objectId: vehicle.objectId, label: vehicle.label, seats: vehicle.seats },
      driver: t.driverId ? { id: t.driverId, label: t.driverName ?? '' } : null,
      bookings: seated,
      shiftId: t.shiftId,
      startMs,
    });
  }
  return result;
}

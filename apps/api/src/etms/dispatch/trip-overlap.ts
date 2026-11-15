import type { Prisma } from '@prisma/client';
import { ACTIVE_TRIP_STATUSES_FOR_OVERLAP, type PlannedTripStatus } from '@veetracer/shared';

/**
 * The one "is this vehicle / driver already busy" rule (15 §8.1): an active planned trip (any origin: route schedule,
 * dispatcher, route plan) whose [plannedStart, plannedEnd) overlaps [start, end) — touching ends do not count. Used by
 * the E3 publish transaction (DispatchService.assertFree, under the advisory locks, backed by the ETMS EXCLUDE
 * constraints) and, before anything is written, by the route plans' availability pre-check (WP-B), so both answer the
 * same VEHICLE_BUSY / DRIVER_BUSY for the same trips.
 */
export const ACTIVE_OVERLAP_STATUSES = [...ACTIVE_TRIP_STATUSES_FOR_OVERLAP] as PlannedTripStatus[];

/** Planned-trip filter of the overlap rule (add `objectId` or `driverId`). */
export function overlapWhere(start: Date, end: Date, exceptPlannedTripId: string | null = null): Prisma.PlannedTripWhereInput {
  return { status: { in: ACTIVE_OVERLAP_STATUSES }, plannedStart: { lt: end }, plannedEnd: { gt: start }, ...(exceptPlannedTripId ? { id: { not: exceptPlannedTripId } } : {}) };
}

/** A planned trip as the overlap rule needs it. */
export interface BusyTrip {
  id: string;
  objectId: string;
  driverId: string | null;
  status: string;
  plannedStart: Date;
  plannedEnd: Date;
  routeName: string;
}

/** The same rule in memory (the pre-check loads the candidate trips of a whole plan in one query). */
export function tripOverlaps(t: Pick<BusyTrip, 'status' | 'plannedStart' | 'plannedEnd'>, start: Date, end: Date): boolean {
  return (ACTIVE_OVERLAP_STATUSES as readonly string[]).includes(t.status) && t.plannedStart.getTime() < end.getTime() && t.plannedEnd.getTime() > start.getTime();
}

/** First trip that makes the vehicle / driver busy in [start, end) (vehicle checked first, like the publish), or null. */
export function findBusy(trips: readonly BusyTrip[], who: { objectId: string | null; driverId: string | null }, start: Date, end: Date): { code: 'VEHICLE_BUSY' | 'DRIVER_BUSY'; trip: BusyTrip } | null {
  if (who.objectId) {
    const hit = trips.find((t) => t.objectId === who.objectId && tripOverlaps(t, start, end));
    if (hit) return { code: 'VEHICLE_BUSY', trip: hit };
  }
  if (who.driverId) {
    const hit = trips.find((t) => t.driverId === who.driverId && tripOverlaps(t, start, end));
    if (hit) return { code: 'DRIVER_BUSY', trip: hit };
  }
  return null;
}

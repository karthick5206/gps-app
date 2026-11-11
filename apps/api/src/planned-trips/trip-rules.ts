import { CANCELLABLE_PLANNED_TRIP_STATUSES, PLANNED_TRIP_TIMING, PlannedTripStatus } from '@veetracer/shared';

const MIN = 60_000;

/** Vehicle, driver and planned start can only change before the trip starts. */
export const canEditTrip = (status: PlannedTripStatus): boolean => status === 'SCHEDULED';
export const canCancelTrip = (status: PlannedTripStatus): boolean => CANCELLABLE_PLANNED_TRIP_STATUSES.includes(status);
export const canStartTrip = (status: PlannedTripStatus): boolean => status === 'SCHEDULED';
export const canCompleteTrip = (status: PlannedTripStatus): boolean => status === 'STARTED' || status === 'IN_PROGRESS';

/** Statuses the INCOMPLETE sweeper closes once plannedEnd + 120 min has passed. */
export const OPEN_TRIP_STATUSES: PlannedTripStatus[] = ['SCHEDULED', 'STARTED', 'IN_PROGRESS'];

/** Trips with plannedEnd before this instant are timed out (→ INCOMPLETE, closedBy TIMEOUT). */
export function incompleteCutoff(nowMs: number): Date {
  return new Date(nowMs - PLANNED_TRIP_TIMING.incompleteAfterMin * MIN);
}

/** SCHEDULED trips with plannedStart at or before this instant have not started in time. */
export function notStartedCutoff(nowMs: number, graceMin: number = PLANNED_TRIP_TIMING.notStartedGraceMin): Date {
  return new Date(nowMs - graceMin * MIN);
}

/** Whether an open trip is past the INCOMPLETE timeout. */
export function isTimedOut(trip: { status: PlannedTripStatus; plannedEnd: Date }, nowMs: number): boolean {
  return OPEN_TRIP_STATUSES.includes(trip.status) && trip.plannedEnd.getTime() < incompleteCutoff(nowMs).getTime();
}

/** Whether a SCHEDULED trip is past its start grace (and not yet timed out). */
export function isNotStarted(trip: { status: PlannedTripStatus; plannedStart: Date; plannedEnd: Date }, nowMs: number): boolean {
  return trip.status === 'SCHEDULED' && trip.plannedStart.getTime() <= notStartedCutoff(nowMs).getTime() && !isTimedOut(trip, nowMs);
}

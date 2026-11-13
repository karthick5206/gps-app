import { HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TRANSPORT_E3_LIMITS, type TransportBookingJourney, type TransportIneligibleReason } from '@veetracer/shared';
import { conflict, e3Error } from './e3-common';

/**
 * WP 3.9 booking rules shared by the dispatcher create / PATCH and the passenger self-booking (which goes through
 * BookingsService.create): eligibility (422 NOT_ELIGIBLE + reason), personal-point consent (409 CONSENT_REQUIRED, D-A3),
 * the late-booking reason (409 LATE_REASON_REQUIRED, D-A1) and the time-overlap rule of POINT_TO_POINT bookings
 * (409 BOOKING_OVERLAP). Pure parts only; the queries live in BookingsService.
 */

/** Statuses that hold a passenger's time (the partial unique index and the GiST exclusion use the same set). */
export const ACTIVE_BOOKING_STATUSES = ['REQUESTED', 'PENDING_ASSIGNMENT', 'ASSIGNED', 'CONFIRMED', 'WAITLISTED'] as const;

/** Who is booking: the transport desk (dispatcher) or the passenger themself (self-service). */
export type BookingActor = 'DESK' | 'PASSENGER';

export const notEligible = (reason: TransportIneligibleReason, message: string) => e3Error(HttpStatus.UNPROCESSABLE_ENTITY, 'NOT_ELIGIBLE', message, { reason });

export const personalPointConsentRequired = () =>
  conflict('CONSENT_REQUIRED', 'A pickup or destination that is not a company place needs the passenger’s location consent');

export const overlapConflict = (bookingId: string | null) =>
  conflict('BOOKING_OVERLAP', 'The passenger already has a booking at that time', bookingId ? { bookingId } : {});

export interface EligibilityFacts {
  profile: { isActive: boolean; anonymisedAt: Date | null };
  /** The booking's shift, when it has one. */
  shift: { isActive: boolean; days: number[] } | null;
  /** Weekday (0 = Sunday) of the service date. */
  weekday: number;
  passengerCount: number;
}

/** The first eligibility rule that fails, or null. Branch scope and unknown ids are 404 / 400 before this runs. */
export function ineligibility(f: EligibilityFacts): { reason: TransportIneligibleReason; message: string } | null {
  if (f.profile.anonymisedAt) return { reason: 'PASSENGER_ANONYMISED', message: 'This passenger’s data was erased; they cannot be booked' };
  if (!f.profile.isActive) return { reason: 'PASSENGER_INACTIVE', message: 'This passenger is inactive' };
  if (f.shift && !f.shift.isActive) return { reason: 'SHIFT_INACTIVE', message: 'This shift is archived' };
  if (f.shift && !f.shift.days.includes(f.weekday)) return { reason: 'SHIFT_NOT_RUNNING', message: 'The shift does not run on that day' };
  if (!Number.isInteger(f.passengerCount) || f.passengerCount < 1 || f.passengerCount > TRANSPORT_E3_LIMITS.maxPassengerCount) {
    return { reason: 'SEATS_NOT_ALLOWED', message: `Seats must be 1 to ${TRANSPORT_E3_LIMITS.maxPassengerCount}` };
  }
  return null;
}

export function assertEligible(f: EligibilityFacts): void {
  const bad = ineligibility(f);
  if (bad) throw notEligible(bad.reason, bad.message);
}

/** A booking is late once its cut-off has passed (null cut-off = never late). */
export const isLate = (cutoffAt: number | null, now: number = Date.now()): boolean => cutoffAt !== null && now >= cutoffAt;

/**
 * D-A1: the dispatcher's reason for a booking made / changed after its cut-off: trimmed, lateReasonMin..lateReasonMax
 * characters, else 409 LATE_REASON_REQUIRED (so the client can show the reason field).
 */
export function requireLateReason(raw: string | null | undefined): string {
  const reason = (raw ?? '').trim().replace(/\s+/g, ' ');
  const { lateReasonMin: min, lateReasonMax: max } = TRANSPORT_E3_LIMITS;
  if (reason.length < min || reason.length > max) {
    throw conflict('LATE_REASON_REQUIRED', `The cut-off has passed: give a reason of ${min} to ${max} characters`, { lateReasonMin: min, lateReasonMax: max });
  }
  return reason;
}

/**
 * Bookings of the passenger whose time a new / changed booking may not overlap: a POINT_TO_POINT booking overlaps no
 * active booking at all; a COMMUTE booking overlaps no active POINT_TO_POINT booking (COMMUTE vs COMMUTE stays the
 * per-day / direction duplicate rule). Half-open windows, as the GiST exclusion ('[)').
 */
export function overlapWhere(profileId: string, journey: TransportBookingJourney, start: number, end: number, exceptId?: string): Prisma.TransportBookingWhereInput {
  return {
    profileId,
    status: { in: [...ACTIVE_BOOKING_STATUSES] },
    windowStart: { lt: new Date(end) },
    windowEnd: { gt: new Date(start) },
    ...(journey === 'COMMUTE' ? { journey: 'POINT_TO_POINT' as const } : {}),
    ...(exceptId ? { id: { not: exceptId } } : {}),
  };
}

/** The P2P exclusion constraint fired (concurrent overlapping POINT_TO_POINT inserts / edits). */
export function isOverlapExclusion(e: unknown): boolean {
  const msg = `${e instanceof Error ? e.message : ''} ${JSON.stringify((e as { meta?: unknown } | null)?.meta ?? {})}`;
  return msg.includes('TransportBooking_p2p_overlap_excl') || (/23P01|exclusion constraint/i.test(msg) && /TransportBooking/.test(msg));
}

/**
 * WP 3.9: the journey of a TRIP (driver / passenger apps): POINT_TO_POINT when any active (non-cancelled) seat's booking
 * is POINT_TO_POINT, else COMMUTE. A point-to-point trip is stored with direction IN, so the apps must not head it
 * "To site". A trip whose seats are all cancelled is judged on all of them.
 */
export function tripJourney(seats: { status: string; booking?: { journey: TransportBookingJourney } | null }[]): TransportBookingJourney {
  const active = seats.filter((s) => s.status !== 'CANCELLED');
  return (active.length ? active : seats).some((s) => s.booking?.journey === 'POINT_TO_POINT') ? 'POINT_TO_POINT' : 'COMMUTE';
}

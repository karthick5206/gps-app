import { HttpException, type ArgumentsHost } from '@nestjs/common';
import { HttpExceptionFilter } from '../../common/http-exception.filter';
import { TRANSPORT_E3_LIMITS } from '@veetracer/shared';
import { assertEligible, ineligibility, isLate, isOverlapExclusion, notEligible, overlapConflict, overlapWhere, requireLateReason, tripJourney } from './booking-rules';

/** WP 3.9 pure booking rules (eligibility, late reason, overlap, trip journey). */

const ok = { profile: { isActive: true, anonymisedAt: null }, shift: { isActive: true, days: [1, 2, 3, 4, 5] }, weekday: 2, passengerCount: 1 };
const codeOf = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    if (e instanceof HttpException) return [e.getStatus(), (e.getResponse() as { code?: string; reason?: string }).code, (e.getResponse() as { reason?: string }).reason];
    throw e;
  }
  return null;
};

describe('WP 3.9 eligibility (shared by the desk and the passenger paths)', () => {
  it('passes an active passenger, an active shift running that day and 1-6 seats', () => {
    expect(ineligibility(ok)).toBeNull();
    expect(ineligibility({ ...ok, shift: null, passengerCount: TRANSPORT_E3_LIMITS.maxPassengerCount })).toBeNull();
  });

  it.each([
    [{ ...ok, profile: { isActive: false, anonymisedAt: null } }, 'PASSENGER_INACTIVE'],
    [{ ...ok, profile: { isActive: false, anonymisedAt: new Date() } }, 'PASSENGER_ANONYMISED'],
    [{ ...ok, shift: { isActive: false, days: [2] } }, 'SHIFT_INACTIVE'],
    [{ ...ok, weekday: 0 }, 'SHIFT_NOT_RUNNING'],
    [{ ...ok, passengerCount: 0 }, 'SEATS_NOT_ALLOWED'],
    [{ ...ok, passengerCount: TRANSPORT_E3_LIMITS.maxPassengerCount + 1 }, 'SEATS_NOT_ALLOWED'],
    [{ ...ok, passengerCount: 1.5 }, 'SEATS_NOT_ALLOWED'],
  ])('refuses with 422 NOT_ELIGIBLE and the reason (%#)', (facts, reason) => {
    expect(codeOf(() => assertEligible(facts))).toEqual([422, 'NOT_ELIGIBLE', reason]);
  });
});

describe('WP 3.9 late bookings (D-A1)', () => {
  it('is late from the cut-off on; no cut-off is never late', () => {
    expect(isLate(1000, 999)).toBe(false);
    expect(isLate(1000, 1000)).toBe(true);
    expect(isLate(null, 1e15)).toBe(false);
  });

  it('needs a trimmed reason of lateReasonMin..lateReasonMax characters (409 LATE_REASON_REQUIRED)', () => {
    const min = TRANSPORT_E3_LIMITS.lateReasonMin;
    expect(codeOf(() => requireLateReason(undefined))).toEqual([409, 'LATE_REASON_REQUIRED', undefined]);
    expect(codeOf(() => requireLateReason(`   ${'x'.repeat(min - 1)}   `))).toEqual([409, 'LATE_REASON_REQUIRED', undefined]);
    expect(codeOf(() => requireLateReason('y'.repeat(TRANSPORT_E3_LIMITS.lateReasonMax + 1)))).toEqual([409, 'LATE_REASON_REQUIRED', undefined]);
    expect(requireLateReason(`  Client   meeting moved ${'.'.repeat(min)} `)).toBe(`Client meeting moved ${'.'.repeat(min)}`);
  });
});

describe('WP 3.9 overlap and trip journey', () => {
  it('a point-to-point booking overlaps any active booking; a commute only point-to-point ones; half-open windows', () => {
    const p2p = overlapWhere('p1', 'POINT_TO_POINT', 1000, 2000, 'self');
    expect(p2p).toMatchObject({ profileId: 'p1', windowStart: { lt: new Date(2000) }, windowEnd: { gt: new Date(1000) }, id: { not: 'self' } });
    expect(p2p).not.toHaveProperty('journey');
    expect(overlapWhere('p1', 'COMMUTE', 1000, 2000)).toMatchObject({ journey: 'POINT_TO_POINT' });
    expect((p2p.status as { in: string[] }).in.sort()).toEqual(['ASSIGNED', 'CONFIRMED', 'PENDING_ASSIGNMENT', 'REQUESTED', 'WAITLISTED']);
  });

  it('recognises the GiST exclusion violation of point-to-point bookings', () => {
    expect(isOverlapExclusion(new Error('conflicting key value violates exclusion constraint "TransportBooking_p2p_overlap_excl"'))).toBe(true);
    expect(isOverlapExclusion(new Error('duplicate key value violates unique constraint'))).toBe(false);
  });

  it('a trip is POINT_TO_POINT when an active seat is, else COMMUTE', () => {
    expect(tripJourney([{ status: 'PENDING', booking: { journey: 'COMMUTE' } }, { status: 'BOARDED', booking: { journey: 'POINT_TO_POINT' } }])).toBe('POINT_TO_POINT');
    expect(tripJourney([{ status: 'PENDING', booking: { journey: 'COMMUTE' } }, { status: 'CANCELLED', booking: { journey: 'POINT_TO_POINT' } }])).toBe('COMMUTE');
    expect(tripJourney([{ status: 'CANCELLED', booking: { journey: 'POINT_TO_POINT' } }])).toBe('POINT_TO_POINT');
    expect(tripJourney([])).toBe('COMMUTE');
  });
});

describe('WP 3.9 error bodies through the HTTP filter', () => {
  const run = (url: string, e: unknown) => {
    let body: Record<string, unknown> = {};
    let status = 0;
    const res = { status: (s: number) => ((status = s), res), json: (b: Record<string, unknown>) => ((body = b), res), setHeader: () => undefined };
    const host = { getType: () => 'http', switchToHttp: () => ({ getResponse: () => res, getRequest: () => ({ originalUrl: url }) }) } as unknown as ArgumentsHost;
    new HttpExceptionFilter().catch(e, host);
    return { status, body };
  };

  it('NOT_ELIGIBLE keeps reason; BOOKING_OVERLAP keeps bookingId; LATE_REASON_REQUIRED keeps its limits (ETMS routes only)', () => {
    expect(run('/api/transport/bookings', notEligible('SHIFT_NOT_RUNNING', 'no'))).toEqual({ status: 422, body: { statusCode: 422, message: 'no', code: 'NOT_ELIGIBLE', reason: 'SHIFT_NOT_RUNNING' } });
    expect(run('/api/transport/bookings', overlapConflict('b-1')).body).toMatchObject({ statusCode: 409, code: 'BOOKING_OVERLAP', bookingId: 'b-1' });
    const late = (() => {
      try {
        requireLateReason('');
      } catch (e) {
        return e;
      }
    })();
    expect(run('/api/transport/bookings/x', late).body).toMatchObject({ code: 'LATE_REASON_REQUIRED', lateReasonMin: TRANSPORT_E3_LIMITS.lateReasonMin, lateReasonMax: TRANSPORT_E3_LIMITS.lateReasonMax });
    expect(run('/api/vehicles', notEligible('SHIFT_NOT_RUNNING', 'no')).body.reason).toBeUndefined();
  });
});

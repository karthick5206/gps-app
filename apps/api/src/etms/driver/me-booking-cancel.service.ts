import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { bookingTransition, type MeBookingDto } from '@veetracer/shared';
import { AuthContext } from '../../access/auth-context';
import { AuditService } from '../../audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import { BOOKING_ENTITY } from '../dispatch/bookings.service';
import { MeTransportService } from '../dispatch/me-transport.service';
import { TripLiveService } from '../dispatch/trip-live';
import { lockBookings, lockTrips, recordTripEvent, releaseSeat } from '../dispatch/trip-ops';
import { PeopleService } from '../people/people.service';

/**
 * Passenger self-cancel (05 §2.8 "self-booking within policy cut-offs", 08): POST /api/me/transport/bookings/:id/cancel.
 * Own booking only (other ids 404), before its cut-off (409 AFTER_CUTOFF), never once its trip has started (409
 * INVALID_STATE). A seated booking frees its seat in the same transaction and with the same lock order as dispatch
 * (booking FOR UPDATE, then trip FOR UPDATE; releaseSeat refuses a passenger with a recorded outcome). Idempotent: an
 * already cancelled booking returns its current state. Audited; the trip gets a PASSENGER_REMOVED event (actor
 * PASSENGER, source PASSENGER_APP), which the notification relay reports to the driver as TRIP_CHANGED.
 */
@Injectable()
export class MeBookingCancelService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly people: PeopleService,
    private readonly me: MeTransportService,
    private readonly live: TripLiveService,
  ) {}

  async cancel(ctx: AuthContext, id: string, reasonIn: string | undefined): Promise<MeBookingDto> {
    const profile = await this.people.myProfileRow(ctx);
    const before = await this.prisma.transportBooking.findFirst({ where: { id, customerCompanyId: ctx.companyId, profileId: profile.id } });
    if (!before || before.profileId !== profile.id || before.customerCompanyId !== ctx.companyId) throw new NotFoundException({ message: 'Not found', code: 'NOT_FOUND' });
    if (before.status === 'CANCELLED') return this.me.booking(ctx, id);
    if (!bookingTransition(before.status, 'cancel')) throw new ConflictException({ message: 'This booking can no longer be cancelled', code: 'INVALID_STATE' });
    if (before.cutoffAt && Date.now() >= before.cutoffAt.getTime()) throw new ConflictException({ message: 'The cancellation cut-off has passed; contact the transport desk', code: 'AFTER_CUTOFF' });
    const reason = `Cancelled by passenger${reasonIn?.trim() ? `: ${reasonIn.trim().slice(0, 200)}` : ''}`;
    let plannedTripId: string | null = null;
    await this.prisma.$transaction(async (tx) => {
      await lockBookings(tx, [id]);
      const seat = await tx.transportTripPassenger.findFirst({ where: { bookingId: id, status: { not: 'CANCELLED' } }, include: { trip: { select: { id: true, providerCompanyId: true, customerCompanyId: true, plannedTripId: true } } } });
      if (seat && seat.bookingId === id) {
        await lockTrips(tx, [seat.tripId]);
        const pt = seat.trip.plannedTripId ? await tx.plannedTrip.findFirst({ where: { id: seat.trip.plannedTripId }, select: { status: true } }) : null;
        if (pt && pt.status !== 'SCHEDULED') throw new ConflictException({ message: 'Your trip has already started; contact the transport desk', code: 'INVALID_STATE' });
        if (!(await releaseSeat(tx, seat, reason))) throw new ConflictException({ message: 'Your trip outcome is already recorded', code: 'INVALID_STATE' });
        await recordTripEvent(tx, ctx, { tripId: seat.tripId, providerCompanyId: seat.trip.providerCompanyId, customerCompanyId: seat.trip.customerCompanyId, kind: 'PASSENGER_REMOVED', passengerTripId: seat.id, reasonCode: 'PASSENGER_CANCELLED', actorType: 'PASSENGER', source: 'PASSENGER_APP', data: { bookingId: id } });
        plannedTripId = seat.trip.plannedTripId;
      }
      const claimed = await tx.transportBooking.updateMany({ where: { id, status: before.status, version: before.version }, data: { status: 'CANCELLED', statusReason: reason, version: { increment: 1 } } });
      if (!claimed.count) throw new ConflictException({ message: 'The booking changed meanwhile; reload it', code: 'VERSION_CONFLICT' });
      // QA I3: audit.record keeps only the before / after diff when they are given, so the facts go into the snapshot
      // (the booking id is entityId; statusReason is the stored reason, scrubbed by erasure like other booking audits).
      await this.audit.record(
        ctx,
        {
          action: 'UPDATE',
          entity: BOOKING_ENTITY,
          entityId: id,
          before: { status: before.status, version: before.version, statusReason: before.statusReason ?? null },
          after: { status: 'CANCELLED', version: before.version + 1, statusReason: reason, command: 'cancel', by: 'PASSENGER', seatReleased: !!seat },
        },
        tx,
      );
    });
    if (plannedTripId) await this.live.changed(ctx.companyId, [plannedTripId]);
    return this.me.booking(ctx, id);
  }
}

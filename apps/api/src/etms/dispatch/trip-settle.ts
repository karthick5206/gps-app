import { Prisma } from '@prisma/client';
import { DRIVER_LIMITS } from '@veetracer/shared';
import { lockBookings, lockTrips } from './trip-ops';

/**
 * v1.15.1 trip settlement (E5 L4 / defect I2, seen live in the v1.15.0 demo B4).
 *
 * The v1.8 tracker auto-completes a trip at the last stop, often before the driver taps "Dropped". Inside
 * DRIVER_LIMITS.settleGraceHours the driver's late taps still count (D1, driver-rules inSettleGrace) and the
 * dispatcher can record outcomes on a COMPLETED trip at any time. Once the grace has ended this job finalises what is
 * left, so nothing stays "open" forever:
 *
 * - Passenger seats are NOT given an invented outcome. The documents make that a hard rule: "vehicle GPS alone is never
 *   proof of boarding" (02 §5.3) and only WEB / DRIVER_APP may set BOARDED / NO_SHOW / DROPPED, enforced by the CHECK
 *   `TransportTripPassenger_outcome_source_check` (15 §5.6). No document allows an automatic DROPPED or NO_SHOW. So:
 *     · a seat still BOARDED (drop not recorded) keeps its status and gets a SYSTEM trip event
 *       `PASSENGER_AUTO_SETTLED` (data.autoSettled, statusAtSettle BOARDED, reason DROP_NOT_RECORDED);
 *     · a seat still PENDING (never boarded, no outcome) keeps PENDING and gets the same event with
 *       reason NO_OUTCOME and needsReview: true, for the dispatcher (who can still record NO_SHOW / BOARDED).
 *   The dispatcher trip detail shows both (TransportTripPassengerDto.autoSettled).
 * - Bookings: the lifecycle (05 §3, transport-trips.ts) ends a seated booking at CONFIRMED and has no "served" value.
 *   A booking still ASSIGNED whose seat on the completed trip is BOARDED / DROPPED / NO_SHOW moves to CONFIRMED
 *   (version + 1). A booking whose seat is still PENDING is left ASSIGNED (it was never used: the dispatcher decides).
 *   Erasure and the other "open booking" checks already ignore seats on closed trips (erasure.ts, I2 fix).
 *
 * Idempotent (a seat gets the event once; CONFIRMED is not touched again), batch-limited (TRIP_SETTLE_BATCH trips per
 * run), one transaction per trip under the booking → trip lock order (15 §8.4), audited by the caller (one SYSTEM
 * audit row per trip). Runs in the booking generator / expiry sweep tick.
 */
export const AUTO_SETTLED_EVENT = 'PASSENGER_AUTO_SETTLED';
export const TRIP_SETTLE_BATCH = 50;
const H = 3_600_000;

export interface TripSettlement {
  tripId: string;
  providerCompanyId: string;
  customerCompanyId: string | null;
  closedAt: string | null;
  closedBy: string | null;
  /** Seats left BOARDED (drop not recorded), now marked auto-settled. */
  boardedSettled: string[];
  /** Seats left PENDING (no outcome), marked for dispatcher review. */
  pendingFlagged: string[];
  /** Bookings ASSIGNED → CONFIRMED. */
  bookingsConfirmed: string[];
}

type Db = Pick<Prisma.TransactionClient, 'transportTrip'> & { $transaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> };

/** Seats still needing the job: unsettled and not yet marked, or settled with the booking still ASSIGNED. */
const OPEN_SEAT: Prisma.TransportTripPassengerWhereInput = {
  OR: [
    { status: { in: ['PENDING', 'BOARDED'] }, events: { none: { kind: AUTO_SETTLED_EVENT } } },
    { status: { in: ['BOARDED', 'DROPPED', 'NO_SHOW'] }, booking: { status: 'ASSIGNED' } },
  ],
};

export async function settleClosedTrips(db: Db, now: number, opts: { batch?: number; where?: Prisma.TransportTripWhereInput } = {}): Promise<TripSettlement[]> {
  const cutoff = new Date(now - DRIVER_LIMITS.settleGraceHours * H);
  const trips = await db.transportTrip.findMany({
    where: { ...(opts.where ?? {}), plannedTrip: { status: 'COMPLETED', actualEnd: { lt: cutoff } }, passengers: { some: OPEN_SEAT } },
    select: { id: true },
    orderBy: { id: 'asc' },
    take: opts.batch ?? TRIP_SETTLE_BATCH,
  });
  const out: TripSettlement[] = [];
  for (const { id } of trips) {
    const r = await db.$transaction((tx) => settleTrip(tx, id, cutoff, now));
    if (r && (r.boardedSettled.length || r.pendingFlagged.length || r.bookingsConfirmed.length)) out.push(r);
  }
  return out;
}

async function settleTrip(tx: Prisma.TransactionClient, tripId: string, cutoff: Date, now: number): Promise<TripSettlement | null> {
  const pre = await tx.transportTripPassenger.findMany({ where: { tripId, status: { not: 'CANCELLED' } }, select: { bookingId: true } });
  await lockBookings(tx, pre.map((p) => p.bookingId));
  await lockTrips(tx, [tripId]);
  const trip = await tx.transportTrip.findUnique({
    where: { id: tripId },
    select: { id: true, providerCompanyId: true, customerCompanyId: true, plannedTrip: { select: { status: true, actualEnd: true, closedBy: true } } },
  });
  // Re-checked under the lock: a trip reopened / not yet past the grace is left alone.
  const pt = trip?.plannedTrip;
  if (!trip || !pt || pt.status !== 'COMPLETED' || !pt.actualEnd || pt.actualEnd >= cutoff) return null;
  const seats = await tx.transportTripPassenger.findMany({
    where: { tripId, status: { not: 'CANCELLED' } },
    select: { id: true, status: true, bookingId: true, customerCompanyId: true, booking: { select: { status: true } }, events: { where: { kind: AUTO_SETTLED_EVENT }, select: { id: true }, take: 1 } },
  });
  const r: TripSettlement = { tripId, providerCompanyId: trip.providerCompanyId, customerCompanyId: trip.customerCompanyId, closedAt: pt.actualEnd.toISOString(), closedBy: pt.closedBy, boardedSettled: [], pendingFlagged: [], bookingsConfirmed: [] };
  const at = new Date(now);
  for (const s of seats) {
    if ((s.status === 'BOARDED' || s.status === 'PENDING') && !s.events.length) {
      const boarded = s.status === 'BOARDED';
      await tx.transportTripEvent.create({
        data: {
          tripId,
          providerCompanyId: trip.providerCompanyId,
          customerCompanyId: s.customerCompanyId,
          passengerTripId: s.id,
          kind: AUTO_SETTLED_EVENT,
          actorType: 'SYSTEM',
          source: 'SYSTEM',
          outcome: 'ACCEPTED',
          reasonCode: boarded ? 'DROP_NOT_RECORDED' : 'NO_OUTCOME',
          occurredAt: at,
          data: { autoSettled: true, statusAtSettle: s.status, needsReview: !boarded, closedAt: r.closedAt, closedBy: r.closedBy, settleGraceHours: DRIVER_LIMITS.settleGraceHours },
        },
      });
      (boarded ? r.boardedSettled : r.pendingFlagged).push(s.id);
    }
    if (s.status !== 'PENDING' && s.booking.status === 'ASSIGNED') {
      const done = await tx.transportBooking.updateMany({ where: { id: s.bookingId, status: 'ASSIGNED' }, data: { status: 'CONFIRMED', version: { increment: 1 } } });
      if (done.count) r.bookingsConfirmed.push(s.bookingId);
    }
  }
  return r;
}

import type { Prisma } from '@prisma/client';
import type { RidePreference } from '@veetracer/shared';
import { conflict } from '../dispatch/e3-common';
import { ACTIVE_OVERLAP_STATUSES } from '../dispatch/trip-overlap';
import { limitsOf, partyCount, pickupWindow, privateExclusivityProblem, servedAs } from './pooling-rules';
import { poolingSettingsOf } from './pooling-settings';
import { driverHoursProblems, hasDriverHours, vehicleTimelineProblem } from './timeline-rules';

/**
 * Pooling checks inside the E3 publish transaction (DispatchService.apply), after every change of the change set and
 * before the versions / ledger: so batch publish (route plans), dispatcher change sets and live dispatch all pass the
 * same rules, under the same locks:
 *  1. P1 whole-trip exclusivity of PRIVATE bookings (409 PRIVATE_RIDE_NOT_EXCLUSIVE) and `assignedService` per seated
 *     booking (PRIVATE when alone / private, else SHARED);
 *  2. the accepted limits of the bookings seated by this change set (pickup inside [windowStart, +maxWait], ride ≤
 *     maxRideS): hard for pooling sources (live dispatch, AREA plans: 409 COMMITMENT_VIOLATION), a warning otherwise;
 *  3. the vehicle timeline of new / moved / re-timed trips (downtime, maintenance, operating windows, turnaround);
 *  4. the driver's working-hour policy (409 DRIVER_HOURS) when the company has one (P7);
 *  5. a started trip changed by a live option: liveRouteVersion + 1 and a ROUTE_UPDATED event (the driver acknowledges).
 */

type Tx = Prisma.TransactionClient;
const DAY = 86_400_000;

export interface PoolTripState {
  id: string;
  plannedTripId: string;
  objectId: string;
  driverId: string | null;
  plannedStart: Date;
  plannedEnd: Date;
  created: boolean;
  /** Touched by this change set (any op). */
  touched: boolean;
  /** Vehicle / driver / time span changed or the trip is new: timeline + driver hours re-checked. */
  timeline: boolean;
  /** A started trip changed through a live option (P5). */
  activeChanged: boolean;
  providerCompanyId: string;
  customerCompanyId: string | null;
}

export interface PoolCheckInput {
  companyId: string;
  trips: PoolTripState[];
  /** Bookings seated by this change set. */
  added: ReadonlySet<string>;
  /** Hard limits (pooling sources) or warnings (manual change sets). */
  enforceLimits: boolean;
  changeSetId: string;
  /** Appends a trip event with this change set's actor (DispatchService.apply's writer). */
  event(e: { tripId: string; providerCompanyId: string; customerCompanyId: string | null; kind: 'ROUTE_UPDATED'; data: Record<string, unknown> }): Promise<unknown>;
}

/** Bookings seated (not cancelled) on these trips: locked with the change set's own bookings (order bookings → trips). */
export async function seatedBookingIds(db: Pick<Tx, 'transportTripPassenger'>, tripIds: string[]): Promise<string[]> {
  if (!tripIds.length) return [];
  const rows = await db.transportTripPassenger.findMany({ where: { tripId: { in: tripIds }, status: { not: 'CANCELLED' } }, select: { bookingId: true } });
  return [...new Set(rows.map((r) => r.bookingId))];
}

export async function poolingAfterChanges(tx: Tx, input: PoolCheckInput): Promise<string[]> {
  const warnings: string[] = [];
  const relevant = input.trips.filter((t) => t.created || t.touched);
  if (!relevant.length) return warnings;

  // 1. + 2. Seats and their bookings.
  const seats = await tx.transportTripPassenger.findMany({
    where: { tripId: { in: relevant.map((t) => t.id) }, status: { not: 'CANCELLED' } },
    select: { tripId: true, bookingId: true, pickupSeq: true, dropSeq: true, booking: { select: { id: true, ridePreference: true, limits: true, journey: true, windowStart: true, windowEnd: true, assignedService: true, groupId: true } } },
  });
  const stops = await tx.plannedTripStop.findMany({ where: { tripId: { in: relevant.map((t) => t.plannedTripId) } }, select: { tripId: true, seq: true, plannedArrival: true, plannedDeparture: true } });
  for (const t of relevant) {
    const mine = seats.filter((s) => s.tripId === t.id);
    const parties = mine.map((s) => ({ bookingId: s.bookingId, ridePreference: s.booking.ridePreference as RidePreference, groupId: s.booking.groupId }));
    const offender = privateExclusivityProblem(parties);
    if (offender) throw conflict('PRIVATE_RIDE_NOT_EXCLUSIVE', `Booking ${offender} is a private ride: nobody else may ride on its trip`, { bookingId: offender, tripId: t.id });
    const count = partyCount(parties);
    for (const s of mine) {
      const want = servedAs(s.booking.ridePreference as RidePreference, count);
      if (s.booking.assignedService !== want) {
        await tx.transportBooking.update({ where: { id: s.bookingId }, data: { assignedService: want } });
        s.booking.assignedService = want;
      }
      if (!input.added.has(s.bookingId)) continue;
      const limits = limitsOf(s.booking.limits);
      if (!limits) continue;
      const at = (seq: number) => stops.find((x) => x.tripId === t.plannedTripId && x.seq === seq);
      const pick = at(s.pickupSeq);
      const drop = at(s.dropSeq);
      if (!pick || !drop) continue;
      const problems: string[] = [];
      if (s.booking.journey === 'POINT_TO_POINT') {
        const [, latest] = pickupWindow(s.booking.windowStart.getTime(), s.booking.windowEnd.getTime(), limits);
        if (pick.plannedArrival.getTime() > latest) problems.push(`pickup after the accepted maximum wait (${Math.round(limits.maxWaitS / 60)} min)`);
      }
      const ride = (drop.plannedArrival.getTime() - pick.plannedDeparture.getTime()) / 1000;
      if (limits.maxRideS !== null && ride > limits.maxRideS) problems.push(`ride ${Math.round(ride / 60)} min above the accepted ${Math.round(limits.maxRideS / 60)} min`);
      if (!problems.length) continue;
      const msg = `Booking ${s.bookingId}: ${problems.join('; ')}`;
      if (input.enforceLimits) throw conflict('COMMITMENT_VIOLATION', msg, { bookingId: s.bookingId });
      warnings.push(msg);
    }
  }

  // 3. + 4. Vehicle timeline and driver hours of trips whose vehicle / driver / span changed.
  const timed = relevant.filter((t) => t.timeline);
  if (timed.length) {
    const company = await tx.company.findUnique({ where: { id: input.companyId }, select: { settings: true } });
    const hours = poolingSettingsOf(company?.settings).driverHours;
    for (const t of timed) {
      const span = { start: t.plannedStart.getTime(), end: t.plannedEnd.getTime() };
      const around = { plannedStart: { lt: new Date(span.end + DAY) }, plannedEnd: { gt: new Date(span.start - DAY) }, status: { in: ACTIVE_OVERLAP_STATUSES }, id: { not: t.plannedTripId } };
      const [rows, object, profile, others] = await Promise.all([
        tx.transportVehicleAvailability.findMany({ where: { objectId: t.objectId, startsAt: { lt: new Date(span.end + DAY) }, endsAt: { gt: new Date(span.start - DAY) } }, select: { kind: true, startsAt: true, endsAt: true } }),
        tx.trackedObject.findUnique({ where: { id: t.objectId }, select: { maintenanceSince: true } }),
        tx.transportVehicleProfile.findUnique({ where: { objectId: t.objectId }, select: { turnaroundS: true } }),
        tx.plannedTrip.findMany({ where: { ...around, objectId: t.objectId }, select: { plannedStart: true, plannedEnd: true } }),
      ]);
      const p = vehicleTimelineProblem(span, rows, object?.maintenanceSince ?? null, others.map((o) => ({ start: o.plannedStart.getTime(), end: o.plannedEnd.getTime() })), profile?.turnaroundS ?? null);
      if (p) throw conflict(p.code, p.message, { tripId: t.id, objectId: t.objectId });
      if (t.driverId && hasDriverHours(hours)) {
        const theirs = await tx.plannedTrip.findMany({ where: { ...around, driverId: t.driverId }, select: { plannedStart: true, plannedEnd: true } });
        const problems = driverHoursProblems([...theirs.map((o) => ({ start: o.plannedStart.getTime(), end: o.plannedEnd.getTime() })), span], hours, span);
        if (problems.length) throw conflict('DRIVER_HOURS', `The driver's working-hour policy would be broken (${problems.map((x) => x.kind).join(', ')})`, { problems, tripId: t.id, driverId: t.driverId });
      }
    }
  }

  // 5. Live change of a started trip: route version + 1, ROUTE_UPDATED (the driver app acknowledges it, P5).
  for (const t of relevant.filter((x) => x.activeChanged)) {
    const after = await tx.transportTrip.update({ where: { id: t.id }, data: { liveRouteVersion: { increment: 1 } }, select: { liveRouteVersion: true } });
    await input.event({ tripId: t.id, providerCompanyId: t.providerCompanyId, customerCompanyId: t.customerCompanyId, kind: 'ROUTE_UPDATED', data: { changeSetId: input.changeSetId, routeVersion: after.liveRouteVersion } });
  }
  return warnings;
}

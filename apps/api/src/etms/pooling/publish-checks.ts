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
  /** Driver / time span changed or the trip is new: driver working hours re-checked. */
  timeline: boolean;
  /** Vehicle / time span changed or the trip is new (not a driver change): the vehicle timeline is re-checked. */
  vehicleTimeline?: boolean;
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
  /** Live dispatch change set (pooling source): the vehicle timeline always applies. */
  live?: boolean;
  /**
   * P5 / review fix 1: a started trip changed by a live option must still be reachable from the vehicle's live position
   * (first pending stop in time with the live delay). Returns a problem text, or null. Provided by live dispatch.
   */
  reachable?(t: { tripId: string; plannedTripId: string }): Promise<string | null>;
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

/** Review fix 4: a PRIVATE booking without a limits snapshot (legacy P3 backfill) is judged as FLEXIBLE for P1. */
export function effectivePreference(pref: RidePreference, limits: unknown): RidePreference {
  return pref === 'PRIVATE' && (limits === null || limits === undefined) ? 'FLEXIBLE' : pref;
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
    // Review fix 4: P1 binds PRIVATE choices made under pooling (a limits snapshot exists). Legacy rows (P3 backfill,
    // limits null) that already shared a trip under E3 are not refused, so their trips stay editable.
    const parties = mine.map((s) => ({ bookingId: s.bookingId, ridePreference: effectivePreference(s.booking.ridePreference as RidePreference, s.booking.limits), groupId: s.booking.groupId }));
    const offender = privateExclusivityProblem(parties);
    if (offender) throw conflict('PRIVATE_RIDE_NOT_EXCLUSIVE', `Booking ${offender} is a private ride: nobody else may ride on its trip`, { bookingId: offender, tripId: t.id });
    const count = partyCount(parties);
    for (const s of mine) {
      const want = servedAs(effectivePreference(s.booking.ridePreference as RidePreference, s.booking.limits), count);
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
  const timed = relevant.filter((t) => t.timeline || t.vehicleTimeline);
  if (timed.length) {
    const company = await tx.company.findUnique({ where: { id: input.companyId }, select: { settings: true } });
    const settings = poolingSettingsOf(company?.settings);
    const hours = settings.driverHours;
    // Review fix 5: E3 never looked at maintenance / downtime. The vehicle timeline applies only when pooling is in use
    // (live dispatch / AREA publish, or the company's live switch) or the vehicle has availability / a turnaround set.
    const poolingOn = input.enforceLimits || !!input.live || settings.liveDispatch;
    for (const t of timed) {
      const span = { start: t.plannedStart.getTime(), end: t.plannedEnd.getTime() };
      const around = { plannedStart: { lt: new Date(span.end + DAY) }, plannedEnd: { gt: new Date(span.start - DAY) }, status: { in: ACTIVE_OVERLAP_STATUSES }, id: { not: t.plannedTripId } };
      const [rows, object, profile, others] = await Promise.all([
        tx.transportVehicleAvailability.findMany({ where: { objectId: t.objectId, startsAt: { lt: new Date(span.end + DAY) }, endsAt: { gt: new Date(span.start - DAY) } }, select: { kind: true, startsAt: true, endsAt: true } }),
        tx.trackedObject.findUnique({ where: { id: t.objectId }, select: { maintenanceSince: true } }),
        tx.transportVehicleProfile.findUnique({ where: { objectId: t.objectId }, select: { turnaroundS: true } }),
        tx.plannedTrip.findMany({ where: { ...around, objectId: t.objectId }, select: { plannedStart: true, plannedEnd: true } }),
      ]);
      const configured = poolingOn || rows.length > 0 || (profile?.turnaroundS ?? null) !== null;
      const p = t.vehicleTimeline && configured ? vehicleTimelineProblem(span, rows, object?.maintenanceSince ?? null, others.map((o) => ({ start: o.plannedStart.getTime(), end: o.plannedEnd.getTime() })), profile?.turnaroundS ?? null) : null;
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
    // Review fix 2: no further live change while the driver has not acknowledged the previous one.
    const cur = await tx.transportTrip.findUniqueOrThrow({ where: { id: t.id }, select: { liveRouteVersion: true, liveRouteAckVersion: true } });
    if (cur.liveRouteAckVersion < cur.liveRouteVersion) throw conflict('COMMITMENT_VIOLATION', 'The driver has not acknowledged the previous route change yet', { tripId: t.id, routeVersion: cur.liveRouteVersion });
    // Review fix 1: re-checked inside the transaction from the live position.
    const unreachable = input.reachable ? await input.reachable({ tripId: t.id, plannedTripId: t.plannedTripId }) : null;
    if (unreachable) throw conflict('COMMITMENT_VIOLATION', unreachable, { tripId: t.id });
    const after = await tx.transportTrip.update({ where: { id: t.id }, data: { liveRouteVersion: { increment: 1 } }, select: { liveRouteVersion: true } });
    await input.event({ tripId: t.id, providerCompanyId: t.providerCompanyId, customerCompanyId: t.customerCompanyId, kind: 'ROUTE_UPDATED', data: { changeSetId: input.changeSetId, routeVersion: after.liveRouteVersion } });
  }
  return warnings;
}

/**
 * Review fix 9: after a seat is released (cancellation, consent withdrawal), the passengers left on the trip are served
 * differently (a FLEXIBLE rider now alone is PRIVATE). Their booking rows are taken with SKIP LOCKED — the caller holds
 * the trip lock and a waiting booking lock could deadlock against a publish (order bookings → trips); a row skipped here
 * is recomputed by the next publish touching the trip. Returns the number of bookings updated.
 */
export async function refreshAssignedService(tx: Tx, tripId: string): Promise<number> {
  const seats = await tx.transportTripPassenger.findMany({ where: { tripId, status: { not: 'CANCELLED' } }, select: { bookingId: true, booking: { select: { ridePreference: true, limits: true, groupId: true, assignedService: true } } } });
  if (!seats.length) return 0;
  const ids = [...new Set(seats.map((s) => s.bookingId))].sort();
  const locked = new Set((await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "TransportBooking" WHERE id = ANY(${ids}::uuid[]) ORDER BY id FOR UPDATE SKIP LOCKED`).map((r) => r.id));
  const parties = seats.map((s) => ({ bookingId: s.bookingId, groupId: s.booking.groupId }));
  const count = partyCount(parties);
  let n = 0;
  for (const s of seats) {
    if (!locked.has(s.bookingId)) continue;
    const want = servedAs(effectivePreference(s.booking.ridePreference as RidePreference, s.booking.limits), count);
    if (s.booking.assignedService === want) continue;
    await tx.transportBooking.update({ where: { id: s.bookingId }, data: { assignedService: want } });
    s.booking.assignedService = want;
    n++;
  }
  return n;
}

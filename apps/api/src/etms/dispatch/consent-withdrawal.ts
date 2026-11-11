import { Prisma } from '@prisma/client';
import { ACTIVE_BOOKING_STATUSES, TRANSPORT_E3_LIMITS } from '@veetracer/shared';
import type { AuthContext } from '../../access/auth-context';
import type { AuditService } from '../../audit/audit.service';
import { nearAny } from './personal-points';
import { lockBookings, lockTrips, recordTripEvent, releaseSeat } from './trip-ops';

type Tx = Prisma.TransactionClient;

/** The time / pickup of an exception override (parsed here, not via the generator: people.service imports this file). */
function overrideOf(json: Prisma.JsonValue | null): { timeMin?: number; pickup?: unknown } | null {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  const o = json as Record<string, unknown>;
  return { ...(typeof o.timeMin === 'number' ? { timeMin: o.timeMin } : {}), ...(o.pickup ? { pickup: o.pickup } : {}) };
}

/** statusReason of a booking cancelled because its passenger withdrew routing consent. */
export const CONSENT_WITHDRAWN_REASON = 'CONSENT_WITHDRAWN: the passenger withdrew consent to use their location for transport';
const SEAT_REASON = 'Routing consent withdrawn';
/** 2 decimals (about 1.1 km): what is left of a personal stop that cannot be removed (a trip keeps at least 2 stops). */
const COARSE = (v: number) => Math.round(v * 100) / 100;

export interface ConsentWithdrawalEffects {
  bookingsCancelled: number;
  seatsReleased: number;
  stopsRemoved: number;
  stopsAnonymised: number;
  draftsDiscarded: number;
  exceptionsCleared: number;
  /** Bookings seated on a trip already under way: left as they are (the run is in progress). */
  /** E5: open trips not otherwise changed (under way, or a stop kept for another passenger) bumped so the driver sync drops the hidden points. */
  tripsUnderWayChanged: number;
  inProgress: number;
  /** PlannedTrip ids whose stops / path changed (processor cache + live push after commit). */
  plannedTripIds: string[];
}

type Point = { lat: number; lng: number };

/**
 * E3 security review M2: what a TRANSPORT_PROFILE (routing) consent withdrawal changes in E3, inside the withdrawal's
 * own transaction (all or nothing with the consent row):
 * - upcoming bookings (active, window not ended) that use a personal point (pickup / drop not at a company place) are
 *   CANCELLED with reason CONSENT_WITHDRAWN and lose those points and labels; a seat on a trip that has not started is
 *   released (trip version + 1, a PASSENGER_REMOVED event with reason CONSENT_WITHDRAWN the dispatcher sees). Bookings on
 *   a trip already under way are left alone (counted in `inProgress`);
 * - the passenger's personal stops on trips that have not started are deleted when nobody else is picked up / dropped
 *   there (later stops and seats renumbered), else they stay for the other passengers; a stop that cannot be deleted
 *   (the trip would keep fewer than 2 stops) is coarsened to 2 decimals and skipped. The trip's road path is cleared;
 * - DRAFT change sets naming one of the bookings, or carrying a stop within personalPointNearM of one of the passenger's
 *   points, are discarded (so a repeat draft cannot re-create the home stop; publish refuses unlinked personal stops too);
 * - pickup overrides on upcoming schedule exceptions are removed (an exception left with nothing is deleted);
 * - the passenger gets an in-app notice and every change is audited (the dispatcher sees the trip events, the booking
 *   reason and the audit).
 * The generator already creates no personal point without consent, so later bookings come as "needs location".
 */
export async function applyRoutingConsentWithdrawal(
  tx: Tx,
  ctx: AuthContext,
  audit: Pick<AuditService, 'record'>,
  p: { companyId: string; profileId: string; userId: string | null; home: Point | null },
  now: Date = new Date(),
): Promise<ConsentWithdrawalEffects> {
  const out: ConsentWithdrawalEffects = { bookingsCancelled: 0, seatsReleased: 0, stopsRemoved: 0, stopsAnonymised: 0, draftsDiscarded: 0, exceptionsCleared: 0, inProgress: 0, tripsUnderWayChanged: 0, plannedTripIds: [] };
  const candidates = await tx.transportBooking.findMany({
    where: { customerCompanyId: p.companyId, profileId: p.profileId, status: { in: [...ACTIVE_BOOKING_STATUSES] }, windowEnd: { gt: now } },
    select: { id: true },
  });
  const seatsOf = await tx.transportTripPassenger.findMany({ where: { bookingId: { in: candidates.map((b) => b.id) }, status: { not: 'CANCELLED' } }, select: { tripId: true } });
  // Trips whose stops may change: seated ones and those carrying one of the passenger's personal stops. Locked once,
  // sorted, after the bookings (15 §8.4 order), so this never deadlocks with a publish.
  const ownStops = await tx.plannedTripStop.findMany({ where: { profileId: p.profileId }, select: { tripId: true } });
  const ownHeaders = ownStops.length ? await tx.transportTrip.findMany({ where: { plannedTripId: { in: [...new Set(ownStops.map((s) => s.tripId))] } }, select: { id: true } }) : [];
  await lockBookings(tx, candidates.map((b) => b.id));
  await lockTrips(tx, [...seatsOf.map((s) => s.tripId), ...ownHeaders.map((h) => h.id)]);
  const bookings = await tx.transportBooking.findMany({
    where: { id: { in: candidates.map((b) => b.id) }, status: { in: [...ACTIVE_BOOKING_STATUSES] } },
    include: { passengers: { where: { status: { not: 'CANCELLED' } }, include: { trip: { include: { plannedTrip: { select: { id: true, status: true, origin: true } } } } } } },
  });
  const personal = (lat: number | null, poiId: string | null) => lat !== null && !poiId;
  const points: Point[] = p.home ? [p.home] : [];
  const touchedTrips = new Map<string, { tripId: string; plannedTripId: string; providerCompanyId: string; customerCompanyId: string | null }>();
  const releasedStopIds = new Set<string>();

  for (const b of bookings) {
    if (b.pickupLat !== null && b.pickupLng !== null && !b.pickupPoiId) points.push({ lat: b.pickupLat, lng: b.pickupLng });
    if (b.dropLat !== null && b.dropLng !== null && !b.dropPoiId) points.push({ lat: b.dropLat, lng: b.dropLng });
    if (!personal(b.pickupLat, b.pickupPoiId) && !personal(b.dropLat, b.dropPoiId)) continue; // site to site: no location needed
    const seat = b.passengers.find((x) => x.status !== 'CANCELLED');
    const pt = seat?.trip.plannedTrip;
    if (seat && pt && pt.status !== 'SCHEDULED') {
      out.inProgress++;
      continue;
    }
    if (seat) {
      if (!(await releaseSeat(tx, seat, SEAT_REASON))) {
        out.inProgress++; // an outcome is recorded: never silently removed
        continue;
      }
      out.seatsReleased++;
      if (seat.pickupStopId && !b.pickupPoiId) releasedStopIds.add(seat.pickupStopId);
      if (seat.dropStopId && !b.dropPoiId) releasedStopIds.add(seat.dropStopId);
      if (pt) touchedTrips.set(seat.tripId, { tripId: seat.tripId, plannedTripId: pt.id, providerCompanyId: seat.trip.providerCompanyId, customerCompanyId: seat.trip.customerCompanyId });
      await recordTripEvent(tx, ctx, { tripId: seat.tripId, providerCompanyId: seat.trip.providerCompanyId, customerCompanyId: seat.trip.customerCompanyId, kind: 'PASSENGER_REMOVED', passengerTripId: seat.id, reasonCode: 'CONSENT_WITHDRAWN', actorType: 'SYSTEM', source: 'SYSTEM', data: { bookingId: b.id } });
    }
    const data: Prisma.TransportBookingUncheckedUpdateInput = { status: 'CANCELLED', statusReason: CONSENT_WITHDRAWN_REASON, version: { increment: 1 } };
    if (personal(b.pickupLat, b.pickupPoiId)) Object.assign(data, { pickupLat: null, pickupLng: null, pickupLabel: null });
    if (personal(b.dropLat, b.dropPoiId)) Object.assign(data, { dropLat: null, dropLng: null, dropLabel: null });
    await tx.transportBooking.update({ where: { id: b.id }, data });
    await audit.record(ctx, { action: 'UPDATE', entity: 'TransportBooking', entityId: b.id, details: { consentWithdrawn: true, status: 'CANCELLED', seatReleased: !!seat } }, tx);
    out.bookingsCancelled++;
  }

  // Personal stops of trips that have not started: by owner, and the ends of the seats just released.
  const found = await tx.plannedTripStop.findMany({
    where: { OR: [{ profileId: p.profileId }, ...(releasedStopIds.size ? [{ id: { in: [...releasedStopIds] } }] : [])] },
    select: { id: true, tripId: true, seq: true, lat: true, lng: true },
  });
  // Only trips of this company that have not started (checked in code, not through a relation filter).
  const open = new Set((found.length ? await tx.plannedTrip.findMany({ where: { id: { in: [...new Set(found.map((s) => s.tripId))] }, companyId: p.companyId, origin: 'ETMS', status: 'SCHEDULED' }, select: { id: true } }) : []).map((t) => t.id));
  const stops = found.filter((s) => open.has(s.tripId));
  const byTrip = new Map<string, typeof stops>();
  for (const s of stops) byTrip.set(s.tripId, [...(byTrip.get(s.tripId) ?? []), s]);
  for (const [plannedTripId, mine] of byTrip) {
    const header = await tx.transportTrip.findFirst({ where: { plannedTripId }, select: { id: true, providerCompanyId: true, customerCompanyId: true } });
    // Highest seq first so the renumbering of one deletion never moves another stop still to be handled.
    for (const s of [...mine].sort((a, b) => b.seq - a.seq)) {
      const others = await tx.transportTripPassenger.count({ where: { status: { not: 'CANCELLED' }, OR: [{ pickupStopId: s.id }, { dropStopId: s.id }] } });
      if (others) continue; // another passenger is picked up / dropped here: the stop stays for them
      const count = await tx.plannedTripStop.count({ where: { tripId: plannedTripId } });
      if (count <= 2) {
        await tx.plannedTripStop.update({ where: { id: s.id }, data: { lat: COARSE(s.lat), lng: COARSE(s.lng), name: 'Removed stop', status: 'SKIPPED', profileId: null } });
        out.stopsAnonymised++;
      } else {
        // Seats are read before the delete (its FK sets their stop id to NULL). Seats keep their seq snapshot in step with
        // the stops; rows that pointed at the deleted stop (cancelled ones) keep theirs, so dropSeq > pickupSeq holds.
        const seats = header ? await tx.transportTripPassenger.findMany({ where: { tripId: header.id }, select: { id: true, pickupSeq: true, dropSeq: true, pickupStopId: true, dropStopId: true } }) : [];
        await tx.plannedTripStop.delete({ where: { id: s.id } });
        const later = await tx.plannedTripStop.findMany({ where: { tripId: plannedTripId, seq: { gt: s.seq } }, select: { id: true, seq: true } });
        for (const l of later.sort((a, b) => a.seq - b.seq)) await tx.plannedTripStop.update({ where: { id: l.id }, data: { seq: l.seq - 1 } });
        for (const x of seats) {
          if (x.pickupStopId === s.id || x.dropStopId === s.id) continue;
          const pickupSeq = x.pickupSeq > s.seq ? x.pickupSeq - 1 : x.pickupSeq;
          const dropSeq = x.dropSeq > s.seq ? x.dropSeq - 1 : x.dropSeq;
          if (pickupSeq !== x.pickupSeq || dropSeq !== x.dropSeq) await tx.transportTripPassenger.update({ where: { id: x.id }, data: { pickupSeq, dropSeq } });
        }
        out.stopsRemoved++;
      }
      if (header) touchedTrips.set(header.id, { tripId: header.id, plannedTripId, providerCompanyId: header.providerCompanyId, customerCompanyId: header.customerCompanyId });
    }
  }
  for (const t of touchedTrips.values()) {
    // The road path ran through the removed stop: cleared (never a stale one); the dispatcher re-plans if needed.
    await tx.plannedTrip.update({ where: { id: t.plannedTripId }, data: { path: Prisma.DbNull } });
    await tx.transportTrip.update({ where: { id: t.tripId }, data: { version: { increment: 1 } } });
    await recordTripEvent(tx, ctx, { tripId: t.tripId, providerCompanyId: t.providerCompanyId, customerCompanyId: t.customerCompanyId, kind: 'CHANGED', reasonCode: 'CONSENT_WITHDRAWN', actorType: 'SYSTEM', source: 'SYSTEM', data: { personalStopsChanged: true, pathCleared: true } });
    await audit.record(ctx, { action: 'UPDATE', entity: 'TransportTrip', entityId: t.tripId, details: { consentWithdrawn: true, pathCleared: true } }, tx);
  }
  // E5: trips already under way (or a stop kept for another passenger) keep their stops, but the driver API now hides this passenger's
  // personal points (no active consent). Bump them so GET /api/driver/v1/sync reports the change and the driver app
  // refetches the trip, replacing any cached copy of the point. Event without coordinates; no push (sync is the channel).
  const underWayIds = [...new Set([...seatsOf.map((s) => s.tripId), ...ownHeaders.map((h) => h.id)])].filter((id) => !touchedTrips.has(id));
  const underWay = underWayIds.length
    ? await tx.transportTrip.findMany({ where: { id: { in: underWayIds } }, select: { id: true, providerCompanyId: true, customerCompanyId: true, plannedTripId: true, plannedTrip: { select: { status: true, origin: true } } } })
    : [];
  for (const t of underWay) {
    if (!t.plannedTripId || t.customerCompanyId !== p.companyId || t.plannedTrip?.origin !== 'ETMS' || !['SCHEDULED', 'STARTED', 'IN_PROGRESS'].includes(t.plannedTrip.status)) continue;
    await tx.transportTrip.update({ where: { id: t.id }, data: { version: { increment: 1 } } });
    await recordTripEvent(tx, ctx, { tripId: t.id, providerCompanyId: t.providerCompanyId, customerCompanyId: t.customerCompanyId, kind: 'CHANGED', reasonCode: 'CONSENT_WITHDRAWN', actorType: 'SYSTEM', source: 'SYSTEM', data: { personalPointsHidden: true } });
    out.tripsUnderWayChanged++;
  }
  out.plannedTripIds = [...new Set([...touchedTrips.values()].map((t) => t.plannedTripId))];

  // Drafts that name one of the bookings or carry a stop near one of the passenger's points.
  const ids = bookings.map((b) => b.id);
  const drafts = await tx.transportChangeSet.findMany({ where: { companyId: p.companyId, status: 'DRAFT' }, select: { id: true, draft: true } });
  for (const d of drafts) {
    if (!draftTouches(d.draft, ids, points)) continue;
    await tx.transportChangeSet.update({ where: { id: d.id }, data: { status: 'REJECTED', draft: Prisma.DbNull, result: { discardedBy: 'consent-withdrawal' } as Prisma.InputJsonValue } });
    await audit.record(ctx, { action: 'DELETE', entity: 'TransportChangeSet', entityId: d.id, details: { discarded: true, reason: 'CONSENT_WITHDRAWN' } }, tx);
    out.draftsDiscarded++;
  }

  // Pickup overrides on upcoming exceptions of the passenger's schedules.
  const today = new Date(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`);
  const scheduleIds = (await tx.transportSchedule.findMany({ where: { companyId: p.companyId, profileId: p.profileId }, select: { id: true } })).map((s) => s.id);
  const exceptions = scheduleIds.length ? await tx.transportScheduleException.findMany({ where: { scheduleId: { in: scheduleIds }, kind: 'OVERRIDE', date: { gte: today } }, select: { id: true, scheduleId: true, override: true } }) : [];
  for (const e of exceptions) {
    const ov = overrideOf(e.override);
    if (!ov?.pickup) continue;
    if (ov.timeMin === undefined) await tx.transportScheduleException.delete({ where: { id: e.id } });
    else await tx.transportScheduleException.update({ where: { id: e.id }, data: { override: { timeMin: ov.timeMin } as Prisma.InputJsonValue } });
    await audit.record(ctx, { action: 'UPDATE', entity: 'TransportSchedule', entityId: e.scheduleId, details: { exception: { pickupRemoved: true }, reason: 'CONSENT_WITHDRAWN' } }, tx);
    out.exceptionsCleared++;
  }

  if (out.bookingsCancelled || out.seatsReleased) {
    await tx.transportPassengerNotice.create({
      data: { companyId: p.companyId, profileId: p.profileId, userId: p.userId, kind: 'TRANSPORT_STOPPED_CONSENT_WITHDRAWN', channel: 'IN_APP', details: { bookingsCancelled: out.bookingsCancelled, seatsReleased: out.seatsReleased } },
    });
  }
  return out;
}

/** True when a draft's changes name one of `bookingIds` or carry a stop near one of `points` (consent withdrawal / erasure). */
export function draftTouches(draft: Prisma.JsonValue | null, bookingIds: string[], points: Point[]): boolean {
  const text = JSON.stringify(draft ?? null);
  if (bookingIds.some((id) => text.includes(id))) return true;
  const changes = (draft as { changes?: unknown } | null)?.changes;
  if (!Array.isArray(changes) || !points.length) return false;
  for (const c of changes as { op?: string; stops?: { point?: { lat?: unknown; lng?: unknown; poiId?: unknown } }[] }[]) {
    for (const s of c?.stops ?? []) {
      const pt = s?.point;
      if (pt && typeof pt.lat === 'number' && typeof pt.lng === 'number' && !pt.poiId && nearAny({ lat: pt.lat, lng: pt.lng }, points, TRANSPORT_E3_LIMITS.personalPointNearM)) return true;
    }
  }
  return false;
}

import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ACTIVE_BOOKING_STATUSES, DRIVER_REASON_CODES, TRANSPORT_E3_LIMITS } from '@veetracer/shared';
import { draftTouches } from './consent-withdrawal';
import { nearAny } from './personal-points';
import { eraseRoutingPlanPoints } from './routing-plan-privacy';

type Tx = Prisma.TransactionClient;

/** Erased personal points keep 2 decimals (≈ 1.1 km): statistics by area survive, the home does not (L5 default). */
const ERASED_DECIMALS = 2;
const round2 = (v: number) => Math.round(v * 10 ** ERASED_DECIMALS) / 10 ** ERASED_DECIMALS;
/** Free-text keys removed from the passenger's trip-event data (dispatcher notes, reasons). */
const EVENT_TEXT_KEYS = ['note', 'reason'];
/** Driver reports stored per trip (no seat link) whose `data.note` is free text (E5 security review L1). */
const DRIVER_REPORT_KINDS = ['REPORT_DELAY', 'REPORT_BREAKDOWN'];

/** Trip states in which a seat can still be served. */
const OPEN_TRIP_STATUSES = ['SCHEDULED', 'STARTED', 'IN_PROGRESS'] as const;
/** Seat states that are not settled yet (waiting for pickup, or on board). */
const LIVE_SEAT_STATUSES = ['PENDING', 'BOARDED'] as const;

/**
 * Before "Erase personal data" (E2 M5): the passenger must have no booking that can still be served (an active status
 * whose window has not ended). Those are cancelled first (Bookings), which also frees their seats; erasure itself never
 * changes a trip in the future. 409 INVALID_STATE otherwise.
 *
 * Defect I2 (E5 WP 5.5): a seated booking keeps its ASSIGNED / CONFIRMED status after its trip ends (the booking status
 * has no "served" value). Such a booking is no longer open once none of its seats can still be served: a booking with
 * seats counts only while one of them is PENDING / BOARDED on a trip that is still SCHEDULED / STARTED / IN_PROGRESS.
 * A booking without any seat (PENDING_ASSIGNMENT, WAITLISTED, …) stays open until its window ends, as before.
 */
export async function assertNoOpenBookings(db: Pick<Tx, 'transportBooking'>, companyId: string, profileId: string, now: Date = new Date()): Promise<void> {
  const open = await db.transportBooking.count({
    where: {
      customerCompanyId: companyId,
      profileId,
      status: { in: [...ACTIVE_BOOKING_STATUSES] },
      windowEnd: { gt: now },
      OR: [{ passengers: { none: {} } }, { passengers: { some: { status: { in: [...LIVE_SEAT_STATUSES] }, trip: { plannedTrip: { status: { in: [...OPEN_TRIP_STATUSES] } } } } } }],
    },
  });
  if (open) throw new ConflictException({ code: 'INVALID_STATE', message: `Cancel the passenger's ${open} upcoming booking(s) before erasing the personal data` });
}

export interface TransportErasure {
  bookings: number;
  stops: number;
  drafts: number;
  /** Planned trips whose road path was cleared (it ran through one of the passenger's points). */
  paths: number;
  exceptions: number;
  /** E4: routing-plan stops at the passenger's personal points (coarsened; name, snapped point and geometry removed). */
  planStops: number;
  /** Booking ids: their audit trail is scrubbed with the passenger's. */
  bookingIds: string[];
  /** The passenger's schedule ids: their audit trail (exceptions with pickup / reason) is scrubbed too. */
  scheduleIds: string[];
}

/**
 * E3 part of the erasure (E2 M5, L5 default, pending owner confirmation of L5; extended by the E3 security review M5),
 * inside the erasure transaction:
 * - bookings keep status, dates, windows and sites (statistics); personal points (no poiId) are coarsened to 2 decimals
 *   (the ASSIGNED / CONFIRMED CHECK needs a point), their labels and the free-text note / status reason are removed;
 * - planned stops that were the passenger's personal points lose their name and are coarsened the same way: stops they
 *   own (profileId), stops their seats link to as a non-site pickup / drop, and ETMS stops within personalPointNearM of
 *   any of their points or home (a 4-decimal board point never equals the exact one: distance, not equality);
 * - the road path of every planned trip that had such a stop is cleared (it ran through the home);
 * - seat cancel / no-show reasons and the note / reason of their trip events are removed, a reasonCode outside the
 *   closed driver lists on those events is cleared, and the driver's note on REPORT_DELAY / REPORT_BREAKDOWN of every
 *   trip the passenger rode is replaced by the erasure mark (E5 security review L1);
 * - schedule exceptions: pickup overrides removed (an override left empty is deleted), reasons cleared;
 * - server-held DRAFT change sets naming one of the bookings or carrying a stop near one of the points are discarded;
 * - E4: the passenger's personal-point stops in routing plans are coarsened the same way (routing-plan-privacy.ts).
 * Inherent residue (owner decision L5): the vehicle's own position history shows where it stopped at the planned time.
 */
export async function eraseTransportData(tx: Tx, companyId: string, profileId: string, mark: string, home: { lat: number; lng: number } | null = null): Promise<TransportErasure> {
  const bookings = await tx.transportBooking.findMany({
    where: { customerCompanyId: companyId, profileId },
    select: { id: true, pickupLat: true, pickupLng: true, pickupPoiId: true, dropLat: true, dropLng: true, dropPoiId: true },
  });
  const personal = (lat: number | null, lng: number | null, poiId: string | null) => lat !== null && lng !== null && !poiId;
  // The exact points, read before they are coarsened (stop / path / draft matching).
  const points: { lat: number; lng: number }[] = home ? [home] : [];
  for (const b of bookings) {
    if (personal(b.pickupLat, b.pickupLng, b.pickupPoiId)) points.push({ lat: b.pickupLat!, lng: b.pickupLng! });
    if (personal(b.dropLat, b.dropLng, b.dropPoiId)) points.push({ lat: b.dropLat!, lng: b.dropLng! });
  }
  for (const b of bookings) {
    const data: Prisma.TransportBookingUncheckedUpdateInput = { note: null, statusReason: null, lateReason: null, purpose: null };
    if (personal(b.pickupLat, b.pickupLng, b.pickupPoiId)) Object.assign(data, { pickupLat: round2(b.pickupLat!), pickupLng: round2(b.pickupLng!), pickupLabel: null });
    if (personal(b.dropLat, b.dropLng, b.dropPoiId)) Object.assign(data, { dropLat: round2(b.dropLat!), dropLng: round2(b.dropLng!), dropLabel: null });
    await tx.transportBooking.update({ where: { id: b.id }, data });
  }
  const ids = bookings.map((b) => b.id);
  const seats = ids.length ? await tx.transportTripPassenger.findMany({ where: { bookingId: { in: ids } }, select: { id: true, tripId: true, bookingId: true, pickupStopId: true, dropStopId: true } }) : [];

  // Stops: owned, linked as a non-site end of one of the seats, or an ETMS stop near one of the points.
  const linked = new Set<string>();
  for (const s of seats) {
    const b = bookings.find((x) => x.id === s.bookingId)!;
    if (s.pickupStopId && !b.pickupPoiId) linked.add(s.pickupStopId);
    if (s.dropStopId && !b.dropPoiId) linked.add(s.dropStopId);
  }
  const R = TRANSPORT_E3_LIMITS.personalPointNearM;
  const boxes = points.map((p) => {
    const dLat = R / 111_000 + 1e-6;
    const dLng = R / (111_000 * Math.max(0.1, Math.cos((p.lat * Math.PI) / 180))) + 1e-6;
    return { lat: { gte: p.lat - dLat, lte: p.lat + dLat }, lng: { gte: p.lng - dLng, lte: p.lng + dLng } };
  });
  const candidates = await tx.plannedTripStop.findMany({
    where: { OR: [{ profileId }, ...(linked.size ? [{ id: { in: [...linked] } }] : []), ...boxes] },
    select: { id: true, tripId: true, lat: true, lng: true, profileId: true, poiId: true },
  });
  // Only this company's trips; proximity matches only on ETMS trips (a v1.8 route stop near a home is a company stop).
  const trips = new Map((candidates.length ? await tx.plannedTrip.findMany({ where: { id: { in: [...new Set(candidates.map((c) => c.tripId))] }, companyId }, select: { id: true, origin: true } }) : []).map((t) => [t.id, t]));
  const mine = candidates.filter((st) => {
    const t = trips.get(st.tripId);
    if (!t) return false;
    if (st.profileId === profileId || linked.has(st.id)) return !st.poiId;
    return t.origin === 'ETMS' && !st.poiId && (!st.profileId || st.profileId === profileId) && nearAny(st, points, R);
  });
  for (const st of mine) await tx.plannedTripStop.update({ where: { id: st.id }, data: { name: mark, lat: round2(st.lat), lng: round2(st.lng) } });
  const pathTrips = [...new Set(mine.map((s) => s.tripId))];
  if (pathTrips.length) await tx.plannedTrip.updateMany({ where: { id: { in: pathTrips } }, data: { path: Prisma.DbNull } });

  // Free text on the seats and in their events.
  if (seats.length) {
    await tx.transportTripPassenger.updateMany({ where: { id: { in: seats.map((s) => s.id) } }, data: { cancelReason: null, noShowReason: null } });
    const events = await tx.transportTripEvent.findMany({ where: { passengerTripId: { in: seats.map((s) => s.id) } }, select: { id: true, data: true } });
    for (const e of events) {
      const data = e.data && typeof e.data === 'object' && !Array.isArray(e.data) ? (e.data as Record<string, unknown>) : null;
      if (!data || !EVENT_TEXT_KEYS.some((k) => data[k] !== undefined && data[k] !== null)) continue;
      const next = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, EVENT_TEXT_KEYS.includes(k) && v !== null ? mark : v]));
      await tx.transportTripEvent.update({ where: { id: e.id }, data: { data: next as Prisma.InputJsonValue } });
    }
    // E5 security review L1: a reasonCode outside the closed driver lists on the seats' events is free text: removed.
    await tx.transportTripEvent.updateMany({ where: { passengerTripId: { in: seats.map((s) => s.id) }, reasonCode: { notIn: [...DRIVER_REASON_CODES] } }, data: { reasonCode: null } });
    // E5 security review L1: the driver's free-text note on REPORT_DELAY / REPORT_BREAKDOWN of every trip the passenger
    // rode (stored without a seat link: "Asha not at …" must not survive the erasure).
    const tripIds = [...new Set(seats.map((s) => s.tripId))];
    const reports = await tx.transportTripEvent.findMany({ where: { tripId: { in: tripIds }, kind: { in: [...DRIVER_REPORT_KINDS] } }, select: { id: true, data: true } });
    for (const e of reports) {
      const data = e.data && typeof e.data === 'object' && !Array.isArray(e.data) ? (e.data as Record<string, unknown>) : null;
      if (!data || data.note === undefined || data.note === null || data.note === mark) continue;
      await tx.transportTripEvent.update({ where: { id: e.id }, data: { data: { ...data, note: mark } as Prisma.InputJsonValue } });
    }
  }

  // Schedule exceptions (M4): pickup overrides and reasons.
  const scheduleIds = (await tx.transportSchedule.findMany({ where: { companyId, profileId }, select: { id: true } })).map((s) => s.id);
  let exceptions = 0;
  if (scheduleIds.length) {
    const rows = await tx.transportScheduleException.findMany({ where: { scheduleId: { in: scheduleIds } }, select: { id: true, kind: true, override: true, reason: true } });
    for (const e of rows) {
      const o = e.override && typeof e.override === 'object' && !Array.isArray(e.override) ? (e.override as Record<string, unknown>) : null;
      const hasPickup = !!o?.pickup;
      if (!hasPickup && e.reason === null) continue;
      if (hasPickup && typeof o?.timeMin !== 'number') await tx.transportScheduleException.delete({ where: { id: e.id } });
      else await tx.transportScheduleException.update({ where: { id: e.id }, data: { reason: null, ...(hasPickup ? { override: { timeMin: o!.timeMin } as Prisma.InputJsonValue } : {}) } });
      exceptions++;
    }
  }

  // Drafts naming one of the bookings or carrying a stop near one of the points.
  let drafts = 0;
  const open = await tx.transportChangeSet.findMany({ where: { companyId, status: 'DRAFT' }, select: { id: true, draft: true } });
  for (const d of open) {
    if (!draftTouches(d.draft, ids, points)) continue;
    await tx.transportChangeSet.update({ where: { id: d.id }, data: { status: 'REJECTED', draft: Prisma.DbNull, result: { discardedBy: 'erasure' } as Prisma.InputJsonValue } });
    drafts++;
  }
  const planStops = await eraseRoutingPlanPoints(tx, companyId, profileId, ids);
  return { bookings: bookings.length, stops: mine.length, drafts, paths: pathTrips.length, exceptions, planStops, bookingIds: ids, scheduleIds };
}

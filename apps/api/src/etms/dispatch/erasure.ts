import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ACTIVE_BOOKING_STATUSES } from '@veetracer/shared';

type Tx = Prisma.TransactionClient;

/** Erased personal points keep 2 decimals (≈ 1.1 km): statistics by area survive, the home does not (L5 default). */
const ERASED_DECIMALS = 2;
const round2 = (v: number) => Math.round(v * 10 ** ERASED_DECIMALS) / 10 ** ERASED_DECIMALS;
const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;

/**
 * Before "Erase personal data" (E2 M5): the passenger must have no booking that can still be served (an active status
 * whose window has not ended). Those are cancelled first (Bookings), which also frees their seats; erasure itself never
 * changes a trip in the future. 409 INVALID_STATE otherwise.
 */
export async function assertNoOpenBookings(db: Pick<Tx, 'transportBooking'>, companyId: string, profileId: string, now: Date = new Date()): Promise<void> {
  const open = await db.transportBooking.count({ where: { customerCompanyId: companyId, profileId, status: { in: [...ACTIVE_BOOKING_STATUSES] }, windowEnd: { gt: now } } });
  if (open) throw new ConflictException({ code: 'INVALID_STATE', message: `Cancel the passenger's ${open} upcoming booking(s) before erasing the personal data` });
}

export interface TransportErasure {
  bookings: number;
  stops: number;
  drafts: number;
  /** Booking ids: their audit trail is scrubbed with the passenger's. */
  bookingIds: string[];
}

/**
 * E3 part of the erasure (E2 M5, L5 default, pending owner confirmation of L5), inside the erasure transaction:
 * - bookings keep status, dates, windows and sites (statistics); personal points (no poiId) are coarsened to 2 decimals
 *   (the ASSIGNED / CONFIRMED CHECK needs a point), their labels and the free-text note / status reason are removed;
 * - planned stops that were the passenger's personal pickup / drop lose their name and are coarsened the same way;
 * - server-held DRAFT change sets that seat one of the bookings are discarded (they carry stop coordinates).
 */
export async function eraseTransportData(tx: Tx, companyId: string, profileId: string, mark: string): Promise<TransportErasure> {
  const bookings = await tx.transportBooking.findMany({
    where: { customerCompanyId: companyId, profileId },
    select: { id: true, pickupLat: true, pickupLng: true, pickupPoiId: true, dropLat: true, dropLng: true, dropPoiId: true },
  });
  const personal = (lat: number | null, lng: number | null, poiId: string | null) => lat !== null && lng !== null && !poiId;
  for (const b of bookings) {
    const data: Prisma.TransportBookingUncheckedUpdateInput = { note: null, statusReason: null };
    if (personal(b.pickupLat, b.pickupLng, b.pickupPoiId)) Object.assign(data, { pickupLat: round2(b.pickupLat!), pickupLng: round2(b.pickupLng!), pickupLabel: null });
    if (personal(b.dropLat, b.dropLng, b.dropPoiId)) Object.assign(data, { dropLat: round2(b.dropLat!), dropLng: round2(b.dropLng!), dropLabel: null });
    await tx.transportBooking.update({ where: { id: b.id }, data });
  }
  const ids = bookings.map((b) => b.id);
  let stops = 0;
  if (ids.length) {
    const seats = await tx.transportTripPassenger.findMany({ where: { bookingId: { in: ids } }, select: { bookingId: true, pickupStopId: true, dropStopId: true } });
    const stopIds = [...new Set(seats.flatMap((s) => [s.pickupStopId, s.dropStopId]).filter((x): x is string => !!x))];
    const rows = stopIds.length ? await tx.plannedTripStop.findMany({ where: { id: { in: stopIds } }, select: { id: true, lat: true, lng: true } }) : [];
    for (const st of rows) {
      // Only a stop at one of the passenger's personal points (never a site stop shared with the trip).
      const mine = seats.some((s) => {
        const b = bookings.find((x) => x.id === s.bookingId)!;
        return (s.pickupStopId === st.id && personal(b.pickupLat, b.pickupLng, b.pickupPoiId) && near(b.pickupLat!, st.lat) && near(b.pickupLng!, st.lng)) || (s.dropStopId === st.id && personal(b.dropLat, b.dropLng, b.dropPoiId) && near(b.dropLat!, st.lat) && near(b.dropLng!, st.lng));
      });
      if (!mine) continue;
      await tx.plannedTripStop.update({ where: { id: st.id }, data: { name: mark, lat: round2(st.lat), lng: round2(st.lng) } });
      stops++;
    }
  }
  let drafts = 0;
  if (ids.length) {
    const open = await tx.transportChangeSet.findMany({ where: { companyId, status: 'DRAFT' }, select: { id: true, draft: true } });
    for (const d of open) {
      const text = JSON.stringify(d.draft ?? null);
      if (!ids.some((id) => text.includes(id))) continue;
      await tx.transportChangeSet.update({ where: { id: d.id }, data: { status: 'REJECTED', draft: Prisma.DbNull, result: { discardedBy: 'erasure' } as Prisma.InputJsonValue } });
      drafts++;
    }
  }
  return { bookings: bookings.length, stops, drafts, bookingIds: ids };
}

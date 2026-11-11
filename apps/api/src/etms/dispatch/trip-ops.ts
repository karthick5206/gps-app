import { Prisma } from '@prisma/client';
import { type TransportTripActorType, type TransportTripEventKind, type TransportTripEventSource } from '@veetracer/shared';
import { AuthContext } from '../../access/auth-context';

/**
 * Row locks and the append-only event writer used inside E3 write transactions (15 §8.4: advisory locks per vehicle /
 * driver first — trip-locks.ts — then bookings FOR UPDATE sorted by id, then trips FOR UPDATE sorted by id, so every
 * transaction takes locks in the same order and none deadlocks).
 */

type Tx = Prisma.TransactionClient;

const uniq = (ids: (string | null | undefined)[]) => [...new Set(ids.filter((x): x is string => !!x))].sort();

/** SELECT … FOR UPDATE on bookings (sorted). Read the rows with Prisma afterwards: they are now stable until commit. */
export async function lockBookings(tx: Tx, ids: (string | null | undefined)[]): Promise<void> {
  const list = uniq(ids);
  if (list.length) await tx.$queryRaw`SELECT id FROM "TransportBooking" WHERE id = ANY(${list}::uuid[]) ORDER BY id FOR UPDATE`;
}

/** SELECT … FOR UPDATE on trip headers (sorted): occupiedSeats / version change only under this lock (15 §8.3). */
export async function lockTrips(tx: Tx, ids: (string | null | undefined)[]): Promise<void> {
  const list = uniq(ids);
  if (list.length) await tx.$queryRaw`SELECT id FROM "TransportTrip" WHERE id = ANY(${list}::uuid[]) ORDER BY id FOR UPDATE`;
}

export interface TripEventInput {
  tripId: string;
  providerCompanyId: string;
  customerCompanyId: string | null;
  kind: TransportTripEventKind;
  passengerTripId?: string | null;
  stopSeq?: number | null;
  reasonCode?: string | null;
  clientEventId?: string | null;
  occurredAt?: Date;
  data?: Record<string, unknown>;
  actorType?: TransportTripActorType;
  source?: TransportTripEventSource;
}

/** Append one TransportTripEvent (dispatcher on the web unless stated). Never updated or deleted by the code. */
export function recordTripEvent(tx: Tx, ctx: Pick<AuthContext, 'userId'>, e: TripEventInput) {
  return tx.transportTripEvent.create({
    data: {
      tripId: e.tripId,
      providerCompanyId: e.providerCompanyId,
      customerCompanyId: e.customerCompanyId,
      passengerTripId: e.passengerTripId ?? null,
      kind: e.kind,
      actorType: e.actorType ?? 'DISPATCHER',
      actorUserId: ctx.userId,
      source: e.source ?? 'WEB',
      outcome: 'ACCEPTED',
      clientEventId: e.clientEventId ?? null,
      stopSeq: e.stopSeq ?? null,
      reasonCode: e.reasonCode ?? null,
      occurredAt: e.occurredAt ?? new Date(),
      data: (e.data ?? {}) as Prisma.InputJsonValue,
    },
  });
}

/**
 * Takes a passenger off a trip inside the caller's transaction (the trip row must be locked): PENDING → CANCELLED,
 * occupiedSeats −= seats, trip version + 1. Returns false when the passenger is no longer PENDING (an outcome was
 * recorded: a boarded / dropped / no-show passenger is never silently removed).
 */
export async function releaseSeat(tx: Tx, p: { id: string; tripId: string; seats: number }, reason: string): Promise<boolean> {
  const done = await tx.transportTripPassenger.updateMany({ where: { id: p.id, status: 'PENDING' }, data: { status: 'CANCELLED', cancelReason: reason } });
  if (!done.count) return false;
  await tx.transportTrip.update({ where: { id: p.tripId }, data: { occupiedSeats: { decrement: p.seats }, version: { increment: 1 } } });
  return true;
}

/** True when this clientEventId was already recorded on the trip (a retried command is a no-op). */
export async function seenClientEvent(db: Pick<Tx, 'transportTripEvent'>, tripId: string, clientEventId: string | undefined): Promise<boolean> {
  if (!clientEventId) return false;
  return (await db.transportTripEvent.count({ where: { tripId, clientEventId } })) > 0;
}

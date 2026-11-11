import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

/**
 * Transaction-scoped advisory locks that serialise every write which can make two planned trips of one vehicle (or one
 * driver) overlap (docs/employee-transport/15 §8.4): the ETMS publish transaction and the v1.8 create / update /
 * generator paths take the same keys, so a ROUTE trip created at the same moment cannot slip past the ETMS overlap check.
 * Keys are hashed (`hashtextextended`, 64 bit); a collision only over-serialises. Locks are taken in sorted order
 * (vehicles first, then drivers) so two transactions never deadlock on them. Released at commit / rollback.
 */
export const vehicleLockKey = (objectId: string) => `etms:object:${objectId}`;
export const driverLockKey = (driverId: string) => `etms:driver:${driverId}`;

export async function lockTripResources(tx: Prisma.TransactionClient, ids: { objectIds?: (string | null | undefined)[]; driverIds?: (string | null | undefined)[] }): Promise<void> {
  const keys = [
    ...[...new Set((ids.objectIds ?? []).filter((x): x is string => !!x))].sort().map(vehicleLockKey),
    ...[...new Set((ids.driverIds ?? []).filter((x): x is string => !!x))].sort().map(driverLockKey),
  ];
  for (const key of keys) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
}

/** Statuses in which a trip holds its vehicle / driver (same set as the ETMS EXCLUDE constraints). */
const HOLDING_STATUSES = ['SCHEDULED', 'STARTED', 'IN_PROGRESS'] as const;

/**
 * E3 security review M3: a ROUTE (v1.8) trip must not double-book a vehicle or driver that an active ETMS run holds over
 * [start, end). Call inside the transaction, after lockTripResources, so the ETMS publish (which checks the other
 * direction under the same locks) and this check serialise. ROUTE vs ROUTE overlaps keep their v1.8 behaviour (allowed;
 * the tracker follows the earliest open trip). Throws 409 VEHICLE_BUSY / DRIVER_BUSY.
 */
export async function assertNoEtmsOverlap(
  tx: Prisma.TransactionClient,
  r: { objectId: string; driverId: string | null; start: Date; end: Date; exceptId?: string | null },
): Promise<void> {
  const base: Prisma.PlannedTripWhereInput = { origin: 'ETMS', status: { in: [...HOLDING_STATUSES] }, plannedStart: { lt: r.end }, plannedEnd: { gt: r.start }, ...(r.exceptId ? { id: { not: r.exceptId } } : {}) };
  const vehicle = await tx.plannedTrip.findFirst({ where: { ...base, objectId: r.objectId }, select: { id: true } });
  if (vehicle) throw new ConflictException({ code: 'VEHICLE_BUSY', message: 'The vehicle is on an employee-transport trip at that time' });
  if (r.driverId) {
    const driver = await tx.plannedTrip.findFirst({ where: { ...base, driverId: r.driverId }, select: { id: true } });
    if (driver) throw new ConflictException({ code: 'DRIVER_BUSY', message: 'The driver is on an employee-transport trip at that time' });
  }
}

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

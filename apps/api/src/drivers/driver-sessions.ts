import { Prisma, PrismaClient } from '@prisma/client';
import { DriverAssignmentSource } from '@veetracer/shared';

type Db = PrismaClient | Prisma.TransactionClient;

export interface SwitchDriverInput {
  companyId: string;
  objectId: string;
  /** null = the vehicle has no driver from `at`. */
  driverId: string | null;
  at: Date;
  source: DriverAssignmentSource;
  createdById?: string | null;
}

/**
 * Puts a driver on a vehicle (or clears it). Closes the vehicle's open session and the driver's open session on any
 * other vehicle at `at`, then opens a new one. A no-op when that driver is already on that vehicle.
 * Returns true when anything changed.
 */
export async function switchDriver(prisma: PrismaClient, input: SwitchDriverInput): Promise<boolean> {
  return prisma.$transaction((tx) => switchDriverTx(tx, input));
}

export async function switchDriverTx(tx: Db, { companyId, objectId, driverId, at, source, createdById = null }: SwitchDriverInput): Promise<boolean> {
  const open = await tx.driverAssignment.findFirst({ where: { objectId, toTime: null } });
  if (open && open.driverId === driverId) return false;
  if (!open && !driverId) return false;
  // A session never ends before it started (late / out-of-order points).
  const close = (fromTime: Date) => (at > fromTime ? at : fromTime);
  if (open) await tx.driverAssignment.update({ where: { id: open.id }, data: { toTime: close(open.fromTime) } });
  if (!driverId) return true;
  const elsewhere = await tx.driverAssignment.findFirst({ where: { driverId, toTime: null } });
  if (elsewhere) await tx.driverAssignment.update({ where: { id: elsewhere.id }, data: { toTime: close(elsewhere.fromTime) } });
  await tx.driverAssignment.create({ data: { companyId, driverId, objectId, fromTime: at, source, createdById } });
  return true;
}

/** Ends the vehicle's open session if it came from an RFID swipe (ignition off = driver left). */
export async function endRfidSession(prisma: PrismaClient, objectId: string, at: Date): Promise<boolean> {
  const open = await prisma.driverAssignment.findFirst({ where: { objectId, toTime: null, source: 'RFID' } });
  if (!open) return false;
  await prisma.driverAssignment.update({ where: { id: open.id }, data: { toTime: at > open.fromTime ? at : open.fromTime } });
  return true;
}

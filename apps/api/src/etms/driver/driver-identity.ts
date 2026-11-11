import { ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuthContext } from '../../access/auth-context';

/**
 * D5 relationship guard of every /api/driver/v1 route (doc 09 §3.2, 05 §6.1 "Trip assignment"): the caller's own
 * Driver row (Driver.userId = caller) in the company it acts in. The menu `etms_driver` alone is never enough: an Admin
 * holds every menu, a Super Admin bypasses menus, and neither is a driver. No linked driver (or one of another company,
 * e.g. a switched Super Admin) → 403 NOT_A_DRIVER; linked but archived → 403 DRIVER_INACTIVE.
 */
export const DRIVER_SELECT = { id: true, companyId: true, name: true, employeeId: true, licenseExpiry: true, isActive: true, userId: true } satisfies Prisma.DriverSelect;
export type MeDriver = Prisma.DriverGetPayload<{ select: typeof DRIVER_SELECT }>;

export async function resolveDriver(db: { driver: Prisma.TransactionClient['driver'] }, ctx: Pick<AuthContext, 'userId' | 'companyId'>): Promise<MeDriver> {
  const row = await db.driver.findFirst({ where: { userId: ctx.userId }, select: DRIVER_SELECT });
  if (!row || row.userId !== ctx.userId || row.companyId !== ctx.companyId) throw new ForbiddenException({ message: 'This login is not linked to a driver', code: 'NOT_A_DRIVER' });
  if (!row.isActive) throw new ForbiddenException({ message: 'Your driver profile is inactive; contact your dispatcher', code: 'DRIVER_INACTIVE' });
  return row;
}

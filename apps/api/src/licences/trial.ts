import { Prisma } from '@prisma/client';
import { trialPlan, type SeatLicenceType } from '@veetracer/shared';

const DAY_MS = 24 * 3600_000;

/**
 * Free-trial seat for a device of a personal / family account (see trialPlan): created when the account has no free
 * bought seat, while the account's trial count for that kind of device lasts. Returns the seat id, or null when the
 * account isn't eligible (business account, other seat type, trial used up).
 */
export async function grantTrialSeat(tx: Prisma.TransactionClient, companyId: string, type: SeatLicenceType, deviceId: string): Promise<{ id: string; expiresAt: Date } | null> {
  const plan = trialPlan(type);
  if (!plan) return null;
  const company = await tx.company.findUnique({ where: { id: companyId }, select: { accountType: true } });
  if (!company || company.accountType === 'BUSINESS') return null;
  const used = await tx.licenceSeat.count({ where: { companyId, source: 'TRIAL', type: { in: plan.countTypes } } });
  if (used >= plan.max) return null;
  const now = new Date();
  const seat = await tx.licenceSeat.create({
    data: { type, companyId, source: 'TRIAL', activatedAt: now, expiresAt: new Date(now.getTime() + plan.days * DAY_MS), deviceId, assignedAt: now, note: `Free trial (${plan.days} days)` },
    select: { id: true, expiresAt: true },
  });
  return seat;
}

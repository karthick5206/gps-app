import {
  addYears,
  LICENCE_REMINDER_DAYS,
  LICENCE_TYPES,
  LicencePrices,
  LicenceType,
  PurchaseItem,
  QuoteLineDto,
  renewedExpiry,
  seatLocked,
  seatStatus,
  SeatSummaryDto,
} from '@veetracer/shared';

const DAY_MS = 86_400_000;

/** Column that links a seat of this type to its subject. */
export const SUBJECT_COLUMN: Record<LicenceType, 'userId' | 'deviceId' | 'fuelObjectId'> = {
  USER: 'userId',
  GPS_DEVICE: 'deviceId',
  DASHCAM: 'deviceId',
  FUEL_SENSOR: 'fuelObjectId',
};

export interface SeatLike {
  id: string;
  type: LicenceType;
  expiresAt: Date;
  userId: string | null;
  deviceId: string | null;
  fuelObjectId: string | null;
}

export const isFree = (s: SeatLike): boolean => !s.userId && !s.deviceId && !s.fuelObjectId;

/**
 * Free seat to reuse for a new subject: unassigned and not yet expired (a seat in its grace period is not handed out).
 * The one expiring first is used first, so no paid time is wasted in the pool.
 */
export function pickFreeSeat<T extends SeatLike>(seats: T[], type: LicenceType, now: number): T | null {
  return (
    seats
      .filter((s) => s.type === type && isFree(s) && s.expiresAt.getTime() > now)
      .sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime() || a.id.localeCompare(b.id))[0] ?? null
  );
}

export function summarise(seats: SeatLike[], now: number, graceDays: number): SeatSummaryDto[] {
  return LICENCE_TYPES.map((type) => {
    const mine = seats.filter((s) => s.type === type);
    const valid = mine.filter((s) => s.expiresAt.getTime() > now);
    return {
      type,
      total: valid.length,
      used: valid.filter((s) => !isFree(s)).length,
      free: valid.filter(isFree).length,
      expiring: mine.filter((s) => seatStatus(s.expiresAt, now, graceDays) === 'EXPIRING').length,
      expired: mine.filter((s) => s.expiresAt.getTime() <= now && !isFree(s)).length,
    };
  });
}

/**
 * Why a user may not sign in (expired USER seat past grace, or none assigned), or null when they may.
 * Super Admins and platform-company users are never locked.
 */
export function userLockReason(
  user: { isSuperAdmin: boolean; platform: boolean },
  seat: { expiresAt: Date } | null,
  now: number,
  graceDays: number,
): string | null {
  if (user.isSuperAdmin || user.platform) return null;
  if (!seat) return 'No VeeTrax licence is assigned to your account. Ask your administrator to assign or buy a user licence.';
  if (seatLocked(seat.expiresAt, now, graceDays)) return 'Your VeeTrax licence has expired. Ask your administrator to renew it.';
  return null;
}

/** Quote lines: new seats run a year from the payment date; renewals extend each seat (see renewedExpiry). */
export function quoteLines(
  items: PurchaseItem[],
  renewals: { id: string; type: LicenceType; expiresAt: Date }[],
  prices: LicencePrices,
  paidAt: Date,
): QuoteLineDto[] {
  const lines: QuoteLineDto[] = [];
  for (const item of items) {
    if (item.quantity <= 0) continue;
    const unit = prices[item.type];
    lines.push({
      kind: 'NEW',
      type: item.type,
      quantity: item.quantity,
      unitPaise: unit,
      amountPaise: unit * item.quantity,
      periodFrom: paidAt.toISOString(),
      periodTo: addYears(paidAt).toISOString(),
      seatIds: [],
    });
  }
  for (const s of renewals) {
    const unit = prices[s.type];
    const from = s.expiresAt.getTime() > paidAt.getTime() ? s.expiresAt : paidAt;
    lines.push({
      kind: 'RENEWAL',
      type: s.type,
      quantity: 1,
      unitPaise: unit,
      amountPaise: unit,
      periodFrom: from.toISOString(),
      periodTo: renewedExpiry(s.expiresAt, paidAt).toISOString(),
      seatIds: [s.id],
    });
  }
  return lines;
}

/**
 * Which reminder is due for a seat expiring at `expiresAt` given the last one sent (D30, D15, D7, D1, D0), or null.
 * Only the most urgent threshold reached is sent (no burst of older reminders after downtime).
 */
export function reminderDue(expiresAt: Date, notifiedState: string | null, now: number): { state: string; daysLeft: number } | null {
  const daysLeft = Math.ceil((expiresAt.getTime() - now) / DAY_MS);
  if (daysLeft > LICENCE_REMINDER_DAYS[0]) return null;
  const reached = [...LICENCE_REMINDER_DAYS].reverse().find((d) => daysLeft <= d) ?? LICENCE_REMINDER_DAYS[0];
  const state = `D${reached}`;
  if (notifiedState === state) return null;
  // Do not step backwards (e.g. after a manual date change the state is reset by renewal anyway).
  if (notifiedState && Number(notifiedState.slice(1)) <= reached) return null;
  return { state, daysLeft: Math.max(daysLeft, 0) };
}

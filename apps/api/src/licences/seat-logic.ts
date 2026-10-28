import {
  addYears,
  ApiPlan,
  ApiPlans,
  DEFAULT_GRACE_DAYS,
  LICENCE_GRACE_REMINDER_DAYS,
  LICENCE_REMINDER_DAYS,
  LICENCE_TYPES,
  LicencePrices,
  LicenceType,
  PurchaseItem,
  QuoteLineDto,
  SeatLicenceType,
  unitPricePaise,
  renewedExpiry,
  seatStatus,
  SeatSummaryDto,
} from '@veetracer/shared';

const DAY_MS = 86_400_000;

/** Column that links a seat of this type to its subject. */
export const SUBJECT_COLUMN: Record<SeatLicenceType, 'deviceId' | 'fuelObjectId'> = {
  GPS_DEVICE: 'deviceId',
  DASHCAM: 'deviceId',
  FUEL_SENSOR: 'fuelObjectId',
  MOBILE_TRACKER: 'deviceId',
};

export interface SeatLike {
  id: string;
  type: LicenceType;
  expiresAt: Date;
  userId: string | null;
  deviceId: string | null;
  fuelObjectId: string | null;
  /** API_ACCESS seats are account-level: in use while in a company pool (the company is the subject). */
  companyId?: string | null;
}

export const isFree = (s: SeatLike): boolean => (s.type === 'API_ACCESS' ? !s.companyId : !s.userId && !s.deviceId && !s.fuelObjectId);

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
    if (type === 'API_ACCESS' && mine.some((s) => s.companyId)) {
      // One account-level seat per company: older (replaced) API seats are history, not "expired" seats to renew.
      const latest = [...mine].sort((a, b) => b.expiresAt.getTime() - a.expiresAt.getTime())[0];
      const st = seatStatus(latest.expiresAt, now, graceDays);
      return { type, total: valid.length, used: valid.length, free: 0, expiring: st === 'EXPIRING' ? 1 : 0, expired: latest.expiresAt.getTime() <= now ? 1 : 0 };
    }
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
 * Quote lines: new seats run a year from the payment date; renewals extend each seat (see renewedExpiry). Developer API
 * lines carry their plan (a renewal keeps the seat's plan).
 */
export function quoteLines(
  items: PurchaseItem[],
  renewals: { id: string; type: LicenceType; expiresAt: Date; apiPlan?: string | null }[],
  prices: LicencePrices,
  paidAt: Date,
  plans: ApiPlans,
): QuoteLineDto[] {
  const lines: QuoteLineDto[] = [];
  for (const item of items) {
    if (item.quantity <= 0) continue;
    const plan: ApiPlan | null = item.type === 'API_ACCESS' ? (item.plan ?? 'BASIC') : null;
    const unit = unitPricePaise(prices, plans, item.type, plan);
    lines.push({
      kind: 'NEW',
      type: item.type,
      quantity: item.quantity,
      unitPaise: unit,
      amountPaise: unit * item.quantity,
      periodFrom: paidAt.toISOString(),
      periodTo: addYears(paidAt).toISOString(),
      seatIds: [],
      ...(plan ? { plan } : {}),
    });
  }
  for (const s of renewals) {
    const plan: ApiPlan | null = s.type === 'API_ACCESS' ? ((s.apiPlan as ApiPlan | null) ?? 'BASIC') : null;
    const unit = unitPricePaise(prices, plans, s.type, plan);
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
      ...(plan ? { plan } : {}),
    });
  }
  return lines;
}

/**
 * Which reminder is due for a seat expiring at `expiresAt` given the last one sent (D30, D15, D7, D1, D0), or null.
 * Only the most urgent threshold reached is sent (no burst of older reminders after downtime).
 */
export function reminderDue(
  expiresAt: Date,
  notifiedState: string | null,
  now: number,
  graceDays = DEFAULT_GRACE_DAYS,
): { state: string; daysLeft: number; locked: boolean } | null {
  const daysLeft = Math.ceil((expiresAt.getTime() - now) / DAY_MS) || 0; // no -0
  if (daysLeft > LICENCE_REMINDER_DAYS[0]) return null;
  // Thresholds, latest first: before expiry (20 … 0), then during grace (-3, -7, -10) and the lock day (-grace).
  const thresholds = [...LICENCE_REMINDER_DAYS, ...LICENCE_GRACE_REMINDER_DAYS.filter((d) => d < graceDays).map((d) => -d), -graceDays];
  const reached = daysLeft < -graceDays ? -graceDays : ([...thresholds].reverse().find((d) => daysLeft <= d) ?? thresholds[0]);
  const state = `D${reached}`;
  if (notifiedState === state) return null;
  // Do not step backwards (e.g. after a manual date change the state is reset by renewal anyway).
  if (notifiedState && Number(notifiedState.slice(1)) <= reached) return null;
  return { state, daysLeft, locked: reached === -graceDays };
}

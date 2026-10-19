import { HttpException } from '@nestjs/common';
import { ApiLicenceErrorCode, ApiPlan, ApiPlanLimits, ApiPlans, isApiPlan, seatLocked } from '@veetracer/shared';

const DAY_MS = 86_400_000;

/** 402 from the customer API / Developer API settings when the Developer API licence does not allow the request. */
export class ApiLicenceException extends HttpException {
  constructor(
    readonly code: ApiLicenceErrorCode,
    message: string,
  ) {
    super({ statusCode: 402, code, licenceType: 'API_ACCESS', message }, 402);
  }
}

export const API_LICENCE_MESSAGES: Record<ApiLicenceErrorCode, string> = {
  LICENCE_EXPIRED: 'Developer API licence expired. Renew it in VeeTrax → Billing & Licences.',
  LICENCE_REQUIRED: 'No Developer API licence. Buy a Developer API plan in VeeTrax → Billing & Licences.',
  API_VEHICLE_LIMIT: 'This vehicle is beyond the vehicle limit of your Developer API plan. Upgrade the plan to reach it.',
  API_WEBHOOK_LIMIT: 'Your Developer API plan allows no more webhook endpoints. Upgrade the plan to add more.',
};

export interface ApiSeatLike {
  id: string;
  expiresAt: Date;
  apiPlan: string | null;
}

export interface ApiAccessDecision {
  exempt: boolean;
  allowed: boolean;
  /** Why the API is refused (null when allowed). */
  code: 'LICENCE_EXPIRED' | 'LICENCE_REQUIRED' | null;
  plan: ApiPlan | null;
  /** Plan limits (null: exempt or no seat). */
  limits: ApiPlanLimits | null;
}

/** The effective Developer API seat of a company: the one expiring last (a newly bought plan replaces older seats). */
export function currentApiSeat<T extends ApiSeatLike>(seats: T[]): T | null {
  return [...seats].sort((a, b) => b.expiresAt.getTime() - a.expiresAt.getTime() || a.id.localeCompare(b.id))[0] ?? null;
}

/**
 * Whether API keys of a company work: platform companies always (no plan limits); otherwise only while the current
 * API_ACCESS seat is active or in its grace period. Limits come from the seat's plan.
 */
export function apiAccessDecision(seat: ApiSeatLike | null, exempt: boolean, plans: ApiPlans, now: number, graceDays: number): ApiAccessDecision {
  if (exempt) return { exempt: true, allowed: true, code: null, plan: null, limits: null };
  if (!seat) return { exempt: false, allowed: false, code: 'LICENCE_REQUIRED', plan: null, limits: null };
  const plan: ApiPlan = isApiPlan(seat.apiPlan) ? seat.apiPlan : 'BASIC';
  const locked = seatLocked(seat.expiresAt, now, graceDays);
  return { exempt: false, allowed: !locked, code: locked ? 'LICENCE_EXPIRED' : null, plan, limits: plans[plan] };
}

/**
 * Launch rule (mirrored by the SQL in migration 20261019210000_licence_credit_notes_api): no free API seat for existing
 * companies, except those that already created API keys — they get a MIGRATION seat on BASIC for 12 months.
 * Platform companies are exempt and get none.
 */
export function apiMigrationSeatDue(c: { isPlatform: boolean; apiKeyCount: number; hasApiSeat: boolean }): boolean {
  return !c.isPlatform && c.apiKeyCount > 0 && !c.hasApiSeat;
}

/** Webhook endpoints still allowed by the plan (Infinity when exempt). */
export function webhooksLeft(existing: number, limits: ApiPlanLimits | null): number {
  return limits ? Math.max(0, limits.maxWebhooks - existing) : Infinity;
}

/** Company-wide daily request counter (UTC day, like the per-key day window). */
export const companyQuotaKey = (companyId: string, now: number) => `vt:api:quota:d:${companyId}:${Math.floor(now / DAY_MS)}`;

/** Seconds until the UTC day ends (Retry-After for the company quota). */
export const secondsToUtcMidnight = (now: number) => Math.max(1, Math.ceil((DAY_MS - (now % DAY_MS)) / 1000));

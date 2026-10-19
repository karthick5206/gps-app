import { Injectable } from '@nestjs/common';
import { ApiAccessStatusDto, ApiPlan, readApiPlans, seatLocked, seatStatus, SeatSource } from '@veetracer/shared';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { API_LICENCE_MESSAGES, apiAccessDecision, ApiAccessDecision, ApiLicenceException, companyQuotaKey, currentApiSeat, secondsToUtcMidnight, webhooksLeft } from './api-access';
import { LicencePolicyService } from './licence-policy.service';
import { LicenceSettingsService } from './licence-settings.service';

const CACHE_MS = 60_000;

interface Resolved extends ApiAccessDecision {
  seat: { id: string; expiresAt: Date; activatedAt: Date; apiPlan: string | null; source: string } | null;
  graceDays: number;
}

/**
 * Developer API licence (API_ACCESS seat, one per company): whether API keys work, the plan's limits (per-key rate
 * caps, company daily quota, vehicle and webhook counts) and usage. Decisions are cached for a minute per company and
 * dropped when a seat changes (purchase, grant, credit note).
 */
@Injectable()
export class ApiAccessService {
  private readonly cache = new Map<string, { value: Resolved; at: number }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: LicenceSettingsService,
    private readonly policy: LicencePolicyService,
    private readonly redis: RedisService,
  ) {}

  invalidate(companyId?: string): void {
    if (companyId) this.cache.delete(companyId);
    else this.cache.clear();
  }

  async resolve(companyId: string, now = Date.now()): Promise<Resolved> {
    const hit = this.cache.get(companyId);
    if (hit && now - hit.at < CACHE_MS) return hit.value;
    const [exempt, seats, s] = await Promise.all([
      this.policy.isExempt(companyId),
      this.prisma.licenceSeat.findMany({ where: { companyId, type: 'API_ACCESS' }, select: { id: true, expiresAt: true, activatedAt: true, apiPlan: true, source: true } }),
      this.settings.get(),
    ]);
    const seat = currentApiSeat(seats);
    const value: Resolved = { ...apiAccessDecision(seat, exempt, readApiPlans(s.apiPlans), now, s.graceDays), seat: exempt ? null : seat, graceDays: s.graceDays };
    this.cache.set(companyId, { value, at: now });
    return value;
  }

  /** Throws 402 LICENCE_EXPIRED / LICENCE_REQUIRED unless the company's API keys may be used. */
  async assertAllowed(companyId: string): Promise<Resolved> {
    const r = await this.resolve(companyId);
    if (!r.allowed && r.code) throw new ApiLicenceException(r.code, API_LICENCE_MESSAGES[r.code]);
    return r;
  }

  /**
   * Vehicles reachable through the API: the first N of the company by name (N = plan's maxVehicles), or null when the
   * plan is unlimited / the company is exempt.
   */
  async allowedVehicleIds(companyId: string): Promise<string[] | null> {
    const r = await this.resolve(companyId);
    const max = r.limits?.maxVehicles;
    if (max === null || max === undefined) return null;
    const rows = await this.prisma.trackedObject.findMany({ where: { companyId }, orderBy: [{ name: 'asc' }, { id: 'asc' }], take: max, select: { id: true } });
    return rows.map((o) => o.id);
  }

  /** 402 API_VEHICLE_LIMIT when a vehicle of the company is beyond the plan's vehicle limit. */
  async assertVehicleAllowed(companyId: string, vehicleId: string): Promise<void> {
    const ids = await this.allowedVehicleIds(companyId);
    if (!ids || ids.includes(vehicleId)) return;
    const own = await this.prisma.trackedObject.count({ where: { id: vehicleId, companyId } });
    if (own) throw new ApiLicenceException('API_VEHICLE_LIMIT', API_LICENCE_MESSAGES.API_VEHICLE_LIMIT);
  }

  /** Before creating a webhook endpoint: the licence must be valid and the plan must allow one more endpoint. */
  async assertWebhookCapacity(companyId: string): Promise<void> {
    const r = await this.assertAllowed(companyId);
    if (!r.limits) return;
    const existing = await this.prisma.webhookEndpoint.count({ where: { companyId } });
    if (webhooksLeft(existing, r.limits) <= 0) {
      throw new ApiLicenceException('API_WEBHOOK_LIMIT', `${API_LICENCE_MESSAGES.API_WEBHOOK_LIMIT} (limit ${r.limits.maxWebhooks})`);
    }
  }

  /** Counts one request against the company's daily quota (all keys); refused once over the plan's ratePerDay. */
  async hitCompanyQuota(companyId: string, perDay: number, now = Date.now()): Promise<{ allowed: boolean; count: number; remaining: number; retryAfterSec: number }> {
    const key = companyQuotaKey(companyId, now);
    const count = Number(await this.redis.client.incr(key));
    if (count === 1) await this.redis.client.expire(key, 172_800);
    const allowed = count <= perDay;
    return { allowed, count, remaining: Math.max(0, perDay - count), retryAfterSec: allowed ? 0 : secondsToUtcMidnight(now) };
  }

  async requestsToday(companyId: string, now = Date.now()): Promise<number> {
    return Number((await this.redis.client.get(companyQuotaKey(companyId, now))) ?? 0);
  }

  async status(companyId: string, now = Date.now()): Promise<ApiAccessStatusDto> {
    this.invalidate(companyId);
    const r = await this.resolve(companyId, now);
    const [requestsToday, vehicles, webhooks] = await Promise.all([
      this.requestsToday(companyId, now).catch(() => 0),
      this.prisma.trackedObject.count({ where: { companyId } }),
      this.prisma.webhookEndpoint.count({ where: { companyId } }),
    ]);
    return {
      exempt: r.exempt,
      seat: r.seat
        ? {
            id: r.seat.id,
            plan: (r.plan ?? 'BASIC') as ApiPlan,
            source: r.seat.source as SeatSource,
            activatedAt: r.seat.activatedAt.toISOString(),
            expiresAt: r.seat.expiresAt.toISOString(),
            status: seatStatus(r.seat.expiresAt, now, r.graceDays),
            locked: seatLocked(r.seat.expiresAt, now, r.graceDays),
          }
        : null,
      allowed: r.allowed,
      limits: r.limits,
      usage: { requestsToday, vehicles, webhooks },
      graceDays: r.graceDays,
    };
  }
}

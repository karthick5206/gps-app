import { ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LicenceSettingsService } from './licence-settings.service';
import { userLockReason } from './seat-logic';

const DAY_MS = 86_400_000;
const CACHE_MS = 60_000;

type Ctx = { companyId: string; isSuperAdmin: boolean };

/**
 * Licence locking. After a seat's grace period: a USER seat blocks that user's sign-in; a device seat hides the vehicle's
 * position, history and reports (the gateway / processor keep recording). Super Admins and platform companies are
 * never locked. Lookups are cached for a minute per company.
 */
@Injectable()
export class LicencePolicyService {
  private readonly platform = new Map<string, { value: boolean; at: number }>();
  private readonly locked = new Map<string, { ids: Set<string>; at: number }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: LicenceSettingsService,
  ) {}

  invalidate(companyId?: string): void {
    if (companyId) this.locked.delete(companyId);
    else this.locked.clear();
  }

  async isExempt(companyId: string): Promise<boolean> {
    const hit = this.platform.get(companyId);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
    const c = await this.prisma.company.findUnique({ where: { id: companyId }, select: { isPlatform: true } });
    const value = c?.isPlatform ?? false;
    this.platform.set(companyId, { value, at: Date.now() });
    return value;
  }

  /** Cut-off: a seat expiring after this instant still allows viewing (now − grace). */
  async cutoff(now = Date.now()): Promise<Date> {
    return new Date(now - (await this.settings.graceDays()) * DAY_MS);
  }

  /** Message why this user may not sign in / use the app, or null. */
  async userLock(userId: string, user: { isSuperAdmin: boolean; companyId: string }, now = Date.now()): Promise<string | null> {
    if (user.isSuperAdmin) return null;
    const platform = await this.isExempt(user.companyId);
    if (platform) return null;
    const seat = await this.prisma.licenceSeat.findUnique({ where: { userId }, select: { expiresAt: true } });
    return userLockReason({ isSuperAdmin: false, platform }, seat, now, await this.settings.graceDays());
  }

  /** Objects whose data may be viewed: no device now, or the current device's seat is within its grace period. */
  async viewableWhere(ctx: Ctx, now = Date.now()): Promise<Prisma.TrackedObjectWhereInput> {
    if (ctx.isSuperAdmin || (await this.isExempt(ctx.companyId))) return {};
    const cutoff = await this.cutoff(now);
    return {
      OR: [
        { assignments: { none: { toTime: null } } },
        // Free-trial seats lock at expiry (no grace period).
        { assignments: { some: { toTime: null, device: { licenceSeat: { is: { expiresAt: { gt: cutoff }, OR: [{ source: { not: 'TRIAL' } }, { expiresAt: { gt: new Date(now) } }] } } } } } },
      ],
    };
  }

  /** Ids of the company's vehicles locked by an expired licence (empty for Super Admins / platform companies). */
  async lockedObjectIds(ctx: Ctx): Promise<Set<string>> {
    if (ctx.isSuperAdmin || (await this.isExempt(ctx.companyId))) return new Set();
    const hit = this.locked.get(ctx.companyId);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.ids;
    const viewable = await this.viewableWhere(ctx);
    const rows = await this.prisma.trackedObject.findMany({ where: { companyId: ctx.companyId, NOT: viewable }, select: { id: true } });
    const ids = new Set(rows.map((r) => r.id));
    this.locked.set(ctx.companyId, { ids, at: Date.now() });
    return ids;
  }

  async assertViewable(ctx: Ctx, objectId: string): Promise<void> {
    if ((await this.lockedObjectIds(ctx)).has(objectId)) {
      throw new ForbiddenException({ statusCode: 403, code: 'LICENCE_EXPIRED', message: 'This vehicle’s licence has expired. Renew it to view its location, history and reports.' });
    }
  }

  /** Vehicles whose fuel-sensor seat expired past grace (fuel data hidden). */
  async fuelLockedObjectIds(ctx: Ctx): Promise<Set<string>> {
    if (ctx.isSuperAdmin || (await this.isExempt(ctx.companyId))) return new Set();
    const cutoff = await this.cutoff();
    const rows = await this.prisma.fuelConfig.findMany({
      where: { companyId: ctx.companyId, source: { not: 'none' }, NOT: { licenceSeat: { is: { expiresAt: { gt: cutoff } } } } },
      select: { objectId: true },
    });
    return new Set(rows.map((r) => r.objectId));
  }
}

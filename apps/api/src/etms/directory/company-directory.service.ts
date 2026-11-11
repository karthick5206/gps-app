import { BadRequestException, Injectable, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  TRANSPORT_COMPANY_LOOKUP_MIN_CHARS,
  TRANSPORT_COMPANY_LOOKUP_PER_COMPANY_PER_MINUTE,
  TRANSPORT_COMPANY_LOOKUP_PER_MINUTE,
  transportSettingsOf,
  type TransportCompanyLookupDto,
} from '@veetracer/shared';
import { AuthContext } from '../../access/auth-context';
import { AuditService } from '../../audit/audit.service';
import { companyFeatures } from '../../common/company-features';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { FixedWindowLimiter, rateLimited } from './lookup-rate-limit';

const MAX_RESULTS = 20;
export const LOOKUP_AUDIT_ENTITY = 'etms_company_lookup';

/**
 * Partner-company directory for drafting agreements (E1a gap 1, hardened by F4). Privacy-safe by construction:
 * - only ACTIVE BUSINESS companies, never the platform company or the caller's own, only those with the `etms` add-on on
 *   AND that opted in to the directory (`Company.settings.etms.directoryListed`, default off; filtered in the query and
 *   again in code). Unlisted companies are reached by pasting their company ID (create checks the add-on, F8);
 * - only id, name and billing city leave the service (`select` never reads contacts, users, vehicles);
 * - at least 3 characters, at most 20 results, 30 lookups per user and 60 per company per minute (Valkey, in-process
 *   fallback), so a company with many users cannot multiply its budget;
 * - every search, and every refused one, is audited in the caller's company (`ACCESS` / etms_company_lookup) with the
 *   query length and the result count only: never the query text or the companies found.
 */
@Injectable()
export class CompanyDirectoryService {
  readonly limiter: FixedWindowLimiter;
  readonly companyLimiter: FixedWindowLimiter;

  constructor(
    private readonly prisma: PrismaService,
    redis: RedisService,
    @Optional() private readonly audit?: AuditService,
  ) {
    this.limiter = new FixedWindowLimiter(redis?.client ?? null, 'vt:etms:lookup', TRANSPORT_COMPANY_LOOKUP_PER_MINUTE, 60_000);
    this.companyLimiter = new FixedWindowLimiter(redis?.client ?? null, 'vt:etms:lookup-co', TRANSPORT_COMPANY_LOOKUP_PER_COMPANY_PER_MINUTE, 60_000);
  }

  async lookup(ctx: AuthContext, rawQ: string | undefined): Promise<TransportCompanyLookupDto[]> {
    const q = (rawQ ?? '').trim().replace(/\s+/g, ' ');
    if (q.length < TRANSPORT_COMPANY_LOOKUP_MIN_CHARS) {
      throw new BadRequestException({ message: `Type at least ${TRANSPORT_COMPANY_LOOKUP_MIN_CHARS} characters`, code: 'VALIDATION_FAILED' });
    }
    const rate = await this.limiter.hit(ctx.userId);
    const companyRate = rate.allowed ? await this.companyLimiter.hit(ctx.companyId) : rate;
    if (!rate.allowed || !companyRate.allowed) {
      await this.record(ctx, { queryLength: q.length, resultCount: 0, rateLimited: !rate.allowed ? 'user' : 'company' });
      throw rateLimited((rate.allowed ? companyRate : rate).retryAfterSec);
    }
    const where: Prisma.CompanyWhereInput = {
      name: { contains: q, mode: 'insensitive' },
      status: 'ACTIVE',
      accountType: 'BUSINESS',
      isPlatform: false,
      id: { not: ctx.companyId },
      AND: [{ settings: { path: ['features'], array_contains: ['etms'] } }, { settings: { path: ['etms', 'directoryListed'], equals: true } }],
    };
    const rows = await this.prisma.company.findMany({
      where,
      orderBy: { name: 'asc' },
      take: MAX_RESULTS * 2,
      select: { id: true, name: true, settings: true, isPlatform: true, billingProfile: { select: { city: true } } },
    });
    const result = rows
      .filter((c) => c.id !== ctx.companyId && !c.isPlatform && companyFeatures(c).includes('etms') && transportSettingsOf(c.settings).directoryListed)
      .slice(0, MAX_RESULTS)
      .map((c) => ({ id: c.id, name: c.name, city: c.billingProfile?.city?.trim() || null }));
    await this.record(ctx, { queryLength: q.length, resultCount: result.length });
    return result;
  }

  /** Audit one search: sizes only (no query text, no company ids). An audit failure never fails the lookup. */
  private async record(ctx: AuthContext, details: { queryLength: number; resultCount: number; rateLimited?: 'user' | 'company' }): Promise<void> {
    if (!this.audit) return;
    await this.audit.record(ctx, { action: 'ACCESS', entity: LOOKUP_AUDIT_ENTITY, entityId: null, details }).catch(() => undefined);
  }
}

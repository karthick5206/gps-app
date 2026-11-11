import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TRANSPORT_COMPANY_LOOKUP_MIN_CHARS, TRANSPORT_COMPANY_LOOKUP_PER_MINUTE, type TransportCompanyLookupDto } from '@veetracer/shared';
import { AuthContext } from '../../access/auth-context';
import { companyFeatures } from '../../common/company-features';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { FixedWindowLimiter, rateLimited } from './lookup-rate-limit';

const MAX_RESULTS = 20;

/**
 * Partner-company directory for drafting agreements (E1a gap 1). Privacy-safe by construction:
 * - only ACTIVE BUSINESS companies, never the platform company or the caller's own, and only those with the `etms`
 *   add-on on (filtered in the query and again in code);
 * - only id, name and billing city leave the service (`select` never reads contacts, users, vehicles);
 * - at least 3 characters, at most 20 results, 30 lookups per user per minute (Valkey, in-process fallback).
 * Not written to the audit log: doc 05 §1 reserves `ACCESS` audit for sensitive personal reads (home address, phone,
 * live location, manifest); a company name is neither personal nor sensitive, and per-keystroke rows would bury the
 * real audit trail. Abuse (enumeration) is bounded by the minimum length, the result cap and the rate limit.
 */
@Injectable()
export class CompanyDirectoryService {
  readonly limiter: FixedWindowLimiter;

  constructor(
    private readonly prisma: PrismaService,
    redis: RedisService,
  ) {
    this.limiter = new FixedWindowLimiter(redis?.client ?? null, 'vt:etms:lookup', TRANSPORT_COMPANY_LOOKUP_PER_MINUTE, 60_000);
  }

  async lookup(ctx: AuthContext, rawQ: string | undefined): Promise<TransportCompanyLookupDto[]> {
    const q = (rawQ ?? '').trim().replace(/\s+/g, ' ');
    if (q.length < TRANSPORT_COMPANY_LOOKUP_MIN_CHARS) {
      throw new BadRequestException({ message: `Type at least ${TRANSPORT_COMPANY_LOOKUP_MIN_CHARS} characters`, code: 'VALIDATION_FAILED' });
    }
    const rate = await this.limiter.hit(ctx.userId);
    if (!rate.allowed) throw rateLimited(rate.retryAfterSec);

    const where: Prisma.CompanyWhereInput = {
      name: { contains: q, mode: 'insensitive' },
      status: 'ACTIVE',
      accountType: 'BUSINESS',
      isPlatform: false,
      id: { not: ctx.companyId },
      settings: { path: ['features'], array_contains: ['etms'] },
    };
    const rows = await this.prisma.company.findMany({
      where,
      orderBy: { name: 'asc' },
      take: MAX_RESULTS * 2,
      select: { id: true, name: true, settings: true, isPlatform: true, billingProfile: { select: { city: true } } },
    });
    return rows
      .filter((c) => c.id !== ctx.companyId && !c.isPlatform && companyFeatures(c).includes('etms'))
      .slice(0, MAX_RESULTS)
      .map((c) => ({ id: c.id, name: c.name, city: c.billingProfile?.city?.trim() || null }));
  }
}

import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { API_PLANS, ApiPlan, apiPlanPriceKey, LICENCE_EXPIRING_DAYS, LicenceType, SEAT_LICENCE_TYPES, SeatLicenceType, SeatSummaryDto } from '@veetracer/shared';
import { AuthContext } from '../access/auth-context';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { LicenceSettingsService } from './licence-settings.service';
import { PoolsService } from './pools.service';
import { summarise } from './seat-logic';

const DAY_MS = 86_400_000;

export interface PoolRow {
  kind: 'COMPANY' | 'PARTNER';
  id: string;
  name: string;
  partnerName: string | null;
  total: number;
  used: number;
  free: number;
  expiring: number;
  expired: number;
}

export interface PartnerRow {
  id: string;
  name: string;
  slug: string;
  homeCompanyId: string | null;
  homeCompanyName: string | null;
  customers: number;
  pricesPaise: Record<SeatLicenceType, number | null>;
  apiPlanPricesPaise: Record<ApiPlan, number | null>;
}

export interface CustomerRow {
  companyId: string;
  name: string;
  summary: SeatSummaryDto[];
  /** Assigned seats expiring within 30 days or already expired. */
  expiring: { seatId: string; type: LicenceType; subject: string; expiresAt: string }[];
}

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'partner';

/** Partners (resellers) and the Super Admin's view of every licence pool. */
@Injectable()
export class PartnersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: LicenceSettingsService,
    private readonly pools: PoolsService,
    private readonly audit: AuditService,
  ) {}

  async allPools(now = Date.now()): Promise<PoolRow[]> {
    const grace = await this.settings.graceDays();
    const [companies, partners, seats] = await Promise.all([
      this.prisma.company.findMany({ where: { isPlatform: false }, select: { id: true, name: true, partner: { select: { name: true } } }, orderBy: { name: 'asc' } }),
      this.prisma.partner.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } }),
      this.prisma.licenceSeat.findMany({ select: { id: true, type: true, companyId: true, partnerId: true, expiresAt: true, userId: true, deviceId: true, fuelObjectId: true } }),
    ]);
    const byKey = new Map<string, typeof seats>();
    for (const s of seats) {
      const key = s.companyId ?? `p:${s.partnerId}`;
      byKey.set(key, [...(byKey.get(key) ?? []), s]);
    }
    const row = (kind: 'COMPANY' | 'PARTNER', id: string, name: string, partnerName: string | null, list: typeof seats): PoolRow => {
      const sum = summarise(list.map((s) => ({ ...s, type: s.type as LicenceType })), now, grace);
      const total = (k: keyof SeatSummaryDto) => sum.reduce((a, s) => a + (s[k] as number), 0);
      return { kind, id, name, partnerName, total: total('total'), used: total('used'), free: total('free'), expiring: total('expiring'), expired: total('expired') };
    };
    return [
      ...partners.map((p) => row('PARTNER', p.id, p.name, null, byKey.get(`p:${p.id}`) ?? [])),
      ...companies.map((c) => row('COMPANY', c.id, c.name, c.partner.name, byKey.get(c.id) ?? [])),
    ];
  }

  async partners(): Promise<PartnerRow[]> {
    const rows = await this.prisma.partner.findMany({ include: { _count: { select: { companies: true } } }, orderBy: { name: 'asc' } });
    const homes = await this.prisma.company.findMany({ where: { id: { in: rows.map((r) => r.homeCompanyId).filter((x): x is string => !!x) } }, select: { id: true, name: true } });
    const homeName = new Map(homes.map((h) => [h.id, h.name]));
    return rows.map((p) => {
      const prices = (p.pricesPaise ?? {}) as Record<string, unknown>;
      return {
        id: p.id,
        name: p.name,
        slug: p.slug,
        homeCompanyId: p.homeCompanyId,
        homeCompanyName: p.homeCompanyId ? (homeName.get(p.homeCompanyId) ?? null) : null,
        customers: p._count.companies,
        pricesPaise: Object.fromEntries(SEAT_LICENCE_TYPES.map((t) => [t, typeof prices[t] === 'number' ? (prices[t] as number) : null])) as Record<SeatLicenceType, number | null>,
        apiPlanPricesPaise: Object.fromEntries(API_PLANS.map((pl) => [pl, typeof prices[apiPlanPriceKey(pl)] === 'number' ? (prices[apiPlanPriceKey(pl)] as number) : null])) as Record<ApiPlan, number | null>,
      };
    });
  }

  async create(ctx: AuthContext, dto: { name: string; homeCompanyId?: string | null }): Promise<PartnerRow[]> {
    let slug = slugify(dto.name);
    if (await this.prisma.partner.count({ where: { slug } })) slug = `${slug}-${Date.now().toString(36)}`;
    const p = await this.prisma.partner.create({ data: { name: dto.name.trim(), slug, homeCompanyId: dto.homeCompanyId ?? null } });
    await this.audit.record(ctx, { action: 'CREATE', entity: 'partner', entityId: p.id, after: p });
    return this.partners();
  }

  async update(ctx: AuthContext, id: string, dto: { name?: string; homeCompanyId?: string | null; pricesPaise?: Partial<Record<SeatLicenceType, number | null>>; apiPlanPricesPaise?: Partial<Record<ApiPlan, number | null>> }): Promise<PartnerRow[]> {
    const before = await this.prisma.partner.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('Partner not found');
    if (dto.homeCompanyId && (await this.prisma.partner.count({ where: { homeCompanyId: dto.homeCompanyId, id: { not: id } } }))) {
      throw new BadRequestException('That company is already the home account of another partner');
    }
    let prices: Record<string, number> | undefined;
    if (dto.pricesPaise || dto.apiPlanPricesPaise) {
      const old = (before.pricesPaise ?? {}) as Record<string, unknown>;
      prices = {};
      for (const t of SEAT_LICENCE_TYPES) {
        const v = dto.pricesPaise ? dto.pricesPaise[t] : old[t];
        if (typeof v === 'number' && Number.isFinite(v) && v >= 0) prices[t] = Math.round(v);
      }
      for (const pl of API_PLANS) {
        const v = dto.apiPlanPricesPaise ? dto.apiPlanPricesPaise[pl] : old[apiPlanPriceKey(pl)];
        if (typeof v === 'number' && Number.isFinite(v) && v >= 0) prices[apiPlanPriceKey(pl)] = Math.round(v);
      }
    }
    const after = await this.prisma.partner.update({
      where: { id },
      data: { name: dto.name?.trim(), homeCompanyId: dto.homeCompanyId === undefined ? undefined : dto.homeCompanyId, pricesPaise: prices },
    });
    await this.audit.record(ctx, { action: 'UPDATE', entity: 'partner', entityId: id, before, after });
    return this.partners();
  }

  async setCompanyPartner(ctx: AuthContext, companyId: string, partnerId: string): Promise<void> {
    const before = await this.prisma.company.findUnique({ where: { id: companyId }, select: { partnerId: true, isPlatform: true } });
    if (!before || before.isPlatform) throw new NotFoundException('Company not found');
    if (!(await this.prisma.partner.count({ where: { id: partnerId } }))) throw new NotFoundException('Partner not found');
    await this.prisma.company.update({ where: { id: companyId }, data: { partnerId } });
    await this.audit.record(ctx, { action: 'UPDATE', entity: 'company', entityId: companyId, before: { partnerId: before.partnerId }, after: { partnerId } });
  }

  /** A partner's customers with their seat summaries and what expires soon. */
  async customers(partnerId: string, now = Date.now()): Promise<CustomerRow[]> {
    const partner = await this.prisma.partner.findUnique({ where: { id: partnerId }, select: { homeCompanyId: true } });
    const companies = await this.prisma.company.findMany({
      where: { partnerId, isPlatform: false, ...(partner?.homeCompanyId ? { id: { not: partner.homeCompanyId } } : {}) },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
    const out: CustomerRow[] = [];
    for (const c of companies) {
      const { seats, summary } = await this.pools.seats({ companyId: c.id }, now);
      out.push({
        companyId: c.id,
        name: c.name,
        summary,
        expiring: seats
          .filter((s) => s.subject && Date.parse(s.expiresAt) <= now + LICENCE_EXPIRING_DAYS * DAY_MS)
          .map((s) => ({ seatId: s.id, type: s.type, subject: s.subject?.name ?? '', expiresAt: s.expiresAt })),
      });
    }
    return out;
  }
}


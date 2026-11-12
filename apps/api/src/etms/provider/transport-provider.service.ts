import { ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { TransportAccessActorKind, TransportAccessLogEntryDto, TransportCustomerContextDto, TransportCustomerOptionDto } from '@veetracer/shared';
import { AuthContext } from '../../access/auth-context';
import { actingCustomers, agreementScopeInForce } from '../../access/transport-scope';
import { CsvSpec, ListSpec, listResult, planList } from '../../common/list-query';
import { PrismaService } from '../../prisma/prisma.service';
import { LOOKUP_AUDIT_ENTITY } from '../directory/company-directory.service';
import { PROFILE_ENTITY } from '../people/people.service';
import { AccessLogQuery } from './transport-provider.dto';

const LIST: ListSpec = {
  search: (q) => ({ entityId: { contains: q } }),
  sort: { createdAt: 'createdAt' },
  defaultSort: 'createdAt',
  defaultOrder: 'desc',
  status: null,
};

const CSV: CsvSpec<TransportAccessLogEntryDto> = {
  name: 'transport-sensitive-access',
  columns: [
    { header: 'When', value: (e) => e.at },
    { header: 'Who', value: (e) => e.actorKind },
    { header: 'Name', value: (e) => e.actorName ?? '' },
    { header: 'Provider', value: (e) => e.actorCompanyName ?? '' },
    { header: 'What', value: (e) => e.what },
    { header: 'Passenger', value: (e) => e.subjectName ?? '' },
    { header: 'Rows', value: (e) => e.rows ?? '' },
    { header: 'Reason', value: (e) => e.reason ?? '' },
  ],
};

const NONE = '00000000-0000-0000-0000-000000000000';
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * E1b provider side: the customer-context picker (doc 07 §2.5) and the customer's sensitive-access log (doc 10 §2.2
 * item 8, §2.3 "Audit / sensitive-access log: corporate admin V COMPANY incl. provider and Super Admin access").
 */
@Injectable()
export class TransportProviderService {
  constructor(private readonly prisma: PrismaService) {}

  /** The customers the caller may act for (own company first), from the UNNARROWED agreements. */
  async context(ctx: AuthContext): Promise<TransportCustomerContextDto> {
    const full = { companyId: ctx.companyId, agreements: (ctx.agreementsAll ?? ctx.agreements ?? []).filter((a) => agreementScopeInForce(a)) };
    const acting = actingCustomers(full);
    const names = new Map(
      (await this.prisma.company.findMany({ where: { id: { in: acting.map((c) => c.customerCompanyId) } }, select: { id: true, name: true } })).map((c) => [c.id, c.name]),
    );
    const validTo = new Map(full.agreements.map((a) => [a.id, a.validTo]));
    const customers: TransportCustomerOptionDto[] = acting.map((c) => ({
      customerCompanyId: c.customerCompanyId,
      name: names.get(c.customerCompanyId) ?? '',
      mode: c.mode,
      agreementId: c.agreementId,
      grants: c.grants,
      allSites: !c.siteIds || c.siteIds.length === 0,
      siteCount: c.siteIds?.length ?? 0,
      dataProfile: c.dataProfile,
      validTo: c.agreementId && validTo.get(c.agreementId) ? new Date(validTo.get(c.agreementId) as number).toISOString() : null,
    }));
    const [self, ...rest] = customers;
    rest.sort((a, b) => a.name.localeCompare(b.name));
    const isProvider = !!ctx.features?.includes('etmsProvider');
    return { companyId: ctx.companyId, isProvider, showPicker: isProvider && rest.length > 0, selected: ctx.transportCustomerId ?? null, customers: [self, ...rest] };
  }

  /**
   * ACCESS audit entries in the caller's company about its transport data (passenger reads, personal points, driver
   * manifests), classified by who read: the company's own staff, a provider (a user of another company, under an
   * agreement), or VeeTrax support (a Super Admin). Whole-company scope only (403 SCOPE_REQUIRED).
   */
  async accessLog(ctx: AuthContext, query: AccessLogQuery) {
    if (ctx.dataScope !== 'COMPANY') throw new ForbiddenException({ message: 'Only users with whole-company access can see the sensitive-access log', code: 'SCOPE_REQUIRED' });
    const plan = planList<Prisma.AuditLogWhereInput, Prisma.AuditLogOrderByWithRelationInput>(query, LIST);
    const filters: Prisma.AuditLogWhereInput[] = [{ companyId: ctx.companyId, action: 'ACCESS', entity: { not: LOOKUP_AUDIT_ENTITY } }, plan.where];
    if (query.from) filters.push({ createdAt: { gte: dayStart(query.from) } });
    if (query.to) filters.push({ createdAt: { lte: dayEnd(query.to) } });
    if ((query.actor ?? 'external') === 'external') {
      // Own staff = users of this company that are not Super Admins; everything else (providers, support) is external.
      const own = await this.prisma.user.findMany({ where: { companyId: ctx.companyId, isSuperAdmin: false }, select: { id: true } });
      filters.push({ userId: { not: null } }, { userId: { notIn: own.length ? own.map((u) => u.id) : [NONE] } });
    }
    const where: Prisma.AuditLogWhereInput = { AND: filters };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.auditLog.findMany({ where, orderBy: plan.orderBy, skip: plan.skip, take: plan.take }),
      this.prisma.auditLog.count({ where }),
    ]);
    const userIds = [...new Set(rows.map((r) => r.userId).filter((v): v is string => !!v))];
    const users = userIds.length ? await this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, companyId: true, isSuperAdmin: true } }) : [];
    const byUser = new Map(users.map((u) => [u.id, u]));
    const details = rows.map((r) => (r.changes && typeof r.changes === 'object' && !Array.isArray(r.changes) ? (r.changes as Record<string, unknown>) : {}));
    const companyIds = [...new Set(rows.flatMap((r, i) => [str(details[i].actingCompanyId), byUser.get(r.userId ?? '')?.companyId ?? null]).filter((v): v is string => !!v && v !== ctx.companyId))];
    const companies = companyIds.length ? await this.prisma.company.findMany({ where: { id: { in: companyIds } }, select: { id: true, name: true } }) : [];
    const companyName = new Map(companies.map((c) => [c.id, c.name]));
    const passengerIds = [...new Set(rows.filter((r) => r.entity === PROFILE_ENTITY && r.entityId).map((r) => r.entityId as string))];
    const passengers = passengerIds.length
      ? await this.prisma.employeeTransportProfile.findMany({ where: { id: { in: passengerIds }, companyId: ctx.companyId }, select: { id: true, displayName: true } })
      : [];
    const passengerName = new Map(passengers.map((p) => [p.id, p.displayName]));
    const items: TransportAccessLogEntryDto[] = rows.map((r, i) => {
      const d = details[i];
      const u = r.userId ? byUser.get(r.userId) : undefined;
      const kind: TransportAccessActorKind = u?.isSuperAdmin || d.superAdmin === true ? 'SUPPORT' : u && u.companyId !== ctx.companyId ? 'PROVIDER' : 'OWN';
      const actingCompany = str(d.actingCompanyId) ?? (u && u.companyId !== ctx.companyId ? u.companyId : null);
      return {
        id: r.id,
        at: r.createdAt.toISOString(),
        actorKind: kind,
        actorName: kind === 'SUPPORT' ? 'VeeTrax support' : (u?.name ?? null),
        actorCompanyName: kind === 'PROVIDER' && actingCompany ? (companyName.get(actingCompany) ?? null) : null,
        what: str(d.what) ?? str(d.view) ?? r.entity,
        entity: r.entity,
        entityId: r.entityId,
        subjectName: r.entityId ? (passengerName.get(r.entityId) ?? null) : null,
        rows: num(d.rows) ?? num(d.passengers),
        reason: str(d.reason),
        agreementId: str(d.agreementId),
        homeLocation: d.homeLocation === true,
      };
    });
    return listResult(plan, items, total, CSV);
  }
}

/** YYYY-MM-DD → start of that UTC day; a full ISO instant is taken as is (the web sends local day bounds). */
function dayStart(v: string): Date {
  return new Date(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00.000Z` : v);
}
function dayEnd(v: string): Date {
  return new Date(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T23:59:59.999Z` : v);
}

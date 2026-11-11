import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  TRANSPORT_AGREEMENT_STATUSES,
  TRANSPORT_AGREEMENT_TERM_FIELDS,
  type TransportAgreementAwaitingDto,
  type TransportAgreementHistoryEntryDto,
  type TransportAgreementHistoryKind,
  type TransportAgreementSitesDto,
  type TransportAgreementStatus,
  type TransportAgreementSummaryDto,
  type TransportAgreementTermField,
  type TransportSiteOptionDto,
} from '@veetracer/shared';
import { hasPermission } from '../../access/access-rules';
import { AuthContext } from '../../access/auth-context';
import { agreementSiteScope, transportNotFound } from '../../access/transport-scope';
import { PrismaService } from '../../prisma/prisma.service';
import { poiScopeWhere } from '../../pois/pois.service';
import { AGREEMENT_ENTITY, agreementVisibilityWhere } from './agreements.service';

const AWAITING_LIST = 10;
const HISTORY_MAX = 500;
const SITE_OPTIONS_MAX = 200;
const STATUS_SET = new Set<string>(TRANSPORT_AGREEMENT_STATUSES);

type Changes = Record<string, { from?: unknown; to?: unknown } | undefined>;
const asStatus = (v: unknown): TransportAgreementStatus | null => (typeof v === 'string' && STATUS_SET.has(v) ? (v as TransportAgreementStatus) : null);

/**
 * Turns one agreement audit row (AuditService diff `{ field: { from, to } }`) into a history entry kind. Pure; exported
 * for tests. CREATE → CREATED; a status change names the command (PROPOSED → ACTIVE is the approval that activated it,
 * SUSPENDED → ACTIVE a resume); an approval without a status change (first side) is APPROVED; anything else is EDITED.
 */
export function classifyAgreementAudit(action: string, changes: unknown): Omit<TransportAgreementHistoryEntryDto, 'id' | 'at' | 'actorSide' | 'actorName'> | null {
  const c: Changes = changes && typeof changes === 'object' && !Array.isArray(changes) ? (changes as Changes) : {};
  const reasonOf = () => (typeof c.statusReason?.to === 'string' ? (c.statusReason.to as string) : null);
  if (action === 'CREATE') return { kind: 'CREATED', fromStatus: null, toStatus: asStatus(c.status?.to) ?? 'DRAFT', changedFields: [], reason: null };
  if (action !== 'UPDATE') return null;
  const from = asStatus(c.status?.from);
  const to = asStatus(c.status?.to);
  let kind: TransportAgreementHistoryKind;
  if (to) {
    kind = to === 'PROPOSED' ? 'PROPOSED' : to === 'SUSPENDED' ? 'SUSPENDED' : to === 'ENDED' ? 'ENDED' : to === 'ACTIVE' ? (from === 'SUSPENDED' ? 'RESUMED' : 'APPROVED') : 'EDITED';
  } else if (c.approvedByCustomerAt || c.approvedByProviderAt) {
    kind = 'APPROVED';
  } else {
    kind = 'EDITED';
  }
  const changedFields: TransportAgreementTermField[] = kind === 'EDITED' ? TRANSPORT_AGREEMENT_TERM_FIELDS.filter((f) => f in c) : [];
  return { kind, fromStatus: from, toStatus: to, changedFields, reason: kind === 'SUSPENDED' || kind === 'ENDED' ? reasonOf() : null };
}

/**
 * Read-only views on agreements (E1a gaps 2–4): customer sites, site picker, audit-log history and the dashboard
 * summary. Visibility always goes through agreementVisibilityWhere (parties; Super Admin on the platform = PLAT) and the
 * site names through agreementSiteScope; other companies' ids are 404.
 */
@Injectable()
export class AgreementViewsService {
  constructor(private readonly prisma: PrismaService) {}

  private async visible(ctx: AuthContext, id: string) {
    const row = await this.prisma.transportServiceAgreement.findFirst({
      where: { AND: [{ id }, agreementVisibilityWhere(ctx)] },
      select: { id: true, providerCompanyId: true, customerCompanyId: true, siteIds: true },
    });
    if (!row) throw transportNotFound('Agreement not found');
    return row;
  }

  /** Names of the customer sites the agreement names (id + name only); "all sites" lists nothing. */
  async sites(ctx: AuthContext, id: string): Promise<TransportAgreementSitesDto> {
    const row = await this.visible(ctx, id);
    const scope = agreementSiteScope(ctx, row);
    if (!scope) throw transportNotFound('Agreement not found');
    if (scope.allSites) return { agreementId: row.id, allSites: true, sites: [], unavailableCount: 0 };
    const pois = await this.prisma.poi.findMany({
      where: { companyId: scope.customerCompanyId, id: { in: scope.siteIds }, isActive: true },
      select: { id: true, name: true },
    });
    const byId = new Map(pois.map((p) => [p.id, p.name]));
    const sites = scope.siteIds.filter((s) => byId.has(s)).map((s) => ({ id: s, name: byId.get(s)! }));
    return { agreementId: row.id, allSites: false, sites, unavailableCount: scope.siteIds.length - sites.length };
  }

  /**
   * The acting company's own active places for the agreement site picker (no `pois` permission needed; ASSIGNED users
   * see their branches' places plus company-wide ones, like the Places screen). The Super Admin (platform reach) may name
   * the customer company; for everyone else the parameter is ignored and they always get their own company's places.
   */
  async siteOptions(ctx: AuthContext, q: string | undefined, customerCompanyId: string | undefined): Promise<TransportSiteOptionDto[]> {
    const platform = ctx.isSuperAdmin && ctx.companyId === ctx.homeCompanyId;
    if (platform && !customerCompanyId) return [];
    const scope: Prisma.PoiWhereInput = ctx.isSuperAdmin && customerCompanyId ? { companyId: customerCompanyId } : poiScopeWhere(ctx);
    const text = q?.trim();
    const rows = await this.prisma.poi.findMany({
      where: { AND: [scope, { isActive: true }, ...(text ? [{ name: { contains: text, mode: 'insensitive' as const } }] : [])] },
      orderBy: { name: 'asc' },
      take: SITE_OPTIONS_MAX,
      select: { id: true, name: true, branch: { select: { name: true } } },
    });
    return rows.map((p) => ({ id: p.id, name: p.name, branchName: p.branch?.name ?? null }));
  }

  /**
   * Full history from the audit log, oldest first. Minimum data: a person's name only when the audit row was written
   * for the viewer's company (or the viewer is the Super Admin on the platform); the other party and the platform appear
   * by side only. No IPs, user ids or raw diffs leave the service.
   */
  async history(ctx: AuthContext, id: string): Promise<TransportAgreementHistoryEntryDto[]> {
    const row = await this.visible(ctx, id);
    const logs = await this.prisma.auditLog.findMany({
      where: { entity: AGREEMENT_ENTITY, entityId: row.id, action: { in: ['CREATE', 'UPDATE'] } },
      orderBy: { createdAt: 'asc' },
      take: HISTORY_MAX,
      select: { id: true, companyId: true, userId: true, action: true, changes: true, createdAt: true },
    });
    const platformViewer = ctx.isSuperAdmin && ctx.companyId === ctx.homeCompanyId;
    const named = (companyId: string | null) => platformViewer || (!!companyId && companyId === ctx.companyId);
    const userIds = [...new Set(logs.filter((l) => l.userId && named(l.companyId)).map((l) => l.userId!))];
    const users = userIds.length ? await this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }) : [];
    const names = new Map(users.map((u) => [u.id, u.name]));
    const out: TransportAgreementHistoryEntryDto[] = [];
    for (const l of logs) {
      const entry = classifyAgreementAudit(l.action, l.changes);
      if (!entry) continue;
      const actorSide = l.companyId === row.customerCompanyId ? 'CUSTOMER' : l.companyId === row.providerCompanyId ? 'PROVIDER' : l.companyId ? 'PLATFORM' : null;
      const actorName = l.userId && named(l.companyId) ? (names.get(l.userId) ?? null) : null;
      out.push({ id: l.id, at: l.createdAt.toISOString(), actorSide, actorName, ...entry });
    }
    return out;
  }

  /** Counts per status over the visible agreements, plus the proposed ones awaiting the caller's side. */
  async summary(ctx: AuthContext): Promise<TransportAgreementSummaryDto> {
    const visible = agreementVisibilityWhere(ctx);
    const canApprove = hasPermission(ctx, 'etms_partners', 'edit');
    const awaitingWhere: Prisma.TransportServiceAgreementWhereInput = {
      AND: [
        visible,
        { status: 'PROPOSED' },
        { OR: [{ customerCompanyId: ctx.companyId, approvedByCustomerAt: null }, { providerCompanyId: ctx.companyId, approvedByProviderAt: null }] },
      ],
    };
    const counts = await this.prisma.$transaction(TRANSPORT_AGREEMENT_STATUSES.map((s) => this.prisma.transportServiceAgreement.count({ where: { AND: [visible, { status: s }] } })));
    const byStatus = Object.fromEntries(TRANSPORT_AGREEMENT_STATUSES.map((s, i) => [s, counts[i]])) as Record<TransportAgreementStatus, number>;
    let awaitingMyApproval = 0;
    let awaiting: TransportAgreementAwaitingDto[] = [];
    if (canApprove) {
      const [n, rows] = await this.prisma.$transaction([
        this.prisma.transportServiceAgreement.count({ where: awaitingWhere }),
        this.prisma.transportServiceAgreement.findMany({
          where: awaitingWhere,
          orderBy: { updatedAt: 'desc' },
          take: AWAITING_LIST,
          select: { id: true, providerCompanyId: true, updatedAt: true, provider: { select: { name: true } }, customer: { select: { name: true } } },
        }),
      ]);
      awaitingMyApproval = n;
      awaiting = rows.map((r) => ({ id: r.id, counterpartyName: r.providerCompanyId === ctx.companyId ? r.customer.name : r.provider.name, updatedAt: r.updatedAt.toISOString() }));
    }
    return { byStatus, total: counts.reduce((s, n) => s + n, 0), awaitingMyApproval, awaiting };
  }
}

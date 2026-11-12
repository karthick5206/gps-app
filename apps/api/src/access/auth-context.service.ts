import { ForbiddenException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { APP_ENV } from '../config/config.module';
import { AppEnv } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { resolvePermissions } from './access-rules';
import { ALL_COMPANIES, withoutUnavailableMenus } from '@veetracer/shared';
import { ADMIN_ROLE } from './access-rules';
import { companyFeatures } from '../common/company-features';
import { AccessTokenPayload, AuthContext, SharedVehicle, TransportAgreementScope } from './auth-context';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class AuthContextService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    @Inject(APP_ENV) private readonly env: AppEnv,
  ) {}

  verifyToken(token: string): AccessTokenPayload {
    try {
      return this.jwt.verify<AccessTokenPayload>(token, { secret: this.env.jwtSecret });
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }

  /**
   * Build the caller's context. `requestedCompanyId` (X-Company-Id / socket `companyId`) is honoured only for the
   * Super Admin; everyone else is locked to their own company.
   */
  async fromToken(token: string, requestedCompanyId: string | undefined, ip: string | null): Promise<AuthContext> {
    const payload = this.verifyToken(token);
    if (payload.sid) {
      const session = await this.prisma.session.findUnique({ where: { id: payload.sid }, select: { userId: true, revokedAt: true, expiresAt: true } });
      if (!session || session.userId !== payload.sub || session.revokedAt || session.expiresAt < new Date()) {
        throw new UnauthorizedException('Session ended');
      }
    }
    const ctx = await this.forUser(payload.sub, requestedCompanyId, ip);
    return { ...ctx, sessionId: payload.sid ?? null };
  }

  async forUser(userId: string, requestedCompanyId: string | undefined, ip: string | null): Promise<AuthContext> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        company: { select: { status: true, settings: true, isPlatform: true } },
        roles: { include: { role: { include: { permissions: true } } } },
        branches: { select: { branchId: true } },
        objects: { select: { objectId: true } },
      },
    });
    if (!user) throw new UnauthorizedException('Invalid or expired token');
    if (!user.isActive) throw new ForbiddenException('Account inactive');
    if (!user.isSuperAdmin && user.company.status !== 'ACTIVE') throw new ForbiddenException('Company suspended');

    let companyId = user.companyId;
    let acting: { settings: unknown; isPlatform: boolean } = user.company;
    const allCompanies = user.isSuperAdmin && requestedCompanyId === ALL_COMPANIES;
    if (user.isSuperAdmin && requestedCompanyId && !allCompanies && requestedCompanyId !== companyId) {
      if (!UUID_RE.test(requestedCompanyId)) throw new ForbiddenException('Unknown company');
      const selected = await this.prisma.company.findUnique({ where: { id: requestedCompanyId }, select: { settings: true, isPlatform: true } });
      if (!selected) throw new ForbiddenException('Unknown company');
      companyId = requestedCompanyId;
      acting = selected;
    }

    const features = companyFeatures(acting);
    const resolved = resolvePermissions(
      user.roles.map((ur) => ur.role),
      user.isSuperAdmin,
    );
    const dataScope = resolved.dataScope;
    // R-12 ceiling exemption: the built-in Admin role of the user's own company (only the Super Admin switches company).
    const isCompanyAdmin = user.isSuperAdmin || user.roles.some((ur) => ur.role.isSystem && ur.role.name === ADMIN_ROLE && ur.role.companyId === user.companyId);
    // Module menus (e.g. ETMS) are hidden and refused while the acting company's add-on is off (MenuDef.requires).
    const permissions = withoutUnavailableMenus(resolved.permissions, features);
    return {
      userId: user.id,
      homeCompanyId: user.companyId,
      companyId,
      ...(allCompanies ? { allCompanies: true } : {}),
      isSuperAdmin: user.isSuperAdmin,
      isCompanyAdmin,
      permissions,
      dataScope,
      branchIds: user.branches.map((b) => b.branchId),
      objectIds: user.objects.map((o) => o.objectId),
      shares: dataScope === 'COMPANY' && !allCompanies ? await this.sharesOf(companyId) : [],
      features,
      // E1b: only a transport provider (add-ons etms + etmsProvider) acts for customers; switching etmsProvider off
      // removes its grants on the next request, like switching etms off.
      agreements: features.includes('etms') && features.includes('etmsProvider') && !allCompanies ? await this.agreementsOf(companyId) : [],
      ip,
    };
  }

  /**
   * ETMS (D1): ACTIVE agreements in force now where this company is the provider and the customer is active AND has the
   * `etms` add-on on (F3: switching the customer's module off, e.g. the doc 15 §9.4 rollback, removes the provider's
   * grants at once; switching it back on restores them, and the customer can then see and suspend the agreement). The
   * provider's own add-on is checked by the caller. Read per request (like shares), so suspending or ending an agreement
   * takes effect on the next request; sockets pick it up on their refresh (forUser again).
   */
  private agreementsOf(companyId: string): Promise<TransportAgreementScope[]> {
    return providerAgreementScopes(this.prisma, companyId);
  }


  /** Vehicles of other companies shared with this one right now. */
  private async sharesOf(companyId: string): Promise<SharedVehicle[]> {
    const now = new Date();
    const rows = await this.prisma.vehicleShare.findMany({
      where: { sharedWithId: companyId, startAt: { lte: now }, OR: [{ endAt: null }, { endAt: { gt: now } }], object: { isActive: true, companyId: { not: companyId } } },
      select: { objectId: true, startAt: true, alertsOn: true, object: { select: { companyId: true } } },
    });
    return rows.map((r) => ({ objectId: r.objectId, ownerCompanyId: r.object.companyId, startAt: r.startAt.getTime(), alertsOn: r.alertsOn }));
  }
}

/**
 * The agreements a provider company acts under (AuthContextService.agreementsOf). Shared with the SAFETY outbox relay
 * (security review L4) so SOS push recipients follow exactly the rule of the incidents lane. The caller checks the
 * provider's own add-ons (etms + etmsProvider).
 */
export async function providerAgreementScopes(prisma: Pick<PrismaService, 'transportServiceAgreement'>, companyId: string): Promise<TransportAgreementScope[]> {
  const now = new Date();
  const rows = await prisma.transportServiceAgreement.findMany({
    where: {
      providerCompanyId: companyId,
      customerCompanyId: { not: companyId },
      status: 'ACTIVE',
      validFrom: { lte: now },
      OR: [{ validTo: null }, { validTo: { gt: now } }],
      customer: { status: 'ACTIVE', isPlatform: false, settings: { path: ['features'], array_contains: ['etms'] } },
    },
    select: {
      id: true,
      customerCompanyId: true,
      grants: true,
      siteIds: true,
      dataProfile: true,
      validFrom: true,
      validTo: true,
      customer: { select: { status: true, settings: true, isPlatform: true } },
    },
  });
  // Same rule again in code (the JSON filter is easy to get wrong; companyFeatures is the single reading of add-ons).
  return rows.filter((r) => r.customer.status === 'ACTIVE' && !r.customer.isPlatform && companyFeatures(r.customer).includes('etms')).map((r) => ({
    id: r.id,
    customerCompanyId: r.customerCompanyId,
    grants: [...r.grants],
    siteIds: [...r.siteIds],
    dataProfile: r.dataProfile,
    validFrom: r.validFrom.getTime(),
    validTo: r.validTo?.getTime() ?? null,
  }));
}

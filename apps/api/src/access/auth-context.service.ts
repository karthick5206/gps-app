import { ForbiddenException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { APP_ENV } from '../config/config.module';
import { AppEnv } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { resolvePermissions } from './access-rules';
import { ALL_COMPANIES, withoutUnavailableMenus } from '@veetracer/shared';
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
    // Module menus (e.g. ETMS) are hidden and refused while the acting company's add-on is off (MenuDef.requires).
    const permissions = withoutUnavailableMenus(resolved.permissions, features);
    return {
      userId: user.id,
      homeCompanyId: user.companyId,
      companyId,
      ...(allCompanies ? { allCompanies: true } : {}),
      isSuperAdmin: user.isSuperAdmin,
      permissions,
      dataScope,
      branchIds: user.branches.map((b) => b.branchId),
      objectIds: user.objects.map((o) => o.objectId),
      shares: dataScope === 'COMPANY' && !allCompanies ? await this.sharesOf(companyId) : [],
      features,
      agreements: features.includes('etms') && !allCompanies ? await this.agreementsOf(companyId) : [],
      ip,
    };
  }

  /**
   * ETMS (D1): ACTIVE agreements in force now where this company is the provider and the customer is active. Read per
   * request (like shares), so suspending or ending an agreement takes effect on the next request; sockets pick it up on
   * their refresh (forUser again).
   */
  private async agreementsOf(companyId: string): Promise<TransportAgreementScope[]> {
    const now = new Date();
    const rows = await this.prisma.transportServiceAgreement.findMany({
      where: {
        providerCompanyId: companyId,
        customerCompanyId: { not: companyId },
        status: 'ACTIVE',
        validFrom: { lte: now },
        OR: [{ validTo: null }, { validTo: { gt: now } }],
        customer: { status: 'ACTIVE' },
      },
      select: { id: true, customerCompanyId: true, grants: true, siteIds: true, dataProfile: true, validFrom: true, validTo: true },
    });
    return rows.map((r) => ({
      id: r.id,
      customerCompanyId: r.customerCompanyId,
      grants: [...r.grants],
      siteIds: [...r.siteIds],
      dataProfile: r.dataProfile,
      validFrom: r.validFrom.getTime(),
      validTo: r.validTo?.getTime() ?? null,
    }));
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

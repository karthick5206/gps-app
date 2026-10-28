import { ForbiddenException, Inject, Injectable, Optional, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { APP_ENV } from '../config/config.module';
import { AppEnv } from '../config/env';
import { LicencePolicyService } from '../licences/licence-policy.service';
import { PrismaService } from '../prisma/prisma.service';
import { resolvePermissions } from './access-rules';
import { ALL_COMPANIES } from '@veetracer/shared';
import { AccessTokenPayload, AuthContext } from './auth-context';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class AuthContextService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    @Inject(APP_ENV) private readonly env: AppEnv,
    @Optional() private readonly licences?: LicencePolicyService,
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

  /** Users whose licence seat expired past the grace period cannot sign in or use the app (Super Admin never). */
  async assertLicence(user: { id: string; isSuperAdmin: boolean; companyId: string }): Promise<void> {
    const lock = await this.licences?.userLock(user.id, user);
    if (lock) throw new ForbiddenException({ statusCode: 403, code: 'USER_LICENCE_EXPIRED', message: lock });
  }

  async forUser(userId: string, requestedCompanyId: string | undefined, ip: string | null): Promise<AuthContext> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        company: { select: { status: true } },
        roles: { include: { role: { include: { permissions: true } } } },
        branches: { select: { branchId: true } },
        objects: { select: { objectId: true } },
      },
    });
    if (!user) throw new UnauthorizedException('Invalid or expired token');
    if (!user.isActive) throw new ForbiddenException('Account inactive');
    if (!user.isSuperAdmin && user.company.status !== 'ACTIVE') throw new ForbiddenException('Company suspended');
    await this.assertLicence(user);

    let companyId = user.companyId;
    const allCompanies = user.isSuperAdmin && requestedCompanyId === ALL_COMPANIES;
    if (user.isSuperAdmin && requestedCompanyId && !allCompanies && requestedCompanyId !== companyId) {
      if (!UUID_RE.test(requestedCompanyId)) throw new ForbiddenException('Unknown company');
      const exists = await this.prisma.company.count({ where: { id: requestedCompanyId } });
      if (!exists) throw new ForbiddenException('Unknown company');
      companyId = requestedCompanyId;
    }

    const { permissions, dataScope } = resolvePermissions(
      user.roles.map((ur) => ur.role),
      user.isSuperAdmin,
    );
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
      ip,
    };
  }
}

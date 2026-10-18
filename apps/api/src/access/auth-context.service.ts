import { ForbiddenException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { APP_ENV } from '../config/config.module';
import { AppEnv } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { resolvePermissions } from './access-rules';
import { AccessTokenPayload, AuthContext } from './auth-context';

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
    return this.forUser(this.verifyToken(token).sub, requestedCompanyId, ip);
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

    let companyId = user.companyId;
    if (user.isSuperAdmin && requestedCompanyId && requestedCompanyId !== companyId) {
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
      isSuperAdmin: user.isSuperAdmin,
      permissions,
      dataScope,
      branchIds: user.branches.map((b) => b.branchId),
      objectIds: user.objects.map((o) => o.objectId),
      ip,
    };
  }
}

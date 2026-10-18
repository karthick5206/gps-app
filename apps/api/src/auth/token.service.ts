import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AuthTokens } from '@veetracer/shared';
import { AccessTokenPayload } from '../access/auth-context';
import { APP_ENV } from '../config/config.module';
import { AppEnv } from '../config/env';
import { randomToken, sha256 } from '../common/secrets';
import { PrismaService } from '../prisma/prisma.service';

const ACCESS_TTL_SEC = 15 * 60;
const REFRESH_TTL_MS = 30 * 24 * 3600 * 1000;

export interface ClientInfo {
  ip: string | null;
  userAgent: string | null;
}

/** Access JWTs plus rotating, hashed-at-rest refresh tokens (one Session row per login). */
@Injectable()
export class TokenService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    @Inject(APP_ENV) private readonly env: AppEnv,
  ) {}

  private accessToken(user: { id: string; companyId: string; isSuperAdmin: boolean }): string {
    const payload: AccessTokenPayload = { sub: user.id, cid: user.companyId, sa: user.isSuperAdmin };
    return this.jwt.sign(payload, { secret: this.env.jwtSecret, expiresIn: ACCESS_TTL_SEC });
  }

  async issue(user: { id: string; companyId: string; isSuperAdmin: boolean }, client: ClientInfo): Promise<AuthTokens> {
    const refreshToken = randomToken(48);
    await this.prisma.session.create({
      data: {
        userId: user.id,
        refreshTokenHash: sha256(refreshToken),
        ip: client.ip,
        userAgent: client.userAgent?.slice(0, 300) ?? null,
        expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
      },
    });
    return { accessToken: this.accessToken(user), refreshToken, expiresIn: ACCESS_TTL_SEC };
  }

  /** Exchange a refresh token for a new pair; the old refresh token stops working. */
  async rotate(refreshToken: string): Promise<AuthTokens> {
    const session = await this.prisma.session.findUnique({
      where: { refreshTokenHash: sha256(refreshToken) },
      include: { user: { include: { company: { select: { status: true } } } } },
    });
    const user = session?.user;
    if (!session || session.revokedAt || session.expiresAt < new Date() || !user?.isActive) {
      throw new UnauthorizedException('Invalid refresh token');
    }
    if (!user.isSuperAdmin && user.company.status !== 'ACTIVE') throw new UnauthorizedException('Company suspended');
    const next = randomToken(48);
    const { count } = await this.prisma.session.updateMany({
      where: { id: session.id, refreshTokenHash: session.refreshTokenHash },
      data: { refreshTokenHash: sha256(next), expiresAt: new Date(Date.now() + REFRESH_TTL_MS) },
    });
    if (count !== 1) throw new UnauthorizedException('Invalid refresh token');
    return { accessToken: this.accessToken(user), refreshToken: next, expiresIn: ACCESS_TTL_SEC };
  }

  /** Revoke the session; returns its user id when one was found. */
  async revoke(refreshToken: string): Promise<string | null> {
    const session = await this.prisma.session.findUnique({ where: { refreshTokenHash: sha256(refreshToken) } });
    if (!session || session.revokedAt) return null;
    await this.prisma.session.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
    return session.userId;
  }

  async revokeAll(userId: string): Promise<void> {
    await this.prisma.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
  }
}

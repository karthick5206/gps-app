import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Me, ThemePreference } from '@veetracer/shared';
import { AuthContext } from '../access/auth-context';
import { asRecord } from '../common/dto';
import { hashPassword, verifyPassword } from '../common/secrets';
import { toCompanySummary } from '../common/company-summary';
import { PrismaService } from '../prisma/prisma.service';

const THEMES: ThemePreference[] = ['light', 'dark', 'system'];

@Injectable()
export class MeService {
  constructor(private readonly prisma: PrismaService) {}

  async build(ctx: AuthContext): Promise<Me> {
    const [user, company] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({ where: { id: ctx.userId } }),
      this.prisma.company.findUniqueOrThrow({ where: { id: ctx.companyId } }),
    ]);
    const theme = asRecord(user.preferences).theme;
    return {
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        mobile: user.mobile,
        isSuperAdmin: user.isSuperAdmin,
        preferences: { theme: THEMES.includes(theme as ThemePreference) ? (theme as ThemePreference) : 'system' },
      },
      company: toCompanySummary(company),
      permissions: ctx.permissions,
      dataScope: ctx.dataScope,
    };
  }

  async setTheme(ctx: AuthContext, theme: ThemePreference): Promise<Me> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: ctx.userId }, select: { preferences: true } });
    await this.prisma.user.update({
      where: { id: ctx.userId },
      data: { preferences: { ...asRecord(user.preferences), theme } },
    });
    return this.build(ctx);
  }

  /** One row per app install: re-registering moves the token to the current user and session. */
  async registerPushToken(ctx: AuthContext, dto: { token: string; platform: string; deviceName?: string }): Promise<void> {
    const data = { userId: ctx.userId, sessionId: ctx.sessionId ?? null, platform: dto.platform, deviceName: dto.deviceName ?? null };
    await this.prisma.pushToken.upsert({ where: { token: dto.token }, create: { token: dto.token, ...data }, update: data });
  }

  async removePushToken(token: string): Promise<void> {
    await this.prisma.pushToken.deleteMany({ where: { token } });
  }

  async updateProfile(ctx: AuthContext, dto: { name?: string; email?: string | null; mobile?: string | null }): Promise<Me> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: ctx.userId }, select: { email: true, mobile: true } });
    const email = dto.email === undefined ? user.email : dto.email?.trim().toLowerCase() || null;
    const mobile = dto.mobile === undefined ? user.mobile : dto.mobile?.trim() || null;
    if (!email && !mobile) throw new BadRequestException('Keep an email or a mobile number to sign in with');
    await this.prisma.user.update({
      where: { id: ctx.userId },
      data: { name: dto.name?.trim(), ...(dto.email !== undefined ? { email } : {}), ...(dto.mobile !== undefined ? { mobile } : {}) },
    });
    return this.build(ctx);
  }

  async changePassword(ctx: AuthContext, currentPassword: string | undefined, newPassword: string): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: ctx.userId }, select: { passwordHash: true } });
    if (user.passwordHash && !(currentPassword && (await verifyPassword(currentPassword, user.passwordHash)))) {
      throw new UnauthorizedException('Current password is incorrect');
    }
    await this.prisma.user.update({ where: { id: ctx.userId }, data: { passwordHash: await hashPassword(newPassword) } });
  }
}

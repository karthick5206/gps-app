import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DISPLAY_SIZES, DisplaySize, LANGUAGE_CODES, LanguageCode, Me, normalizeTheme, ThemePreference } from '@veetracer/shared';
import { AuthContext } from '../access/auth-context';
import { asRecord } from '../common/dto';
import { hashPassword, verifyPassword } from '../common/secrets';
import { toCompanySummary } from '../common/company-summary';
import { createPushProvider, PushProvider } from '../notifier/push';
import { PrismaService } from '../prisma/prisma.service';


@Injectable()
export class MeService {
  private readonly push: PushProvider = createPushProvider();

  constructor(private readonly prisma: PrismaService) {}

  async build(ctx: AuthContext): Promise<Me> {
    const [user, company] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({ where: { id: ctx.userId } }),
      this.prisma.company.findUniqueOrThrow({ where: { id: ctx.companyId } }),
    ]);
    const { theme, language, textSize, mapIconSize } = asRecord(user.preferences);
    const size = (v: unknown): DisplaySize => (DISPLAY_SIZES.includes(v as DisplaySize) ? (v as DisplaySize) : 'normal');
    return {
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        mobile: user.mobile,
        isSuperAdmin: user.isSuperAdmin,
        preferences: {
          theme: normalizeTheme(theme),
          language: LANGUAGE_CODES.includes(language as LanguageCode) ? (language as LanguageCode) : null,
          textSize: size(textSize),
          mapIconSize: size(mapIconSize),
        },
      },
      company: toCompanySummary(company),
      permissions: ctx.permissions,
      dataScope: ctx.dataScope,
    };
  }

  async setPreferences(ctx: AuthContext, prefs: { theme?: ThemePreference; language?: LanguageCode; textSize?: DisplaySize; mapIconSize?: DisplaySize }): Promise<Me> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: ctx.userId }, select: { preferences: true } });
    await this.prisma.user.update({
      where: { id: ctx.userId },
      // Only the fields sent change; unknown keys in the stored JSON are kept.
      data: { preferences: { ...asRecord(user.preferences), ...Object.fromEntries(Object.entries(prefs).filter(([, v]) => v !== undefined)) } as Prisma.InputJsonObject },
    });
    return this.build(ctx);
  }

  /** One row per app install: re-registering moves the token to the current user and session. */
  async registerPushToken(ctx: AuthContext, dto: { token: string; platform: string; deviceName?: string }): Promise<void> {
    const data = { userId: ctx.userId, sessionId: ctx.sessionId ?? null, platform: dto.platform, deviceName: dto.deviceName ?? null };
    await this.prisma.pushToken.upsert({ where: { token: dto.token }, create: { token: dto.token, ...data }, update: data });
  }

  /** Sends a test notification to one of the caller's own app installs (Settings → "Send test notification"). */
  async testPush(ctx: AuthContext, token: string): Promise<{ sent: boolean; error: string | null }> {
    const row = await this.prisma.pushToken.findUnique({ where: { token }, select: { userId: true } });
    if (!row || row.userId !== ctx.userId) throw new BadRequestException('This phone is not registered for notifications yet');
    if (!this.push.enabled) return { sent: false, error: 'Push is turned off on the server (PUSH_PROVIDER=none)' };
    try {
      const res = await this.push.send([token], { title: 'Test notification', body: 'Alerts will arrive on this phone like this.', data: { test: true } });
      if (res.invalidTokens.length) await this.prisma.pushToken.deleteMany({ where: { token: { in: res.invalidTokens } } });
      return res.sent ? { sent: true, error: null } : { sent: false, error: res.error ?? 'The push service did not accept the notification' };
    } catch (error) {
      return { sent: false, error: (error as Error).message };
    }
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

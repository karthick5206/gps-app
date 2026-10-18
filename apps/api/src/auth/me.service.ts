import { Injectable } from '@nestjs/common';
import { Me, ThemePreference } from '@veetracer/shared';
import { AuthContext } from '../access/auth-context';
import { asRecord } from '../common/dto';
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
}

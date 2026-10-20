import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { AlertPack, AlertSnooze, Prisma } from '@prisma/client';
import { ALERT_TYPE_MAP, AlertLevel, AlertPackDto, AlertSnoozeDto, AlertTypeCode } from '@veetracer/shared';
import { AuthContext } from '../../access/auth-context';
import { AuditService } from '../../audit/audit.service';
import { iso } from '../../common/dto';
import { PrismaService } from '../../prisma/prisma.service';
import { AlertTargetsService, targetKey } from '../alert-targets.service';
import { toOverride, validateOverride } from '../logic/settings-resolution';
import { ApplyPackDto, CreatePackDto, CreateSnoozeDto, UpdatePackDto } from './snoozes-packs.dto';

const MAX_SNOOZE_MS = 90 * 24 * 3600_000;

type PackSetting = AlertPackDto['settings'][number];

const isPlatformContext = (ctx: AuthContext) => ctx.isSuperAdmin && ctx.companyId === ctx.homeCompanyId;

/** Normalise and validate pack settings (validated as company level; level rules are re-checked on apply). */
export function cleanPackSettings(input: Record<string, unknown>[]): PackSetting[] {
  const seen = new Set<string>();
  return input.map((raw) => {
    const alertType = raw.alertType as AlertTypeCode;
    if (!ALERT_TYPE_MAP[alertType]) throw new BadRequestException(`Unknown alert type "${String(raw.alertType)}"`);
    if (seen.has(alertType)) throw new BadRequestException(`${alertType} listed twice`);
    seen.add(alertType);
    const o = toOverride({
      enabled: typeof raw.enabled === 'boolean' ? raw.enabled : null,
      params: raw.params ?? {},
      schedule: raw.schedule ?? null,
      cooldownMin: typeof raw.cooldownMin === 'number' ? raw.cooldownMin : null,
      severity: typeof raw.severity === 'string' ? raw.severity : null,
      channels: raw.channels ?? null,
      requireAck: typeof raw.requireAck === 'boolean' ? raw.requireAck : null,
    });
    const err = validateOverride(alertType, 'COMPANY', { ...o, schedule: raw.schedule ?? null, channels: raw.channels ?? null });
    if (err) throw new BadRequestException(err);
    return { alertType, ...o, requireAck: o.requireAck ?? null };
  });
}

@Injectable()
export class SnoozesPacksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly targets: AlertTargetsService,
  ) {}

  // ───────────── snoozes ─────────────
  async listSnoozes(ctx: AuthContext, level?: AlertLevel, targetId?: string, includeExpired = false): Promise<AlertSnoozeDto[]> {
    if (level && targetId) await this.targets.assertTarget(ctx, level, targetId, false);
    const rows = await this.prisma.alertSnooze.findMany({
      where: {
        companyId: ctx.companyId,
        ...(level ? { level } : {}),
        ...(targetId ? { targetId } : {}),
        until: { gt: includeExpired ? new Date(Date.now() - 30 * 24 * 3600_000) : new Date() },
      },
      orderBy: { until: 'desc' },
      take: 500,
    });
    return this.snoozeDtos(ctx.companyId, rows);
  }

  async createSnooze(ctx: AuthContext, dto: CreateSnoozeDto): Promise<AlertSnoozeDto> {
    await this.targets.assertTarget(ctx, dto.level, dto.targetId, true);
    const until = new Date(dto.until);
    if (until.getTime() <= Date.now()) throw new BadRequestException('Snooze end must be in the future');
    if (until.getTime() - Date.now() > MAX_SNOOZE_MS) throw new BadRequestException('Snoozes can last at most 90 days');
    const mandatory = dto.alertTypes.filter((t) => ALERT_TYPE_MAP[t].mandatory);
    if (mandatory.length) throw new BadRequestException(`${mandatory.join(', ')} cannot be snoozed`);
    const row = await this.prisma.alertSnooze.create({
      data: {
        companyId: ctx.companyId,
        level: dto.level,
        targetId: dto.targetId,
        alertTypes: [...new Set(dto.alertTypes)],
        until,
        reason: dto.reason?.trim() || null,
        createdById: ctx.userId,
      },
    });
    await this.audit.record(ctx, {
      action: 'CREATE',
      entity: 'alert_snooze',
      entityId: row.targetId,
      details: { level: row.level, snoozeId: row.id, alertTypes: row.alertTypes, until: row.until.toISOString(), reason: row.reason },
    });
    await this.targets.invalidate(ctx.companyId, 'alert_snooze');
    return (await this.snoozeDtos(ctx.companyId, [row]))[0];
  }

  async removeSnooze(ctx: AuthContext, id: string): Promise<void> {
    const row = await this.prisma.alertSnooze.findFirst({ where: { id, companyId: ctx.companyId } });
    if (!row) throw new NotFoundException('Snooze not found');
    await this.targets.assertTarget(ctx, row.level, row.targetId, true);
    await this.prisma.alertSnooze.delete({ where: { id } });
    await this.audit.record(ctx, {
      action: 'DELETE',
      entity: 'alert_snooze',
      entityId: row.targetId,
      details: { level: row.level, snoozeId: row.id, alertTypes: row.alertTypes, until: row.until.toISOString() },
    });
    await this.targets.invalidate(ctx.companyId, 'alert_snooze');
  }

  private async snoozeDtos(companyId: string, rows: AlertSnooze[]): Promise<AlertSnoozeDto[]> {
    const names = await this.targets.names(companyId, rows);
    const userIds = [...new Set(rows.map((r) => r.createdById).filter((x): x is string => !!x))];
    const users = userIds.length ? await this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }) : [];
    const userNames = new Map(users.map((u) => [u.id, u.name]));
    return rows.map((r) => ({
      id: r.id,
      level: r.level,
      targetId: r.targetId,
      targetName: names.get(targetKey(r.level, r.targetId)) ?? '',
      alertTypes: r.alertTypes as AlertTypeCode[],
      until: iso(r.until),
      reason: r.reason,
      createdByName: r.createdById ? (userNames.get(r.createdById) ?? null) : null,
      createdAt: iso(r.createdAt),
    }));
  }

  // ───────────── packs ─────────────
  private packDto(p: AlertPack): AlertPackDto {
    return {
      id: p.id,
      name: p.name,
      description: p.description,
      isSystem: p.companyId === null,
      isActive: p.isActive,
      settings: Array.isArray(p.settings) ? (p.settings as unknown as PackSetting[]) : [],
    };
  }

  async listPacks(ctx: AuthContext): Promise<AlertPackDto[]> {
    const rows = await this.prisma.alertPack.findMany({
      where: { OR: [{ companyId: null }, { companyId: ctx.companyId }] },
      orderBy: [{ companyId: { sort: 'asc', nulls: 'first' } }, { name: 'asc' }],
    });
    return rows.map((p) => this.packDto(p));
  }

  async createPack(ctx: AuthContext, dto: CreatePackDto): Promise<AlertPackDto> {
    const settings = cleanPackSettings(dto.settings);
    const companyId = isPlatformContext(ctx) ? null : ctx.companyId;
    const exists = await this.prisma.alertPack.findFirst({ where: { companyId, name: dto.name.trim() } });
    if (exists) throw new BadRequestException('A pack with this name already exists');
    const row = await this.prisma.alertPack.create({
      data: {
        companyId,
        name: dto.name.trim(),
        description: dto.description ?? null,
        settings: settings as unknown as Prisma.InputJsonValue,
        isActive: dto.isActive ?? true,
      },
    });
    await this.audit.record(ctx, { action: 'CREATE', entity: 'alert_pack', entityId: row.id, after: row });
    return this.packDto(row);
  }

  async updatePack(ctx: AuthContext, id: string, dto: UpdatePackDto): Promise<AlertPackDto> {
    const before = await this.findWritablePack(ctx, id);
    const row = await this.prisma.alertPack.update({
      where: { id },
      data: {
        name: dto.name?.trim(),
        description: dto.description,
        isActive: dto.isActive,
        settings: dto.settings ? (cleanPackSettings(dto.settings) as unknown as Prisma.InputJsonValue) : undefined,
      },
    });
    await this.audit.record(ctx, { action: 'UPDATE', entity: 'alert_pack', entityId: id, before, after: row });
    return this.packDto(row);
  }

  async removePack(ctx: AuthContext, id: string): Promise<void> {
    const before = await this.findWritablePack(ctx, id);
    await this.prisma.alertPack.delete({ where: { id } });
    await this.audit.record(ctx, { action: 'DELETE', entity: 'alert_pack', entityId: id, before });
  }

  async applyPack(ctx: AuthContext, id: string, dto: ApplyPackDto): Promise<{ targets: number; settings: number }> {
    const pack = await this.prisma.alertPack.findFirst({ where: { id, OR: [{ companyId: null }, { companyId: ctx.companyId }] } });
    if (!pack) throw new NotFoundException('Pack not found');
    if (!pack.isActive) throw new BadRequestException('Pack is inactive');
    const settings = this.packDto(pack).settings;
    for (const s of settings) {
      const err = validateOverride(s.alertType, dto.level, s);
      if (err) throw new BadRequestException(err);
    }
    const targetIds = [...new Set(dto.targetIds)];
    for (const t of targetIds) await this.targets.assertTarget(ctx, dto.level, t, true);
    await this.prisma.$transaction(async (tx) => {
      for (const targetId of targetIds) {
        for (const s of settings) {
          const data = {
            enabled: s.enabled,
            params: (s.params ?? {}) as Prisma.InputJsonValue,
            schedule: s.schedule ? (s.schedule as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
            cooldownMin: s.cooldownMin,
            severity: s.severity,
            channels: s.channels ? (s.channels as Prisma.InputJsonValue) : Prisma.DbNull,
            requireAck: s.requireAck ?? null,
            updatedById: ctx.userId,
          };
          await tx.alertSetting.upsert({
            where: { companyId_level_targetId_alertType: { companyId: ctx.companyId, level: dto.level, targetId, alertType: s.alertType } },
            create: { companyId: ctx.companyId, level: dto.level, targetId, alertType: s.alertType, ...data },
            update: data,
          });
        }
      }
    });
    for (const targetId of targetIds) {
      await this.audit.record(ctx, {
        action: 'UPDATE',
        entity: 'alert_setting',
        entityId: targetId,
        details: { level: dto.level, operation: 'apply_pack', packId: pack.id, packName: pack.name, alertTypes: settings.map((s) => s.alertType) },
      });
    }
    await this.targets.invalidate(ctx.companyId, 'alert_pack_apply');
    return { targets: targetIds.length, settings: settings.length };
  }

  private async findWritablePack(ctx: AuthContext, id: string): Promise<AlertPack> {
    const pack = await this.prisma.alertPack.findFirst({ where: { id, OR: [{ companyId: null }, { companyId: ctx.companyId }] } });
    if (!pack) throw new NotFoundException('Pack not found');
    if (pack.companyId === null && !isPlatformContext(ctx)) throw new ForbiddenException('System packs are read-only');
    return pack;
  }
}

import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { AlertSetting, Prisma } from '@prisma/client';
import {
  ALERT_TYPE_MAP,
  ALERT_TYPES,
  AlertLevel,
  AlertSettingDto,
  AlertTypeCode,
  AlertTypeDef,
  AuditLogDto,
  ChannelsBySeverity,
  EffectiveAlertSetting,
  TimeWindow,
} from '@veetracer/shared';
import { AuthContext } from '../../access/auth-context';
import { AuditService, diffSnapshots } from '../../audit/audit.service';
import { asRecord, iso } from '../../common/dto';
import { PrismaService } from '../../prisma/prisma.service';
import { AlertTargetsService, targetKey } from '../alert-targets.service';
import { findGroupConflicts, GroupConflict, validateOverride } from '../logic/settings-resolution';
import { isValidTimeWindow } from '../logic/time-window';
import { loadCompanyRules } from '../rules-data';
import { BulkEnableDto, CopySettingsDto, PutAlertSettingDto } from './alert-settings.dto';

export const SETTINGS_AUDIT_ENTITIES = ['alert_setting', 'recipient_list', 'alert_snooze'];

type Fields = Pick<AlertSetting, 'enabled' | 'params' | 'schedule' | 'cooldownMin' | 'severity' | 'channels' | 'requireAck'>;

export function settingSnapshot(row: Fields | null): Record<string, unknown> | null {
  if (!row) return null;
  return {
    enabled: row.enabled,
    params: row.params,
    schedule: row.schedule ?? null,
    cooldownMin: row.cooldownMin,
    severity: row.severity,
    channels: row.channels ?? null,
    requireAck: row.requireAck ?? null,
  };
}

function isEmpty(f: { enabled: boolean | null; params: Record<string, unknown>; schedule: unknown; cooldownMin: number | null; severity: string | null; channels: unknown; requireAck: boolean | null }) {
  return f.enabled === null && Object.keys(f.params).length === 0 && f.schedule === null && f.cooldownMin === null && f.severity === null && f.channels === null && f.requireAck === null;
}

export interface AlertTypeWithSupport extends AlertTypeDef {
  supportedBy: { count: number; total: number };
}

@Injectable()
export class AlertSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly targets: AlertTargetsService,
  ) {}

  toDto(row: AlertSetting, targetName: string): AlertSettingDto {
    return {
      id: row.id,
      level: row.level,
      targetId: row.targetId,
      targetName,
      alertType: row.alertType as AlertTypeCode,
      enabled: row.enabled,
      params: asRecord(row.params),
      schedule: isValidTimeWindow(row.schedule) ? (row.schedule as TimeWindow) : null,
      cooldownMin: row.cooldownMin,
      severity: row.severity,
      channels: (row.channels as Partial<ChannelsBySeverity> | null) ?? null,
      requireAck: row.requireAck,
      updatedAt: iso(row.updatedAt),
    };
  }

  async alertTypes(ctx: AuthContext): Promise<AlertTypeWithSupport[]> {
    const objects = await this.prisma.trackedObject.findMany({
      where: { companyId: ctx.companyId, isActive: true },
      select: { assignments: { where: { toTime: null }, select: { device: { select: { model: { select: { capabilities: true } } } } } } },
    });
    const caps = objects.map((o) => o.assignments[0]?.device.model.capabilities ?? []);
    return ALERT_TYPES.map((t) => ({
      ...t,
      supportedBy: {
        count: t.capability === null ? caps.length : caps.filter((c) => c.includes(t.capability!)).length,
        total: caps.length,
      },
    }));
  }

  async list(ctx: AuthContext, level: AlertLevel, targetId: string): Promise<AlertSettingDto[]> {
    const name = await this.targets.assertTarget(ctx, level, targetId, false);
    const rows = await this.prisma.alertSetting.findMany({ where: { companyId: ctx.companyId, level, targetId }, orderBy: { alertType: 'asc' } });
    return rows.map((r) => this.toDto(r, name));
  }

  async put(ctx: AuthContext, dto: PutAlertSettingDto): Promise<{ setting: AlertSettingDto | null }> {
    const err = validateOverride(dto.alertType, dto.level, dto);
    if (err) throw new BadRequestException(err);
    const name = await this.targets.assertTarget(ctx, dto.level, dto.targetId, true);
    const where = { companyId_level_targetId_alertType: { companyId: ctx.companyId, level: dto.level, targetId: dto.targetId, alertType: dto.alertType } };
    const existing = await this.prisma.alertSetting.findUnique({ where });

    const params = { ...asRecord(existing?.params) };
    if (dto.params === null) for (const k of Object.keys(params)) delete params[k];
    else if (dto.params) for (const [k, v] of Object.entries(dto.params)) if (v === null) delete params[k]; else params[k] = v;

    let channels: Record<string, unknown> | null = existing?.channels ? { ...asRecord(existing.channels) } : null;
    if (dto.channels === null) channels = null;
    else if (dto.channels) {
      channels = channels ?? {};
      for (const [sev, list] of Object.entries(dto.channels)) if (list === null) delete channels[sev]; else channels[sev] = list;
      if (!Object.keys(channels).length) channels = null;
    }
    const merged = {
      enabled: dto.enabled !== undefined ? dto.enabled : (existing?.enabled ?? null),
      params,
      schedule: dto.schedule !== undefined ? dto.schedule : ((existing?.schedule as Record<string, unknown> | null) ?? null),
      cooldownMin: dto.cooldownMin !== undefined ? dto.cooldownMin : (existing?.cooldownMin ?? null),
      severity: dto.severity !== undefined ? dto.severity : (existing?.severity ?? null),
      channels,
      requireAck: dto.requireAck !== undefined ? dto.requireAck : (existing?.requireAck ?? null),
    };

    let row: AlertSetting | null = null;
    if (isEmpty(merged)) {
      if (existing) await this.prisma.alertSetting.delete({ where: { id: existing.id } });
    } else {
      const data = {
        enabled: merged.enabled,
        params: merged.params as Prisma.InputJsonValue,
        schedule: merged.schedule === null ? Prisma.DbNull : (merged.schedule as Prisma.InputJsonValue),
        cooldownMin: merged.cooldownMin,
        severity: merged.severity,
        channels: merged.channels === null ? Prisma.DbNull : (merged.channels as Prisma.InputJsonValue),
        requireAck: merged.requireAck,
        updatedById: ctx.userId,
      };
      row = await this.prisma.alertSetting.upsert({
        where,
        create: { companyId: ctx.companyId, level: dto.level, targetId: dto.targetId, alertType: dto.alertType, ...data },
        update: data,
      });
    }
    await this.recordAudit(ctx, dto.level, dto.targetId, dto.alertType, existing, row);
    await this.targets.invalidate(ctx.companyId, 'alert_setting');
    return { setting: row ? this.toDto(row, name) : null };
  }

  async remove(ctx: AuthContext, id: string): Promise<void> {
    const row = await this.prisma.alertSetting.findFirst({ where: { id, companyId: ctx.companyId } });
    if (!row) throw new NotFoundException('Setting not found');
    await this.targets.assertTarget(ctx, row.level, row.targetId, true);
    await this.prisma.alertSetting.delete({ where: { id } });
    await this.recordAudit(ctx, row.level, row.targetId, row.alertType, row, null);
    await this.targets.invalidate(ctx.companyId, 'alert_setting');
  }

  async effective(ctx: AuthContext, objectId: string): Promise<EffectiveAlertSetting[]> {
    await this.targets.assertObject(ctx, objectId);
    const rules = await loadCompanyRules(this.prisma, ctx.companyId, { objectIds: [objectId], geofences: false });
    return [...rules.effective(objectId).values()];
  }

  async conflicts(ctx: AuthContext, objectId: string): Promise<GroupConflict[]> {
    await this.targets.assertObject(ctx, objectId);
    const rules = await loadCompanyRules(this.prisma, ctx.companyId, { objectIds: [objectId], geofences: false });
    return findGroupConflicts(rules.chain(objectId));
  }

  async copy(ctx: AuthContext, dto: CopySettingsDto): Promise<{ targets: number; settings: number }> {
    await this.targets.assertObject(ctx, dto.fromObjectId);
    const targets: { level: AlertLevel; targetId: string }[] = [
      ...(dto.toObjectIds ?? []).filter((id) => id !== dto.fromObjectId).map((targetId) => ({ level: 'OBJECT' as const, targetId })),
      ...(dto.toGroupIds ?? []).map((targetId) => ({ level: 'GROUP' as const, targetId })),
    ];
    if (!targets.length) throw new BadRequestException('Choose at least one target');
    for (const t of targets) await this.targets.assertTarget(ctx, t.level, t.targetId, true);
    const source = await this.prisma.alertSetting.findMany({ where: { companyId: ctx.companyId, level: 'OBJECT', targetId: dto.fromObjectId } });
    await this.prisma.$transaction(async (tx) => {
      for (const t of targets) {
        await tx.alertSetting.deleteMany({ where: { companyId: ctx.companyId, level: t.level, targetId: t.targetId } });
        if (source.length) {
          await tx.alertSetting.createMany({
            data: source.map((s) => ({
              companyId: ctx.companyId,
              level: t.level,
              targetId: t.targetId,
              alertType: s.alertType,
              // Mandatory types can't be disabled below company level; copies to groups/objects are equally restricted.
              enabled: ALERT_TYPE_MAP[s.alertType as AlertTypeCode]?.mandatory && s.enabled === false ? null : s.enabled,
              params: s.params as Prisma.InputJsonValue,
              schedule: s.schedule === null ? Prisma.DbNull : (s.schedule as Prisma.InputJsonValue),
              cooldownMin: s.cooldownMin,
              severity: s.severity,
              channels: s.channels === null ? Prisma.DbNull : (s.channels as Prisma.InputJsonValue),
              requireAck: s.requireAck,
              updatedById: ctx.userId,
            })),
          });
        }
      }
    });
    for (const t of targets) {
      await this.audit.record(ctx, {
        action: 'UPDATE',
        entity: 'alert_setting',
        entityId: t.targetId,
        details: { level: t.level, operation: 'copy', fromObjectId: dto.fromObjectId, alertTypes: source.map((s) => s.alertType) },
      });
    }
    await this.targets.invalidate(ctx.companyId, 'alert_setting_copy');
    return { targets: targets.length, settings: source.length };
  }

  async bulkEnable(ctx: AuthContext, dto: BulkEnableDto): Promise<{ updated: number }> {
    const err = validateOverride(dto.alertType, dto.level, { enabled: dto.enabled });
    if (err) throw new BadRequestException(err);
    const ids = [...new Set(dto.targetIds)];
    for (const id of ids) await this.targets.assertTarget(ctx, dto.level, id, true);
    for (const targetId of ids) {
      const where = { companyId_level_targetId_alertType: { companyId: ctx.companyId, level: dto.level, targetId, alertType: dto.alertType } };
      const before = await this.prisma.alertSetting.findUnique({ where });
      const row = await this.prisma.alertSetting.upsert({
        where,
        create: { companyId: ctx.companyId, level: dto.level, targetId, alertType: dto.alertType, enabled: dto.enabled, updatedById: ctx.userId },
        update: { enabled: dto.enabled, updatedById: ctx.userId },
      });
      await this.recordAudit(ctx, dto.level, targetId, dto.alertType, before, row);
    }
    await this.targets.invalidate(ctx.companyId, 'alert_setting_bulk');
    return { updated: ids.length };
  }

  async history(ctx: AuthContext, level: AlertLevel | undefined, targetId: string | undefined): Promise<AuditLogDto[]> {
    if (level && targetId) await this.targets.assertTarget(ctx, level, targetId, false);
    const rows = await this.prisma.auditLog.findMany({
      where: {
        companyId: ctx.companyId,
        entity: { in: SETTINGS_AUDIT_ENTITIES },
        ...(targetId ? { entityId: targetId } : {}),
        ...(level ? { changes: { path: ['level'], equals: level } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return this.audit.toDtos(rows);
  }

  private async recordAudit(
    ctx: AuthContext,
    level: AlertLevel,
    targetId: string,
    alertType: string,
    before: Fields | null,
    after: Fields | null,
  ): Promise<void> {
    const changes = diffSnapshots(settingSnapshot(before), settingSnapshot(after));
    if (before && after && !Object.keys(changes).length) return;
    await this.audit.record(ctx, {
      action: !before ? 'CREATE' : !after ? 'DELETE' : 'UPDATE',
      entity: 'alert_setting',
      entityId: targetId,
      details: { level, alertType, changes } as Prisma.InputJsonValue,
    });
  }

  /** Names for many rows at once (used by packs/other listings). */
  async namesFor(companyId: string, rows: { level: string; targetId: string }[]) {
    const names = await this.targets.names(companyId, rows);
    return (r: { level: string; targetId: string }) => names.get(targetKey(r.level, r.targetId)) ?? '';
  }
}

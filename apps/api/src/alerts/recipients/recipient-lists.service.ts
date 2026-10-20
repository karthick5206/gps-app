import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, RecipientList } from '@prisma/client';
import {
  ALERT_TYPE_MAP,
  AlertLevel,
  AlertSeverity,
  AlertTypeCode,
  NotifyChannel,
  RecipientEntry,
  RecipientListDto,
} from '@veetracer/shared';
import { AuthContext } from '../../access/auth-context';
import { AuditService, diffSnapshots } from '../../audit/audit.service';
import { iso } from '../../common/dto';
import { PrismaService } from '../../prisma/prisma.service';
import { alertVars, TemplateRenderer } from '../../templates/template-renderer';
import { AlertTargetsService } from '../alert-targets.service';
import { dedupeEntries, validateEntries } from '../logic/recipients';
import { loadCompanyRules } from '../rules-data';
import { NotifyQueueService, QueuedMessage } from '../notify-queue.service';
import { ChannelRecipients, RecipientExpander } from './recipient-expander';
import { PutRecipientListDto } from './recipient-lists.dto';

const SENDABLE: NotifyChannel[] = ['EMAIL', 'SMS', 'WHATSAPP', 'PUSH'];

export interface ResolvedRecipientsResponse {
  objectId: string;
  alertType: AlertTypeCode;
  severity: AlertSeverity;
  channels: (ChannelRecipients & { enabled: boolean })[];
}

function toEntries(json: unknown): RecipientEntry[] {
  return Array.isArray(json) ? (json as RecipientEntry[]) : [];
}

@Injectable()
export class RecipientListsService {
  private readonly expander: RecipientExpander;
  private readonly renderer: TemplateRenderer;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly targets: AlertTargetsService,
    private readonly queue: NotifyQueueService,
  ) {
    this.expander = new RecipientExpander(prisma);
    this.renderer = new TemplateRenderer(prisma);
  }

  private toDto(r: RecipientList, targetName: string): RecipientListDto {
    return {
      id: r.id,
      level: r.level,
      targetId: r.targetId,
      targetName,
      alertType: r.alertType as AlertTypeCode | '*',
      severity: r.severity as AlertSeverity | '*',
      channel: r.channel,
      mode: r.mode,
      entries: toEntries(r.entries),
      updatedAt: iso(r.updatedAt),
    };
  }

  async list(ctx: AuthContext, level: AlertLevel, targetId: string): Promise<RecipientListDto[]> {
    const name = await this.targets.assertTarget(ctx, level, targetId, false);
    const rows = await this.prisma.recipientList.findMany({
      where: { companyId: ctx.companyId, level, targetId },
      orderBy: [{ alertType: 'asc' }, { severity: 'asc' }, { channel: 'asc' }],
    });
    return rows.map((r) => this.toDto(r, name));
  }

  async put(ctx: AuthContext, dto: PutRecipientListDto): Promise<RecipientListDto> {
    const name = await this.targets.assertTarget(ctx, dto.level, dto.targetId, true);
    const entries = await this.cleanEntries(ctx, dto.entries);
    const alertType = dto.alertType ?? '*';
    const severity = dto.severity ?? '*';
    const where = {
      companyId_level_targetId_alertType_channel_severity: {
        companyId: ctx.companyId,
        level: dto.level,
        targetId: dto.targetId,
        alertType,
        channel: dto.channel,
        severity,
      },
    };
    const before = await this.prisma.recipientList.findUnique({ where });
    const row = await this.prisma.recipientList.upsert({
      where,
      create: { companyId: ctx.companyId, level: dto.level, targetId: dto.targetId, alertType, severity, channel: dto.channel, mode: dto.mode, entries: entries as unknown as Prisma.InputJsonValue },
      update: { mode: dto.mode, entries: entries as unknown as Prisma.InputJsonValue },
    });
    await this.recordAudit(ctx, row, before, row);
    await this.targets.invalidate(ctx.companyId, 'recipient_list');
    return this.toDto(row, name);
  }

  async remove(ctx: AuthContext, id: string): Promise<void> {
    const row = await this.prisma.recipientList.findFirst({ where: { id, companyId: ctx.companyId } });
    if (!row) throw new NotFoundException('Recipient list not found');
    await this.targets.assertTarget(ctx, row.level, row.targetId, true);
    await this.prisma.recipientList.delete({ where: { id } });
    await this.recordAudit(ctx, row, row, null);
    await this.targets.invalidate(ctx.companyId, 'recipient_list');
  }

  async resolve(ctx: AuthContext, objectId: string, alertType: AlertTypeCode, severityIn?: AlertSeverity): Promise<ResolvedRecipientsResponse> {
    const object = await this.targets.assertObject(ctx, objectId);
    const rules = await loadCompanyRules(this.prisma, ctx.companyId, { objectIds: [objectId], geofences: false });
    const setting = rules.effective(objectId).get(alertType)!;
    const severity = severityIn ?? setting.severity;
    const enabledChannels = new Set(setting.channels[severity]);
    const resolved = await this.expander.resolve(object, alertType, severity, SENDABLE);
    return {
      objectId,
      alertType,
      severity,
      channels: resolved.map((c) => ({ ...c, enabled: enabledChannels.has(c.channel) })),
    };
  }

  /** Render the alert type's templates with sample data for this object and send through the notifier. */
  async test(ctx: AuthContext, objectId: string, alertType: AlertTypeCode, severityIn?: AlertSeverity): Promise<{ logIds: string[] }> {
    const resolved = await this.resolve(ctx, objectId, alertType, severityIn);
    const object = await this.prisma.trackedObject.findUniqueOrThrow({
      where: { id: objectId },
      select: { name: true, plateNumber: true, branch: { select: { name: true } }, company: { select: { name: true, timezone: true } } },
    });
    const vars = alertVars(
      {
        type: alertType,
        severity: resolved.severity,
        occurredAt: new Date(),
        lat: 13.0604,
        lng: 80.2496,
        address: 'Test location',
        data: { speedKph: 72, limitKph: 60, maxSpeedKph: 84, durationSec: 720, batteryPct: 15, geofence: 'Depot' },
        geofenceName: 'Depot',
      },
      { objectName: object.name, plateNumber: object.plateNumber, branchName: object.branch?.name ?? null, companyName: object.company.name, timezone: object.company.timezone },
    );
    const messages: QueuedMessage[] = [];
    for (const c of resolved.channels) {
      if (!c.enabled || !c.recipients.length) continue;
      const rendered = c.channel === 'WHATSAPP' ? null : await this.renderer.render(ctx.companyId, alertType, c.channel as 'EMAIL' | 'SMS' | 'PUSH', vars);
      const label = ALERT_TYPE_MAP[alertType].label;
      for (const r of c.recipients) {
        messages.push({
          channel: c.channel,
          recipient: r.address,
          templateId: rendered?.templateId ?? null,
          subject: rendered?.subject ? `[TEST] ${rendered.subject}` : `[TEST] ${label}`,
          body: rendered?.body ?? `[TEST] ${label}: ${object.name}`,
        });
      }
    }
    if (!messages.length) throw new BadRequestException('Nothing to send: this alert only shows in the app (no Push, Email or SMS recipients). Turn on Push, Email or SMS under Notify by, then test again.');
    return { logIds: await this.queue.enqueueMessages(ctx.companyId, messages) };
  }

  /** Validate, dedupe and check USER/ROLE ids belong to the company. */
  private async cleanEntries(ctx: AuthContext, input: RecipientEntry[]): Promise<RecipientEntry[]> {
    if (!input.every((e) => e && typeof e === 'object' && typeof e.kind === 'string' && typeof e.value === 'string')) {
      throw new BadRequestException('Each entry needs kind and value');
    }
    const entries = dedupeEntries(
      input.map((e) => ({
        kind: e.kind,
        value: e.kind === 'EMAIL' ? e.value.trim().toLowerCase() : e.value.trim(),
        ...(typeof e.label === 'string' && e.label.trim() ? { label: e.label.trim().slice(0, 120) } : {}),
      })),
    );
    const err = validateEntries(entries);
    if (err) throw new BadRequestException(err);
    const userIds = entries.filter((e) => e.kind === 'USER').map((e) => e.value);
    const roleIds = entries.filter((e) => e.kind === 'ROLE').map((e) => e.value);
    if (userIds.length) {
      const users = await this.prisma.user.findMany({ where: { companyId: ctx.companyId, id: { in: userIds } }, select: { id: true, name: true } });
      if (users.length !== userIds.length) throw new BadRequestException('Unknown user in recipients');
      const names = new Map(users.map((u) => [u.id, u.name]));
      for (const e of entries) if (e.kind === 'USER' && !e.label) e.label = names.get(e.value);
    }
    if (roleIds.length) {
      const roles = await this.prisma.role.findMany({ where: { companyId: ctx.companyId, id: { in: roleIds } }, select: { id: true, name: true } });
      if (roles.length !== roleIds.length) throw new BadRequestException('Unknown role in recipients');
      const names = new Map(roles.map((r) => [r.id, r.name]));
      for (const e of entries) if (e.kind === 'ROLE' && !e.label) e.label = names.get(e.value);
    }
    return entries;
  }

  private async recordAudit(ctx: AuthContext, key: RecipientList, before: RecipientList | null, after: RecipientList | null) {
    const snap = (r: RecipientList | null) => (r ? { mode: r.mode, entries: r.entries } : null);
    const changes = diffSnapshots(snap(before), snap(after));
    if (before && after && !Object.keys(changes).length) return;
    await this.audit.record(ctx, {
      action: !before ? 'CREATE' : !after ? 'DELETE' : 'UPDATE',
      entity: 'recipient_list',
      entityId: key.targetId,
      details: { level: key.level, alertType: key.alertType, severity: key.severity, channel: key.channel, changes } as Prisma.InputJsonValue,
    });
  }
}

import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, StreamableFile } from '@nestjs/common';
import { MessageTemplate, NotifyChannel } from '@prisma/client';
import { MessageTemplateDto, Paginated, TemplateApproval, TemplatePurpose } from '@veetracer/shared';
import { objectScopeWhere } from '../access/access-rules';
import { AuthContext } from '../access/auth-context';
import { EMAIL_PATTERN, INDIA_MOBILE_PATTERN } from '../alerts/logic/recipients';
import { AlertTargetsService } from '../alerts/alert-targets.service';
import { NotifyQueueService } from '../alerts/notify-queue.service';
import { AuditService } from '../audit/audit.service';
import { csvFile } from '../common/csv';
import { iso } from '../common/dto';
import { PrismaService } from '../prisma/prisma.service';
import { placeholdersFor, sampleVars, smsActivationError, smsDltText, smsParts, smsVariableOrder, templateVariables } from './render';
import { loadAlertContext, renderTemplate } from './template-renderer';
import { DuplicateTemplateDto, PreviewTemplateDto, TemplateListQuery, UpdateTemplateDto } from './templates.dto';

const ENTITY = 'message_template';

/** MessageTemplateDto plus SMS DLT helpers (dltText = body with `{#var#}` slots; variables = slot order). */
export type TemplateResponse = MessageTemplateDto & { dltText: string | null; variables: string[] };

export interface TemplateVersionDto {
  version: number;
  subject: string | null;
  body: string;
  changedByName: string | null;
  createdAt: string;
  current: boolean;
}

export interface PreviewResponse {
  subject: string | null;
  body: string;
  text: string;
  missing: string[];
  unknown: string[];
  sms: { dltText: string; values: string[]; encoding: 'GSM' | 'UNICODE'; length: number; parts: number } | null;
}

const isPlatformContext = (ctx: AuthContext) => ctx.isSuperAdmin && ctx.companyId === ctx.homeCompanyId;
const sameSlot = (a: MessageTemplate, b: MessageTemplate) => a.purpose === b.purpose && a.channel === b.channel && a.language === b.language;

@Injectable()
export class TemplatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly targets: AlertTargetsService,
    private readonly queue: NotifyQueueService,
  ) {}

  // ───────────── listing ─────────────
  private async visibleRows(ctx: AuthContext): Promise<MessageTemplate[]> {
    return this.prisma.messageTemplate.findMany({
      where: isPlatformContext(ctx) ? { companyId: null } : { OR: [{ companyId: null }, { companyId: ctx.companyId }] },
    });
  }

  private async toDtos(ctx: AuthContext, rows: MessageTemplate[], all?: MessageTemplate[]): Promise<TemplateResponse[]> {
    const pool = all ?? (await this.visibleRows(ctx));
    const systemRows = pool.filter((r) => r.companyId === null);
    const usage = await this.prisma.alertSetting.groupBy({
      by: ['alertType'],
      where: { ...(isPlatformContext(ctx) ? {} : { companyId: ctx.companyId }), OR: [{ enabled: null }, { enabled: true }] },
      _count: { _all: true },
    });
    const used = new Map(usage.map((u) => [u.alertType, u._count._all]));
    let overrideCounts = new Map<string, number>();
    if (ctx.isSuperAdmin) {
      const groups = await this.prisma.messageTemplate.groupBy({
        by: ['purpose', 'channel', 'language'],
        where: { companyId: { not: null } },
        _count: { _all: true },
      });
      overrideCounts = new Map(groups.map((g) => [`${g.purpose}|${g.channel}|${g.language}`, g._count._all]));
    }
    const userIds = [...new Set(rows.map((r) => r.updatedById).filter((x): x is string => !!x))];
    const users = userIds.length ? await this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }) : [];
    const userNames = new Map(users.map((u) => [u.id, u.name]));
    return rows.map((r) => {
      const system = r.companyId ? systemRows.find((s) => sameSlot(s, r)) : null;
      return {
        id: r.id,
        level: r.companyId ? 'COMPANY' : 'SYSTEM',
        overridesId: system?.id ?? null,
        purpose: r.purpose as TemplatePurpose,
        channel: r.channel as MessageTemplateDto['channel'],
        language: r.language,
        name: r.name,
        subject: r.subject,
        body: r.body,
        dltTemplateId: r.dltTemplateId,
        senderId: r.senderId,
        approvalStatus: r.approvalStatus as TemplateApproval,
        isActive: r.isActive,
        version: r.version,
        usedByRules: used.get(r.purpose) ?? 0,
        overrideCount: !r.companyId && ctx.isSuperAdmin ? (overrideCounts.get(`${r.purpose}|${r.channel}|${r.language}`) ?? 0) : 0,
        updatedByName: r.updatedById ? (userNames.get(r.updatedById) ?? null) : null,
        updatedAt: iso(r.updatedAt),
        dltText: r.channel === 'SMS' ? smsDltText(r.body) : null,
        variables: r.channel === 'SMS' ? smsVariableOrder(r.body) : templateVariables(`${r.subject ?? ''} ${r.body}`),
      };
    });
  }

  async list(ctx: AuthContext, q: TemplateListQuery): Promise<Paginated<TemplateResponse> | StreamableFile> {
    const all = await this.visibleRows(ctx);
    const companyRows = all.filter((r) => r.companyId !== null);
    let rows = all.filter((r) => {
      if (q.channel && r.channel !== q.channel) return false;
      if (q.purpose && r.purpose !== q.purpose) return false;
      if (q.level && (q.level === 'SYSTEM') !== (r.companyId === null)) return false;
      if (q.status && (q.status === 'ACTIVE') !== r.isActive) return false;
      if (q.language && r.language !== q.language) return false;
      if (q.notApproved && !(r.channel === 'SMS' && r.approvalStatus !== 'APPROVED')) return false;
      if (q.overridden) {
        const isOverride = r.companyId !== null && all.some((s) => s.companyId === null && sameSlot(s, r));
        const hasOverride = r.companyId === null && companyRows.some((c) => sameSlot(c, r));
        if (!isOverride && !hasOverride) return false;
      }
      if (q.q) {
        const t = q.q.toLowerCase();
        if (![r.name, r.purpose, r.subject ?? '', r.body].some((s) => s.toLowerCase().includes(t))) return false;
      }
      return true;
    });
    const sort = q.sort ?? 'purpose';
    const dir = q.order === 'desc' ? -1 : 1;
    const key = (r: MessageTemplate): string =>
      sort === 'updatedAt' ? r.updatedAt.toISOString() : sort === 'level' ? (r.companyId ? 'COMPANY' : 'SYSTEM') : sort === 'name' ? r.name : sort === 'channel' ? r.channel : r.purpose;
    const channelOrder = { EMAIL: 0, SMS: 1, PUSH: 2, WHATSAPP: 3, INAPP: 4 };
    rows = rows.sort((a, b) => dir * key(a).localeCompare(key(b)) || channelOrder[a.channel] - channelOrder[b.channel] || (a.companyId ? 1 : 0) - (b.companyId ? 1 : 0));
    const total = rows.length;
    if (q.format === 'csv') {
      const dtos = await this.toDtos(ctx, rows, all);
      return csvFile('message-templates', dtos, [
        { header: 'Name', value: (t) => t.name },
        { header: 'Purpose', value: (t) => t.purpose },
        { header: 'Channel', value: (t) => t.channel },
        { header: 'Language', value: (t) => t.language },
        { header: 'Level', value: (t) => t.level },
        { header: 'Subject', value: (t) => t.subject },
        { header: 'Body', value: (t) => t.body },
        { header: 'DLT template id', value: (t) => t.dltTemplateId },
        { header: 'Approval', value: (t) => t.approvalStatus },
        { header: 'Active', value: (t) => (t.isActive ? 'Yes' : 'No') },
        { header: 'Version', value: (t) => t.version },
        { header: 'Updated', value: (t) => t.updatedAt },
      ]);
    }
    const page = q.page ?? 1;
    const pageSize = q.pageSize ?? 50;
    const items = await this.toDtos(ctx, rows.slice((page - 1) * pageSize, page * pageSize), all);
    return { items, total, page, pageSize };
  }

  async get(ctx: AuthContext, id: string): Promise<TemplateResponse> {
    return (await this.toDtos(ctx, [await this.findVisible(ctx, id)]))[0];
  }

  // ───────────── editing ─────────────
  async update(ctx: AuthContext, id: string, dto: UpdateTemplateDto): Promise<TemplateResponse> {
    const row = await this.findVisible(ctx, id);
    if (row.companyId === null && !isPlatformContext(ctx)) return this.upsertOverride(ctx, row, dto);
    return this.applyUpdate(ctx, row, dto);
  }

  /** Company admin editing a system template: create (or update) the company's override of it. */
  private async upsertOverride(ctx: AuthContext, system: MessageTemplate, dto: UpdateTemplateDto): Promise<TemplateResponse> {
    const existing = await this.prisma.messageTemplate.findFirst({
      where: { companyId: ctx.companyId, purpose: system.purpose, channel: system.channel, language: system.language },
    });
    if (existing) return this.applyUpdate(ctx, existing, dto);
    const subject = dto.subject !== undefined ? dto.subject : system.subject;
    const body = dto.body ?? system.body;
    this.validateContent(system.purpose, system.channel, subject, body);
    const sameSms = system.channel === 'SMS' && body === system.body;
    const approvalStatus = system.channel === 'SMS' ? (dto.approvalStatus ?? (sameSms ? system.approvalStatus : 'DRAFT')) : 'NA';
    const dltTemplateId = dto.dltTemplateId !== undefined ? dto.dltTemplateId : sameSms ? system.dltTemplateId : null;
    const isActive = dto.isActive ?? (system.channel === 'SMS' ? approvalStatus === 'APPROVED' : true);
    const err = smsActivationError({ channel: system.channel, isActive, approvalStatus, dltTemplateId });
    if (err) throw new BadRequestException(err);
    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.messageTemplate.create({
        data: {
          companyId: ctx.companyId,
          purpose: system.purpose,
          channel: system.channel,
          language: system.language,
          name: dto.name?.trim() ?? system.name,
          subject,
          body,
          dltTemplateId,
          senderId: dto.senderId !== undefined ? dto.senderId : system.senderId,
          approvalStatus,
          isActive,
          version: 1,
          updatedById: ctx.userId,
        },
      });
      await tx.messageTemplateVersion.create({ data: { templateId: created.id, version: 1, subject, body, changedById: ctx.userId } });
      return created;
    });
    await this.audit.record(ctx, { action: 'CREATE', entity: ENTITY, entityId: row.id, after: { ...row, overridesId: system.id } });
    await this.targets.invalidate(ctx.companyId, 'template');
    return this.get(ctx, row.id);
  }

  private async applyUpdate(ctx: AuthContext, row: MessageTemplate, dto: UpdateTemplateDto): Promise<TemplateResponse> {
    const subject = dto.subject !== undefined ? dto.subject : row.subject;
    const body = dto.body ?? row.body;
    const contentChanged = subject !== row.subject || body !== row.body;
    if (contentChanged) this.validateContent(row.purpose, row.channel, subject, body);
    let approvalStatus = dto.approvalStatus ?? row.approvalStatus;
    let isActive = dto.isActive ?? row.isActive;
    if (row.channel !== 'SMS') approvalStatus = 'NA';
    else if (body !== row.body && dto.approvalStatus === undefined && row.approvalStatus === 'APPROVED') {
      // The DLT text changed: it must be registered and approved again before it can be used.
      approvalStatus = 'DRAFT';
      if (dto.isActive === undefined) isActive = false;
    }
    const dltTemplateId = dto.dltTemplateId !== undefined ? dto.dltTemplateId : row.dltTemplateId;
    const err = smsActivationError({ channel: row.channel, isActive, approvalStatus, dltTemplateId });
    if (err) throw new BadRequestException(err);
    const version = contentChanged ? row.version + 1 : row.version;
    const updated = await this.prisma.$transaction(async (tx) => {
      const u = await tx.messageTemplate.update({
        where: { id: row.id },
        data: {
          name: dto.name?.trim(),
          subject,
          body,
          dltTemplateId,
          senderId: dto.senderId !== undefined ? dto.senderId : undefined,
          approvalStatus,
          isActive,
          version,
          updatedById: ctx.userId,
        },
      });
      if (contentChanged) {
        await tx.messageTemplateVersion.upsert({
          where: { templateId_version: { templateId: row.id, version } },
          create: { templateId: row.id, version, subject, body, changedById: ctx.userId },
          update: { subject, body, changedById: ctx.userId },
        });
      }
      return u;
    });
    await this.audit.record(ctx, { action: 'UPDATE', entity: ENTITY, entityId: row.id, before: row, after: updated });
    await this.targets.invalidate(ctx.companyId, 'template');
    return this.get(ctx, row.id);
  }

  async duplicate(ctx: AuthContext, id: string, dto: DuplicateTemplateDto): Promise<TemplateResponse> {
    const src = await this.findVisible(ctx, id);
    const companyId = isPlatformContext(ctx) ? null : ctx.companyId;
    const language = (dto.language ?? src.language).toLowerCase();
    const clash = await this.prisma.messageTemplate.findFirst({ where: { companyId, purpose: src.purpose, channel: src.channel, language } });
    if (clash) {
      throw new ConflictException(
        `A ${companyId ? 'company' : 'system'} ${src.channel} template for ${src.purpose} in language "${language}" already exists — choose another language`,
      );
    }
    const approvalStatus = src.channel === 'SMS' ? 'DRAFT' : 'NA';
    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.messageTemplate.create({
        data: {
          companyId,
          purpose: src.purpose,
          channel: src.channel,
          language,
          name: dto.name?.trim() ?? `${src.name} (${language})`,
          subject: src.subject,
          body: src.body,
          dltTemplateId: null,
          senderId: src.senderId,
          approvalStatus,
          isActive: src.channel !== 'SMS',
          version: 1,
          updatedById: ctx.userId,
        },
      });
      await tx.messageTemplateVersion.create({ data: { templateId: created.id, version: 1, subject: src.subject, body: src.body, changedById: ctx.userId } });
      return created;
    });
    await this.audit.record(ctx, { action: 'CREATE', entity: ENTITY, entityId: row.id, after: { ...row, duplicatedFrom: src.id } });
    await this.targets.invalidate(ctx.companyId, 'template');
    return this.get(ctx, row.id);
  }

  async versions(ctx: AuthContext, id: string): Promise<TemplateVersionDto[]> {
    const row = await this.findVisible(ctx, id);
    const versions = await this.prisma.messageTemplateVersion.findMany({ where: { templateId: id }, orderBy: { version: 'desc' } });
    const userIds = [...new Set(versions.map((v) => v.changedById).filter((x): x is string => !!x))];
    const users = userIds.length ? await this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }) : [];
    const names = new Map(users.map((u) => [u.id, u.name]));
    return versions.map((v) => ({
      version: v.version,
      subject: v.subject,
      body: v.body,
      changedByName: v.changedById ? (names.get(v.changedById) ?? null) : null,
      createdAt: iso(v.createdAt),
      current: v.version === row.version,
    }));
  }

  /** Restores an old version's subject/body as a new version (on a system row a company admin gets an override). */
  async restore(ctx: AuthContext, id: string, version: number): Promise<TemplateResponse> {
    await this.findVisible(ctx, id);
    const v = await this.prisma.messageTemplateVersion.findUnique({ where: { templateId_version: { templateId: id, version } } });
    if (!v) throw new NotFoundException('Version not found');
    return this.update(ctx, id, { subject: v.subject, body: v.body });
  }

  /** Delete the caller company's override; `id` may be the override or the system template it overrides. */
  async reset(ctx: AuthContext, id: string): Promise<TemplateResponse> {
    if (isPlatformContext(ctx)) throw new BadRequestException('System templates have no override to reset');
    const row = await this.findVisible(ctx, id);
    const override = row.companyId
      ? row
      : await this.prisma.messageTemplate.findFirst({ where: { companyId: ctx.companyId, purpose: row.purpose, channel: row.channel, language: row.language } });
    if (!override) throw new NotFoundException('This template has no company override');
    const system = await this.prisma.messageTemplate.findFirst({
      where: { companyId: null, purpose: override.purpose, channel: override.channel, language: override.language },
    });
    if (!system) throw new BadRequestException('This company template does not override a system template — delete it instead');
    await this.prisma.messageTemplate.delete({ where: { id: override.id } });
    await this.audit.record(ctx, { action: 'DELETE', entity: ENTITY, entityId: override.id, before: override });
    await this.targets.invalidate(ctx.companyId, 'template');
    return this.get(ctx, system.id);
  }

  async remove(ctx: AuthContext, id: string): Promise<void> {
    const row = await this.findVisible(ctx, id);
    if (row.companyId === null) throw new ForbiddenException('System templates cannot be deleted');
    await this.prisma.messageTemplate.delete({ where: { id } });
    await this.audit.record(ctx, { action: 'DELETE', entity: ENTITY, entityId: id, before: row });
    await this.targets.invalidate(ctx.companyId, 'template');
  }

  async history(ctx: AuthContext, id: string) {
    await this.findVisible(ctx, id);
    return this.audit.history(ctx, ENTITY, id);
  }

  // ───────────── preview / test ─────────────
  async preview(ctx: AuthContext, dto: PreviewTemplateDto): Promise<PreviewResponse> {
    let base: Pick<MessageTemplate, 'id' | 'channel' | 'subject' | 'body' | 'dltTemplateId' | 'senderId' | 'purpose'> | null = null;
    if (dto.templateId) base = await this.findVisible(ctx, dto.templateId);
    const channel = (dto.channel ?? base?.channel ?? 'EMAIL') as NotifyChannel;
    const purpose = dto.purpose ?? base?.purpose ?? 'OVERSPEED';
    const t = {
      id: base?.id ?? '',
      channel,
      subject: dto.subject !== undefined ? dto.subject : (base?.subject ?? null),
      body: dto.body ?? base?.body ?? '',
      dltTemplateId: base?.dltTemplateId ?? null,
      senderId: base?.senderId ?? null,
    };
    if (!t.body) throw new BadRequestException('Provide templateId or body');
    const vars = await this.varsFor(ctx, purpose, dto.alertId);
    const r = renderTemplate(t, vars);
    const known = new Set(placeholdersFor(purpose));
    const unknown = templateVariables(`${t.subject ?? ''} ${t.body}`).filter((v) => !known.has(v));
    return {
      subject: r.subject,
      body: r.body,
      text: r.text,
      missing: r.missing,
      unknown,
      sms: channel === 'SMS' ? { dltText: r.dltText ?? smsDltText(t.body), values: r.dltValues ?? [], ...smsParts(r.text) } : null,
    };
  }

  async test(ctx: AuthContext, id: string, to: string): Promise<{ logIds: string[] }> {
    const t = await this.findVisible(ctx, id);
    const recipient = to.trim();
    if (t.channel === 'EMAIL' && !EMAIL_PATTERN.test(recipient)) throw new BadRequestException('Enter a valid e-mail address');
    if ((t.channel === 'SMS' || t.channel === 'WHATSAPP') && !INDIA_MOBILE_PATTERN.test(recipient)) {
      throw new BadRequestException('Enter a mobile number as +91 followed by 10 digits');
    }
    const company = await this.prisma.company.findUniqueOrThrow({ where: { id: ctx.companyId }, select: { name: true } });
    const r = renderTemplate(t, sampleVars(t.purpose, company.name));
    const logIds = await this.queue.enqueueMessages(ctx.companyId, [
      { channel: t.channel, recipient: t.channel === 'EMAIL' ? recipient.toLowerCase() : recipient, templateId: t.id, subject: r.subject ? `[TEST] ${r.subject}` : '[TEST]', body: r.body },
    ]);
    return { logIds };
  }

  placeholders(purpose?: string): string[] {
    return placeholdersFor(purpose ?? 'OVERSPEED');
  }

  // ───────────── helpers ─────────────
  private async varsFor(ctx: AuthContext, purpose: string, alertId?: string): Promise<Record<string, string>> {
    const company = await this.prisma.company.findUniqueOrThrow({ where: { id: ctx.companyId }, select: { name: true } });
    const sample = sampleVars(purpose, company.name);
    if (!alertId) return sample;
    const alert = await this.prisma.alert.findFirst({ where: { id: alertId, companyId: ctx.companyId } });
    if (!alert) throw new NotFoundException('Alert not found');
    if (ctx.dataScope !== 'COMPANY') {
      const visible = await this.prisma.trackedObject.count({ where: { AND: [objectScopeWhere(ctx), { id: alert.objectId }] } });
      if (!visible) throw new NotFoundException('Alert not found');
    }
    const c = await loadAlertContext(this.prisma, alert);
    return { ...sample, ...(c?.vars ?? {}) };
  }

  private validateContent(purpose: string, channel: NotifyChannel, subject: string | null, body: string): void {
    if (!body.trim()) throw new BadRequestException('Body is required');
    if (channel === 'EMAIL' && !subject?.trim()) throw new BadRequestException('E-mail templates need a subject');
    const known = new Set(placeholdersFor(purpose));
    const unknown = templateVariables(`${subject ?? ''} ${body}`).filter((v) => !known.has(v));
    if (unknown.length) throw new BadRequestException(`Unknown placeholder(s): ${unknown.map((u) => `{{${u}}}`).join(', ')}`);
  }

  private async findVisible(ctx: AuthContext, id: string): Promise<MessageTemplate> {
    const row = await this.prisma.messageTemplate.findUnique({ where: { id } });
    if (!row || (row.companyId !== null && (isPlatformContext(ctx) || row.companyId !== ctx.companyId))) {
      throw new NotFoundException('Template not found');
    }
    return row;
  }
}


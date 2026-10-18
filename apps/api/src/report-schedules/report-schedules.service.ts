import { BadRequestException, Injectable, Logger, NotFoundException, StreamableFile } from '@nestjs/common';
import { Prisma, ReportRun, ReportSchedule } from '@prisma/client';
import { ReportFormat, ReportPeriod, ReportRunDto, ReportScheduleDto, ReportScope, ReportType } from '@veetracer/shared';
import { createReadStream } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hasPermission, objectScopeWhere } from '../access/access-rules';
import { AuthContext } from '../access/auth-context';
import { AuthContextService } from '../access/auth-context.service';
import { AuditService } from '../audit/audit.service';
import { MailerService } from '../auth/mailer.service';
import { BulkActionDto, runBulk } from '../common/bulk';
import { iso, isoOrNull } from '../common/dto';
import { CsvSpec, ListSpec, listResult, planList } from '../common/list-query';
import { APP_ROOT } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { ReportDataService } from '../reports/report-data.service';
import { FILE_MAX_ROWS, renderReport } from '../reports/report-files';
import { REPORT_TITLES } from '../reports/report-columns';
import { normalizeScope } from '../reports/reports.dto';
import { formatLocal } from '../summarizer/tz';
import { CreateReportScheduleDto, ReportScheduleListQuery, UpdateReportScheduleDto } from './report-schedules.dto';
import { computeNextRunAt, previousPeriod } from './schedule-time';

const ENTITY = 'report_schedule';
export const REPORTS_DIR = join(APP_ROOT, 'var', 'reports');

const LIST: ListSpec = {
  search: ['name'],
  sort: { name: 'name', createdAt: 'createdAt', updatedAt: 'updatedAt', nextRunAt: 'nextRunAt', lastRunAt: 'lastRunAt', frequency: 'frequency' },
  defaultSort: 'name',
};

const CSV: CsvSpec<ReportScheduleDto> = {
  name: 'report-schedules',
  columns: [
    { header: 'Name', value: (s) => s.name },
    { header: 'Owner', value: (s) => s.ownerName },
    { header: 'Reports', value: (s) => s.reportTypes },
    { header: 'Frequency', value: (s) => s.frequency },
    { header: 'Day', value: (s) => s.dayOfWeek ?? s.dayOfMonth ?? '' },
    { header: 'Time', value: (s) => s.timeOfDay },
    { header: 'Format', value: (s) => s.format },
    { header: 'Recipients', value: (s) => s.recipients },
    { header: 'Active', value: (s) => (s.isActive ? 'Yes' : 'No') },
    { header: 'Last run', value: (s) => s.lastRunAt },
    { header: 'Next run', value: (s) => s.nextRunAt },
  ],
};

const PLACEHOLDER_RE = /\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/gi;
const escapeHtml = (t: string) => t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
function render(template: string, vars: Record<string, string>, html: boolean): string {
  return template.replace(PLACEHOLDER_RE, (_m, name: string) => {
    const v = vars[name.toLowerCase()] ?? '';
    return html ? escapeHtml(v) : v;
  });
}

function scopeOf(value: Prisma.JsonValue): ReportScope {
  return normalizeScope((value ?? {}) as Partial<ReportScope>);
}

function snapshot(s: ReportSchedule) {
  return { ...s, nextRunAt: undefined, lastRunAt: undefined };
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'report';
}

@Injectable()
export class ReportSchedulesService {
  private readonly logger = new Logger('ReportSchedules');

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly data: ReportDataService,
    private readonly authContext: AuthContextService,
    private readonly mailer: MailerService,
  ) {}

  /** Company-scope users see every schedule of the company; others only their own. */
  private visibleWhere(ctx: AuthContext): Prisma.ReportScheduleWhereInput {
    return ctx.dataScope === 'COMPANY' ? { companyId: ctx.companyId } : { companyId: ctx.companyId, ownerId: ctx.userId };
  }

  async list(ctx: AuthContext, query: ReportScheduleListQuery) {
    const plan = planList<Prisma.ReportScheduleWhereInput, Prisma.ReportScheduleOrderByWithRelationInput>(query, LIST);
    const filters: Prisma.ReportScheduleWhereInput[] = [this.visibleWhere(ctx), plan.where];
    if (query.ownerId) filters.push({ ownerId: query.ownerId });
    if (query.frequency) filters.push({ frequency: query.frequency });
    const where: Prisma.ReportScheduleWhereInput = { AND: filters };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.reportSchedule.findMany({ where, orderBy: plan.orderBy, skip: plan.skip, take: plan.take }),
      this.prisma.reportSchedule.count({ where }),
    ]);
    return listResult(plan, await this.toDtos(rows), total, CSV);
  }

  async get(ctx: AuthContext, id: string): Promise<ReportScheduleDto> {
    return (await this.toDtos([await this.find(ctx, id)]))[0];
  }

  async create(ctx: AuthContext, dto: CreateReportScheduleDto): Promise<ReportScheduleDto> {
    const tz = await this.companyTz(ctx.companyId);
    const fields = await this.normalize(ctx, dto, null);
    const row = await this.prisma.reportSchedule.create({
      data: {
        companyId: ctx.companyId,
        ownerId: ctx.userId,
        ...fields,
        nextRunAt: fields.isActive === false ? null : new Date(computeNextRunAt(fields, tz, Date.now())),
      },
    });
    await this.audit.record(ctx, { action: 'CREATE', entity: ENTITY, entityId: row.id, after: snapshot(row) });
    return this.get(ctx, row.id);
  }

  async update(ctx: AuthContext, id: string, dto: UpdateReportScheduleDto): Promise<ReportScheduleDto> {
    const before = await this.find(ctx, id);
    const tz = await this.companyTz(ctx.companyId);
    const fields = await this.normalize(ctx, dto, before);
    const isActive = fields.isActive ?? before.isActive;
    const row = await this.prisma.reportSchedule.update({
      where: { id },
      data: { ...fields, nextRunAt: isActive ? new Date(computeNextRunAt(fields, tz, Date.now())) : null },
    });
    await this.audit.record(ctx, { action: 'UPDATE', entity: ENTITY, entityId: id, before: snapshot(before), after: snapshot(row) });
    return this.get(ctx, id);
  }

  async remove(ctx: AuthContext, id: string): Promise<void> {
    const before = await this.find(ctx, id);
    await this.prisma.reportSchedule.delete({ where: { id } });
    await this.audit.record(ctx, { action: 'DELETE', entity: ENTITY, entityId: id, before: snapshot(before) });
  }

  bulk(ctx: AuthContext, dto: BulkActionDto) {
    return runBulk(ctx, 'report_schedules', dto, {
      setActive: (id, isActive) => this.update(ctx, id, { isActive }),
      remove: (id) => this.remove(ctx, id),
    });
  }

  async history(ctx: AuthContext, id: string) {
    await this.find(ctx, id);
    return this.audit.history(ctx, ENTITY, id);
  }

  async runNow(ctx: AuthContext, id: string): Promise<ReportRunDto> {
    const schedule = await this.find(ctx, id);
    const run = await this.execute(schedule, { requestedById: ctx.userId, runAt: Date.now() });
    return (await this.runDtos([run]))[0];
  }

  async listRuns(ctx: AuthContext, scheduleId?: string): Promise<ReportRunDto[]> {
    if (scheduleId) await this.find(ctx, scheduleId);
    const where: Prisma.ReportRunWhereInput = { companyId: ctx.companyId };
    if (scheduleId) where.scheduleId = scheduleId;
    else if (ctx.dataScope !== 'COMPANY') {
      const own = await this.prisma.reportSchedule.findMany({ where: this.visibleWhere(ctx), select: { id: true } });
      where.OR = [{ scheduleId: { in: own.map((s) => s.id) } }, { requestedById: ctx.userId }];
    }
    const rows = await this.prisma.reportRun.findMany({ where, orderBy: { startedAt: 'desc' }, take: 100 });
    return this.runDtos(rows);
  }

  async runFile(ctx: AuthContext, id: string): Promise<StreamableFile> {
    const run = await this.prisma.reportRun.findFirst({ where: { id, companyId: ctx.companyId } });
    if (!run) throw new NotFoundException('Report run not found');
    if (ctx.dataScope !== 'COMPANY' && run.requestedById !== ctx.userId) {
      const schedule = run.scheduleId ? await this.prisma.reportSchedule.findFirst({ where: { id: run.scheduleId, ownerId: ctx.userId } }) : null;
      if (!schedule) throw new NotFoundException('Report run not found');
    }
    if (!run.filePath || !run.fileName) throw new NotFoundException('This run has no file');
    const info = await stat(run.filePath).catch(() => null);
    if (!info) throw new NotFoundException('Report file no longer exists');
    const format = run.fileName.split('.').pop()?.toUpperCase();
    const type =
      format === 'PDF'
        ? 'application/pdf'
        : format === 'CSV'
          ? 'text/csv; charset=utf-8'
          : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    return new StreamableFile(createReadStream(run.filePath), {
      type,
      disposition: `attachment; filename="${run.fileName}"`,
      length: info.size,
    });
  }

  /**
   * Generate the schedule's reports for the previous complete period with the owner's current data scope, save the
   * file under var/reports/ and e-mail it to the recipients. Always returns the ReportRun (SUCCEEDED or FAILED).
   */
  async execute(schedule: ReportSchedule, opts: { requestedById: string | null; runAt: number }): Promise<ReportRun> {
    const company = await this.prisma.company.findUniqueOrThrow({ where: { id: schedule.companyId }, select: { name: true, timezone: true } });
    const tz = company.timezone;
    const period = previousPeriod(schedule.frequency, opts.runAt, tz);
    const format = schedule.format as ReportFormat;
    const scope = scopeOf(schedule.scope);
    const run = await this.prisma.reportRun.create({
      data: {
        companyId: schedule.companyId,
        scheduleId: schedule.id,
        requestedById: opts.requestedById,
        reportTypes: schedule.reportTypes,
        params: { ...period, period: schedule.period, format, scope } as unknown as Prisma.InputJsonValue,
      },
    });
    try {
      const owner = await this.authContext.forUser(schedule.ownerId, schedule.companyId, null);
      if (!hasPermission(owner, 'reports', 'view')) throw new Error('The schedule owner no longer has access to reports');
      const sections = [];
      for (const type of schedule.reportTypes as ReportType[]) {
        sections.push(
          await this.data.generate(
            owner,
            { type, scope, from: period.from, to: period.to, period: schedule.period as ReportPeriod },
            FILE_MAX_ROWS[format],
          ),
        );
      }
      const file = await renderReport(sections, format);
      const fileName = `${slug(schedule.name)}-${file.fileName}`;
      await mkdir(REPORTS_DIR, { recursive: true });
      const filePath = join(REPORTS_DIR, `${run.id}-${fileName}`);
      await writeFile(filePath, file.buffer);

      const ownerUser = await this.prisma.user.findUnique({ where: { id: schedule.ownerId }, select: { name: true } });
      const vars: Record<string, string> = {
        user_name: ownerUser?.name ?? '',
        report_name: schedule.name,
        report_types: (schedule.reportTypes as ReportType[]).map((t) => REPORT_TITLES[t]).join(', '),
        period: period.from === period.to ? period.from : `${period.from} to ${period.to}`,
        generated_at: `${formatLocal(Date.now(), tz)} (${tz})`,
        file_name: fileName,
        company: company.name,
      };
      const mail = await this.composeEmail(schedule.companyId, vars);
      for (const to of schedule.recipients) {
        await this.mailer.send({ to, ...mail, attachments: [{ filename: fileName, path: filePath, contentType: file.contentType }] });
      }
      await this.prisma.reportSchedule.update({ where: { id: schedule.id }, data: { lastRunAt: new Date() } });
      return await this.prisma.reportRun.update({
        where: { id: run.id },
        data: { status: 'SUCCEEDED', fileName, filePath, finishedAt: new Date() },
      });
    } catch (error) {
      const message = (error as Error).message ?? String(error);
      this.logger.error(`Report run ${run.id} (${schedule.name}) failed: ${message}`);
      return this.prisma.reportRun.update({ where: { id: run.id }, data: { status: 'FAILED', error: message.slice(0, 1000), finishedAt: new Date() } });
    }
  }

  /** SYSTEM_SCHEDULED_REPORT e-mail template (company override first, then system), else a built-in e-mail. */
  private async composeEmail(companyId: string, vars: Record<string, string>): Promise<{ subject: string; html: string; text: string }> {
    const templates = await this.prisma.messageTemplate.findMany({
      where: { purpose: 'SYSTEM_SCHEDULED_REPORT', channel: 'EMAIL', isActive: true, OR: [{ companyId }, { companyId: null }] },
    });
    const pick = (cid: string | null) =>
      templates.find((t) => t.companyId === cid && t.language === 'en') ?? templates.find((t) => t.companyId === cid);
    const tpl = pick(companyId) ?? pick(null);
    if (tpl) {
      const html = render(tpl.body, vars, true);
      return {
        subject: render(tpl.subject ?? '{{report_name}} — {{period}}', vars, false),
        html,
        text: html.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
      };
    }
    const e = (k: string) => escapeHtml(vars[k] ?? '');
    return {
      subject: `${vars.report_name} — ${vars.period}`,
      html:
        `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#0f172a">` +
        `<h2 style="color:#0e5e57;margin:0 0 8px">${e('report_name')}</h2>` +
        `<p>Hi ${e('user_name')},</p><p>Your scheduled report (${e('report_types')}) for <b>${e('period')}</b> is attached: ${e('file_name')}.</p>` +
        `<p style="color:#64748b;font-size:12px">Generated ${e('generated_at')} · ${e('company')} · Veetrax</p></body></html>`,
      text: `${vars.report_name}\n\nHi ${vars.user_name}, your scheduled report (${vars.report_types}) for ${vars.period} is attached: ${vars.file_name}.\nGenerated ${vars.generated_at} · ${vars.company}`,
    };
  }

  private async find(ctx: AuthContext, id: string): Promise<ReportSchedule> {
    const row = await this.prisma.reportSchedule.findFirst({ where: { AND: [this.visibleWhere(ctx), { id }] } });
    if (!row) throw new NotFoundException('Report schedule not found');
    return row;
  }

  private async companyTz(companyId: string): Promise<string> {
    return (await this.prisma.company.findUniqueOrThrow({ where: { id: companyId }, select: { timezone: true } })).timezone;
  }

  /** Validated, normalised column values (merged over `before` for updates). */
  private async normalize(ctx: AuthContext, dto: UpdateReportScheduleDto, before: ReportSchedule | null) {
    const frequency = dto.frequency ?? before?.frequency;
    if (!frequency) throw new BadRequestException('frequency is required');
    let dayOfWeek = dto.dayOfWeek !== undefined ? dto.dayOfWeek : (before?.dayOfWeek ?? null);
    let dayOfMonth = dto.dayOfMonth !== undefined ? dto.dayOfMonth : (before?.dayOfMonth ?? null);
    if (frequency === 'DAILY') {
      dayOfWeek = null;
      dayOfMonth = null;
    } else if (frequency === 'WEEKLY') {
      dayOfWeek = dayOfWeek ?? 1;
      dayOfMonth = null;
    } else {
      dayOfMonth = dayOfMonth ?? 1;
      dayOfWeek = null;
    }
    const recipients = dto.recipients
      ? [...new Set(dto.recipients.map((r) => r.trim().toLowerCase()).filter(Boolean))]
      : (before?.recipients ?? []);
    if (!recipients.length) throw new BadRequestException('At least one recipient is required');
    const scope = dto.scope ? normalizeScope(dto.scope) : before ? scopeOf(before.scope) : normalizeScope(null);
    if (dto.scope) await this.assertScope(ctx, scope);
    const reportTypes = dto.reportTypes ? [...new Set(dto.reportTypes)] : (before?.reportTypes ?? []);
    return {
      name: dto.name?.trim() ?? before?.name ?? '',
      reportTypes,
      scope: scope as unknown as Prisma.InputJsonValue,
      period: dto.period ?? before?.period ?? 'DAY',
      frequency,
      dayOfWeek,
      dayOfMonth,
      timeOfDay: dto.timeOfDay ?? before?.timeOfDay ?? '07:00',
      format: dto.format ?? before?.format ?? 'XLSX',
      recipients,
      isActive: dto.isActive ?? before?.isActive ?? true,
    };
  }

  private async assertScope(ctx: AuthContext, scope: ReportScope): Promise<void> {
    const [branches, groups, objects] = await Promise.all([
      scope.branchIds.length ? this.prisma.branch.count({ where: { companyId: ctx.companyId, id: { in: scope.branchIds } } }) : 0,
      scope.groupIds.length ? this.prisma.vehicleGroup.count({ where: { companyId: ctx.companyId, id: { in: scope.groupIds } } }) : 0,
      scope.objectIds.length ? this.prisma.trackedObject.count({ where: { AND: [objectScopeWhere(ctx), { id: { in: scope.objectIds } }] } }) : 0,
    ]);
    if (branches !== new Set(scope.branchIds).size) throw new BadRequestException('Unknown branch in scope');
    if (groups !== new Set(scope.groupIds).size) throw new BadRequestException('Unknown vehicle group in scope');
    if (objects !== new Set(scope.objectIds).size) throw new BadRequestException('Unknown vehicle in scope');
  }

  private async toDtos(rows: ReportSchedule[]): Promise<ReportScheduleDto[]> {
    const ownerIds = [...new Set(rows.map((r) => r.ownerId))];
    const owners = ownerIds.length ? await this.prisma.user.findMany({ where: { id: { in: ownerIds } }, select: { id: true, name: true } }) : [];
    const names = new Map(owners.map((u) => [u.id, u.name]));
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      ownerId: r.ownerId,
      ownerName: names.get(r.ownerId) ?? 'Unknown user',
      reportTypes: r.reportTypes as ReportType[],
      scope: scopeOf(r.scope),
      period: r.period,
      frequency: r.frequency,
      dayOfWeek: r.dayOfWeek,
      dayOfMonth: r.dayOfMonth,
      timeOfDay: r.timeOfDay,
      format: r.format,
      recipients: r.recipients,
      isActive: r.isActive,
      lastRunAt: isoOrNull(r.lastRunAt),
      nextRunAt: isoOrNull(r.nextRunAt),
      createdAt: iso(r.createdAt),
      updatedAt: iso(r.updatedAt),
    }));
  }

  async runDtos(rows: ReportRun[]): Promise<ReportRunDto[]> {
    const ids = [...new Set(rows.map((r) => r.scheduleId).filter((id): id is string => !!id))];
    const schedules = ids.length ? await this.prisma.reportSchedule.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : [];
    const names = new Map(schedules.map((s) => [s.id, s.name]));
    return rows.map((r) => ({
      id: r.id,
      scheduleId: r.scheduleId,
      scheduleName: r.scheduleId ? (names.get(r.scheduleId) ?? null) : null,
      reportTypes: r.reportTypes as ReportType[],
      status: r.status,
      fileName: r.fileName,
      error: r.error,
      startedAt: iso(r.startedAt),
      finishedAt: isoOrNull(r.finishedAt),
    }));
  }
}

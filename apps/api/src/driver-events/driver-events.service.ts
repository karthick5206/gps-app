import { BadRequestException, Inject, Injectable, NotFoundException, Optional, StreamableFile } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  ALERT_TYPE_MAP,
  AlertTypeCode,
  DRIVER_EVENT_TYPES,
  DriverEventDto,
  DriverEventSettings,
  driverEventSettings,
  DriverEventStatsDto,
  DriverEventType,
  driverScore,
  Paginated,
} from '@veetracer/shared';
import ExcelJS from 'exceljs';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { objectScopeWhere } from '../access/access-rules';
import { AuthContext } from '../access/auth-context';
import { AuditService } from '../audit/audit.service';
import { CsvColumn, toCsv } from '../common/csv';
import { asRecord } from '../common/dto';
import { APP_ENV } from '../config/config.module';
import { AppEnv } from '../config/env';
import { LicencePolicyService } from '../licences/licence-policy.service';
import { PrismaService } from '../prisma/prisma.service';
import { AddressEnricher } from '../reports/address-enricher';
import { CONTENT_TYPES } from '../reports/report-files';
import { addDays, formatLocal, localDayKey, localMidnight } from '../summarizer/tz';
import { DriverEventQuery, DriverEventSettingsDto, ReviewDriverEventDto } from './driver-events.dto';
import { mediaPath } from './media-store';
import { mediaUrl, signMediaToken, verifyMediaToken } from './media-token';

const INCLUDE = {
  object: { select: { name: true, plateNumber: true } },
  driver: { select: { name: true } },
  media: { orderBy: [{ kind: 'asc' }, { createdAt: 'asc' }] },
} satisfies Prisma.DriverEventInclude;
type Row = Prisma.DriverEventGetPayload<{ include: typeof INCLUDE }>;

const EXPORT_MAX_ROWS = 20_000;
const STATS_MAX_DAYS = 92;
const ADDRESS_BUDGET = 25;

const typeLabel = (t: string) => ALERT_TYPE_MAP[t as AlertTypeCode]?.label ?? t;

@Injectable()
export class DriverEventsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly addresses: AddressEnricher,
    @Inject(APP_ENV) private readonly env: AppEnv,
    @Optional() private readonly licences?: LicencePolicyService,
  ) {}

  /** Events of vehicles in the caller's scope whose licence allows viewing. */
  private async scope(ctx: AuthContext): Promise<Prisma.DriverEventWhereInput> {
    const viewable = (await this.licences?.viewableWhere(ctx)) ?? {};
    return { companyId: ctx.companyId, object: { AND: [objectScopeWhere(ctx), viewable] } };
  }

  async where(ctx: AuthContext, q: DriverEventQuery): Promise<Prisma.DriverEventWhereInput> {
    const and: Prisma.DriverEventWhereInput[] = [await this.scope(ctx)];
    if (q.objectId) and.push({ objectId: q.objectId });
    if (q.driverId) and.push({ driverId: q.driverId });
    const types = (q.type ?? []).filter((t) => (DRIVER_EVENT_TYPES as readonly string[]).includes(t));
    if (q.type?.length) and.push({ type: { in: types } });
    if (q.status?.length) and.push({ status: { in: q.status } });
    if (q.minLevel) and.push({ level: { gte: q.minLevel } });
    if (q.from || q.to) and.push({ occurredAt: { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lte: new Date(q.to) } : {}) } });
    if (q.hasPhoto === true) and.push({ media: { some: { kind: 'PHOTO' } } });
    if (q.hasPhoto === false) and.push({ media: { none: { kind: 'PHOTO' } } });
    return { AND: and };
  }

  async list(ctx: AuthContext, q: DriverEventQuery): Promise<Paginated<DriverEventDto> | StreamableFile> {
    const where = await this.where(ctx, q);
    if (q.format) return this.export(ctx, where, q.format);
    const page = q.page ?? 1;
    const pageSize = q.pageSize ?? 24;
    const [rows, total] = await Promise.all([
      this.prisma.driverEvent.findMany({ where, include: INCLUDE, orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * pageSize, take: pageSize }),
      this.prisma.driverEvent.count({ where }),
    ]);
    return { items: await this.toDtos(ctx, rows, true), total, page, pageSize };
  }

  async get(ctx: AuthContext, id: string): Promise<DriverEventDto> {
    const row = await this.prisma.driverEvent.findFirst({ where: { AND: [await this.scope(ctx), { id }] }, include: INCLUDE });
    if (!row) throw new NotFoundException('Driver event not found');
    return (await this.toDtos(ctx, [row], true))[0];
  }

  /** Driver event of an alert (alert detail sheet thumbnail), or null. */
  async byAlert(ctx: AuthContext, alertId: string): Promise<DriverEventDto | null> {
    const row = await this.prisma.driverEvent.findFirst({ where: { AND: [await this.scope(ctx), { alertId }] }, include: INCLUDE });
    return row ? (await this.toDtos(ctx, [row], false))[0] : null;
  }

  async review(ctx: AuthContext, id: string, dto: ReviewDriverEventDto): Promise<DriverEventDto> {
    const before = await this.prisma.driverEvent.findFirst({ where: { AND: [await this.scope(ctx), { id }] } });
    if (!before) throw new NotFoundException('Driver event not found');
    const reset = dto.status === 'NEW';
    const after = await this.prisma.driverEvent.update({
      where: { id },
      data: {
        status: dto.status,
        note: dto.note === undefined ? undefined : dto.note?.trim() || null,
        reviewedById: reset ? null : ctx.userId,
        reviewedAt: reset ? null : new Date(),
      },
    });
    await this.audit.record(ctx, { action: 'UPDATE', entity: 'driver_event', entityId: id, before, after });
    return this.get(ctx, id);
  }

  private async toDtos(ctx: AuthContext, rows: Row[], fillAddresses: boolean): Promise<DriverEventDto[]> {
    const reviewerIds = [...new Set(rows.map((r) => r.reviewedById).filter((v): v is string => !!v))];
    const reviewers = reviewerIds.length ? await this.prisma.user.findMany({ where: { id: { in: reviewerIds } }, select: { id: true, name: true } }) : [];
    const names = new Map(reviewers.map((u) => [u.id, u.name]));
    const dtos = rows.map((r): DriverEventDto => {
      const media = r.media.map((m) => ({
        id: m.id,
        kind: m.kind,
        source: m.source,
        channel: m.channel,
        mime: m.mime,
        size: m.fileSize,
        capturedAt: m.capturedAt?.toISOString() ?? null,
        url: mediaUrl(m.id, signMediaToken({ u: ctx.userId, c: r.companyId, m: m.id }, this.env.jwtSecret)),
        playable: m.mime === 'video/mp4',
      }));
      return {
        id: r.id,
        alertId: r.alertId,
        objectId: r.objectId,
        objectName: r.object.name,
        plateNumber: r.object.plateNumber,
        driverId: r.driverId,
        driverName: r.driver?.name ?? null,
        type: r.type as DriverEventType,
        level: r.level,
        speedKph: r.speedKph,
        lat: r.lat,
        lng: r.lng,
        address: r.address,
        occurredAt: r.occurredAt.toISOString(),
        status: r.status,
        reviewedByName: r.reviewedById ? (names.get(r.reviewedById) ?? null) : null,
        reviewedAt: r.reviewedAt?.toISOString() ?? null,
        note: r.note,
        media,
        thumbnailUrl: media.find((m) => m.kind === 'PHOTO')?.url ?? null,
      };
    });
    if (fillAddresses && dtos.some((d) => !d.address && d.lat !== null)) {
      const missing = new Set(dtos.filter((d) => !d.address).map((d) => d.id));
      await this.addresses.enrich(dtos, [{ lat: (d) => d.lat, lng: (d) => d.lng, get: (d) => d.address, set: (d, a) => (d.address = a) }], { budget: ADDRESS_BUDGET, timeBudgetMs: 3000 });
      const filled = dtos.filter((d) => missing.has(d.id) && d.address);
      // Remember resolved addresses on the rows (best effort).
      void Promise.all(filled.map((d) => this.prisma.driverEvent.update({ where: { id: d.id }, data: { address: d.address } }))).catch(() => undefined);
    }
    return dtos;
  }

  async stats(ctx: AuthContext, q: DriverEventQuery): Promise<DriverEventStatsDto> {
    const company = await this.prisma.company.findUnique({ where: { id: ctx.companyId }, select: { timezone: true } });
    const tz = company?.timezone ?? 'Asia/Kolkata';
    const now = Date.now();
    const to = q.to ? new Date(q.to) : new Date(now);
    const from = q.from ? new Date(q.from) : new Date(to.getTime() - 7 * 86_400_000);
    if (to.getTime() - from.getTime() > STATS_MAX_DAYS * 86_400_000) throw new BadRequestException(`Choose at most ${STATS_MAX_DAYS} days`);
    const base = await this.where(ctx, { ...q, from: undefined, to: undefined });
    const where: Prisma.DriverEventWhereInput = { AND: [base, { occurredAt: { gte: from, lte: to } }] };
    const today = localDayKey(now, tz);
    const todayStart = new Date(localMidnight(today, tz));
    const weekStart = new Date(localMidnight(addDays(today, -6), tz));
    const [rows, todayCount, weekCount, withPhoto] = await Promise.all([
      this.prisma.driverEvent.findMany({ where, select: { type: true, level: true, status: true, driverId: true, occurredAt: true }, take: 50_000 }),
      this.prisma.driverEvent.count({ where: { AND: [base, { occurredAt: { gte: todayStart } }] } }),
      this.prisma.driverEvent.count({ where: { AND: [base, { occurredAt: { gte: weekStart } }] } }),
      this.prisma.driverEvent.count({ where: { AND: [where, { media: { some: { kind: 'PHOTO' } } }] } }),
    ]);
    const byType = new Map<string, number>();
    const byDay = new Map<string, number>();
    const byDriver = new Map<string | null, { type: string; level: number | null; status: string }[]>();
    for (const r of rows) {
      byType.set(r.type, (byType.get(r.type) ?? 0) + 1);
      const day = localDayKey(r.occurredAt.getTime(), tz);
      byDay.set(day, (byDay.get(day) ?? 0) + 1);
      const list = byDriver.get(r.driverId) ?? [];
      list.push(r);
      byDriver.set(r.driverId, list);
    }
    const driverIds = [...byDriver.keys()].filter((v): v is string => !!v);
    const drivers = driverIds.length ? await this.prisma.driver.findMany({ where: { id: { in: driverIds } }, select: { id: true, name: true } }) : [];
    const names = new Map(drivers.map((d) => [d.id, d.name]));
    return {
      total: rows.length,
      today: todayCount,
      week: weekCount,
      withPhoto,
      byType: [...byType.entries()].map(([type, count]) => ({ type: type as DriverEventType, count })).sort((a, b) => b.count - a.count),
      byDay: [...byDay.entries()].map(([day, count]) => ({ day, count })).sort((a, b) => a.day.localeCompare(b.day)),
      drivers: [...byDriver.entries()]
        .map(([driverId, events]) => ({ driverId, driverName: driverId ? (names.get(driverId) ?? null) : null, events: events.length, score: driverScore(events) }))
        .sort((a, b) => a.score - b.score || b.events - a.events)
        .slice(0, 20),
    };
  }

  async settings(ctx: AuthContext): Promise<{ settings: DriverEventSettings; usedBytes: number }> {
    const [company, used] = await Promise.all([
      this.prisma.company.findUniqueOrThrow({ where: { id: ctx.companyId }, select: { settings: true } }),
      this.prisma.driverEventMedia.aggregate({ where: { companyId: ctx.companyId }, _sum: { fileSize: true } }),
    ]);
    return { settings: driverEventSettings(asRecord(company.settings).driverEvents), usedBytes: used._sum.fileSize ?? 0 };
  }

  async updateSettings(ctx: AuthContext, dto: DriverEventSettingsDto): Promise<{ settings: DriverEventSettings; usedBytes: number }> {
    const before = await this.prisma.company.findUniqueOrThrow({ where: { id: ctx.companyId } });
    const all = asRecord(before.settings);
    const next = driverEventSettings({ ...driverEventSettings(all.driverEvents), ...dto });
    const after = await this.prisma.company.update({ where: { id: ctx.companyId }, data: { settings: { ...all, driverEvents: next } as unknown as Prisma.InputJsonValue } });
    await this.audit.record(ctx, { action: 'UPDATE', entity: 'company', entityId: ctx.companyId, before, after });
    return this.settings(ctx);
  }

  /** Photo / clip for a signed URL (`?token=` from the event DTO). */
  async media(id: string, token: string): Promise<{ file: StreamableFile; mime: string } | null> {
    const claims = verifyMediaToken(token, id, this.env.jwtSecret);
    if (!claims) return null;
    const m = await this.prisma.driverEventMedia.findFirst({ where: { id, companyId: claims.c } });
    if (!m) return null;
    const path = mediaPath(m.filePath);
    const info = await stat(path).catch(() => null);
    if (!info) return null;
    const ext = path.slice(path.lastIndexOf('.'));
    return {
      mime: m.mime,
      file: new StreamableFile(createReadStream(path), { type: m.mime, length: info.size, disposition: `inline; filename="driver-event-${m.eventId.slice(0, 8)}${ext}"` }),
    };
  }

  private async export(ctx: AuthContext, where: Prisma.DriverEventWhereInput, format: 'CSV' | 'XLSX'): Promise<StreamableFile> {
    const [rows, company] = await Promise.all([
      this.prisma.driverEvent.findMany({ where, include: INCLUDE, orderBy: { occurredAt: 'desc' }, take: EXPORT_MAX_ROWS }),
      this.prisma.company.findUnique({ where: { id: ctx.companyId }, select: { timezone: true } }),
    ]);
    const tz = company?.timezone ?? 'Asia/Kolkata';
    const dtos = await this.toDtos(ctx, rows, false);
    const columns: CsvColumn<DriverEventDto>[] = [
      { header: 'Time', value: (d) => formatLocal(new Date(d.occurredAt).getTime(), tz) },
      { header: 'Event', value: (d) => typeLabel(d.type) },
      { header: 'Level', value: (d) => d.level },
      { header: 'Vehicle', value: (d) => d.objectName },
      { header: 'Plate', value: (d) => d.plateNumber },
      { header: 'Driver', value: (d) => d.driverName },
      { header: 'Speed (km/h)', value: (d) => d.speedKph },
      { header: 'Address', value: (d) => d.address },
      { header: 'Latitude', value: (d) => d.lat },
      { header: 'Longitude', value: (d) => d.lng },
      { header: 'Photos', value: (d) => d.media.filter((m) => m.kind === 'PHOTO').length },
      { header: 'Clips', value: (d) => d.media.filter((m) => m.kind === 'VIDEO').length },
      { header: 'Status', value: (d) => d.status },
      { header: 'Reviewed by', value: (d) => d.reviewedByName },
      { header: 'Note', value: (d) => d.note },
    ];
    const date = new Date().toISOString().slice(0, 10);
    if (format === 'CSV') {
      return new StreamableFile(Buffer.from(toCsv(dtos, columns), 'utf8'), { type: CONTENT_TYPES.CSV, disposition: `attachment; filename="driver-events-${date}.csv"` });
    }
    const wb = new ExcelJS.Workbook();
    wb.creator = 'VeeTrax';
    const ws = wb.addWorksheet('Driver events');
    ws.addRow(columns.map((c) => c.header)).font = { bold: true };
    for (const d of dtos) ws.addRow(columns.map((c) => c.value(d) ?? ''));
    ws.columns.forEach((col, i) => (col.width = [20, 26, 8, 22, 14, 20, 12, 40, 11, 11, 8, 8, 11, 18, 30][i] ?? 14));
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    return new StreamableFile(buffer, { type: CONTENT_TYPES.XLSX, disposition: `attachment; filename="driver-events-${date}.xlsx"` });
  }
}

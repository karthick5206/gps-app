import { BadRequestException, Injectable, NotFoundException, StreamableFile } from '@nestjs/common';
import { Alert, Prisma } from '@prisma/client';
import { ALERT_TYPE_MAP, AlertDto, AlertTypeCode, AlertUnreadCount, isEmergencyAlert, NotificationLogDto, Paginated } from '@veetracer/shared';
import { objectScopeWhere } from '../../access/access-rules';
import { AuthContext } from '../../access/auth-context';
import { csvFile } from '../../common/csv';
import { CSV_MAX_ROWS } from '../../common/list-query';
import { PrismaService } from '../../prisma/prisma.service';
import { AlertNames, toAlertDto, toNotificationLogDto } from '../alert-dto';
import { readSql } from '../logic/alert-read';
import { AlertSyncService } from './alert-sync.service';
import { AckAllDto, AlertListQuery, ReadAllDto } from './alerts.dto';

const UNREAD_WINDOW_MS = 7 * 24 * 3600_000;
/** Above this many acknowledged alerts the socket event carries no ids (clients refetch). */
const ACK_SYNC_MAX = 200;
const SORT_COLUMNS: Record<string, Prisma.Sql> = {
  occurredAt: Prisma.sql`a."occurredAt"`,
  severity: Prisma.sql`a."severity"`,
  type: Prisma.sql`a."type"`,
  status: Prisma.sql`a."status"`,
};

/** Needs acknowledgement: stored on each alert when raised (Alert Settings `requireAck`). */
const ACK_REQUIRED_SQL = Prisma.sql`a."ackRequired"`;
const ACK_REQUIRED_WHERE: Prisma.AlertWhereInput = { ackRequired: true };

/** Escapes LIKE wildcards so user text matches literally. */
const likeText = (text: string) => `%${text.replace(/[\\%_]/g, '\\$&')}%`;

@Injectable()
export class AlertsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sync: AlertSyncService,
  ) {}

  /** Object ids in the caller's data scope; null = the whole company. */
  private async scopeObjectIds(ctx: AuthContext): Promise<string[] | null> {
    if (ctx.dataScope === 'COMPANY') return null;
    const ids = await this.prisma.trackedObject.findMany({ where: objectScopeWhere(ctx), select: { id: true } });
    return ids.map((o) => o.id);
  }

  /** Alerts the caller may see: whole company, or alerts of objects in their scope. */
  private async scopeWhere(ctx: AuthContext): Promise<Prisma.AlertWhereInput> {
    const ids = await this.scopeObjectIds(ctx);
    return ids === null ? { companyId: ctx.companyId } : { companyId: ctx.companyId, objectId: { in: ids } };
  }

  /** The same scope as SQL on alias `a`. */
  private async scopeSql(ctx: AuthContext): Promise<Prisma.Sql> {
    const ids = await this.scopeObjectIds(ctx);
    return ids === null ? Prisma.sql`a."companyId" = ${ctx.companyId}::uuid` : Prisma.sql`a."companyId" = ${ctx.companyId}::uuid AND a."objectId" = ANY(${ids}::uuid[])`;
  }

  /** Ids among `ids` that `userId` has read (see `readSql`). */
  async readIds(userId: string, ids: string[]): Promise<Set<string>> {
    if (!ids.length) return new Set();
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`SELECT a.id FROM "Alert" a WHERE a.id = ANY(${ids}::uuid[]) AND ${readSql(userId)}`;
    return new Set(rows.map((r) => r.id));
  }

  async names(rows: Alert[]): Promise<AlertNames> {
    const objectIds = [...new Set(rows.map((r) => r.objectId))];
    const geofenceIds = [...new Set(rows.map((r) => r.geofenceId).filter((x): x is string => !!x))];
    const userIds = [...new Set(rows.map((r) => r.ackById).filter((x): x is string => !!x))];
    const [objects, geofences, users] = await Promise.all([
      objectIds.length ? this.prisma.trackedObject.findMany({ where: { id: { in: objectIds } }, select: { id: true, name: true, plateNumber: true, branchId: true } }) : [],
      geofenceIds.length ? this.prisma.geofence.findMany({ where: { id: { in: geofenceIds } }, select: { id: true, name: true } }) : [],
      userIds.length ? this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }) : [],
    ]);
    return {
      objects: new Map(objects.map((o) => [o.id, o])),
      geofences: new Map(geofences.map((g) => [g.id, g.name])),
      users: new Map(users.map((u) => [u.id, u.name])),
    };
  }

  /** `read` per row from `read` (ids read by the caller); without it, read = no longer NEW. */
  async toDtos(rows: Alert[], read?: Set<string>): Promise<AlertDto[]> {
    const names = await this.names(rows);
    return rows.map((r) => toAlertDto(r, names, read ? read.has(r.id) : undefined));
  }

  private async toUserDtos(ctx: AuthContext, rows: Alert[]): Promise<AlertDto[]> {
    return this.toDtos(rows, await this.readIds(ctx.userId, rows.map((r) => r.id)));
  }

  /**
   * Raw SQL so the per-user `read` state can be selected and filtered in the same statement (AlertRead has no relation
   * to Alert). Indexes: (companyId, occurredAt), (objectId, occurredAt), (companyId, status, occurredAt); AlertRead's
   * primary key serves the EXISTS probe.
   */
  async list(ctx: AuthContext, q: AlertListQuery): Promise<Paginated<AlertDto> | StreamableFile> {
    const and: Prisma.Sql[] = [await this.scopeSql(ctx)];
    if (q.from) and.push(Prisma.sql`a."occurredAt" >= ${new Date(q.from)}`);
    if (q.to) and.push(Prisma.sql`a."occurredAt" <= ${new Date(q.to)}`);
    if (q.objectId) and.push(Prisma.sql`a."objectId" = ${q.objectId}::uuid`);
    if (q.type) and.push(Prisma.sql`a."type" = ${q.type}`);
    if (q.severity) and.push(Prisma.sql`a."severity" = ${q.severity}::"AlertSeverity"`);
    if (q.status) and.push(Prisma.sql`a."status" = ${q.status}::"AlertStatus"`);
    if (q.pendingAck !== undefined) and.push(q.pendingAck ? Prisma.sql`a."status" = 'NEW' AND ${ACK_REQUIRED_SQL}` : Prisma.sql`NOT (a."status" = 'NEW' AND ${ACK_REQUIRED_SQL})`);
    if (q.read !== undefined) and.push(q.read ? readSql(ctx.userId) : Prisma.sql`NOT ${readSql(ctx.userId)}`);
    if (q.branchId) {
      const ids = await this.prisma.trackedObject.findMany({ where: { companyId: ctx.companyId, branchId: q.branchId }, select: { id: true } });
      and.push(Prisma.sql`a."objectId" = ANY(${ids.map((o) => o.id)}::uuid[])`);
    }
    const text = q.q?.trim();
    if (text) {
      const objs = await this.prisma.trackedObject.findMany({
        where: { companyId: ctx.companyId, OR: [{ name: { contains: text, mode: 'insensitive' } }, { plateNumber: { contains: text, mode: 'insensitive' } }] },
        select: { id: true },
        take: 5000,
      });
      const typeCodes = Object.values(ALERT_TYPE_MAP).filter((t) => t.label.toLowerCase().includes(text.toLowerCase())).map((t) => t.code);
      const like = likeText(text);
      and.push(Prisma.sql`(a."message" ILIKE ${like} OR a."address" ILIKE ${like} OR a."objectId" = ANY(${objs.map((o) => o.id)}::uuid[]) OR a."type" = ANY(${typeCodes}::text[]))`);
    }
    const where = Prisma.join(and, ' AND ');
    const csv = q.format === 'csv';
    const page = q.page ?? 1;
    const pageSize = q.pageSize ?? 25;
    const order = q.order === 'asc' ? Prisma.sql`ASC` : Prisma.sql`DESC`;
    const sort = SORT_COLUMNS[q.sort ?? 'occurredAt'] ?? SORT_COLUMNS.occurredAt;
    const take = csv ? CSV_MAX_ROWS : pageSize;
    const skip = csv ? 0 : (page - 1) * pageSize;
    const [rows, counted] = await Promise.all([
      this.prisma.$queryRaw<(Alert & { read: boolean })[]>`
        SELECT a.*, ${readSql(ctx.userId)} AS "read" FROM "Alert" a WHERE ${where}
        ORDER BY ${sort} ${order}, a.id ASC LIMIT ${take} OFFSET ${skip}`,
      this.prisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM "Alert" a WHERE ${where}`,
    ]);
    const total = counted[0]?.n ?? 0;
    const items = await this.toDtos(rows, new Set(rows.filter((r) => r.read).map((r) => r.id)));
    if (csv) {
      return csvFile('alerts', items, [
        { header: 'Time', value: (a) => a.occurredAt },
        { header: 'Vehicle', value: (a) => a.objectName },
        { header: 'Plate', value: (a) => a.plateNumber },
        { header: 'Type', value: (a) => ALERT_TYPE_MAP[a.type as AlertTypeCode]?.label ?? a.type },
        { header: 'Severity', value: (a) => a.severity },
        { header: 'Message', value: (a) => a.message },
        { header: 'Geofence', value: (a) => a.geofenceName },
        { header: 'Address', value: (a) => a.address },
        { header: 'Latitude', value: (a) => a.lat },
        { header: 'Longitude', value: (a) => a.lng },
        { header: 'Status', value: (a) => a.status },
        { header: 'Read', value: (a) => (a.read ? 'Yes' : 'No') },
        { header: 'Acknowledged by', value: (a) => a.ackByName },
        { header: 'Acknowledged at', value: (a) => a.ackAt },
        { header: 'Note', value: (a) => a.ackNote },
      ]);
    }
    return { items, total, page, pageSize };
  }

  async get(ctx: AuthContext, id: string): Promise<AlertDto> {
    const row = await this.find(ctx, id);
    const dto = (await this.toUserDtos(ctx, [row]))[0];
    return isEmergencyAlert(row.type) ? { ...dto, contacts: await this.contacts(row) } : dto;
  }

  /** Phone numbers for the SOS screen: the driver assigned at the time of the alert and the tracker's SIM. */
  private async contacts(a: Alert): Promise<NonNullable<AlertDto['contacts']>> {
    const at = { objectId: a.objectId, fromTime: { lte: a.occurredAt }, OR: [{ toTime: null }, { toTime: { gt: a.occurredAt } }] };
    const [driver, device] = await Promise.all([
      this.prisma.driverAssignment.findFirst({ where: at, orderBy: { fromTime: 'desc' }, select: { driver: { select: { name: true, mobile: true } } } }),
      this.prisma.deviceAssignment.findFirst({ where: at, orderBy: { fromTime: 'desc' }, select: { device: { select: { simNumber: true } } } }),
    ]);
    return { driverName: driver?.driver.name ?? null, driverMobile: driver?.driver.mobile || null, deviceSim: device?.device.simNumber || null };
  }

  /**
   * Last 7 days in scope: `count` = alerts the caller hasn't read (see `readSql`); `pendingAck` = NEW alerts that need
   * acknowledgement (`ackRequired`), shared by everyone in scope. One scan of (companyId, status, occurredAt).
   */
  async unreadCount(ctx: AuthContext): Promise<AlertUnreadCount> {
    const since = new Date(Date.now() - UNREAD_WINDOW_MS);
    const rows = await this.prisma.$queryRaw<{ n: number; p: number }[]>`
      SELECT count(*) FILTER (WHERE NOT ${readSql(ctx.userId)})::int AS n, count(*) FILTER (WHERE ${ACK_REQUIRED_SQL})::int AS p FROM "Alert" a
      WHERE ${await this.scopeSql(ctx)} AND a."status" = 'NEW' AND a."occurredAt" >= ${since}`;
    return { count: rows[0]?.n ?? 0, pendingAck: rows[0]?.p ?? 0 };
  }

  /** Marks one alert read for the caller only (idempotent). */
  async markRead(ctx: AuthContext, id: string): Promise<{ ok: true }> {
    await this.find(ctx, id);
    await this.prisma.alertRead.createMany({ data: [{ alertId: id, userId: ctx.userId }], skipDuplicates: true });
    await this.sync.read(ctx.userId, { ids: [id] });
    return { ok: true };
  }

  /**
   * With `ids`: marks those in scope read for the caller. Without: moves the caller's watermark to now, so every alert
   * stored until now is read for them (one row update instead of a row per alert).
   */
  async readAll(ctx: AuthContext, dto: ReadAllDto): Promise<{ ok: true; count: number | null }> {
    if (!dto.ids) {
      await this.prisma.user.update({ where: { id: ctx.userId }, data: { alertsReadBefore: new Date() } });
      await this.sync.read(ctx.userId, { all: true });
      return { ok: true, count: null };
    }
    const rows = dto.ids.length ? await this.prisma.alert.findMany({ where: { AND: [await this.scopeWhere(ctx), { id: { in: dto.ids } }] }, select: { id: true } }) : [];
    const ids = rows.map((r) => r.id);
    if (ids.length) {
      await this.prisma.alertRead.createMany({ data: ids.map((alertId) => ({ alertId, userId: ctx.userId })), skipDuplicates: true });
      await this.sync.read(ctx.userId, { ids });
    }
    return { ok: true, count: ids.length };
  }

  /**
   * Acknowledging is shared (everyone sees who handled it) and only for alerts that need it (`ackRequired`, decided when raised); it also
   * counts as read, for everyone.
   */
  async ack(ctx: AuthContext, id: string, note?: string): Promise<AlertDto> {
    const row = await this.find(ctx, id);
    if (!row.ackRequired) throw new BadRequestException("This alert doesn't need acknowledgement");
    await this.prisma.alertRead.createMany({ data: [{ alertId: id, userId: ctx.userId }], skipDuplicates: true });
    if (row.status !== 'NEW') return (await this.toUserDtos(ctx, [row]))[0];
    const updated = await this.prisma.alert.update({
      where: { id },
      data: { status: 'ACKNOWLEDGED', ackById: ctx.userId, ackAt: new Date(), ackNote: note?.trim() || null },
    });
    const [dto] = await this.toUserDtos(ctx, [updated]);
    await this.sync.acked(ctx.companyId, [{ id, objectId: row.objectId }], dto.ackByName, dto.ackAt ?? new Date().toISOString());
    return dto;
  }

  async ackAll(ctx: AuthContext, dto: AckAllDto): Promise<{ count: number }> {
    // Alerts that don't need acknowledgement are skipped.
    const where: Prisma.AlertWhereInput = { AND: [await this.scopeWhere(ctx), { status: 'NEW' }, ACK_REQUIRED_WHERE, ...(dto.ids ? [{ id: { in: dto.ids } }] : [])] };
    const ackAt = new Date();
    // Ids first (bounded by `ids` when given) so in-scope sockets can be told which alerts changed.
    const targets = await this.prisma.alert.findMany({ where, select: { id: true, objectId: true }, ...(dto.ids ? {} : { take: ACK_SYNC_MAX + 1 }) });
    const { count } = await this.prisma.alert.updateMany({
      where,
      data: { status: 'ACKNOWLEDGED', ackById: ctx.userId, ackAt, ackNote: dto.note?.trim() || null },
    });
    // Acknowledged alerts are read for everyone; explicit rows for the acknowledging user only when ids were given.
    if (dto.ids && targets.length) await this.prisma.alertRead.createMany({ data: targets.map((t) => ({ alertId: t.id, userId: ctx.userId })), skipDuplicates: true });
    if (count) {
      const me = await this.prisma.user.findUnique({ where: { id: ctx.userId }, select: { name: true } });
      await this.sync.acked(ctx.companyId, targets.length > ACK_SYNC_MAX ? null : targets, me?.name ?? null, ackAt.toISOString());
    }
    return { count };
  }

  async notifications(ctx: AuthContext, id: string): Promise<NotificationLogDto[]> {
    await this.find(ctx, id);
    const rows = await this.prisma.notificationLog.findMany({ where: { alertId: id }, orderBy: { createdAt: 'asc' } });
    return rows.map(toNotificationLogDto);
  }

  private async find(ctx: AuthContext, id: string): Promise<Alert> {
    const row = await this.prisma.alert.findFirst({ where: { AND: [await this.scopeWhere(ctx), { id }] } });
    if (!row) throw new NotFoundException('Alert not found');
    return row;
  }
}

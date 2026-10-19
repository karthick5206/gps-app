import { Injectable, NotFoundException, StreamableFile } from '@nestjs/common';
import { Alert, Prisma } from '@prisma/client';
import { ALERT_TYPE_MAP, AlertDto, AlertTypeCode, isEmergencyAlert, NotificationLogDto, Paginated } from '@veetracer/shared';
import { objectScopeWhere } from '../../access/access-rules';
import { AuthContext } from '../../access/auth-context';
import { csvFile } from '../../common/csv';
import { CSV_MAX_ROWS } from '../../common/list-query';
import { PrismaService } from '../../prisma/prisma.service';
import { AlertNames, toAlertDto, toNotificationLogDto } from '../alert-dto';
import { AckAllDto, AlertListQuery } from './alerts.dto';

const UNREAD_WINDOW_MS = 7 * 24 * 3600_000;

@Injectable()
export class AlertsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Alerts the caller may see: whole company, or alerts of objects in their scope. */
  private async scopeWhere(ctx: AuthContext): Promise<Prisma.AlertWhereInput> {
    if (ctx.dataScope === 'COMPANY') return { companyId: ctx.companyId };
    const ids = await this.prisma.trackedObject.findMany({ where: objectScopeWhere(ctx), select: { id: true } });
    return { companyId: ctx.companyId, objectId: { in: ids.map((o) => o.id) } };
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

  async toDtos(rows: Alert[]): Promise<AlertDto[]> {
    const names = await this.names(rows);
    return rows.map((r) => toAlertDto(r, names));
  }

  async list(ctx: AuthContext, q: AlertListQuery): Promise<Paginated<AlertDto> | StreamableFile> {
    const and: Prisma.AlertWhereInput[] = [await this.scopeWhere(ctx)];
    if (q.from || q.to) and.push({ occurredAt: { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lte: new Date(q.to) } : {}) } });
    if (q.objectId) and.push({ objectId: q.objectId });
    if (q.type) and.push({ type: q.type });
    if (q.severity) and.push({ severity: q.severity });
    if (q.status) and.push({ status: q.status });
    if (q.branchId) {
      const ids = await this.prisma.trackedObject.findMany({ where: { companyId: ctx.companyId, branchId: q.branchId }, select: { id: true } });
      and.push({ objectId: { in: ids.map((o) => o.id) } });
    }
    const text = q.q?.trim();
    if (text) {
      const objs = await this.prisma.trackedObject.findMany({
        where: { companyId: ctx.companyId, OR: [{ name: { contains: text, mode: 'insensitive' } }, { plateNumber: { contains: text, mode: 'insensitive' } }] },
        select: { id: true },
        take: 5000,
      });
      const typeCodes = Object.values(ALERT_TYPE_MAP).filter((t) => t.label.toLowerCase().includes(text.toLowerCase())).map((t) => t.code);
      and.push({
        OR: [
          { message: { contains: text, mode: 'insensitive' } },
          { address: { contains: text, mode: 'insensitive' } },
          { objectId: { in: objs.map((o) => o.id) } },
          ...(typeCodes.length ? [{ type: { in: typeCodes } }] : []),
        ],
      });
    }
    const where: Prisma.AlertWhereInput = { AND: and };
    const csv = q.format === 'csv';
    const page = q.page ?? 1;
    const pageSize = q.pageSize ?? 25;
    const order = q.order ?? 'desc';
    const sort = q.sort ?? 'occurredAt';
    const orderBy: Prisma.AlertOrderByWithRelationInput[] = [{ [sort]: order }, { id: 'asc' }];
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.alert.findMany({ where, orderBy, skip: csv ? 0 : (page - 1) * pageSize, take: csv ? CSV_MAX_ROWS : pageSize }),
      this.prisma.alert.count({ where }),
    ]);
    const items = await this.toDtos(rows);
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
        { header: 'Acknowledged by', value: (a) => a.ackByName },
        { header: 'Acknowledged at', value: (a) => a.ackAt },
        { header: 'Note', value: (a) => a.ackNote },
      ]);
    }
    return { items, total, page, pageSize };
  }

  async get(ctx: AuthContext, id: string): Promise<AlertDto> {
    const row = await this.find(ctx, id);
    const dto = (await this.toDtos([row]))[0];
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

  async unreadCount(ctx: AuthContext): Promise<{ count: number }> {
    const count = await this.prisma.alert.count({
      where: { AND: [await this.scopeWhere(ctx), { status: 'NEW', occurredAt: { gte: new Date(Date.now() - UNREAD_WINDOW_MS) } }] },
    });
    return { count };
  }

  async ack(ctx: AuthContext, id: string, note?: string): Promise<AlertDto> {
    const row = await this.find(ctx, id);
    if (row.status !== 'NEW') return (await this.toDtos([row]))[0];
    const updated = await this.prisma.alert.update({
      where: { id },
      data: { status: 'ACKNOWLEDGED', ackById: ctx.userId, ackAt: new Date(), ackNote: note?.trim() || null },
    });
    return (await this.toDtos([updated]))[0];
  }

  async ackAll(ctx: AuthContext, dto: AckAllDto): Promise<{ count: number }> {
    const where: Prisma.AlertWhereInput = { AND: [await this.scopeWhere(ctx), { status: 'NEW' }, ...(dto.ids ? [{ id: { in: dto.ids } }] : [])] };
    const { count } = await this.prisma.alert.updateMany({
      where,
      data: { status: 'ACKNOWLEDGED', ackById: ctx.userId, ackAt: new Date(), ackNote: dto.note?.trim() || null },
    });
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

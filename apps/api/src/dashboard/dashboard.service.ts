import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  ConsolidatedReportRow,
  DashboardCompare,
  DashboardHealth,
  DashboardOverview,
  DashboardVehicleDistance,
  POSITION_FLAGS,
  ReportScope,
  VehicleHealthRow,
  VehicleRemarkDto,
} from '@veetracer/shared';
import { objectScopeWhere } from '../access/access-rules';
import { AuthContext } from '../access/auth-context';
import { AuditService } from '../audit/audit.service';
import { LiveService } from '../live/live.service';
import { PrismaService } from '../prisma/prisma.service';
import { ReportDataService } from '../reports/report-data.service';
import { deviceStatusReport, QueryCtx } from '../reports/report-queries';
import { localDayKey, localMidnight } from '../summarizer/tz';

const EMPTY_SCOPE = { branchIds: [], groupIds: [], objectIds: [] };
/** Only a packet received this recently says anything about the device clock today. */
const CLOCK_SAMPLE_MAX_AGE_SEC = 6 * 3600;
const r1 = (v: number) => Math.round(v * 10) / 10;

@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly live: LiveService,
    private readonly reports: ReportDataService,
    private readonly audit: AuditService,
  ) {}

  private async today(companyId: string): Promise<{ tz: string; day: string; start: Date }> {
    const company = await this.prisma.company.findUniqueOrThrow({ where: { id: companyId }, select: { timezone: true } });
    const day = localDayKey(Date.now(), company.timezone);
    return { tz: company.timezone, day, start: new Date(localMidnight(day, company.timezone)) };
  }

  async overview(ctx: AuthContext, topN: number): Promise<DashboardOverview> {
    const [objects, { day, start }] = await Promise.all([this.live.snapshot(ctx), this.today(ctx.companyId)]);
    const ids = objects.map((o) => o.objectId);
    const byStatus: Record<string, number> = {};
    let devicesOnline = 0;
    for (const o of objects) {
      byStatus[o.status] = (byStatus[o.status] ?? 0) + 1;
      if (o.deviceId && o.status !== 'OFFLINE' && o.status !== 'NO_DATA') devicesOnline++;
    }
    const empty: DashboardOverview = {
      generatedAt: new Date().toISOString(),
      day,
      total: objects.length,
      byStatus,
      devicesOnline,
      todayDistanceKm: 0,
      totalOdometerKm: 0,
      todayTrips: 0,
      todayAlerts: { total: 0, critical: 0, byType: [] },
      geofences: [],
      vehiclesInsideGeofences: 0,
      top: [],
      bottom: [],
    };
    if (!ids.length) return empty;

    const dayDate = new Date(`${day}T00:00:00.000Z`);
    const [todayRows, allTime, offsets, alertTypes, critical, openVisits] = await Promise.all([
      this.prisma.dailySummary.findMany({ where: { objectId: { in: ids }, day: dayDate }, select: { objectId: true, distanceKm: true, runningSec: true, tripCount: true } }),
      this.prisma.dailySummary.aggregate({ where: { objectId: { in: ids } }, _sum: { distanceKm: true } }),
      this.prisma.trackedObject.aggregate({ where: { id: { in: ids } }, _sum: { odometerOffsetKm: true } }),
      this.prisma.alert.groupBy({ by: ['type'], where: { companyId: ctx.companyId, objectId: { in: ids }, occurredAt: { gte: start } }, _count: true }),
      this.prisma.alert.count({ where: { companyId: ctx.companyId, objectId: { in: ids }, occurredAt: { gte: start }, severity: 'CRITICAL' } }),
      this.prisma.geofenceVisit.groupBy({ by: ['geofenceId'], where: { companyId: ctx.companyId, objectId: { in: ids }, exitTime: null }, _count: true }),
    ]);
    const geofences = openVisits.length
      ? await this.prisma.geofence.findMany({ where: { id: { in: openVisits.map((v) => v.geofenceId) } }, select: { id: true, name: true, color: true } })
      : [];
    const gMeta = new Map(geofences.map((g) => [g.id, g]));
    const insideObjects = openVisits.length
      ? await this.prisma.geofenceVisit.findMany({ where: { companyId: ctx.companyId, objectId: { in: ids }, exitTime: null }, select: { objectId: true }, distinct: ['objectId'] })
      : [];

    const byObject = new Map(todayRows.map((r) => [r.objectId, r]));
    const distances: DashboardVehicleDistance[] = objects
      .filter((o) => o.deviceId)
      .map((o) => {
        const r = byObject.get(o.objectId);
        return { objectId: o.objectId, name: o.name, plateNumber: o.plateNumber, distanceKm: r1(r?.distanceKm ?? 0), runningSec: r?.runningSec ?? 0 };
      });
    const sorted = [...distances].sort((a, b) => b.distanceKm - a.distanceKm || a.name.localeCompare(b.name));

    return {
      ...empty,
      todayDistanceKm: r1(todayRows.reduce((s, r) => s + r.distanceKm, 0)),
      totalOdometerKm: Math.round((allTime._sum.distanceKm ?? 0) + (offsets._sum.odometerOffsetKm ?? 0)),
      todayTrips: todayRows.reduce((s, r) => s + r.tripCount, 0),
      todayAlerts: {
        total: alertTypes.reduce((s, a) => s + a._count, 0),
        critical,
        byType: alertTypes.map((a) => ({ type: a.type, count: a._count })).sort((a, b) => b.count - a.count),
      },
      geofences: openVisits
        .map((v) => ({ geofenceId: v.geofenceId, name: gMeta.get(v.geofenceId)?.name ?? 'Deleted geofence', color: gMeta.get(v.geofenceId)?.color ?? null, vehicles: v._count }))
        .sort((a, b) => b.vehicles - a.vehicles),
      vehiclesInsideGeofences: insideObjects.length,
      top: sorted.slice(0, topN),
      bottom: sorted.slice(-topN).reverse(),
    };
  }

  async health(ctx: AuthContext, inactiveAfterMin: number): Promise<DashboardHealth> {
    const now = Date.now();
    const objects = await this.reports.scopeObjects(ctx, EMPTY_SCOPE);
    const ids = [...objects.keys()];
    const generatedAt = new Date(now).toISOString();
    if (!ids.length) return { generatedAt, inactiveAfterMin, rows: [] };
    const { day } = await this.today(ctx.companyId);
    const q: QueryCtx = { prisma: this.prisma, companyId: ctx.companyId, objects, ids, range: { gte: new Date(0), lt: new Date(now) }, maxRows: ids.length, options: { inactiveAfterMin } };
    const [status, clocks, todayRows, remarks, maintenance] = await Promise.all([
      deviceStatusReport(q, now),
      // Latest live (not late / not re-uploaded) GPS fix per vehicle: device clock vs server clock. Points without a
      // fix are skipped: trackers stamp them with a default date (e.g. years in the past) until GPS locks.
      this.prisma.$queryRaw<{ objectId: string; skew: number; age: number }[]>`
        SELECT DISTINCT ON ("objectId") "objectId",
               extract(epoch from ("fixTime" - "serverTime"))::float8 AS skew,
               extract(epoch from (now() - "serverTime"))::float8 AS age
        FROM "Position"
        WHERE "objectId" = ANY(${ids}::uuid[]) AND valid AND (flags & ${POSITION_FLAGS.LATE | POSITION_FLAGS.INVALID_FIX}) = 0
          AND NOT (attributes ? 'reupload') AND "serverTime" > now() - make_interval(secs => ${CLOCK_SAMPLE_MAX_AGE_SEC})
        ORDER BY "objectId", "serverTime" DESC`,
      this.prisma.dailySummary.findMany({ where: { objectId: { in: ids }, day: new Date(`${day}T00:00:00.000Z`) }, select: { objectId: true, distanceKm: true } }),
      this.latestRemarks(ids),
      this.prisma.trackedObject.findMany({ where: { id: { in: ids }, maintenanceSince: { not: null } }, select: { id: true, maintenanceSince: true, maintenanceNote: true } }),
    ]);
    const maint = new Map(maintenance.map((m) => [m.id, m]));
    const skew = new Map(clocks.map((c) => [c.objectId, Math.round(c.skew)]));
    const km = new Map(todayRows.map((r) => [r.objectId, r.distanceKm]));
    const rows: VehicleHealthRow[] = status.rows.map((r) => ({
      objectId: r.objectId,
      name: r.objectName,
      plateNumber: r.plateNumber,
      branchName: r.branchName,
      uniqueId: r.uniqueId,
      model: r.model,
      simNumber: r.simNumber,
      status: r.status,
      lastSeenAt: r.lastSeenAt,
      lastFixTime: r.lastFixTime,
      inactiveSec: r.inactiveSec,
      clockSkewSec: skew.get(r.objectId) ?? null,
      todayDistanceKm: r1(km.get(r.objectId) ?? 0),
      batteryLevel: r.batteryLevel,
      extVoltage: r.extVoltage,
      gsmSignal: r.gsmSignal,
      lat: r.lat,
      lng: r.lng,
      remark: remarks.get(r.objectId) ?? null,
      maintenanceSince: maint.get(r.objectId)?.maintenanceSince?.toISOString() ?? null,
      maintenanceNote: maint.get(r.objectId)?.maintenanceNote ?? null,
    }));
    return { generatedAt, inactiveAfterMin, rows };
  }

  async compare(ctx: AuthContext, from: string, to: string, scope: ReportScope): Promise<DashboardCompare> {
    const data = await this.reports.generate(ctx, { type: 'CONSOLIDATED', scope, from, to });
    return { from, to, rows: data.rows as ConsolidatedReportRow[], totals: data.totals ?? {} };
  }

  // ── Remarks ────────────────────────────────────────────────────────────────

  private async assertObject(ctx: AuthContext, objectId: string): Promise<void> {
    const found = await this.prisma.trackedObject.count({ where: { AND: [objectScopeWhere(ctx), { id: objectId }] } });
    if (!found) throw new NotFoundException('Vehicle not found');
  }

  private async latestRemarks(ids: string[]): Promise<Map<string, VehicleRemarkDto>> {
    const rows = await this.prisma.objectRemark.findMany({ where: { objectId: { in: ids } }, orderBy: { createdAt: 'desc' }, distinct: ['objectId'] });
    return this.toDtos(rows).then((dtos) => new Map(dtos.map((d) => [d.objectId, d])));
  }

  private async toDtos(rows: { id: string; objectId: string; note: string; createdById: string | null; createdAt: Date }[]): Promise<VehicleRemarkDto[]> {
    const userIds = [...new Set(rows.map((r) => r.createdById).filter((id): id is string => !!id))];
    const users = userIds.length ? await this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }) : [];
    const names = new Map(users.map((u) => [u.id, u.name]));
    return rows.map((r) => ({ id: r.id, objectId: r.objectId, note: r.note, createdByName: r.createdById ? (names.get(r.createdById) ?? null) : null, createdAt: r.createdAt.toISOString() }));
  }

  async remarks(ctx: AuthContext, objectId: string): Promise<VehicleRemarkDto[]> {
    await this.assertObject(ctx, objectId);
    const rows = await this.prisma.objectRemark.findMany({ where: { objectId }, orderBy: { createdAt: 'desc' }, take: 50 });
    return this.toDtos(rows);
  }

  async addRemark(ctx: AuthContext, objectId: string, note: string): Promise<VehicleRemarkDto> {
    const text = note.trim();
    if (!text) throw new BadRequestException('Remark is empty');
    await this.assertObject(ctx, objectId);
    const row = await this.prisma.objectRemark.create({ data: { companyId: ctx.companyId, objectId, note: text, createdById: ctx.userId } });
    await this.audit.record(ctx, { action: 'CREATE', entity: 'ObjectRemark', entityId: row.id, after: { objectId, note: text } });
    return (await this.toDtos([row]))[0];
  }
}

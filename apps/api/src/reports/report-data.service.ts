import { BadRequestException, Injectable, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  AlertDto,
  DailySummaryDto,
  DistanceReportRow,
  EngineHoursReportRow,
  GeofenceVisitDto,
  ReportPeriod,
  ReportRequest,
  ReportResponse,
  ReportScope,
  ReportType,
  StopDto,
  SummaryReportRow,
  TripDto,
} from '@veetracer/shared';
import { objectScopeWhere } from '../access/access-rules';
import { AuthContext } from '../access/auth-context';
import { toAlertDto } from '../alerts/alert-dto';
import { stopDto, tripDto } from '../history/history.service';
import { LicencePolicyService } from '../licences/licence-policy.service';
import { PrismaService } from '../prisma/prisma.service';
import { addDays, daysBetween, isDayKey, localDayKey, localMidnight } from '../summarizer/tz';
import { aggregateSummaries, intersectScope, summaryTotals } from './aggregate';
import {
  alertTypeFilter,
  consolidated,
  continuousDrivingReport,
  deviceStatusReport,
  driversReport,
  eventSummary,
  geofenceSummary,
  ignition,
  ObjInfo,
  overspeed,
  positions,
  QueryCtx,
} from './report-queries';
import { documentsReport } from './documents-report';
import { attachPoiNames, poiVisitsReport } from './poi-visits-report';
import { fuelEventsReport, fuelReport } from './fuel-report';
import { AddressEnricher } from './address-enricher';

export const REPORT_JSON_MAX_ROWS = 10_000;
export const REPORT_MAX_DAYS = 366;

/** Everything needed to show or render one report section. */
export interface ReportData extends ReportResponse {
  companyName: string;
  tz: string;
  /** True when more rows matched than were returned. */
  truncated: boolean;
  totalRows: number;
}

type ScopeCtx = Pick<AuthContext, 'companyId' | 'dataScope' | 'branchIds' | 'objectIds'>;

@Injectable()
export class ReportDataService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly addresses: AddressEnricher,
    @Optional() private readonly licences?: LicencePolicyService,
  ) {}

  validate(req: ReportRequest): void {
    if (!isDayKey(req.from) || !isDayKey(req.to)) throw new BadRequestException('from and to must be dates (YYYY-MM-DD)');
    if (req.to < req.from) throw new BadRequestException('to must not be before from');
    if (daysBetween(req.from, req.to) >= REPORT_MAX_DAYS) throw new BadRequestException(`Range too long (max ${REPORT_MAX_DAYS} days)`);
  }

  /** Object ids covered by `scope` within the caller's data scope. */
  async scopeObjects(ctx: ScopeCtx, scope: ReportScope): Promise<Map<string, ObjInfo>> {
    // Vehicles locked by an expired licence are left out of reports.
    const viewable = this.licences ? await this.licences.viewableWhere({ companyId: ctx.companyId, isSuperAdmin: (ctx as Partial<AuthContext>).isSuperAdmin ?? false }) : {};
    const rows = await this.prisma.trackedObject.findMany({
      where: { AND: [objectScopeWhere(ctx), viewable] },
      select: {
        id: true,
        name: true,
        plateNumber: true,
        branchId: true,
        branch: { select: { name: true } },
        groups: { select: { groupId: true } },
        type: true,
        vehicleType: true,
        speedLimitKph: true,
      },
    });
    const ids = new Set(
      intersectScope(
        rows.map((r) => ({ id: r.id, branchId: r.branchId, groupIds: r.groups.map((g) => g.groupId) })),
        scope,
      ),
    );
    const map = new Map<string, ObjInfo>();
    for (const r of rows) {
      if (ids.has(r.id)) {
        map.set(r.id, {
          name: r.name,
          plateNumber: r.plateNumber,
          branchId: r.branchId,
          branchName: r.branch?.name ?? null,
          type: r.type,
          vehicleType: r.vehicleType,
          speedLimitKph: r.speedLimitKph,
        });
      }
    }
    return map;
  }

  /** Builds a report section; rows with a location get their addresses filled (cache first, then a bounded number of lookups). */
  async generate(ctx: ScopeCtx, req: ReportRequest, maxRows = REPORT_JSON_MAX_ROWS): Promise<ReportData> {
    const data = await this.build(ctx, req, maxRows);
    await this.addresses.enrichReport(data.type, data.rows);
    return data;
  }

  private async build(ctx: ScopeCtx, req: ReportRequest, maxRows: number): Promise<ReportData> {
    this.validate(req);
    const company = await this.prisma.company.findUniqueOrThrow({ where: { id: ctx.companyId }, select: { name: true, timezone: true } });
    const tz = company.timezone;
    const objects = await this.scopeObjects(ctx, req.scope ?? { branchIds: [], groupIds: [], objectIds: [] });
    const ids = [...objects.keys()];
    const range = { gte: new Date(localMidnight(req.from, tz)), lt: new Date(localMidnight(addDays(req.to, 1), tz)) };
    const base = { type: req.type, from: req.from, to: req.to, companyName: company.name, tz };
    const empty: ReportData = { ...base, rows: [], totals: {}, truncated: false, totalRows: 0 };
    const name = (id: string) => objects.get(id)?.name ?? 'Unknown object';
    const byName = <T extends { objectId: string }>(a: T, b: T) => name(a.objectId).localeCompare(name(b.objectId));

    switch (req.type) {
      case 'SUMMARY': {
        const period: ReportPeriod = req.period ?? 'DAY';
        if (!ids.length) return { ...empty, period, totals: summaryTotals([]) };
        const days = await this.loadDays(ctx.companyId, objects, req);
        const all: SummaryReportRow[] = aggregateSummaries(days, period);
        return { ...base, period, rows: all.slice(0, maxRows), totals: summaryTotals(all), truncated: all.length > maxRows, totalRows: all.length };
      }

      case 'DISTANCE':
      case 'ENGINE_HOURS': {
        const period: ReportPeriod = req.period ?? 'DAY';
        if (!ids.length) return { ...empty, period, totals: {} };
        const all = aggregateSummaries(await this.loadDays(ctx.companyId, objects, req), period);
        const t = summaryTotals(all);
        const rows: (DistanceReportRow | EngineHoursReportRow)[] = all.map((r) =>
          req.type === 'DISTANCE'
            ? { objectId: r.objectId, objectName: r.objectName, plateNumber: r.plateNumber, branchName: r.branchName, period: r.period, distanceKm: r.distanceKm, tripCount: r.tripCount, runningSec: r.runningSec, offlineSec: r.offlineSec }
            : {
                objectId: r.objectId,
                objectName: r.objectName,
                plateNumber: r.plateNumber,
                branchName: r.branchName,
                period: r.period,
                engineSec: r.engineSec,
                runningSec: r.runningSec,
                idleSec: r.idleSec,
                idlePct: r.engineSec ? Math.round((r.idleSec / r.engineSec) * 1000) / 10 : 0,
                distanceKm: r.distanceKm,
              },
        );
        const totals: Record<string, number> =
          req.type === 'DISTANCE'
            ? { distanceKm: t.distanceKm, tripCount: t.tripCount, runningSec: t.runningSec, offlineSec: t.offlineSec, vehicles: t.vehicles }
            : { engineSec: t.engineSec, runningSec: t.runningSec, idleSec: t.idleSec, idlePct: t.engineSec ? Math.round((t.idleSec / t.engineSec) * 1000) / 10 : 0, distanceKm: t.distanceKm, vehicles: t.vehicles };
        return { ...base, period, rows: rows.slice(0, maxRows), totals, truncated: rows.length > maxRows, totalRows: rows.length };
      }

      case 'CONSOLIDATED':
      case 'POSITIONS':
      case 'OVERSPEED':
      case 'IGNITION':
      case 'CONTINUOUS_DRIVING':
      case 'EVENT_SUMMARY':
      case 'GEOFENCE_SUMMARY':
      case 'DEVICE_STATUS':
      case 'DRIVERS': {
        const q: QueryCtx = { prisma: this.prisma, companyId: ctx.companyId, objects, ids, range, maxRows, options: req.options ?? {} };
        const r =
          req.type === 'CONSOLIDATED'
            ? await consolidated(q, ids.length ? await this.loadDays(ctx.companyId, objects, req) : [], req)
            : req.type === 'POSITIONS'
              ? await positions(q, req)
              : req.type === 'OVERSPEED'
                ? await overspeed(q)
                : req.type === 'IGNITION'
                  ? await ignition(q)
                  : req.type === 'CONTINUOUS_DRIVING'
                    ? await continuousDrivingReport(q)
                    : req.type === 'EVENT_SUMMARY'
                      ? await eventSummary(q)
                      : req.type === 'GEOFENCE_SUMMARY'
                        ? await geofenceSummary(q)
                        : req.type === 'DRIVERS'
                          ? await driversReport(q)
                          : await deviceStatusReport(q, Date.now());
        return { ...base, rows: r.rows, totals: r.totals, truncated: r.totalRows > r.rows.length, totalRows: r.totalRows };
      }

      case 'DOCUMENTS': {
        // Status as of today (like the device status report); the date range is not used.
        const r = await documentsReport(this.prisma, ctx, objects, req.scope ?? { branchIds: [], groupIds: [], objectIds: [] }, localDayKey(Date.now(), tz), maxRows);
        return { ...base, rows: r.rows, totals: r.totals, truncated: r.totalRows > r.rows.length, totalRows: r.totalRows };
      }

      case 'FUEL': {
        const r = await fuelReport(this.prisma, ctx.companyId, objects, range, req.from, req.to, tz, maxRows);
        return { ...base, rows: r.rows, totals: r.totals, truncated: r.totalRows > r.rows.length, totalRows: r.totalRows };
      }

      case 'FUEL_EVENTS': {
        const r = await fuelEventsReport(this.prisma, ctx.companyId, objects, range, maxRows);
        return { ...base, rows: r.rows, totals: r.totals, truncated: r.totalRows > r.rows.length, totalRows: r.totalRows };
      }

      case 'POI_VISITS': {
        const r = await poiVisitsReport(this.prisma, ctx, objects, range, maxRows);
        return { ...base, rows: r.rows, totals: r.totals, truncated: r.totalRows > r.rows.length, totalRows: r.totalRows };
      }

      case 'HALT': {
        // Long stoppages: parked (engine off) for at least `minDurationMin` (default 30 min).
        if (!ids.length) return { ...empty, totals: { count: 0, durationSec: 0 } };
        const minSec = Math.max(1, req.options?.minDurationMin ?? 30) * 60;
        const where: Prisma.StopWhereInput = { companyId: ctx.companyId, objectId: { in: ids }, startTime: range, ignitionOn: false, durationSec: { gte: minSec } };
        const [rows, agg] = await Promise.all([
          this.prisma.stop.findMany({ where, orderBy: { startTime: 'asc' }, take: maxRows }),
          this.prisma.stop.aggregate({ where, _count: true, _sum: { durationSec: true } }),
        ]);
        const dtos: StopDto[] = rows.map((s) => stopDto(s, { name: name(s.objectId) })).sort(byName);
        await attachPoiNames(this.prisma, ctx, dtos);
        return { ...base, rows: dtos, totals: { count: agg._count, durationSec: agg._sum.durationSec ?? 0 }, truncated: agg._count > rows.length, totalRows: agg._count };
      }

      case 'TRIPS': {
        if (!ids.length) return { ...empty, totals: { count: 0, distanceKm: 0, durationSec: 0, idleSec: 0, maxSpeedKph: 0 } };
        const where: Prisma.TripWhereInput = { companyId: ctx.companyId, objectId: { in: ids }, startTime: range };
        const [rows, agg] = await Promise.all([
          this.prisma.trip.findMany({ where, orderBy: { startTime: 'asc' }, take: maxRows }),
          this.prisma.trip.aggregate({ where, _count: true, _sum: { distanceKm: true, durationSec: true, idleSec: true }, _max: { maxSpeedKph: true } }),
        ]);
        const dtos: TripDto[] = rows.map((t) => tripDto(t, { name: name(t.objectId) })).sort(byName);
        return {
          ...base,
          rows: dtos,
          totals: {
            count: agg._count,
            distanceKm: round3(agg._sum.distanceKm ?? 0),
            durationSec: agg._sum.durationSec ?? 0,
            idleSec: agg._sum.idleSec ?? 0,
            maxSpeedKph: agg._max.maxSpeedKph ?? 0,
          },
          truncated: agg._count > rows.length,
          totalRows: agg._count,
        };
      }

      case 'STOPS':
      case 'IDLE': {
        if (!ids.length) return { ...empty, totals: { count: 0, durationSec: 0 } };
        const where: Prisma.StopWhereInput = {
          companyId: ctx.companyId,
          objectId: { in: ids },
          startTime: range,
          ...(req.type === 'IDLE' ? { ignitionOn: true } : {}),
          ...(req.options?.minDurationMin ? { durationSec: { gte: req.options.minDurationMin * 60 } } : {}),
        };
        const [rows, agg] = await Promise.all([
          this.prisma.stop.findMany({ where, orderBy: { startTime: 'asc' }, take: maxRows }),
          this.prisma.stop.aggregate({ where, _count: true, _sum: { durationSec: true } }),
        ]);
        const dtos: StopDto[] = rows.map((s) => stopDto(s, { name: name(s.objectId) })).sort(byName);
        await attachPoiNames(this.prisma, ctx, dtos);
        return {
          ...base,
          rows: dtos,
          totals: { count: agg._count, durationSec: agg._sum.durationSec ?? 0 },
          truncated: agg._count > rows.length,
          totalRows: agg._count,
        };
      }

      case 'ALERTS': {
        const zero = { count: 0, INFO: 0, WARNING: 0, CRITICAL: 0 };
        if (!ids.length) return { ...empty, totals: zero };
        const where: Prisma.AlertWhereInput = { companyId: ctx.companyId, objectId: { in: ids }, occurredAt: range, ...alertTypeFilter(req.options ?? {}) };
        const [rows, bySeverity] = await Promise.all([
          this.prisma.alert.findMany({ where, orderBy: { occurredAt: 'asc' }, take: maxRows }),
          this.prisma.alert.groupBy({ by: ['severity'], where, _count: true }),
        ]);
        const totals: Record<string, number> = { ...zero };
        for (const g of bySeverity) {
          totals[g.severity] = g._count;
          totals.count += g._count;
        }
        const geofenceIds = [...new Set(rows.map((r) => r.geofenceId).filter((id): id is string => !!id))];
        const userIds = [...new Set(rows.map((r) => r.ackById).filter((id): id is string => !!id))];
        const [geofences, users] = await Promise.all([
          geofenceIds.length ? this.prisma.geofence.findMany({ where: { id: { in: geofenceIds } }, select: { id: true, name: true } }) : [],
          userIds.length ? this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }) : [],
        ]);
        const names = {
          objects: new Map([...objects].map(([id, o]) => [id, { name: o.name, plateNumber: o.plateNumber, branchId: o.branchId }])),
          geofences: new Map(geofences.map((g) => [g.id, g.name])),
          users: new Map(users.map((u) => [u.id, u.name])),
        };
        const dtos: AlertDto[] = rows.map((r) => toAlertDto(r, names));
        return { ...base, rows: dtos, totals, truncated: totals.count > rows.length, totalRows: totals.count };
      }

      case 'GEOFENCE_VISITS': {
        if (!ids.length) return { ...empty, totals: { count: 0, durationSec: 0 } };
        const where: Prisma.GeofenceVisitWhereInput = { companyId: ctx.companyId, objectId: { in: ids }, enterTime: range };
        const [rows, count] = await Promise.all([
          this.prisma.geofenceVisit.findMany({ where, orderBy: { enterTime: 'asc' }, take: maxRows }),
          this.prisma.geofenceVisit.count({ where }),
        ]);
        const geofences = await this.prisma.geofence.findMany({
          where: { id: { in: [...new Set(rows.map((r) => r.geofenceId))] } },
          select: { id: true, name: true },
        });
        const gName = new Map(geofences.map((g) => [g.id, g.name]));
        const dtos: GeofenceVisitDto[] = rows
          .map((v) => ({
            objectId: v.objectId,
            objectName: name(v.objectId),
            geofenceId: v.geofenceId,
            geofenceName: gName.get(v.geofenceId) ?? 'Deleted geofence',
            enterTime: v.enterTime.toISOString(),
            exitTime: v.exitTime?.toISOString() ?? null,
            durationSec: v.durationSec ?? (v.exitTime ? Math.round((v.exitTime.getTime() - v.enterTime.getTime()) / 1000) : null),
          }))
          .sort(byName);
        const sum = await this.prisma.$queryRaw<{ s: number | null }[]>`
          SELECT sum(coalesce("durationSec", extract(epoch from ("exitTime" - "enterTime"))::int))::float8 AS s
          FROM "GeofenceVisit"
          WHERE "companyId" = ${ctx.companyId}::uuid AND "objectId" = ANY(${ids}::uuid[])
            AND "enterTime" >= ${range.gte} AND "enterTime" < ${range.lt}`;
        return { ...base, rows: dtos, totals: { count, durationSec: Math.round(sum[0]?.s ?? 0) }, truncated: count > rows.length, totalRows: count };
      }
    }
    throw new BadRequestException(`Unknown report type ${(req as { type: ReportType }).type}`);
  }

  /** Daily summaries of the vehicles in `objects` for the request's days, with vehicle names attached. */
  private async loadDays(companyId: string, objects: Map<string, ObjInfo>, req: ReportRequest): Promise<DailySummaryDto[]> {
    const rows = await this.prisma.dailySummary.findMany({
      where: { companyId, objectId: { in: [...objects.keys()] }, day: { gte: dayDate(req.from), lte: dayDate(req.to) } },
      orderBy: [{ objectId: 'asc' }, { day: 'asc' }],
    });
    return rows.map((r) => {
      const o = objects.get(r.objectId);
      return {
        objectId: r.objectId,
        objectName: o?.name ?? 'Unknown object',
        plateNumber: o?.plateNumber ?? null,
        branchName: o?.branchName ?? null,
        day: r.day.toISOString().slice(0, 10),
        distanceKm: r.distanceKm,
        runningSec: r.runningSec,
        idleSec: r.idleSec,
        stopSec: r.stopSec,
        offlineSec: r.offlineSec,
        overspeedSec: r.overspeedSec,
        overspeedCount: r.overspeedCount,
        tripCount: r.tripCount,
        maxSpeedKph: r.maxSpeedKph,
        avgSpeedKph: r.avgSpeedKph,
        engineSec: r.engineSec,
        firstStart: r.firstStart?.toISOString() ?? null,
        lastStop: r.lastStop?.toISOString() ?? null,
      };
    });
  }
}

/** DailySummary.day is a DATE column: Prisma maps it to UTC midnight. */
function dayDate(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;

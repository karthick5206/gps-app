import { Injectable, Optional } from '@nestjs/common';
import { DashboardSummary, LiveObject, MOVEMENT_STATUSES, type VehicleDayStatsDto } from '@veetracer/shared';
import { allCompaniesOr, objectScopeWhere } from '../access/access-rules';
import { AuthContext } from '../access/auth-context';
import { LicencePolicyService } from '../licences/licence-policy.service';
import { PrismaService } from '../prisma/prisma.service';
import { effectiveSpeedLimit, noDataLive, ObjectMeta } from '../tracking/live-object';
import { openSegments, type SegState } from '../summarizer/segmenter';
import { localDayKey, localMidnight } from '../summarizer/tz';
import { LiveStateService } from './live-state.service';

const DAY_STATS_CACHE_MS = 60_000;
const r1 = (v: number) => Math.round(v * 10) / 10;

@Injectable()
export class LiveService {
  /** Day stats per caller scope (the summarizer refreshes them once a minute). */
  private readonly dayStatsCache = new Map<string, { at: number; value: Record<string, VehicleDayStatsDto> }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly liveState: LiveStateService,
    @Optional() private readonly licences?: LicencePolicyService,
  ) {}

/**
   * Vehicle list figures per object in scope, for today in each company's time zone: the day summary (distance,
   * moving / idle time, max speed, trips), stops started today, the trip in progress (summarizer's open segment) or
   * today's last trip, and the odometer (all recorded km + offset). Licence-locked vehicles are left out.
   */
  async dayStats(ctx: AuthContext, now = Date.now()): Promise<Record<string, VehicleDayStatsDto>> {
    const key = `${ctx.userId}:${ctx.allCompanies ? 'all' : ctx.companyId}`;
    const hit = this.dayStatsCache.get(key);
    if (hit && now - hit.at < DAY_STATS_CACHE_MS) return hit.value;
    const objects = await this.prisma.trackedObject.findMany({
      where: { AND: [allCompaniesOr(ctx, objectScopeWhere(ctx)), { isActive: true }] },
      select: { id: true, odometerOffsetKm: true, company: { select: { timezone: true } } },
    });
    const locked = (await this.licences?.lockedObjectIds(ctx)) ?? new Set<string>();
    const list = objects.filter((o) => !locked.has(o.id));
    const ids = list.map((o) => o.id);
    const out: Record<string, VehicleDayStatsDto> = {};
    if (!ids.length) return out;
    // Today per time zone (usually one).
    const dayOf = new Map<string, { day: string; start: Date }>();
    for (const o of list) {
      const tz = o.company.timezone;
      if (!dayOf.has(tz)) {
        const day = localDayKey(now, tz);
        dayOf.set(tz, { day, start: new Date(localMidnight(day, tz)) });
      }
    }
    const days = [...new Set([...dayOf.values()].map((d) => d.day))].map((d) => new Date(`${d}T00:00:00Z`));
    const earliest = new Date(Math.min(...[...dayOf.values()].map((d) => d.start.getTime())));
    const [summaries, totals, stops, lastTrips, cursors] = await Promise.all([
      this.prisma.dailySummary.findMany({ where: { objectId: { in: ids }, day: { in: days } } }),
      this.prisma.dailySummary.groupBy({ by: ['objectId'], where: { objectId: { in: ids } }, _sum: { distanceKm: true } }),
      this.prisma.stop.findMany({ where: { objectId: { in: ids }, startTime: { gte: earliest } }, select: { objectId: true, startTime: true } }),
      this.prisma.trip.findMany({ where: { objectId: { in: ids }, startTime: { gte: earliest } }, orderBy: { startTime: 'desc' }, distinct: ['objectId'], select: { objectId: true, startTime: true, distanceKm: true, durationSec: true } }),
      this.prisma.summaryCursor.findMany({ where: { objectId: { in: ids } }, select: { objectId: true, state: true } }),
    ]);
    const total = new Map(totals.map((t) => [t.objectId, t._sum.distanceKm ?? 0]));
    const cursor = new Map(cursors.map((c) => [c.objectId, (c.state as { seg?: SegState } | null)?.seg ?? null]));
    for (const o of list) {
      const { day, start } = dayOf.get(o.company.timezone)!;
      const s = summaries.find((x) => x.objectId === o.id && x.day.toISOString().slice(0, 10) === day);
      const seg = cursor.get(o.id);
      let open: ReturnType<typeof openSegments>['trip'] = null;
      try {
        open = seg ? openSegments(seg).trip : null;
      } catch {
        open = null;
      }
      const last = lastTrips.find((t) => t.objectId === o.id && t.startTime >= start);
      const trip = open
        ? { distanceKm: r1(open.distanceKm), durationSec: open.durationSec, ongoing: true }
        : last
          ? { distanceKm: r1(last.distanceKm), durationSec: last.durationSec, ongoing: false }
          : null;
      out[o.id] = {
        distanceKm: r1(s?.distanceKm ?? 0),
        movingSec: s?.runningSec ?? 0,
        idleSec: s?.idleSec ?? 0,
        maxSpeedKph: Math.round(s?.maxSpeedKph ?? 0),
        stops: stops.filter((x) => x.objectId === o.id && x.startTime >= start).length,
        trips: s?.tripCount ?? 0,
        trip,
        odometerKm: Math.round((total.get(o.id) ?? 0) + o.odometerOffsetKm),
      };
    }
    this.dayStatsCache.set(key, { at: now, value: out });
    return out;
  }

  /** Every active object in scope; DB metadata wins over the cached copy inside the live state. */
  async snapshot(ctx: AuthContext): Promise<LiveObject[]> {
    const objects = await this.prisma.trackedObject.findMany({
      where: { AND: [allCompaniesOr(ctx, objectScopeWhere(ctx)), { isActive: true }] },
      select: {
        id: true,
        companyId: true,
        branchId: true,
        name: true,
        plateNumber: true,
        type: true,
        vehicleType: true,
        speedLimitKph: true,
        maintenanceSince: true,
        assignments: { where: { toTime: null }, select: { device: { select: { id: true, uniqueId: true, simNumber: true } } } },
        drivers: { where: { toTime: null }, take: 1, select: { driverId: true, source: true, driver: { select: { name: true } } } },
      },
      orderBy: { name: 'asc' },
    });
    const live = await this.liveState.read(objects.map((o) => o.id));
    const locked = (await this.licences?.lockedObjectIds(ctx)) ?? new Set<string>();
    return objects.map((o) => {
      const device = o.assignments[0]?.device ?? null;
      const meta: ObjectMeta = {
        objectId: o.id,
        companyId: o.companyId,
        branchId: o.branchId,
        name: o.name,
        plateNumber: o.plateNumber,
        type: o.type,
        vehicleType: o.vehicleType,
        deviceId: device?.id ?? null,
        uniqueId: device?.uniqueId ?? null,
        simNumber: device?.simNumber ?? null,
        speedLimitKph: effectiveSpeedLimit(o.speedLimitKph, o.type, o.vehicleType),
        inMaintenance: o.maintenanceSince !== null,
        driverId: o.drivers[0]?.driverId ?? null,
        driverName: o.drivers[0]?.driver.name ?? null,
        driverSource: (o.drivers[0]?.source as 'MANUAL' | 'RFID' | undefined) ?? null,
      };
      // Licence expired past grace: listed (so it can be renewed) but without position or telemetry.
      if (locked.has(o.id)) return { ...noDataLive(meta), licenceLocked: true };
      const state = live.get(o.id);
      return state ? { ...state, ...meta } : noDataLive(meta);
    });
  }

  async summary(ctx: AuthContext): Promise<DashboardSummary> {
    const objects = await this.snapshot(ctx);
    const byStatus: Record<string, number> = Object.fromEntries(MOVEMENT_STATUSES.map((s) => [s, 0]));
    let devicesOnline = 0;
    for (const o of objects) {
      byStatus[o.status] += 1;
      if (o.deviceId && o.status !== 'OFFLINE' && o.status !== 'NO_DATA') devicesOnline += 1;
    }
    return { total: objects.length, byStatus, devicesOnline };
  }
}

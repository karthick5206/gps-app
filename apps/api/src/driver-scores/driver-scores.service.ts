import { Injectable } from '@nestjs/common';
import { safetyScore, SCORE_GROUPS, SCORE_WEIGHTS, type DriverScoreRow, type DriverScoresDto, type ScoreBy, type ScorePeriod } from '@veetracer/shared';
import { allCompaniesOr, objectScopeWhere } from '../access/access-rules';
import { AuthContext } from '../access/auth-context';
import { PrismaService } from '../prisma/prisma.service';
import { resolveRange } from '../smart-search/smart-search.service';

const PERIOD_TIME = {
  week: { kind: 'week', offset: 0 },
  lastWeek: { kind: 'week', offset: -1 },
  month: { kind: 'month', offset: 0 },
  lastMonth: { kind: 'month', offset: -1 },
} as const;

interface Acc {
  km: number;
  idleSec: number;
  engineSec: number;
  nightKm: number;
  events: Record<string, number>;
  vehicles: Set<string>;
}
const acc = (): Acc => ({ km: 0, idleSec: 0, engineSec: 0, nightKm: 0, events: {}, vehicles: new Set() });

/**
 * Driver scorecard: trips and driving-behaviour alerts of the period, credited to the driver assigned to the vehicle
 * at that moment (driver view) or to the vehicle (vehicle view), scored by safetyScore (shared).
 */
@Injectable()
export class DriverScoresService {
  constructor(private readonly prisma: PrismaService) {}

  async scores(ctx: AuthContext, period: ScorePeriod, by: ScoreBy, now = Date.now()): Promise<DriverScoresDto> {
    const company = await this.prisma.company.findUnique({ where: { id: ctx.companyId }, select: { timezone: true } });
    const tz = company?.timezone ?? 'Asia/Kolkata';
    const range = resolveRange(PERIOD_TIME[period], tz, now);
    const from = new Date(range.from);
    const to = new Date(range.to);
    const objects = await this.prisma.trackedObject.findMany({
      where: { AND: [allCompaniesOr(ctx, objectScopeWhere(ctx)), { isActive: true }] },
      select: { id: true, name: true, plateNumber: true },
    });
    const ids = objects.map((o) => o.id);
    const label = new Map(objects.map((o) => [o.id, o.plateNumber && o.plateNumber !== o.name ? `${o.name} (${o.plateNumber})` : o.name]));
    const types = Object.keys(SCORE_WEIGHTS);
    const [trips, alerts, assignments] = await Promise.all([
      this.prisma.trip.findMany({ where: { objectId: { in: ids }, startTime: { gte: from, lt: to } }, select: { objectId: true, startTime: true, distanceKm: true, durationSec: true, idleSec: true } }),
      this.prisma.alert.findMany({ where: { objectId: { in: ids }, occurredAt: { gte: from, lt: to }, type: { in: types } }, select: { objectId: true, occurredAt: true, type: true } }),
      by === 'driver'
        ? this.prisma.driverAssignment.findMany({
            where: { objectId: { in: ids }, fromTime: { lt: to }, OR: [{ toTime: null }, { toTime: { gt: from } }] },
            select: { objectId: true, driverId: true, fromTime: true, toTime: true, driver: { select: { name: true } } },
          })
        : [],
    ]);
    const driverName = new Map(assignments.map((a) => [a.driverId, a.driver.name]));
    /** Who drove the vehicle at that moment: `d:<driverId>`, else the vehicle itself `v:<objectId>`. */
    const who = (objectId: string, at: Date) => {
      if (by === 'driver') {
        const a = assignments.find((x) => x.objectId === objectId && x.fromTime <= at && (!x.toTime || x.toTime > at));
        if (a) return `d:${a.driverId}`;
      }
      return `v:${objectId}`;
    };
    const night = (d: Date) => {
      const h = Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).format(d));
      return h >= 22 || h < 5;
    };
    const rows = new Map<string, Acc>();
    const get = (k: string) => rows.get(k) ?? (rows.set(k, acc()), rows.get(k)!);
    for (const t of trips) {
      const a = get(who(t.objectId, t.startTime));
      a.km += t.distanceKm;
      a.idleSec += t.idleSec;
      a.engineSec += t.durationSec;
      if (night(t.startTime)) a.nightKm += t.distanceKm;
      a.vehicles.add(t.objectId);
    }
    for (const al of alerts) {
      const a = get(who(al.objectId, al.occurredAt));
      a.events[al.type] = (a.events[al.type] ?? 0) + 1;
      a.vehicles.add(al.objectId);
    }
    const sum = (e: Record<string, number>, list: readonly string[]) => list.reduce((s, x) => s + (e[x] ?? 0), 0);
    const out: DriverScoreRow[] = [...rows.entries()].map(([key, a]) => {
      const isDriver = key.startsWith('d:');
      const id = key.slice(2);
      const r = safetyScore({ km: a.km, events: a.events, idleSec: a.idleSec, engineSec: a.engineSec, nightKm: a.nightKm });
      return {
        id,
        kind: isDriver ? 'driver' : 'vehicle',
        name: isDriver ? (driverName.get(id) ?? 'Driver') : (label.get(id) ?? 'Vehicle'),
        detail: isDriver ? [...a.vehicles].map((v) => label.get(v)).filter(Boolean).join(', ') || null : by === 'driver' ? 'No driver assigned' : null,
        km: Math.round(a.km * 10) / 10,
        score: r.score,
        grade: r.grade,
        overspeed: sum(a.events, SCORE_GROUPS.overspeed),
        harsh: sum(a.events, SCORE_GROUPS.harsh),
        dms: sum(a.events, SCORE_GROUPS.dms),
        adas: sum(a.events, SCORE_GROUPS.adas),
        crash: sum(a.events, SCORE_GROUPS.crash),
        idlePct: a.engineSec > 0 ? Math.round((a.idleSec / a.engineSec) * 100) : 0,
        nightKm: Math.round(a.nightKm * 10) / 10,
        penalties: r.penalties,
      };
    });
    // Best first; rows without enough driving last.
    out.sort((x, y) => (y.score ?? -1) - (x.score ?? -1) || y.km - x.km);
    const scored = out.filter((r) => r.score !== null);
    return {
      period,
      by,
      from: from.toISOString(),
      to: to.toISOString(),
      rows: out,
      average: scored.length ? Math.round(scored.reduce((s, r) => s + r.score!, 0) / scored.length) : null,
    };
  }
}

import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DMS_COLUMN_OF, DMS_COLUMNS, DMS_MAX_DAYS, dmsTotal, emptyDmsCounts, type DmsPeriod, type DmsSummaryDto, type DmsVehicleRow } from '@veetracer/shared';
import { allCompaniesOr, objectScopeWhere } from '../access/access-rules';
import { AuthContext } from '../access/auth-context';
import { PrismaService } from '../prisma/prisma.service';
import { resolveRange } from '../smart-search/smart-search.service';
import { addDays, localDayKey, localMidnight } from '../summarizer/tz';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const TYPES = DMS_COLUMNS.flatMap((c) => c.types as readonly string[]);

/** Range of a DMS period in the company zone; custom = whole days `from`..`to` inclusive. */
export function dmsRange(period: DmsPeriod, tz: string, now: number, fromDay?: string, toDay?: string): { from: number; to: number } {
  if (period !== 'custom') {
    const time = period === 'today' ? ({ kind: 'day', offset: 0 } as const) : ({ kind: period, offset: 0 } as const);
    const r = resolveRange(time, tz, now);
    return { from: r.from, to: r.to };
  }
  if (!fromDay || !toDay || !DAY_RE.test(fromDay) || !DAY_RE.test(toDay)) throw new BadRequestException('Choose the from and to dates');
  if (toDay < fromDay) throw new BadRequestException('The to date is before the from date');
  const from = localMidnight(fromDay, tz);
  const to = Math.min(now, localMidnight(addDays(toDay, 1), tz));
  if (to - from > DMS_MAX_DAYS * 86_400_000) throw new BadRequestException(`Choose at most ${DMS_MAX_DAYS} days`);
  if (to <= from) throw new BadRequestException('The range is in the future');
  return { from, to };
}

/** Each local day key from `from` to `to` (exclusive end). */
export function daysBetween(from: number, to: number, tz: string): string[] {
  const days: string[] = [];
  const last = localDayKey(to - 1, tz);
  for (let d = localDayKey(from, tz); d <= last && days.length <= DMS_MAX_DAYS; d = addDays(d, 1)) days.push(d);
  return days;
}

/** DMS dashboard: driver-monitoring and harsh-driving alert counts per vehicle and per day. */
@Injectable()
export class DmsService {
  constructor(private readonly prisma: PrismaService) {}

  async summary(ctx: AuthContext, q: { period: DmsPeriod; from?: string; to?: string; objectId?: string }, now = Date.now()): Promise<DmsSummaryDto> {
    const company = await this.prisma.company.findUnique({ where: { id: ctx.companyId }, select: { timezone: true } });
    const tz = company?.timezone ?? 'Asia/Kolkata';
    const range = dmsRange(q.period, tz, now, q.from, q.to);
    const objects = await this.prisma.trackedObject.findMany({
      where: { AND: [allCompaniesOr(ctx, objectScopeWhere(ctx)), { isActive: true }, q.objectId ? { id: q.objectId } : {}] },
      select: { id: true, name: true, plateNumber: true },
    });
    if (q.objectId && !objects.length) throw new NotFoundException('Vehicle not found');
    const ids = objects.map((o) => o.id);
    const counts = ids.length
      ? await this.prisma.$queryRaw<{ objectId: string; type: string; day: string; n: number }[]>(Prisma.sql`
          SELECT "objectId"::text AS "objectId", type, (("occurredAt" AT TIME ZONE ${tz})::date)::text AS day, count(*)::int AS n
          FROM "Alert"
          WHERE "objectId" = ANY(${ids}::uuid[]) AND type = ANY(${TYPES}::text[])
            AND "occurredAt" >= ${new Date(range.from)} AND "occurredAt" < ${new Date(range.to)}
          GROUP BY 1, 2, 3`)
      : [];

    const byObject = new Map<string, DmsVehicleRow>();
    const totals = emptyDmsCounts();
    const daily = new Map(daysBetween(range.from, range.to, tz).map((d) => [d, emptyDmsCounts()]));
    const info = new Map(objects.map((o) => [o.id, o]));
    for (const c of counts) {
      const col = DMS_COLUMN_OF[c.type];
      const o = info.get(c.objectId);
      if (!col || !o) continue;
      let row = byObject.get(c.objectId);
      if (!row) byObject.set(c.objectId, (row = { objectId: o.id, name: o.name, plateNumber: o.plateNumber, counts: emptyDmsCounts(), total: 0 }));
      row.counts[col] += c.n;
      totals[col] += c.n;
      const d = daily.get(c.day);
      if (d) d[col] += c.n;
    }
    const rows = [...byObject.values()].map((r) => ({ ...r, total: dmsTotal(r.counts) })).sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
    return {
      from: new Date(range.from).toISOString(),
      to: new Date(range.to).toISOString(),
      rows,
      totals,
      daily: [...daily].map(([day, c]) => ({ day, counts: c })),
      vehicles: objects.length,
    };
  }
}

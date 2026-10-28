import { PrismaClient } from '@prisma/client';
import { OUTLIER_LABELS, POSITION_FLAGS, type PointLabel } from '@veetracer/shared';
import { analyzeTrack } from '../point-quality/analyze';
import type { ObjectMeta } from './positions';
import { localDayKey } from './tz';

const DAY_MS = 86_400_000;
/** First run / switch changed: re-check this much history. */
const BACKFILL_MS = 7 * DAY_MS;
/** Earlier fixes analysed with new ones, so their neighbours on both sides are known. */
const CONTEXT_MS = 30 * 60_000;
const MAX_ROWS = 250_000;
const OUTLIER = POSITION_FLAGS.OUTLIER;
const isOutlier = (l: PointLabel) => OUTLIER_LABELS.includes(l);

/**
 * Point analysis, phase 3: runs the analysis (point-quality/analyze) over recently received positions of every object
 * and keeps the OUTLIER flag of each stored position in step with its verdict (spike, jump, inaccurate, fake GPS,
 * invalid). The flag only matters while PointQualitySettings.useInReports is on: trips, daily distance and the History
 * track then skip those positions. Days whose flags change, or all recent days when the switch changes, are marked
 * dirty so the summarizer recomputes them. Nothing runs while point analysis is switched off.
 */
export class OutlierFlagger {
  private lastRunAt: number | null = null;
  private lastUse: boolean | null = null;

  constructor(private readonly prisma: PrismaClient) {}

  /** Whether trips / distance skip outliers (read every summarizer run). */
  async useInReports(): Promise<boolean> {
    const s = await this.prisma.pointQualitySettings.findUnique({ where: { id: 'default' }, select: { enabled: true, useInReports: true } });
    return (s?.enabled ?? true) && (s?.useInReports ?? false);
  }

  async run(now: number, meta: Map<string, ObjectMeta>): Promise<{ objects: number; changed: number }> {
    const s = await this.prisma.pointQualitySettings.findUnique({ where: { id: 'default' }, select: { enabled: true, useInReports: true } });
    if (!(s?.enabled ?? true)) return { objects: 0, changed: 0 };
    const use = s?.useInReports ?? false;
    const switched = this.lastUse !== null && this.lastUse !== use;
    const since = this.lastRunAt === null || switched ? now - BACKFILL_MS : this.lastRunAt - 5 * 60_000;
    this.lastRunAt = now;
    this.lastUse = use;

    const objects = await this.prisma.$queryRaw<{ oid: string; mn: number }[]>`
      SELECT "objectId"::text AS oid, (extract(epoch from min("fixTime")) * 1000)::float8 AS mn
      FROM "Position"
      WHERE "serverTime" > to_timestamp(${since}::float8 / 1000) AND "objectId" IS NOT NULL
      GROUP BY 1`;
    let changed = 0;
    const dirty = new Map<string, string>();
    for (const o of objects) {
      const m = meta.get(o.oid);
      if (!m) continue;
      const rows = await this.prisma.$queryRaw<{ t: number; lat: number; lng: number; spd: number; acc: number | null; mock: boolean; flags: number }[]>`
        SELECT (extract(epoch from "fixTime") * 1000)::float8 AS t, lat, lng, "speedKph"::float8 AS spd,
               ("attributes"->>'accuracyM')::float8 AS acc, coalesce(("attributes"->>'mock')::boolean, false) AS mock, flags
        FROM "Position"
        WHERE "objectId" = ${o.oid}::uuid AND "fixTime" >= to_timestamp(${Math.max(o.mn - CONTEXT_MS, now - BACKFILL_MS - CONTEXT_MS)}::float8 / 1000)
        ORDER BY "fixTime"
        LIMIT ${MAX_ROWS}`;
      if (!rows.length) continue;
      const { labels } = analyzeTrack(rows.map((r) => ({ t: r.t, lat: r.lat, lng: r.lng, acc: r.acc, spdKph: r.spd, mock: r.mock })));
      const set: string[] = [];
      const clear: string[] = [];
      let firstChange = Number.POSITIVE_INFINITY;
      rows.forEach((r, i) => {
        const want = isOutlier(labels[i]);
        const has = (r.flags & OUTLIER) !== 0;
        if (want === has) return;
        (want ? set : clear).push(new Date(r.t).toISOString());
        firstChange = Math.min(firstChange, r.t);
      });
      if (set.length) {
        await this.prisma.$executeRaw`UPDATE "Position" SET flags = flags | ${OUTLIER} WHERE "objectId" = ${o.oid}::uuid AND "fixTime" = ANY(${set}::timestamptz[])`;
      }
      if (clear.length) {
        await this.prisma.$executeRaw`UPDATE "Position" SET flags = flags & ~${OUTLIER}::int WHERE "objectId" = ${o.oid}::uuid AND "fixTime" = ANY(${clear}::timestamptz[])`;
      }
      changed += set.length + clear.length;
      // Recompute from the earliest affected day: flags changed while in use, or the switch itself changed.
      if (use && Number.isFinite(firstChange)) dirty.set(o.oid, localDayKey(firstChange, m.tz));
      if (switched) dirty.set(o.oid, localDayKey(rows[0].t, m.tz));
    }
    if (dirty.size) {
      await this.prisma.$executeRaw`
        INSERT INTO "SummaryDirtyDay" ("objectId", day, "createdAt")
        SELECT u.oid::uuid, u.day::date, now() AT TIME ZONE 'UTC'
        FROM unnest(${[...dirty.keys()]}::text[], ${[...dirty.values()]}::text[]) AS u(oid, day)
        ON CONFLICT DO NOTHING`;
    }
    return { objects: objects.length, changed };
  }
}

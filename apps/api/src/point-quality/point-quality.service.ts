import { ForbiddenException, Injectable } from '@nestjs/common';
import { POINT_LABELS, type PointLabel, type PointQualityResponse, type PointQualitySettingsDto, type QualityPoint } from '@veetracer/shared';
import { AuthContext } from '../access/auth-context';
import { AuditService } from '../audit/audit.service';
import { HistoryService } from '../history/history.service';
import { MOBILE_PROTOCOL } from '../mobile-tracker/mobile-tracker.logic';
import { PrismaService } from '../prisma/prisma.service';
import { analyzeTrack, type InPoint } from './analyze';

/** Points analysed per request (a day of a phone at 3 s while moving is well below this). */
const POINT_CAP = 60_000;
const DAY_MS = 86_400_000;

interface StoredRow {
  t: number;
  lat: number;
  lng: number;
  spd: number;
  acc: number | null;
  mock: boolean;
  device: string;
}

/**
 * History → All points: every point of the range (stored positions, and for phones the raw records the server keeps
 * for 7 days, including the ones the phone flagged or the server thinned out), each labelled by analyzeTrack, plus
 * the cleaned track. Switched on and off platform-wide by the Super Admin (PointQualitySettings).
 */
@Injectable()
export class PointQualityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly history: HistoryService,
    private readonly audit: AuditService,
  ) {}

  async settings(): Promise<PointQualitySettingsDto> {
    const row = await this.prisma.pointQualitySettings.findUnique({ where: { id: 'default' }, select: { enabled: true } });
    return { enabled: row?.enabled ?? true };
  }

  async setEnabled(ctx: AuthContext, enabled: boolean): Promise<PointQualitySettingsDto> {
    if (!ctx.isSuperAdmin) throw new ForbiddenException('Only Super Admin can switch point analysis on or off');
    const before = (await this.settings()).enabled;
    await this.prisma.pointQualitySettings.upsert({
      where: { id: 'default' },
      create: { id: 'default', enabled, updatedById: ctx.userId },
      update: { enabled, updatedById: ctx.userId },
    });
    if (before !== enabled) {
      await this.audit.record(ctx, { action: 'UPDATE', entity: 'PointQualitySettings', entityId: 'default', before: { enabled: before }, after: { enabled } });
    }
    return { enabled };
  }

  async analyze(ctx: AuthContext, objectId: string, fromRaw?: string, toRaw?: string): Promise<PointQualityResponse> {
    if (!(await this.settings()).enabled) throw new ForbiddenException('Point analysis is switched off');
    const meta = await this.history.objectMeta(ctx, objectId);
    const { from, to } = this.history.resolveRange(fromRaw, toRaw, meta);

    const stored = await this.prisma.$queryRaw<StoredRow[]>`
      SELECT (extract(epoch from "fixTime") * 1000)::float8 AS t, lat, lng, "speedKph"::float8 AS spd,
             ("attributes"->>'accuracyM')::float8 AS acc, coalesce(("attributes"->>'mock')::boolean, false) AS mock,
             "deviceId"::text AS device
      FROM "Position"
      WHERE "objectId" = ${objectId}::uuid AND "fixTime" >= ${new Date(from)} AND "fixTime" <= ${new Date(to)}
      ORDER BY "fixTime"
      LIMIT ${POINT_CAP}`;

    // Phones: add the raw records (late uploads arrive up to a day after their fix time).
    const deviceIds = [...new Set(stored.map((r) => r.device))];
    const phones = deviceIds.length
      ? await this.prisma.device.findMany({ where: { id: { in: deviceIds } }, select: { uniqueId: true } })
      : [];
    const raw = phones.length
      ? await this.prisma.rawPacket.findMany({
          where: {
            protocol: MOBILE_PROTOCOL,
            uniqueId: { in: phones.map((p) => p.uniqueId) },
            receivedAt: { gte: new Date(from), lte: new Date(to + DAY_MS) },
          },
          select: { hex: true },
          take: POINT_CAP,
        })
      : [];

    const byTime = new Map<number, InPoint & { source: number }>();
    for (const r of stored) byTime.set(r.t, { t: r.t, lat: r.lat, lng: r.lng, acc: r.acc, spdKph: r.spd, mock: r.mock, source: 0 });
    for (const r of raw) {
      const p = parseRaw(r.hex);
      if (!p || p.t < from || p.t > to || byTime.has(p.t)) continue;
      byTime.set(p.t, { ...p, source: 1 });
    }
    let points = [...byTime.values()].sort((a, b) => a.t - b.t);
    const truncated = points.length > POINT_CAP;
    if (truncated) points = points.slice(0, POINT_CAP);

    const { labels, clean } = analyzeTrack(points);
    const counts = Object.fromEntries(POINT_LABELS.map((l) => [l, 0])) as Record<PointLabel, number>;
    for (const l of labels) counts[l]++;
    const out: QualityPoint[] = points.map((p, i) => [
      p.t,
      round6(p.lat),
      round6(p.lng),
      p.acc === null ? -1 : Math.round(p.acc),
      Math.round(p.spdKph),
      POINT_LABELS.indexOf(labels[i]),
      p.source,
    ]);
    return {
      objectId,
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
      points: out,
      clean: clean.map(([t, lat, lng]) => [t, round6(lat), round6(lng)]),
      counts,
      truncated,
    };
  }
}

const round6 = (v: number) => Math.round(v * 1e6) / 1e6;

/** A raw phone record (RawPacket.hex holds the app point as JSON). */
function parseRaw(text: string): InPoint | null {
  try {
    const r = JSON.parse(text) as { t?: unknown; lat?: unknown; lng?: unknown; acc?: unknown; spd?: unknown; mock?: unknown };
    if (typeof r.t !== 'number' || typeof r.lat !== 'number' || typeof r.lng !== 'number') return null;
    return {
      t: r.t,
      lat: r.lat,
      lng: r.lng,
      acc: typeof r.acc === 'number' ? r.acc : null,
      spdKph: typeof r.spd === 'number' && r.spd >= 0 ? r.spd * 3.6 : 0,
      mock: r.mock === true,
    };
  } catch {
    return null;
  }
}

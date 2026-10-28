import { ForbiddenException, Injectable } from '@nestjs/common';
import { POINT_LABELS, type PointLabel, type PointQualityResponse, type PointQualitySettingsDto, type QualityPoint } from '@veetracer/shared';
import { AuthContext } from '../access/auth-context';
import { AuditService } from '../audit/audit.service';
import { HistoryService } from '../history/history.service';
import { MOBILE_PROTOCOL } from '../mobile-tracker/mobile-tracker.logic';
import { PrismaService } from '../prisma/prisma.service';
import { haversineMeters } from '../tracking/geo';
import { analyzeTrack, type InPoint } from './analyze';
import { distanceToRoad, lineLengthM, matchSegment, OFFROAD_M } from './road-match';

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
    const row = await this.prisma.pointQualitySettings.findUnique({ where: { id: 'default' }, select: { enabled: true, useInReports: true } });
    return { enabled: row?.enabled ?? true, useInReports: row?.useInReports ?? false };
  }

  /** Super Admin: switch the analysis (History → All points) and its use in trips / distance on or off. */
  async setSettings(ctx: AuthContext, patch: Partial<PointQualitySettingsDto>): Promise<PointQualitySettingsDto> {
    if (!ctx.isSuperAdmin) throw new ForbiddenException('Only Super Admin can change point analysis');
    const before = await this.settings();
    const next = { enabled: patch.enabled ?? before.enabled, useInReports: patch.useInReports ?? before.useInReports };
    await this.prisma.pointQualitySettings.upsert({
      where: { id: 'default' },
      create: { id: 'default', ...next, updatedById: ctx.userId },
      update: { ...next, updatedById: ctx.userId },
    });
    if (before.enabled !== next.enabled || before.useInReports !== next.useInReports) {
      await this.audit.record(ctx, { action: 'UPDATE', entity: 'PointQualitySettings', entityId: 'default', before: { ...before }, after: { ...next } });
    }
    return next;
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

    const analysis = analyzeTrack(points);
    const { labels } = analysis;
    let clean = analysis.clean;
    const roadMatched = await this.roadMatch(points, analysis.segments, labels, (c) => (clean = c), clean);
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
      roadMatched,
      distanceKm: { recorded: round3(pathKm(points.filter((_, i) => labels[i] !== 'invalid' && labels[i] !== 'duplicate'))), clean: round3(pathKm(clean.map(([t, lat, lng]) => ({ t, lat, lng })))) },
    };
  }

  /**
   * Phase 2: snaps each moving part to roads (GraphHopper map matching; skipped without the engine or when it fails),
   * labels moving fixes far from the matched road as off-road, and makes the clean track follow the roads.
   */
  private async roadMatch(
    points: InPoint[],
    segments: number[][],
    labels: PointLabel[],
    setClean: (c: [number, number, number][]) => void,
    clean: [number, number, number][],
  ): Promise<boolean> {
    const base = (process.env.ROUTER_URL ?? '').replace(/\/+$/, '');
    if (!base || (process.env.ROUTER_ENGINE ?? '').toLowerCase() !== 'graphhopper' || !segments.length) return false;
    const todo = segments.slice(0, MAX_MATCHED_SEGMENTS);
    const roads: ([number, number][] | null)[] = new Array(todo.length).fill(null);
    let next = 0;
    const worker = async () => {
      while (next < todo.length) {
        const k = next++;
        roads[k] = await matchSegment(base, points, todo[k]).catch(() => null);
      }
    };
    await Promise.all(Array.from({ length: 3 }, worker));
    if (!roads.some(Boolean)) return false;

    let out = clean;
    todo.forEach((seg, k) => {
      const road = roads[k];
      if (!road) return;
      let hint = 0;
      for (const i of seg) {
        const p = points[i];
        const r = distanceToRoad(p.lat, p.lng, road, hint);
        hint = r.idx;
        if (labels[i] === 'good' && r.d > Math.max(OFFROAD_M, 2 * (p.acc ?? 0))) labels[i] = 'offroad';
      }
      // The clean track follows the matched road over this part's time span (times spread by distance).
      const t0 = points[seg[0]].t;
      const t1 = points[seg[seg.length - 1]].t;
      const total = lineLengthM(road) || 1;
      let run = 0;
      const timed: [number, number, number][] = road.map(([lng, lat], j) => {
        if (j > 0) run += lineLengthM([road[j - 1], road[j]]);
        return [Math.round(t0 + ((t1 - t0) * run) / total), lat, lng];
      });
      out = out.filter(([t]) => t < t0 || t > t1).concat(timed);
    });
    setClean(out.sort((a, b) => a[0] - b[0]));
    return true;
  }
}

/** Road matching per request: at most this many moving parts (the busiest days keep the Phase 1 result for the rest). */
const MAX_MATCHED_SEGMENTS = 40;

const round3 = (v: number) => Math.round(v * 1000) / 1000;

function pathKm(points: { lat: number; lng: number }[]): number {
  let m = 0;
  for (let k = 1; k < points.length; k++) m += haversineMeters(points[k - 1].lat, points[k - 1].lng, points[k].lat, points[k].lng);
  return m / 1000;
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

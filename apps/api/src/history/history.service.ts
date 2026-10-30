import { BadRequestException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { Stop, Trip } from '@prisma/client';
import { AlertDto, HistoryResponse, StopDto, TrackPoint, TripDto } from '@veetracer/shared';
import { allCompaniesOr, objectScopeWhere } from '../access/access-rules';
import { AuthContext } from '../access/auth-context';
import { toAlertDto } from '../alerts/alert-dto';
import { LicencePolicyService } from '../licences/licence-policy.service';
import { PrismaService } from '../prisma/prisma.service';
import { fetchPositions, isDrift, ObjectMeta, PosRow, skipFlags, toMeta, toSegPoint } from '../summarizer/positions';
import {
  avgMovingSpeed,
  createState,
  emptyOutput,
  openSegments,
  processPoint,
  round1,
  round3,
  StopOut,
  TripOut,
} from '../summarizer/segmenter';
import { parseCursorState } from '../summarizer/summarizer';
import { nearestIndex, simplifyToBudget } from './simplify';

export const HISTORY_POINT_CAP = 50_000;
export const HISTORY_MAX_DAYS = 31;
const DAY_MS = 86_400_000;
const ALERT_CAP = 5_000;
const round6 = (v: number) => Math.round(v * 1e6) / 1e6;

/** Status codes of TRACK_STATUS_CODES: RUNNING, IDLE, OFF, OVERSPEED. */
const ST_RUNNING = 0;
const ST_IDLE = 1;
const ST_OFF = 2;
const ST_OVERSPEED = 3;

export interface ResolvedRange {
  from: number;
  to: number;
}

interface Segments {
  trips: TripDto[];
  stops: StopDto[];
}

@Injectable()
export class HistoryService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly licences?: LicencePolicyService,
  ) {}

  /**
   * Distance (km) the object drove from `fromMs` until now, by the same trip rules as trips / daily distance (moving
   * parts only, outliers skipped when that is switched on). Used to bring an odometer reading taken earlier up to date.
   */
  async distanceSinceKm(ctx: AuthContext, objectId: string, fromMs: number): Promise<number> {
    const meta = await this.objectMeta(ctx, objectId);
    const rows = await fetchPositions(this.prisma, meta.id, fromMs - 1, Date.now(), undefined, await this.skipFlags());
    const state = createState(fromMs);
    const out = emptyOutput();
    for (const r of rows) processPoint(state, toSegPoint(r, state.last), meta.cfg, out);
    const open = openSegments(state).trip;
    const km = out.trips.reduce((s, t) => s + t.distanceKm, 0) + (open?.distanceKm ?? 0);
    return Math.round(km * 10) / 10;
  }

  async objectMeta(ctx: AuthContext, objectId: string): Promise<ObjectMeta> {
    const o = await this.prisma.trackedObject.findFirst({
      where: { AND: [allCompaniesOr(ctx, objectScopeWhere(ctx)), { id: objectId }] },
      select: {
        id: true,
        companyId: true,
        name: true,
        plateNumber: true,
        branchId: true,
        type: true,
        vehicleType: true,
        speedLimitKph: true,
        company: { select: { timezone: true, retentionDays: true, settings: true } },
      },
    });
    if (!o) throw new NotFoundException('Object not found');
    await this.licences?.assertViewable(ctx, objectId);
    return toMeta(o);
  }

  /** Validates ?from&to (ISO), max 31 days, and clamps the start to the company retention. */
  resolveRange(fromRaw: string | undefined, toRaw: string | undefined, meta: ObjectMeta, now = Date.now()): ResolvedRange {
    if (!fromRaw || !toRaw) throw new BadRequestException('from and to are required (ISO date-time)');
    const from = Date.parse(fromRaw);
    const to = Date.parse(toRaw);
    if (!Number.isFinite(from) || !Number.isFinite(to)) throw new BadRequestException('from and to must be ISO date-times');
    if (to <= from) throw new BadRequestException('to must be after from');
    if (to - from > HISTORY_MAX_DAYS * DAY_MS) throw new BadRequestException(`Range too long (max ${HISTORY_MAX_DAYS} days)`);
    const floor = now - meta.retentionDays * DAY_MS;
    return { from: Math.min(Math.max(from, floor), to), to };
  }

  private skipCache: { at: number; flags: number } | null = null;

  /** Flags left out of the track: outliers too while point analysis is used for reports (setting cached 30 s). */
  private async skipFlags(): Promise<number> {
    if (this.skipCache && Date.now() - this.skipCache.at < 30_000) return this.skipCache.flags;
    const s = await this.prisma.pointQualitySettings.findUnique({ where: { id: 'default' }, select: { enabled: true, useInReports: true } });
    const flags = skipFlags((s?.enabled ?? true) && (s?.useInReports ?? false));
    this.skipCache = { at: Date.now(), flags };
    return flags;
  }

  async history(ctx: AuthContext, objectId: string, fromRaw?: string, toRaw?: string): Promise<HistoryResponse> {
    const meta = await this.objectMeta(ctx, objectId);
    const { from, to } = this.resolveRange(fromRaw, toRaw, meta);
    const [rows, alerts, fuel] = await Promise.all([fetchPositions(this.prisma, objectId, from - 1, to, undefined, await this.skipFlags()), this.alerts(meta, from, to), this.fuelSeries(objectId, from, to)]);
    const { trips, stops } = await this.segments(meta, from, to, rows);

    // Range summary straight from the points.
    const state = createState(from);
    const out = emptyOutput();
    for (const r of rows) processPoint(state, toSegPoint(r, state.last), meta.cfg, out);
    const days = state.day ? [...out.days, state.day] : out.days;
    const sum = days.reduce(
      (a, d) => ({
        distanceM: a.distanceM + d.distanceM,
        runningMs: a.runningMs + d.runningMs,
        idleMs: a.idleMs + d.idleMs,
        stopMs: a.stopMs + d.stopMs,
        maxSpeed: Math.max(a.maxSpeed, d.maxSpeed),
        speedTimeSum: a.speedTimeSum + d.speedTimeSum,
      }),
      { distanceM: 0, runningMs: 0, idleMs: 0, stopMs: 0, maxSpeed: 0, speedTimeSum: 0 },
    );

    const track = this.trackPoints(rows, meta);
    let points = track.points;
    let truncated = false;
    if (points.length > HISTORY_POINT_CAP) {
      const times = points.map((p) => p[0]);
      const forced: number[] = [];
      for (const s of stops) forced.push(nearestIndex(times, Date.parse(s.startTime)), nearestIndex(times, Date.parse(s.endTime)));
      for (const a of alerts) forced.push(nearestIndex(times, Date.parse(a.occurredAt)));
      const keep = simplifyToBudget(
        points.map((p) => p[1]),
        points.map((p) => p[2]),
        HISTORY_POINT_CAP,
        forced,
      );
      points = keep.map((i) => points[i]);
      truncated = true;
    }

    return {
      objectId,
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
      points,
      trips,
      stops,
      alerts,
      summary: {
        distanceKm: round3(sum.distanceM / 1000),
        runningSec: Math.round(sum.runningMs / 1000),
        idleSec: Math.round(sum.idleMs / 1000),
        stopSec: Math.round(sum.stopMs / 1000),
        maxSpeedKph: round1(sum.maxSpeed),
        avgSpeedKph: avgMovingSpeed(sum),
      },
      truncated,
      ...(fuel.length ? { fuel } : {}),
    };
  }

  /** Calibrated fuel level over the range (only vehicles with a fuel sensor store `fuelL`), at most ~1500 points. */
  private async fuelSeries(objectId: string, from: number, to: number): Promise<[number, number][]> {
    const rows = await this.prisma.$queryRaw<{ t: Date; l: number }[]>`
      SELECT "fixTime" AS t, ("attributes"->>'fuelL')::float8 AS l
      FROM "Position"
      WHERE "objectId" = ${objectId}::uuid AND "fixTime" >= ${new Date(from)} AND "fixTime" <= ${new Date(to)}
        AND "attributes"->>'fuelL' IS NOT NULL
      ORDER BY "fixTime"
      LIMIT 200000`;
    const step = Math.max(1, Math.ceil(rows.length / 1500));
    const out: [number, number][] = [];
    for (let i = 0; i < rows.length; i += step) out.push([rows[i].t.getTime(), rows[i].l]);
    if (rows.length && (rows.length - 1) % step !== 0) out.push([rows[rows.length - 1].t.getTime(), rows[rows.length - 1].l]);
    return out;
  }

  async trips(ctx: AuthContext, objectId: string, fromRaw?: string, toRaw?: string): Promise<TripDto[]> {
    const meta = await this.objectMeta(ctx, objectId);
    const { from, to } = this.resolveRange(fromRaw, toRaw, meta);
    return (await this.segments(meta, from, to)).trips;
  }

  async stops(ctx: AuthContext, objectId: string, fromRaw?: string, toRaw?: string): Promise<StopDto[]> {
    const meta = await this.objectMeta(ctx, objectId);
    const { from, to } = this.resolveRange(fromRaw, toRaw, meta);
    return (await this.segments(meta, from, to)).stops;
  }

  /** Clean points; consecutive DRIFT points collapse to the first and last of each run at the parked position. */
  trackPoints(rows: PosRow[], meta: ObjectMeta): { points: TrackPoint[] } {
    const { runningSpeedKph, speedLimitKph } = meta.cfg;
    const points: TrackPoint[] = [];
    let lastLat: number | null = null;
    let lastLng: number | null = null;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const ign = r.ign === null ? -1 : r.ign ? 1 : 0;
      if (isDrift(r)) {
        const prevDrift = i > 0 && isDrift(rows[i - 1]);
        const nextDrift = i + 1 < rows.length && isDrift(rows[i + 1]);
        if (prevDrift && nextDrift) continue;
        points.push([r.t, round6(lastLat ?? r.lat), round6(lastLng ?? r.lng), 0, r.course, ign, r.ign === true ? ST_IDLE : ST_OFF]);
        continue;
      }
      const status =
        r.speed > runningSpeedKph
          ? speedLimitKph !== null && r.speed > speedLimitKph
            ? ST_OVERSPEED
            : ST_RUNNING
          : r.ign === true
            ? ST_IDLE
            : ST_OFF;
      points.push([r.t, round6(r.lat), round6(r.lng), Math.round(r.speed * 10) / 10, r.course, ign, status]);
      lastLat = r.lat;
      lastLng = r.lng;
    }
    return { points };
  }

  /**
   * Trips and stops overlapping [from, to]: rows the summarizer already closed, plus — for the part it has not
   * covered yet (from its open trip/stop onwards) — segments computed on the fly from positions, including the
   * still-open trip/stop as provisional entries (id prefixed `live-`).
   */
  async segments(meta: ObjectMeta, from: number, to: number, rows?: PosRow[]): Promise<Segments> {
    const cursor = await this.prisma.summaryCursor.findUnique({ where: { objectId: meta.id }, select: { state: true } });
    const cs = cursor ? parseCursorState(cursor.state) : null;
    let boundary = from;
    if (cs?.seg.at !== null && cs?.seg.at !== undefined) {
      boundary = Math.min(cs.seg.at, cs.seg.trip?.start ?? Infinity, cs.seg.stat?.start ?? Infinity);
      boundary = Math.min(Math.max(boundary, from), to);
    }

    let trips: TripDto[] = [];
    let stops: StopDto[] = [];
    if (boundary > from) {
      const range = { objectId: meta.id, startTime: { lt: new Date(boundary) }, endTime: { gt: new Date(from) } };
      const [dbTrips, dbStops] = await Promise.all([
        this.prisma.trip.findMany({ where: range, orderBy: { startTime: 'asc' } }),
        this.prisma.stop.findMany({ where: range, orderBy: { startTime: 'asc' } }),
      ]);
      trips = dbTrips.map((t) => tripDto(t, meta));
      stops = dbStops.map((s) => stopDto(s, meta));
    }
    if (boundary < to) {
      const points = rows ? rows.filter((r) => r.t >= boundary) : await fetchPositions(this.prisma, meta.id, boundary - 1, to, undefined, await this.skipFlags());
      const state = createState(boundary);
      const out = emptyOutput();
      for (const r of points) processPoint(state, toSegPoint(r, state.last), meta.cfg, out);
      const open = openSegments(state);
      const liveTrips = open.trip ? [...out.trips, open.trip] : out.trips;
      const liveStops = open.stop ? [...out.stops, open.stop] : out.stops;
      // Reuse addresses the summarizer may already have stored for the same segments.
      const known = await this.knownAddresses(meta.id, liveTrips, liveStops);
      trips.push(...liveTrips.map((t) => liveTripDto(t, meta, known.trips.get(t.start))));
      stops.push(...liveStops.map((s) => liveStopDto(s, meta, known.stops.get(s.start))));
    }
    return { trips, stops };
  }

  private async knownAddresses(objectId: string, trips: TripOut[], stops: StopOut[]) {
    const [t, s] = await Promise.all([
      trips.length
        ? this.prisma.trip.findMany({
            where: { objectId, startTime: { in: trips.map((x) => new Date(x.start)) } },
            select: { id: true, startTime: true, startAddress: true, endAddress: true },
          })
        : [],
      stops.length
        ? this.prisma.stop.findMany({
            where: { objectId, startTime: { in: stops.map((x) => new Date(x.start)) } },
            select: { id: true, startTime: true, address: true },
          })
        : [],
    ]);
    return {
      trips: new Map(t.map((x) => [x.startTime.getTime(), x])),
      stops: new Map(s.map((x) => [x.startTime.getTime(), x])),
    };
  }

  private async alerts(meta: ObjectMeta, from: number, to: number): Promise<AlertDto[]> {
    const rows = await this.prisma.alert.findMany({
      where: { objectId: meta.id, occurredAt: { gte: new Date(from), lte: new Date(to) } },
      orderBy: { occurredAt: 'asc' },
      take: ALERT_CAP,
    });
    if (!rows.length) return [];
    const geofenceIds = [...new Set(rows.map((r) => r.geofenceId).filter((id): id is string => !!id))];
    const userIds = [...new Set(rows.map((r) => r.ackById).filter((id): id is string => !!id))];
    const [geofences, users] = await Promise.all([
      geofenceIds.length ? this.prisma.geofence.findMany({ where: { id: { in: geofenceIds } }, select: { id: true, name: true } }) : [],
      userIds.length ? this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }) : [],
    ]);
    const names = {
      objects: new Map([[meta.id, { name: meta.name, plateNumber: meta.plateNumber, branchId: meta.branchId }]]),
      geofences: new Map(geofences.map((g) => [g.id, g.name])),
      users: new Map(users.map((u) => [u.id, u.name])),
    };
    return rows.map((r) => toAlertDto(r, names));
  }
}

export function tripDto(t: Trip, meta: Pick<ObjectMeta, 'name'>): TripDto {
  return {
    id: t.id,
    objectId: t.objectId,
    objectName: meta.name,
    startTime: t.startTime.toISOString(),
    endTime: t.endTime.toISOString(),
    durationSec: t.durationSec,
    idleSec: t.idleSec,
    startLat: t.startLat,
    startLng: t.startLng,
    endLat: t.endLat,
    endLng: t.endLng,
    startAddress: t.startAddress,
    endAddress: t.endAddress,
    distanceKm: t.distanceKm,
    maxSpeedKph: t.maxSpeedKph,
    avgSpeedKph: t.avgSpeedKph,
  };
}

export function stopDto(s: Stop, meta: Pick<ObjectMeta, 'name'>): StopDto {
  return {
    id: s.id,
    objectId: s.objectId,
    objectName: meta.name,
    startTime: s.startTime.toISOString(),
    endTime: s.endTime.toISOString(),
    durationSec: s.durationSec,
    lat: s.lat,
    lng: s.lng,
    address: s.address,
    ignitionOn: s.ignitionOn,
  };
}

function liveTripDto(
  t: TripOut,
  meta: ObjectMeta,
  known?: { id: string; startAddress: string | null; endAddress: string | null },
): TripDto {
  return {
    id: known?.id ?? `live-${meta.id}-${t.start}`,
    objectId: meta.id,
    objectName: meta.name,
    startTime: new Date(t.start).toISOString(),
    endTime: new Date(t.end).toISOString(),
    durationSec: t.durationSec,
    idleSec: t.idleSec,
    startLat: t.startLat,
    startLng: t.startLng,
    endLat: t.endLat,
    endLng: t.endLng,
    startAddress: known?.startAddress ?? null,
    endAddress: known?.endAddress ?? null,
    distanceKm: t.distanceKm,
    maxSpeedKph: t.maxSpeedKph,
    avgSpeedKph: t.avgSpeedKph,
  };
}

function liveStopDto(s: StopOut, meta: ObjectMeta, known?: { id: string; address: string | null }): StopDto {
  return {
    id: known?.id ?? `live-${meta.id}-${s.start}`,
    objectId: meta.id,
    objectName: meta.name,
    startTime: new Date(s.start).toISOString(),
    endTime: new Date(s.end).toISOString(),
    durationSec: s.durationSec,
    lat: s.lat,
    lng: s.lng,
    address: known?.address ?? null,
    ignitionOn: s.ignitionOn,
  };
}

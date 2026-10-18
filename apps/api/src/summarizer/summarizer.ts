import { Prisma, PrismaClient } from '@prisma/client';
import type Redis from 'ioredis';
import { LateDetector } from './late-detector';
import { POSITION_FLAGS } from '@veetracer/shared';
import { fetchPositionsMany, loadObjectMeta, ObjectMeta, SKIP_FLAGS, toSegPoint } from './positions';
import {
  avgMovingSpeed,
  cloneState,
  createState,
  DayAcc,
  daySeconds,
  emptyOutput,
  extendOffline,
  processPoint,
  round1,
  round3,
  SegOutput,
  SegState,
} from './segmenter';
import { localDayKey, localMidnight } from './tz';

/** Shape of SummaryCursor.state. */
export interface CursorState {
  v: 1;
  seg: SegState;
  /** Segmenter state at local midnight starting each recent day — the restart points for late-data recomputation. */
  snaps: Record<string, SegState>;
}

type Mode = 'incremental' | 'dirty' | 'rebuild';

interface WorkItem {
  objectId: string;
  mode: Mode;
  dirtyDay?: string;
}

interface Ctx {
  meta: ObjectMeta;
  mode: Mode;
  seg: SegState;
  snaps: Record<string, SegState>;
  out: SegOutput;
  after: number;
  /** Delete trips/stops/summaries from this instant / day before rebuilding (dirty mode). */
  deleteFrom?: { ms: number; day: string };
  positions: number;
  atBefore: number | null;
}

export interface RunStats {
  objects: number;
  /** Objects whose rows/cursor were written this run. */
  written: number;
  incremental: number;
  dirty: number;
  rebuilds: number;
  positions: number;
  trips: number;
  stops: number;
  days: number;
  lateObjects: number;
  scannedEntries: number;
  fallback: string | null;
  ms: number;
}

const DAY_MS = 86_400_000;
const SNAPSHOTS_KEPT = 10;
const FUTURE_TOLERANCE_MS = 5 * 60_000;

export interface SummarizerOptions {
  chunkSize?: number;
  pageSize?: number;
}

/** Summarises positions into trips, stops and daily summaries (see M2a spec, Part B "Summarizer process"). */
export class Summarizer {
  private readonly chunkSize: number;
  private readonly pageSize: number;
  readonly detector: LateDetector;

  constructor(
    private readonly prisma: PrismaClient,
    redis: Redis,
    opts: SummarizerOptions = {},
  ) {
    this.chunkSize = opts.chunkSize ?? 100;
    this.pageSize = opts.pageSize ?? 20_000;
    this.detector = new LateDetector(prisma, redis);
  }

  async runOnce(now = Date.now()): Promise<RunStats> {
    const started = Date.now();
    const stats: RunStats = {
      objects: 0,
      written: 0,
      incremental: 0,
      dirty: 0,
      rebuilds: 0,
      positions: 0,
      trips: 0,
      stops: 0,
      days: 0,
      lateObjects: 0,
      scannedEntries: 0,
      fallback: null,
      ms: 0,
    };
    const meta = await loadObjectMeta(this.prisma);
    const cursorRows = await this.prisma.$queryRaw<{ oid: string; pu: number; lt: number | null }[]>`
      SELECT "objectId"::text AS oid, (extract(epoch from "processedUntil") * 1000)::float8 AS pu,
             (state->'seg'->'last'->>'t')::float8 AS lt
      FROM "SummaryCursor"`;
    const processedUntil = new Map(cursorRows.map((r) => [r.oid, r.pu]));
    const lastPoint = new Map(cursorRows.map((r) => [r.oid, r.lt ?? r.pu]));

    // 1. Late fixes since the last run → SummaryDirtyDay rows (persisted first, so a crash can't lose them).
    const scan = await this.detector.scan();
    stats.scannedEntries = scan.entries;
    stats.fallback = scan.fallback;
    const suspects: { oid: string; minFix: number; pu: number; lt: number }[] = [];
    for (const [oid, minFix] of scan.minFix) {
      const m = meta.get(oid);
      const pu = processedUntil.get(oid);
      if (!m || pu === undefined) continue;
      const floor = now - m.retentionDays * DAY_MS;
      if (minFix <= pu && minFix <= now + FUTURE_TOLERANCE_MS) suspects.push({ oid, minFix: Math.max(minFix, floor), pu, lt: lastPoint.get(oid) ?? pu });
    }
    const dirty = (await this.confirmLate(suspects, scan.sinceMs)).map(({ oid, t }) => ({ oid, day: localDayKey(t, meta.get(oid)!.tz) }));
    if (dirty.length) {
      await this.prisma.$executeRaw`
        INSERT INTO "SummaryDirtyDay" ("objectId", day, "createdAt")
        SELECT u.oid::uuid, u.day::date, now() AT TIME ZONE 'UTC'
        FROM unnest(${dirty.map((d) => d.oid)}::text[], ${dirty.map((d) => d.day)}::text[]) AS u(oid, day)
        ON CONFLICT DO NOTHING`;
    }
    await this.detector.commit(scan.nextCursor);
    stats.lateObjects = dirty.length;

    // 2. Work list.
    const work = new Map<string, WorkItem>();
    const dirtyRows = await this.prisma.$queryRaw<{ oid: string; day: string }[]>`
      SELECT "objectId"::text AS oid, to_char(min(day), 'YYYY-MM-DD') AS day FROM "SummaryDirtyDay" GROUP BY 1`;
    const fresh = await this.prisma.$queryRaw<{ oid: string }[]>`
      SELECT o.id::text AS oid FROM "TrackedObject" o
      WHERE NOT EXISTS (SELECT 1 FROM "SummaryCursor" c WHERE c."objectId" = o.id)
        AND EXISTS (SELECT 1 FROM "Position" p WHERE p."objectId" = o.id)`;
    const active = await this.prisma.$queryRaw<{ oid: string }[]>`
      SELECT a."objectId"::text AS oid
      FROM "DeviceAssignment" a
      JOIN "Device" d ON d.id = a."deviceId"
      JOIN "SummaryCursor" c ON c."objectId" = a."objectId"
      WHERE a."toTime" IS NULL AND d."lastSeenAt" IS NOT NULL
        AND (d."lastSeenAt" AT TIME ZONE 'UTC') > c."processedUntil"
        -- devices heard from since this cursor was last written (margin covers processor commit delays)
        AND d."lastSeenAt" > c."updatedAt" - interval '2 minutes'`;
    for (const { oid } of fresh) work.set(oid, { objectId: oid, mode: 'rebuild' });
    for (const { oid, day } of dirtyRows) {
      if (work.has(oid)) continue;
      work.set(oid, processedUntil.has(oid) ? { objectId: oid, mode: 'dirty', dirtyDay: day } : { objectId: oid, mode: 'rebuild' });
    }
    for (const { oid } of active) if (!work.has(oid)) work.set(oid, { objectId: oid, mode: 'incremental' });
    // Silent objects: close out whole past days as offline.
    for (const [oid, pu] of processedUntil) {
      const m = meta.get(oid);
      if (!m || work.has(oid)) continue;
      if (pu < localMidnight(localDayKey(now, m.tz), m.tz)) work.set(oid, { objectId: oid, mode: 'incremental' });
    }

    // 3. Process in chunks, one transaction per chunk.
    const items = [...work.values()].filter((w) => meta.has(w.objectId));
    for (let i = 0; i < items.length; i += this.chunkSize) {
      const chunk = items.slice(i, i + this.chunkSize);
      const result = await this.processChunk(chunk, meta, now);
      stats.positions += result.positions;
      stats.trips += result.trips;
      stats.stops += result.stops;
      stats.days += result.days;
      stats.written += result.written;
      for (const w of chunk) stats[w.mode === 'rebuild' ? 'rebuilds' : w.mode === 'dirty' ? 'dirty' : 'incremental']++;
    }
    stats.objects = items.length;
    stats.ms = Date.now() - started;
    return stats;
  }

  /**
   * A stream entry older than the cursor is only late if its stored row was not already summarised: the processor
   * flagged it LATE (older than the device's newest fix) or it falls inside an offline extension (after the last
   * point), and it was received in the scanned window. Rows committed between the scan bound and the position read
   * are neither, so they don't trigger recomputation.
   */
  private async confirmLate(
    suspects: { oid: string; minFix: number; pu: number; lt: number }[],
    sinceMs: number | null,
  ): Promise<{ oid: string; t: number }[]> {
    if (!suspects.length || sinceMs === null) return [];
    return this.prisma.$queryRaw<{ oid: string; t: number }[]>`
      SELECT c.oid, p.t
      FROM unnest(${suspects.map((s) => s.oid)}::text[], ${suspects.map((s) => String(s.minFix))}::text[],
                  ${suspects.map((s) => String(s.pu))}::text[], ${suspects.map((s) => String(s.lt))}::text[]) AS c(oid, mn, pu, lt)
      CROSS JOIN LATERAL (
        SELECT (extract(epoch from "fixTime") * 1000)::float8 AS t
        FROM "Position"
        WHERE "objectId" = c.oid::uuid
          AND "fixTime" >= to_timestamp(c.mn::float8 / 1000) AND "fixTime" <= to_timestamp(c.pu::float8 / 1000)
          AND "serverTime" > to_timestamp(${sinceMs}::float8 / 1000)
          AND valid AND (flags & ${SKIP_FLAGS}) = 0
          AND ((flags & ${POSITION_FLAGS.LATE}) <> 0 OR "fixTime" > to_timestamp(c.lt::float8 / 1000))
        ORDER BY "fixTime"
        LIMIT 1
      ) p`;
  }

  private async processChunk(chunk: WorkItem[], meta: Map<string, ObjectMeta>, now: number) {
    const ids = chunk.map((w) => w.objectId);
    const stored = await this.prisma.summaryCursor.findMany({ where: { objectId: { in: ids } }, select: { objectId: true, state: true } });
    const states = new Map(stored.map((s) => [s.objectId, parseCursorState(s.state)]));

    const ctxs: Ctx[] = [];
    for (const w of chunk) {
      const m = meta.get(w.objectId)!;
      const floor = now - m.retentionDays * DAY_MS;
      const cs = states.get(w.objectId) ?? null;
      let mode: Mode = cs ? w.mode : 'rebuild';
      let ctx: Ctx | null = null;
      if (mode === 'dirty' && cs && w.dirtyDay) {
        const snapDay = Object.keys(cs.snaps)
          .filter((d) => d <= w.dirtyDay!)
          .sort()
          .pop();
        if (snapDay) {
          const ms = localMidnight(snapDay, m.tz);
          const snaps = Object.fromEntries(Object.entries(cs.snaps).filter(([d]) => d <= snapDay));
          ctx = { meta: m, mode, seg: cloneState(cs.snaps[snapDay]), snaps, out: emptyOutput(), after: ms, deleteFrom: { ms, day: snapDay }, positions: 0, atBefore: null };
        } else {
          mode = 'rebuild';
        }
      }
      if (!ctx && mode === 'incremental' && cs) {
        ctx = { meta: m, mode, seg: cs.seg, snaps: cs.snaps, out: emptyOutput(), after: cs.seg.at ?? floor, positions: 0, atBefore: cs.seg.at };
      }
      if (!ctx) ctx = { meta: m, mode: 'rebuild', seg: createState(), snaps: {}, out: emptyOutput(), after: floor, positions: 0, atBefore: null };
      ctxs.push(ctx);
    }

    // Page through new positions; objects with a full page get another round.
    let pending = ctxs;
    while (pending.length) {
      const rows = await fetchPositionsMany(
        this.prisma,
        pending.map((c) => ({ objectId: c.meta.id, afterMs: c.after })),
        now,
        this.pageSize,
      );
      const next: Ctx[] = [];
      for (const c of pending) {
        const list = rows.get(c.meta.id) ?? [];
        for (const r of list) processPoint(c.seg, toSegPoint(r, c.seg.last), c.meta.cfg, c.out);
        c.positions += list.length;
        if (list.length === this.pageSize) {
          c.after = list[list.length - 1].t;
          next.push(c);
        }
      }
      pending = next;
    }

    for (const c of ctxs) {
      extendOffline(c.seg, localMidnight(localDayKey(now, c.meta.tz), c.meta.tz), c.meta.cfg, c.out);
      for (const s of c.out.snapshots) c.snaps[s.day] = s.state;
      const keep = Object.keys(c.snaps).sort().slice(-SNAPSHOTS_KEPT);
      c.snaps = Object.fromEntries(keep.map((d) => [d, c.snaps[d]]));
    }

    return this.persist(ctxs);
  }

  private async persist(all: Ctx[]) {
    // Incremental objects without new data or day changes need no writes.
    const ctxs = all.filter(
      (c) => c.mode !== 'incremental' || c.positions > 0 || c.out.days.length > 0 || c.seg.at !== c.atBefore,
    );
    const tripRows = new Map<string, TripRow>();
    const stopRows = new Map<string, StopRow>();
    const dayRows = new Map<string, DayRow>();
    const touchedDays = new Map<string, { oid: string; day: string; tz: string }>();
    for (const c of ctxs) {
      const { id: oid, companyId, tz } = c.meta;
      for (const t of c.out.trips) {
        tripRows.set(`${oid}|${t.start}`, { oid, companyId, ...t });
        const day = localDayKey(t.start, tz);
        touchedDays.set(`${oid}|${day}`, { oid, day, tz });
      }
      for (const s of c.out.stops) stopRows.set(`${oid}|${s.start}`, { oid, companyId, ...s });
      const days = c.seg.day ? [...c.out.days, c.seg.day] : c.out.days;
      for (const d of days) {
        dayRows.set(`${oid}|${d.day}`, toDayRow(oid, companyId, d));
        touchedDays.set(`${oid}|${d.day}`, { oid, day: d.day, tz });
      }
    }
    const trips = [...tripRows.values()];
    const stops = [...stopRows.values()];
    const days = [...dayRows.values()];
    const rebuildIds = ctxs.filter((c) => c.mode === 'rebuild').map((c) => c.meta.id);
    const dirtyCtx = ctxs.filter((c) => c.mode === 'dirty' && c.deleteFrom);
    const cleanIds = ctxs.filter((c) => c.mode !== 'incremental').map((c) => c.meta.id);
    const cursors = ctxs.filter((c) => c.seg.at !== null);

    await this.prisma.$transaction(
      async (tx) => {
        if (rebuildIds.length) {
          await tx.$executeRaw`DELETE FROM "Trip" WHERE "objectId" = ANY(${rebuildIds}::uuid[])`;
          await tx.$executeRaw`DELETE FROM "Stop" WHERE "objectId" = ANY(${rebuildIds}::uuid[])`;
          await tx.$executeRaw`DELETE FROM "DailySummary" WHERE "objectId" = ANY(${rebuildIds}::uuid[])`;
        }
        if (dirtyCtx.length) {
          const oids = dirtyCtx.map((c) => c.meta.id);
          const froms = dirtyCtx.map((c) => String(c.deleteFrom!.ms));
          const fromDays = dirtyCtx.map((c) => c.deleteFrom!.day);
          for (const table of ['Trip', 'Stop'] as const) {
            await tx.$executeRaw`
              DELETE FROM ${Prisma.raw(`"${table}"`)} t USING unnest(${oids}::text[], ${froms}::text[]) AS u(oid, f)
              WHERE t."objectId" = u.oid::uuid
                AND (t."startTime" >= to_timestamp(u.f::float8 / 1000) OR t."endTime" > to_timestamp(u.f::float8 / 1000))`;
          }
          await tx.$executeRaw`
            DELETE FROM "DailySummary" s USING unnest(${oids}::text[], ${fromDays}::text[]) AS u(oid, day)
            WHERE s."objectId" = u.oid::uuid AND s.day >= u.day::date`;
        }
        if (cleanIds.length) await tx.$executeRaw`DELETE FROM "SummaryDirtyDay" WHERE "objectId" = ANY(${cleanIds}::uuid[])`;
        await upsertTrips(tx, trips);
        await upsertStops(tx, stops);
        await upsertDays(tx, days);
        await updateTripAggregates(tx, [...touchedDays.values()]);
        if (cursors.length) {
          await tx.$executeRaw`
            INSERT INTO "SummaryCursor" ("objectId", "processedUntil", state, "updatedAt")
            SELECT u.oid::uuid, to_timestamp(u.pu::float8 / 1000), u.st::jsonb, now() AT TIME ZONE 'UTC'
            FROM unnest(${cursors.map((c) => c.meta.id)}::text[], ${cursors.map((c) => String(c.seg.at))}::text[],
                        ${cursors.map((c) => JSON.stringify({ v: 1, seg: c.seg, snaps: c.snaps } satisfies CursorState))}::text[])
                 AS u(oid, pu, st)
            ON CONFLICT ("objectId") DO UPDATE
              SET "processedUntil" = EXCLUDED."processedUntil", state = EXCLUDED.state, "updatedAt" = EXCLUDED."updatedAt"`;
        }
      },
      { timeout: 120_000, maxWait: 30_000 },
    );
    return { positions: ctxs.reduce((a, c) => a + c.positions, 0), trips: trips.length, stops: stops.length, days: days.length, written: ctxs.length };
  }
}

export function parseCursorState(value: unknown): CursorState | null {
  const v = value as Partial<CursorState> | null;
  if (!v || v.v !== 1 || !v.seg) return null;
  return { v: 1, seg: v.seg, snaps: v.snaps ?? {} };
}

interface TripRow {
  oid: string;
  companyId: string;
  start: number;
  end: number;
  startLat: number;
  startLng: number;
  endLat: number;
  endLng: number;
  distanceKm: number;
  durationSec: number;
  idleSec: number;
  maxSpeedKph: number;
  avgSpeedKph: number;
}

interface StopRow {
  oid: string;
  companyId: string;
  start: number;
  end: number;
  lat: number;
  lng: number;
  durationSec: number;
  ignitionOn: boolean;
}

interface DayRow {
  oid: string;
  companyId: string;
  day: string;
  distanceKm: number;
  runningSec: number;
  idleSec: number;
  stopSec: number;
  offlineSec: number;
  overspeedSec: number;
  overspeedCount: number;
  maxSpeedKph: number;
  avgSpeedKph: number;
  engineSec: number;
}

function toDayRow(oid: string, companyId: string, d: DayAcc): DayRow {
  const s = daySeconds(d);
  return {
    oid,
    companyId,
    day: d.day,
    distanceKm: round3(d.distanceM / 1000),
    ...s,
    overspeedCount: d.overspeedCount,
    maxSpeedKph: round1(d.maxSpeed),
    avgSpeedKph: avgMovingSpeed(d),
  };
}

const col = <T>(rows: T[], f: (r: T) => string | number | boolean) => rows.map((r) => String(f(r)));
const BATCH = 2000;

async function upsertTrips(tx: Prisma.TransactionClient, all: TripRow[]): Promise<void> {
  for (let i = 0; i < all.length; i += BATCH) {
    const rows = all.slice(i, i + BATCH);
    await tx.$executeRaw`
      INSERT INTO "Trip" (id, "companyId", "objectId", "startTime", "endTime", "startLat", "startLng", "endLat", "endLng",
                          "distanceKm", "durationSec", "idleSec", "maxSpeedKph", "avgSpeedKph")
      SELECT gen_random_uuid(), u.c::uuid, u.o::uuid, to_timestamp(u.st::float8 / 1000), to_timestamp(u.et::float8 / 1000),
             u.sla::float8, u.slo::float8, u.ela::float8, u.elo::float8, u.dk::float8, u.ds::int, u.id::int, u.mx::float8, u.av::float8
      FROM unnest(${col(rows, (r) => r.companyId)}::text[], ${col(rows, (r) => r.oid)}::text[], ${col(rows, (r) => r.start)}::text[],
                  ${col(rows, (r) => r.end)}::text[], ${col(rows, (r) => r.startLat)}::text[], ${col(rows, (r) => r.startLng)}::text[],
                  ${col(rows, (r) => r.endLat)}::text[], ${col(rows, (r) => r.endLng)}::text[], ${col(rows, (r) => r.distanceKm)}::text[],
                  ${col(rows, (r) => r.durationSec)}::text[], ${col(rows, (r) => r.idleSec)}::text[], ${col(rows, (r) => r.maxSpeedKph)}::text[],
                  ${col(rows, (r) => r.avgSpeedKph)}::text[])
           AS u(c, o, st, et, sla, slo, ela, elo, dk, ds, id, mx, av)
      ON CONFLICT ("objectId", "startTime") DO UPDATE SET
        "endTime" = EXCLUDED."endTime", "startLat" = EXCLUDED."startLat", "startLng" = EXCLUDED."startLng",
        "endLat" = EXCLUDED."endLat", "endLng" = EXCLUDED."endLng", "distanceKm" = EXCLUDED."distanceKm",
        "durationSec" = EXCLUDED."durationSec", "idleSec" = EXCLUDED."idleSec", "maxSpeedKph" = EXCLUDED."maxSpeedKph",
        "avgSpeedKph" = EXCLUDED."avgSpeedKph",
        "endAddress" = CASE WHEN "Trip"."endLat" = EXCLUDED."endLat" AND "Trip"."endLng" = EXCLUDED."endLng" THEN "Trip"."endAddress" END`;
  }
}

async function upsertStops(tx: Prisma.TransactionClient, all: StopRow[]): Promise<void> {
  for (let i = 0; i < all.length; i += BATCH) {
    const rows = all.slice(i, i + BATCH);
    await tx.$executeRaw`
      INSERT INTO "Stop" (id, "companyId", "objectId", "startTime", "endTime", lat, lng, "durationSec", "ignitionOn")
      SELECT gen_random_uuid(), u.c::uuid, u.o::uuid, to_timestamp(u.st::float8 / 1000), to_timestamp(u.et::float8 / 1000),
             u.la::float8, u.lo::float8, u.ds::int, u.ig::boolean
      FROM unnest(${col(rows, (r) => r.companyId)}::text[], ${col(rows, (r) => r.oid)}::text[], ${col(rows, (r) => r.start)}::text[],
                  ${col(rows, (r) => r.end)}::text[], ${col(rows, (r) => r.lat)}::text[], ${col(rows, (r) => r.lng)}::text[],
                  ${col(rows, (r) => r.durationSec)}::text[], ${col(rows, (r) => r.ignitionOn)}::text[])
           AS u(c, o, st, et, la, lo, ds, ig)
      ON CONFLICT ("objectId", "startTime") DO UPDATE SET
        "endTime" = EXCLUDED."endTime", "durationSec" = EXCLUDED."durationSec", "ignitionOn" = EXCLUDED."ignitionOn",
        lat = EXCLUDED.lat, lng = EXCLUDED.lng,
        address = CASE WHEN "Stop".lat = EXCLUDED.lat AND "Stop".lng = EXCLUDED.lng THEN "Stop".address END`;
  }
}

async function upsertDays(tx: Prisma.TransactionClient, all: DayRow[]): Promise<void> {
  for (let i = 0; i < all.length; i += BATCH) {
    const rows = all.slice(i, i + BATCH);
    await tx.$executeRaw`
      INSERT INTO "DailySummary" ("objectId", day, "companyId", "distanceKm", "runningSec", "idleSec", "stopSec", "offlineSec",
                                  "overspeedSec", "overspeedCount", "maxSpeedKph", "avgSpeedKph", "engineSec", "updatedAt")
      SELECT u.o::uuid, u.d::date, u.c::uuid, u.dk::float8, u.rs::int, u.ids::int, u.ss::int, u.os::int, u.ovs::int, u.ovc::int,
             u.mx::float8, u.av::float8, u.es::int, now() AT TIME ZONE 'UTC'
      FROM unnest(${col(rows, (r) => r.oid)}::text[], ${col(rows, (r) => r.day)}::text[], ${col(rows, (r) => r.companyId)}::text[],
                  ${col(rows, (r) => r.distanceKm)}::text[], ${col(rows, (r) => r.runningSec)}::text[], ${col(rows, (r) => r.idleSec)}::text[],
                  ${col(rows, (r) => r.stopSec)}::text[], ${col(rows, (r) => r.offlineSec)}::text[], ${col(rows, (r) => r.overspeedSec)}::text[],
                  ${col(rows, (r) => r.overspeedCount)}::text[], ${col(rows, (r) => r.maxSpeedKph)}::text[], ${col(rows, (r) => r.avgSpeedKph)}::text[],
                  ${col(rows, (r) => r.engineSec)}::text[])
           AS u(o, d, c, dk, rs, ids, ss, os, ovs, ovc, mx, av, es)
      ON CONFLICT ("objectId", day) DO UPDATE SET
        "distanceKm" = EXCLUDED."distanceKm", "runningSec" = EXCLUDED."runningSec", "idleSec" = EXCLUDED."idleSec",
        "stopSec" = EXCLUDED."stopSec", "offlineSec" = EXCLUDED."offlineSec", "overspeedSec" = EXCLUDED."overspeedSec",
        "overspeedCount" = EXCLUDED."overspeedCount", "maxSpeedKph" = EXCLUDED."maxSpeedKph", "avgSpeedKph" = EXCLUDED."avgSpeedKph",
        "engineSec" = EXCLUDED."engineSec", "updatedAt" = EXCLUDED."updatedAt"`;
  }
}

/** tripCount / firstStart / lastStop of each touched day, from the Trip table (trips belong to their start day). */
async function updateTripAggregates(tx: Prisma.TransactionClient, keys: { oid: string; day: string; tz: string }[]): Promise<void> {
  for (let i = 0; i < keys.length; i += BATCH) {
    const rows = keys.slice(i, i + BATCH);
    await tx.$executeRaw`
      UPDATE "DailySummary" ds
      SET "tripCount" = a.c, "firstStart" = a.fs AT TIME ZONE 'UTC', "lastStop" = a.ls AT TIME ZONE 'UTC'
      FROM unnest(${col(rows, (r) => r.oid)}::text[], ${col(rows, (r) => r.day)}::text[], ${col(rows, (r) => r.tz)}::text[]) AS k(oid, day, tz)
      CROSS JOIN LATERAL (
        SELECT count(*)::int AS c, min(t."startTime") AS fs, max(t."endTime") AS ls
        FROM "Trip" t
        WHERE t."objectId" = k.oid::uuid
          AND t."startTime" >= (k.day::date::timestamp AT TIME ZONE k.tz)
          AND t."startTime" < ((k.day::date + 1)::timestamp AT TIME ZONE k.tz)
      ) a
      WHERE ds."objectId" = k.oid::uuid AND ds.day = k.day::date`;
  }
}

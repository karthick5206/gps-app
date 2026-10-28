import { Prisma, PrismaClient } from '@prisma/client';
import { MAX_PLAUSIBLE_SPEED_KPH, ObjectType, POSITION_FLAGS, VehicleType } from '@veetracer/shared';
import { effectiveSpeedLimit } from '../tracking/live-object';
import { companyThresholds } from '../tracking/thresholds';
import { SegConfig, SegPoint } from './segmenter';

/** Flags that make a point unusable for summaries / tracks (DRIFT and LATE points are used). */
export const SKIP_FLAGS =
  POSITION_FLAGS.INVALID_FIX | POSITION_FLAGS.JUMP | POSITION_FLAGS.FUTURE | POSITION_FLAGS.LBS;

/** SKIP_FLAGS, plus the analysis outliers while "use cleaned points" is on (point analysis phase 3). */
export const skipFlags = (cleaned: boolean): number => SKIP_FLAGS | (cleaned ? POSITION_FLAGS.OUTLIER : 0);

export interface PosRow {
  t: number; // epoch ms
  lat: number;
  lng: number;
  speed: number;
  course: number;
  ign: boolean | null;
  flags: number;
}

export const isDrift = (r: PosRow) => (r.flags & POSITION_FLAGS.DRIFT) !== 0;

/** Clean point for the segmenter: DRIFT = stationary at the previous clean coordinates. */
export function toSegPoint(r: PosRow, prev: SegPoint | null): SegPoint {
  if (isDrift(r)) return { t: r.t, lat: prev?.lat ?? r.lat, lng: prev?.lng ?? r.lng, speed: 0, ign: r.ign };
  return { t: r.t, lat: r.lat, lng: r.lng, speed: r.speed, ign: r.ign };
}

type Db = PrismaClient | Prisma.TransactionClient;

/** Clean positions of one object with fromMs < fixTime ≤ toMs, ascending. */
export async function fetchPositions(db: Db, objectId: string, fromMs: number, toMs: number, limit = 1_000_000, skip = SKIP_FLAGS): Promise<PosRow[]> {
  return db.$queryRaw<PosRow[]>`
    SELECT (extract(epoch from "fixTime") * 1000)::float8 AS t, lat, lng, "speedKph"::float8 AS speed,
           course::int AS course, ignition AS ign, flags
    FROM "Position"
    WHERE "objectId" = ${objectId}::uuid
      AND "fixTime" > to_timestamp(${fromMs}::float8 / 1000) AND "fixTime" <= to_timestamp(${toMs}::float8 / 1000)
      AND valid AND (flags & ${skip}) = 0
    ORDER BY "fixTime"
    LIMIT ${limit}`;
}

/** Same as fetchPositions for many objects at once (each with its own lower bound), at most `perObject` rows each. */
export async function fetchPositionsMany(
  db: Db,
  items: { objectId: string; afterMs: number }[],
  toMs: number,
  perObject: number,
  skip = SKIP_FLAGS,
): Promise<Map<string, PosRow[]>> {
  const result = new Map<string, PosRow[]>();
  if (!items.length) return result;
  const rows = await db.$queryRaw<(PosRow & { oid: string })[]>`
    SELECT c.oid::text AS oid, p.*
    FROM unnest(${items.map((i) => i.objectId)}::text[], ${items.map((i) => String(i.afterMs))}::text[]) AS c(oid, after)
    CROSS JOIN LATERAL (
      SELECT (extract(epoch from "fixTime") * 1000)::float8 AS t, lat, lng, "speedKph"::float8 AS speed,
             course::int AS course, ignition AS ign, flags
      FROM "Position"
      WHERE "objectId" = c.oid::uuid
        AND "fixTime" > to_timestamp(c.after::float8 / 1000) AND "fixTime" <= to_timestamp(${toMs}::float8 / 1000)
        AND valid AND (flags & ${skip}) = 0
      ORDER BY "fixTime"
      LIMIT ${perObject}
    ) p
    ORDER BY c.oid, p.t`;
  for (const r of rows) {
    const { oid, ...row } = r;
    let list = result.get(oid);
    if (!list) result.set(oid, (list = []));
    list.push(row);
  }
  return result;
}

export interface ObjectMeta {
  id: string;
  companyId: string;
  name: string;
  plateNumber: string | null;
  branchId: string | null;
  tz: string;
  retentionDays: number;
  cfg: SegConfig;
}

/** Objects with their company timezone / thresholds and the segmenter configuration. */
export async function loadObjectMeta(db: Db, where: Prisma.TrackedObjectWhereInput = {}): Promise<Map<string, ObjectMeta>> {
  const rows = await db.trackedObject.findMany({
    where,
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
  const map = new Map<string, ObjectMeta>();
  for (const o of rows) map.set(o.id, toMeta(o));
  return map;
}

export function toMeta(o: {
  id: string;
  companyId: string;
  name: string;
  plateNumber: string | null;
  branchId: string | null;
  type: ObjectType;
  vehicleType: VehicleType | null;
  speedLimitKph: number | null;
  company: { timezone: string; retentionDays: number; settings: unknown };
}): ObjectMeta {
  const thresholds = companyThresholds(o.company.settings);
  return {
    id: o.id,
    companyId: o.companyId,
    name: o.name,
    plateNumber: o.plateNumber,
    branchId: o.branchId,
    tz: o.company.timezone,
    retentionDays: o.company.retentionDays,
    cfg: {
      tz: o.company.timezone,
      runningSpeedKph: thresholds.runningSpeedKph,
      offlineAfterSec: thresholds.offlineAfterSec,
      speedLimitKph: effectiveSpeedLimit(o.speedLimitKph, o.type, o.vehicleType),
      maxPlausibleKph: MAX_PLAUSIBLE_SPEED_KPH[o.type],
    },
  };
}

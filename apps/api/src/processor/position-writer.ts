import { Prisma, PrismaClient } from '@prisma/client';

export interface PositionRow {
  objectId: string | null;
  deviceId: string;
  fixTime: string;
  serverTime: string;
  lat: number;
  lng: number;
  speedKph: number;
  course: number;
  altitude: number | null;
  satellites: number | null;
  valid: boolean;
  ignition: boolean | null;
  flags: number;
  attributes: string; // JSON
}

export interface RawPacketRow {
  uniqueId: string;
  protocol: string;
  remoteAddress: string | null;
  receivedAt: string;
  hex: string;
}

export interface UnknownDeviceRow {
  uniqueId: string;
  protocol: string;
  remoteAddress: string | null;
  seenAt: string;
  count: number;
}

export interface WriteBatch {
  positions: PositionRow[];
  rawPackets: RawPacketRow[];
  unknownDevices: UnknownDeviceRow[];
  lastSeen: { deviceId: string; at: string }[];
}

const str = (v: number | boolean | null) => (v === null ? null : String(v));

/**
 * Writes one processor batch in a single transaction. Columns are passed as parameterised text arrays and
 * expanded with unnest(), so a batch of any size is one statement per table.
 */
export async function writeBatch(
  prisma: PrismaClient,
  batch: WriteBatch,
  extra: Prisma.PrismaPromise<number>[] = [],
): Promise<void> {
  const statements: Prisma.PrismaPromise<number>[] = [];
  const { positions: p, rawPackets: r, unknownDevices: u, lastSeen: s } = batch;

  if (p.length) {
    statements.push(prisma.$executeRaw`
      INSERT INTO "Position" ("objectId", "deviceId", "fixTime", "serverTime", "lat", "lng", "speedKph", "course",
                              "altitude", "satellites", "valid", "ignition", "flags", "attributes")
      SELECT * FROM unnest(
        ${p.map((x) => x.objectId)}::text[]::uuid[],
        ${p.map((x) => x.deviceId)}::text[]::uuid[],
        ${p.map((x) => x.fixTime)}::text[]::timestamptz[],
        ${p.map((x) => x.serverTime)}::text[]::timestamptz[],
        ${p.map((x) => String(x.lat))}::text[]::float8[],
        ${p.map((x) => String(x.lng))}::text[]::float8[],
        ${p.map((x) => String(x.speedKph))}::text[]::real[],
        ${p.map((x) => String(x.course))}::text[]::smallint[],
        ${p.map((x) => str(x.altitude))}::text[]::real[],
        ${p.map((x) => str(x.satellites))}::text[]::smallint[],
        ${p.map((x) => String(x.valid))}::text[]::boolean[],
        ${p.map((x) => str(x.ignition))}::text[]::boolean[],
        ${p.map((x) => String(x.flags))}::text[]::integer[],
        ${p.map((x) => x.attributes)}::text[]::jsonb[]
      )
      ON CONFLICT DO NOTHING`);
  }
  if (r.length) {
    statements.push(prisma.$executeRaw`
      INSERT INTO "RawPacket" ("uniqueId", "protocol", "remoteAddress", "receivedAt", "hex")
      SELECT * FROM unnest(
        ${r.map((x) => x.uniqueId)}::text[],
        ${r.map((x) => x.protocol)}::text[],
        ${r.map((x) => x.remoteAddress)}::text[],
        ${r.map((x) => x.receivedAt)}::text[]::timestamptz[],
        ${r.map((x) => x.hex)}::text[]
      )`);
  }
  if (u.length) {
    statements.push(prisma.$executeRaw`
      INSERT INTO "UnknownDevice" ("uniqueId", "protocol", "remoteAddress", "firstSeenAt", "lastSeenAt", "packetCount")
      SELECT id, proto, remote, seen, seen, n FROM unnest(
        ${u.map((x) => x.uniqueId)}::text[],
        ${u.map((x) => x.protocol)}::text[],
        ${u.map((x) => x.remoteAddress)}::text[],
        ${u.map((x) => x.seenAt)}::text[]::timestamptz[],
        ${u.map((x) => String(x.count))}::text[]::integer[]
      ) AS t(id, proto, remote, seen, n)
      ON CONFLICT ("uniqueId") DO UPDATE SET
        "lastSeenAt" = EXCLUDED."lastSeenAt",
        "remoteAddress" = EXCLUDED."remoteAddress",
        "packetCount" = "UnknownDevice"."packetCount" + EXCLUDED."packetCount"`);
  }
  if (s.length) {
    statements.push(prisma.$executeRaw`
      UPDATE "Device" AS d SET "lastSeenAt" = t.at
      FROM unnest(${s.map((x) => x.deviceId)}::text[]::uuid[], ${s.map((x) => x.at)}::text[]::timestamptz[]) AS t(id, at)
      WHERE d.id = t.id`);
  }
  // Extra statements (alert rows, geofence visits) commit atomically with the positions they came from.
  statements.push(...extra);
  if (statements.length) await prisma.$transaction(statements);
}

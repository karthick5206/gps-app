/**
 * Part B test data: inserts one synthetic day (10 s fixes = 8,640 points) of positions for an object, or removes them.
 *   npx tsx scripts/partb-synth-day.ts --object <uuid> --day 2026-10-17 [--from-hour 0 --to-hour 24]
 *   npx tsx scripts/partb-synth-day.ts --object <uuid> --day 2026-10-17 --delete
 * Rows are marked with attributes.synthetic = true so --delete only removes what this script created.
 */
import { PrismaClient } from '@prisma/client';
import { loadEnv } from '../src/config/env';
import { localMidnight } from '../src/summarizer/tz';

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  if (fallback === undefined) throw new Error(`--${name} is required`);
  return fallback;
}

async function main(): Promise<void> {
  loadEnv();
  const prisma = new PrismaClient();
  const objectId = arg('object');
  const day = arg('day');
  const start = localMidnight(day, 'Asia/Kolkata') + Number(arg('from-hour', '0')) * 3600_000;
  const end = localMidnight(day, 'Asia/Kolkata') + Number(arg('to-hour', '24')) * 3600_000;
  const assignment = await prisma.deviceAssignment.findFirst({ where: { objectId, toTime: null } });
  if (!assignment) throw new Error('Object has no device');

  if (process.argv.includes('--delete')) {
    const n = await prisma.$executeRaw`
      DELETE FROM "Position" WHERE "objectId" = ${objectId}::uuid AND "fixTime" >= to_timestamp(${start}::float8 / 1000)
        AND "fixTime" < to_timestamp(${end}::float8 / 1000) AND attributes->>'synthetic' = 'true'`;
    console.log(`deleted ${n} synthetic positions`);
    await prisma.$disconnect();
    return;
  }

  // Deterministic pseudo-random drive: 20–40 min trips, short idles, 10–40 min parked stops.
  let seed = 42;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  let lat = 13.05;
  let lng = 80.22;
  let heading = rnd() * 360;
  type Row = [number, number, number, number, number, boolean];
  const rows: Row[] = [];
  let t = start;
  while (t < end) {
    const driveSec = 1200 + Math.floor(rnd() * 1200);
    for (let s = 0; s < driveSec && t < end; s += 10, t += 10_000) {
      if (rnd() < 0.03) heading = (heading + (rnd() - 0.5) * 120 + 360) % 360;
      const speed = rnd() < 0.02 ? 0 : 25 + rnd() * 45 + (rnd() < 0.05 ? 30 : 0);
      const m = (speed / 3.6) * 10;
      lat += (m * Math.cos((heading * Math.PI) / 180)) / 111_195;
      lng += (m * Math.sin((heading * Math.PI) / 180)) / (111_195 * Math.cos((lat * Math.PI) / 180));
      if (lat > 13.15 || lat < 12.95 || lng > 80.3 || lng < 80.15) heading = (heading + 180) % 360;
      rows.push([t, lat, lng, speed, Math.round(heading), true]);
    }
    const idleSec = rnd() < 0.5 ? 60 + Math.floor(rnd() * 200) : 0;
    for (let s = 0; s < idleSec && t < end; s += 10, t += 10_000) rows.push([t, lat, lng, 0, Math.round(heading), true]);
    const parkSec = 600 + Math.floor(rnd() * 1800);
    for (let s = 0; s < parkSec && t < end; s += 10, t += 10_000) rows.push([t, lat, lng, 0, Math.round(heading), false]);
  }

  for (let i = 0; i < rows.length; i += 2000) {
    const chunk = rows.slice(i, i + 2000);
    await prisma.$executeRaw`
      INSERT INTO "Position" ("objectId", "deviceId", "fixTime", "serverTime", lat, lng, "speedKph", course, satellites, valid, ignition, flags, attributes)
      SELECT ${objectId}::uuid, ${assignment.deviceId}::uuid, to_timestamp(u.t::float8 / 1000), now(), u.la::float8, u.lo::float8,
             u.sp::real, u.co::smallint, 10, true, u.ig::boolean, 0, '{"synthetic": true}'::jsonb
      FROM unnest(${chunk.map((r) => String(r[0]))}::text[], ${chunk.map((r) => String(r[1]))}::text[], ${chunk.map((r) => String(r[2]))}::text[],
                  ${chunk.map((r) => String(r[3]))}::text[], ${chunk.map((r) => String(r[4]))}::text[], ${chunk.map((r) => String(r[5]))}::text[])
           AS u(t, la, lo, sp, co, ig)
      ON CONFLICT DO NOTHING`;
  }
  console.log(`inserted ${rows.length} synthetic positions for ${objectId} on ${day}`);
  await prisma.$disconnect();
}

void main();

/**
 * Register simulator devices (Concox GT06N) with one object each in the demo company.
 *   npm run sim:register -- --count 1000 [--imei-start 868120000000001] [--branch "Load Test"]
 * IMEIs that already exist (e.g. the 20 seeded devices) are skipped, so the command is idempotent.
 */
import { PrismaClient, VehicleType } from '@prisma/client';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { randomToken } from '../common/secrets';
import { loadEnv } from '../config/env';
import { RedisKeys } from '../redis/keys';
import { DEFAULT_IMEI_START, imeiAt, numberArg, parseArgs } from './cli-args';

const DEMO_COMPANY = 'Demo Logistics';
const CHUNK = 1000;
const TYPES: VehicleType[] = ['CAR', 'TRUCK', 'BUS', 'BIKE', 'VAN', 'AUTO'];

async function main(): Promise<void> {
  const env = loadEnv();
  const args = parseArgs(process.argv.slice(2));
  const count = numberArg(args, 'count', 1000);
  const imeiStart = numberArg(args, 'imei-start', DEFAULT_IMEI_START);
  const branchName = args.get('branch') ?? 'Load Test';
  const prisma = new PrismaClient();

  try {
    const company = await prisma.company.findFirst({ where: { name: DEMO_COMPANY, isPlatform: false } });
    if (!company) throw new Error(`Company "${DEMO_COMPANY}" not found — run npm run db:seed first`);
    const model = await prisma.deviceModel.findUnique({ where: { brand_model: { brand: 'Concox', model: 'GT06N' } } });
    if (!model) throw new Error('Device model Concox GT06N not found — run npm run db:seed first');
    const branch = await prisma.branch.upsert({
      where: { companyId_name: { companyId: company.id, name: branchName } },
      update: {},
      create: { companyId: company.id, name: branchName, code: 'LOAD' },
    });

    const imeis = Array.from({ length: count }, (_, i) => imeiAt(imeiStart, i));
    let created = 0;
    for (let i = 0; i < imeis.length; i += CHUNK) {
      const chunk = imeis.slice(i, i + CHUNK);
      const existing = new Set(
        (await prisma.device.findMany({ where: { uniqueId: { in: chunk } }, select: { uniqueId: true } })).map((d) => d.uniqueId),
      );
      const fresh = chunk.filter((imei) => !existing.has(imei));
      if (!fresh.length) continue;
      const rows = fresh.map((imei, j) => ({
        imei,
        deviceId: randomUUID(),
        objectId: randomUUID(),
        vehicleType: TYPES[(i + j) % TYPES.length],
      }));
      await prisma.$transaction([
        prisma.device.createMany({
          data: rows.map((r) => ({
            id: r.deviceId,
            uniqueId: r.imei,
            companyId: company.id,
            modelId: model.id,
            ingestToken: randomToken(24),
          })),
        }),
        prisma.trackedObject.createMany({
          data: rows.map((r) => ({
            id: r.objectId,
            companyId: company.id,
            branchId: branch.id,
            type: 'VEHICLE' as const,
            vehicleType: r.vehicleType,
            name: `Sim ${r.imei.slice(-5)}`,
            plateNumber: `TN-99-SM-${r.imei.slice(-5)}`,
          })),
        }),
        prisma.deviceAssignment.createMany({
          data: rows.map((r) => ({ deviceId: r.deviceId, objectId: r.objectId })),
        }),
      ]);
      created += rows.length;
    }

    const redis = new Redis(env.redisUrl);
    await redis.publish(RedisKeys.cacheInvalidate, JSON.stringify({ reason: 'sim:register', at: Date.now() }));
    await redis.quit();
    console.log(
      `Registered ${created} new device(s) + object(s) in "${DEMO_COMPANY}" / branch "${branchName}" ` +
        `(${count - created} already existed; IMEI ${imeis[0]} … ${imeis[imeis.length - 1]})`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

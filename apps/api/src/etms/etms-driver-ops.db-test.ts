/**
 * ETMS E5 migration etms_driver_ops on a real PostgreSQL with all migrations applied (doc 15 §9.5). Not part of the
 * normal run (testRegex is *.spec.ts):
 *   ETMS_DB_TEST_URL=postgresql://user:pass@127.0.0.1:5432/veetrax_e5be_test \
 *     npx jest --testRegex 'etms-driver-ops\.db-test\.ts$' --runInBand
 * Allowed databases: *_test (veetrax_assess outside CI); never veetracer. Everything runs inside ONE transaction that
 * is always rolled back: no row is left behind.
 */
import { randomUUID } from 'crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { readFileSync } from 'fs';
import { join } from 'path';
import { dbDescribe } from '../test/scratch-db';

const URL_ = process.env.ETMS_DB_TEST_URL ?? '';
const { d, dbName } = dbDescribe(URL_);
type Tx = Prisma.TransactionClient;
class Rollback extends Error {}

async function inRollback(prisma: PrismaClient, fn: (tx: Tx) => Promise<void>): Promise<void> {
  await prisma
    .$transaction(
      async (tx) => {
        await fn(tx);
        throw new Rollback();
      },
      { timeout: 120_000, maxWait: 10_000 },
    )
    .catch((e) => {
      if (!(e instanceof Rollback)) throw e;
    });
}

d(`ETMS E5 etms_driver_ops on ${dbName || '(no scratch DB)'}`, () => {
  let prisma: PrismaClient;
  beforeAll(() => {
    prisma = new PrismaClient({ datasources: { db: { url: URL_ } } });
  });
  afterAll(async () => prisma?.$disconnect());

  it('raw-SQL inventory: partial unique open duty, CHECKs, receivedAt index, NotificationLog ref columns', async () => {
    const idx = await prisma.$queryRaw<{ indexname: string; indexdef: string }[]>`SELECT indexname, indexdef FROM pg_indexes WHERE indexname IN ('TransportDriverDuty_open_driver_key', 'TransportTripEvent_receivedAt_idx', 'TransportNotification_dedupeKey_key')`;
    expect(idx.map((i) => i.indexname).sort()).toEqual(['TransportDriverDuty_open_driver_key', 'TransportNotification_dedupeKey_key', 'TransportTripEvent_receivedAt_idx']);
    expect(idx.find((i) => i.indexname === 'TransportDriverDuty_open_driver_key')!.indexdef).toMatch(/UNIQUE.*WHERE \("endedAt" IS NULL\)/);
    const checks = await prisma.$queryRaw<{ conname: string }[]>`SELECT conname FROM pg_constraint WHERE contype = 'c' AND conrelid IN ('"TransportDriverDuty"'::regclass, '"TransportNotification"'::regclass) ORDER BY conname`;
    expect(checks.map((c) => c.conname)).toEqual(['TransportDriverDuty_end_check', 'TransportDriverDuty_source_check', 'TransportNotification_audience_check', 'TransportNotification_kind_check']);
    const cols = await prisma.$queryRaw<{ column_name: string }[]>`SELECT column_name FROM information_schema.columns WHERE table_name = 'NotificationLog' AND column_name IN ('refType', 'refId') ORDER BY column_name`;
    expect(cols.map((c) => c.column_name)).toEqual(['refId', 'refType']);
    // Purge rules (doc 15 §1.2): no SetNull FK on a column named companyId; duty → driver Cascade, → vehicle SetNull.
    const fks = await prisma.$queryRaw<{ conname: string; confdeltype: string }[]>`SELECT conname, confdeltype::text FROM pg_constraint WHERE contype = 'f' AND conrelid IN ('"TransportDriverDuty"'::regclass, '"TransportNotification"'::regclass) ORDER BY conname`;
    expect(Object.fromEntries(fks.map((f) => [f.conname, f.confdeltype]))).toEqual({
      TransportDriverDuty_companyId_fkey: 'r',
      TransportDriverDuty_driverId_fkey: 'c',
      TransportDriverDuty_objectId_fkey: 'n',
      TransportNotification_companyId_fkey: 'r',
      TransportNotification_tripId_fkey: 'n',
      TransportNotification_userId_fkey: 'c',
    });
  });

  it('constraints: one open duty per driver, end >= start, known kinds / audiences, unique dedupeKey; backfill idempotent', async () => {
    const out: Record<string, string> = {};
    await inRollback(prisma, async (tx) => {
      const [partner] = await tx.$queryRaw<{ id: string }[]>`INSERT INTO "Partner" (id, name, slug, "updatedAt") VALUES (gen_random_uuid(), 'etms-e5-db-test', 'etms-e5-db-test-' || gen_random_uuid(), now()) RETURNING id`;
      const company = randomUUID();
      const driver = randomUUID();
      const user = randomUUID();
      const role = randomUUID();
      await tx.$executeRawUnsafe(`INSERT INTO "Company" (id, "partnerId", name, settings, "updatedAt") VALUES ('${company}', '${partner.id}', 'etms-e5-db-test', '{"features":["etms"]}', now())`);
      await tx.$executeRawUnsafe(`INSERT INTO "User" (id, "companyId", name, email, "updatedAt") VALUES ('${user}', '${company}', 'Driver login', 'e5-${user.slice(0, 8)}@t.test', now())`);
      await tx.$executeRawUnsafe(`INSERT INTO "Driver" (id, "companyId", name, "userId", "updatedAt") VALUES ('${driver}', '${company}', 'Driver', '${user}', now())`);
      const attempt = async (name: string, sql: string) => {
        await tx.$executeRawUnsafe('SAVEPOINT s');
        try {
          await tx.$executeRawUnsafe(sql);
          out[name] = 'accepted';
          await tx.$executeRawUnsafe('RELEASE SAVEPOINT s');
        } catch (e) {
          out[name] = `rejected ${/Transport[A-Za-z]*_[A-Za-z_]+_check/.exec(String(e))?.[0] ?? /Code: `(\w+)`/.exec(String(e))?.[1] ?? String(e).slice(0, 120)}`;
          await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT s');
        }
      };
      const duty = (end: string) => `INSERT INTO "TransportDriverDuty" (id, "companyId", "driverId", "startedAt", "endedAt", "startClientEventId", "updatedAt") VALUES (gen_random_uuid(), '${company}', '${driver}', now(), ${end}, gen_random_uuid(), now())`;
      await attempt('duty open', duty('NULL'));
      await attempt('second open duty', duty('NULL'));
      await attempt('ended duty', duty(`now() + interval '1 hour'`));
      await attempt('end before start', duty(`now() - interval '1 hour'`));
      const notif = (kind: string, audience: string, key: string) => `INSERT INTO "TransportNotification" (id, "companyId", "userId", audience, kind, title, body, "dedupeKey") VALUES (gen_random_uuid(), '${company}', '${user}', '${audience}', '${kind}', 't', 'b', '${key}')`;
      await attempt('notification', notif('TRIP_ASSIGNED', 'DRIVER', 'k1'));
      await attempt('duplicate dedupeKey', notif('TRIP_CHANGED', 'DRIVER', 'k1'));
      await attempt('unknown kind', notif('HELLO', 'DRIVER', 'k2'));
      await attempt('unknown audience', notif('TRIP_ASSIGNED', 'ADMIN', 'k3'));
      // Backfill: an untouched driver template gets view + edit; running the block again changes nothing.
      await tx.$executeRawUnsafe(`INSERT INTO "Role" (id, "companyId", name, description, "isSystem", "dataScope", "updatedAt") VALUES ('${role}', '${company}', 'Transport driver', 'Employee transport: driver (own assigned trips only)', false, 'ASSIGNED', now())`);
      await tx.$executeRawUnsafe(`INSERT INTO "RolePermission" ("roleId", menu, actions) VALUES ('${role}', 'etms_driver', ARRAY['view'])`);
      const sql = readFileSync(join(__dirname, '../../prisma/migrations/20261117090000_etms_driver_ops/migration.sql'), 'utf8');
      const block = /-- ETMS-E5-BACKFILL-BEGIN[\s\S]*?-- ETMS-E5-BACKFILL-END/.exec(sql)![0];
      const stmt = block.split('\n').filter((l) => !l.startsWith('--')).join('\n').trim().replace(/;$/, '');
      await tx.$executeRawUnsafe(stmt);
      await tx.$executeRawUnsafe(stmt);
      const [perm] = await tx.$queryRawUnsafe<{ actions: string[] }[]>(`SELECT actions FROM "RolePermission" WHERE "roleId" = '${role}' AND menu = 'etms_driver'`);
      out.backfill = perm.actions.join(',');
    });
    expect(out).toEqual({
      'duty open': 'accepted',
      'second open duty': 'rejected 23505', // unique violation of TransportDriverDuty_open_driver_key
      'ended duty': 'accepted',
      'end before start': 'rejected TransportDriverDuty_end_check',
      notification: 'accepted',
      'duplicate dedupeKey': 'rejected 23505',
      'unknown kind': 'rejected TransportNotification_kind_check',
      'unknown audience': 'rejected TransportNotification_audience_check',
      backfill: 'view,edit',
    });
  });
});

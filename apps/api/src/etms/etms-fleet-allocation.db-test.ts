/**
 * Migration etms_fleet_allocation (E1b WP 1b.0, doc 15 §10) on a real PostgreSQL with all migrations applied (doc 15
 * §9.5 "Raw-SQL object inventory" and "Constraint behaviour"). Not part of the normal run (testRegex is *.spec.ts):
 *   ETMS_DB_TEST_URL=postgresql://…/veetrax_x_test npx jest --testRegex 'etms-fleet-allocation\.db-test\.ts$' --runInBand
 * Everything runs inside ONE transaction that is always rolled back (savepoints around each rejected row).
 */
import { PrismaClient } from '@prisma/client';
import { readFileSync } from 'fs';
import { join } from 'path';
import { dbDescribe } from '../test/scratch-db';

const URL_ = process.env.ETMS_DB_TEST_URL ?? '';
const { d, dbName } = dbDescribe(URL_);

class Rollback extends Error {}

d(`etms_fleet_allocation on ${dbName}`, () => {
  jest.setTimeout(60_000);
  const prisma = new PrismaClient({ datasourceUrl: URL_ });
  afterAll(() => prisma.$disconnect());

  it('security review L5: the migration sets lock_timeout before its first ALTER / FK', () => {
    const sql = readFileSync(join(__dirname, '../../prisma/migrations/20261120100000_etms_fleet_allocation/migration.sql'), 'utf8');
    const lock = sql.search(/^SET lock_timeout = '5s';\r?$/m);
    expect(lock).toBeGreaterThan(-1);
    expect(lock).toBeLessThan(sql.indexOf('CREATE TABLE "TransportFleetAllocation"'));
    expect(lock).toBeLessThan(sql.indexOf('ADD CONSTRAINT "TransportFleetAllocation_objectId_fkey"'));
  });

  it('QA B3: the upgrade backfill gives etmsProvider to providers of non-ENDED agreements only; idempotent; settings kept', async () => {
    const sql = readFileSync(join(__dirname, '../../prisma/migrations/20261120100000_etms_fleet_allocation/migration.sql'), 'utf8');
    const block = /-- ETMS-E1B-PROVIDER-BACKFILL-BEGIN[\s\S]*-- ETMS-E1B-PROVIDER-BACKFILL-END/.exec(sql)![0].replace(/^\s*--.*$/gm, '').trim();
    const settingsAfter: Record<string, unknown> = {};
    await prisma
      .$transaction(async (tx) => {
        const [partner] = await tx.$queryRaw<{ id: string }[]>`INSERT INTO "Partner" (id, name, slug, "updatedAt") VALUES (gen_random_uuid(), 'etms-b3 partner', 'etms-b3-' || gen_random_uuid(), now()) RETURNING id`;
        const company = async (n: string, settings: string) =>
          (await tx.$queryRawUnsafe<{ id: string }[]>(`INSERT INTO "Company" (id, "partnerId", name, settings, "updatedAt") VALUES (gen_random_uuid(), '${partner.id}', 'etms-b3 ${n}', '${settings}', now()) RETURNING id`))[0].id;
        const cust = await company('customer', '{"features":["etms"]}');
        const ids = {
          active: await company('active provider', '{"features":["etms"],"timezoneNote":"kept"}'),
          suspended: await company('suspended provider', '{}'),
          ended: await company('ended-only provider', '{"features":["etms"]}'),
          already: await company('already provider', '{"features":["etms","etmsProvider"]}'),
          odd: await company('odd settings', '{"features":"etms"}'),
          none: await company('no agreement', '{"features":["etms"]}'),
        };
        const agreement = (p: string, status: string) =>
          tx.$executeRawUnsafe(`INSERT INTO "TransportServiceAgreement" (id, "providerCompanyId", "customerCompanyId", status, "validFrom", "approvedByCustomerAt", "approvedByProviderAt", "endedAt", "updatedAt") VALUES (gen_random_uuid(), '${p}', '${cust}', '${status}', now(), now(), now(), ${status === 'ENDED' ? 'now()' : 'NULL'}, now())`);
        await agreement(ids.active, 'ACTIVE');
        await agreement(ids.suspended, 'SUSPENDED');
        await agreement(ids.ended, 'ENDED');
        await agreement(ids.already, 'ACTIVE');
        await agreement(ids.odd, 'ACTIVE');
        for (let i = 0; i < 2; i++) await tx.$executeRawUnsafe(block);
        for (const [k, id] of Object.entries(ids)) settingsAfter[k] = (await tx.$queryRawUnsafe<{ settings: unknown }[]>(`SELECT settings FROM "Company" WHERE id = '${id}'`))[0].settings;
        throw new Rollback();
      })
      .catch((e: unknown) => {
        if (!(e instanceof Rollback)) throw e;
      });
    expect(settingsAfter).toEqual({
      active: { features: ['etms', 'etmsProvider'], timezoneNote: 'kept' },
      suspended: { features: ['etmsProvider'] },
      ended: { features: ['etms'] },
      already: { features: ['etms', 'etmsProvider'] },
      odd: { features: 'etms' },
      none: { features: ['etms'] },
    });
  });

  it('creates the documented raw-SQL objects and foreign keys with the planned delete rules', async () => {
    const cons = await prisma.$queryRaw<{ conname: string; contype: string; confdeltype: string }[]>`
      SELECT conname, contype, confdeltype FROM pg_constraint WHERE conrelid = '"TransportFleetAllocation"'::regclass ORDER BY conname`;
    const by = Object.fromEntries(cons.map((c) => [c.conname, c]));
    expect(by.TransportFleetAllocation_target_check?.contype).toBe('c');
    expect(by.TransportFleetAllocation_validity_check?.contype).toBe('c');
    expect(by.TransportFleetAllocation_vehicle_overlap_excl?.contype).toBe('x');
    expect(by.TransportFleetAllocation_driver_overlap_excl?.contype).toBe('x');
    // 15 §10: agreement Cascade, provider Restrict, customer SetNull, vehicle / driver Cascade.
    expect(by.TransportFleetAllocation_agreementId_fkey?.confdeltype).toBe('c');
    expect(by.TransportFleetAllocation_providerCompanyId_fkey?.confdeltype).toBe('r');
    expect(by.TransportFleetAllocation_customerCompanyId_fkey?.confdeltype).toBe('n');
    expect(by.TransportFleetAllocation_objectId_fkey?.confdeltype).toBe('c');
    expect(by.TransportFleetAllocation_driverId_fkey?.confdeltype).toBe('c');
    // Purge planner (15 §1.2): no column named companyId / deviceId (objectId has an FK, so the logical key is skipped).
    const cols = await prisma.$queryRaw<{ column_name: string }[]>`SELECT column_name FROM information_schema.columns WHERE table_name = 'TransportFleetAllocation'`;
    const names = cols.map((c) => c.column_name);
    expect(names).not.toContain('companyId');
    expect(names).not.toContain('deviceId');
    const idx = await prisma.$queryRaw<{ indexname: string }[]>`SELECT indexname FROM pg_indexes WHERE tablename = 'TransportFleetAllocation'`;
    expect(idx.map((i) => i.indexname)).toEqual(
      expect.arrayContaining(['TransportFleetAllocation_agreementId_validFrom_idx', 'TransportFleetAllocation_providerCompanyId_validFrom_idx', 'TransportFleetAllocation_objectId_idx', 'TransportFleetAllocation_driverId_idx']),
    );
  });

  it('constraints reject bad rows; one vehicle may serve two agreements but not overlap within one', async () => {
    const outcomes: Record<string, string> = {};
    await prisma
      .$transaction(async (tx) => {
        const [partner] = await tx.$queryRaw<{ id: string }[]>`INSERT INTO "Partner" (id, name, slug, "updatedAt") VALUES (gen_random_uuid(), 'etms-fa-db-test partner', 'etms-fa-db-test-' || gen_random_uuid(), now()) RETURNING id`;
        const company = async (n: string) => (await tx.$queryRawUnsafe<{ id: string }[]>(`INSERT INTO "Company" (id, "partnerId", name, "updatedAt") VALUES (gen_random_uuid(), '${partner.id}', 'etms-fa-db-test ${n}', now()) RETURNING id`))[0].id;
        const p = await company('provider');
        const c1 = await company('customer 1');
        const c2 = await company('customer 2');
        const agreement = async (c: string) =>
          (await tx.$queryRawUnsafe<{ id: string }[]>(`INSERT INTO "TransportServiceAgreement" (id, "providerCompanyId", "customerCompanyId", "validFrom", "updatedAt") VALUES (gen_random_uuid(), '${p}', '${c}', now(), now()) RETURNING id`))[0].id;
        const a1 = await agreement(c1);
        const a2 = await agreement(c2);
        const [veh] = await tx.$queryRawUnsafe<{ id: string }[]>(`INSERT INTO "TrackedObject" (id, "companyId", name, "updatedAt") VALUES (gen_random_uuid(), '${p}', 'FA test bus', now()) RETURNING id`);
        const [drv] = await tx.$queryRawUnsafe<{ id: string }[]>(`INSERT INTO "Driver" (id, "companyId", name, "updatedAt") VALUES (gen_random_uuid(), '${p}', 'FA test driver', now()) RETURNING id`);
        const ins = (a: string, c: string, obj: string | null, drvId: string | null, from: string, to: string | null) =>
          `INSERT INTO "TransportFleetAllocation" (id, "agreementId", "providerCompanyId", "customerCompanyId", "objectId", "driverId", "validFrom", "validTo", "updatedAt") VALUES (gen_random_uuid(), '${a}', '${p}', '${c}', ${obj ? `'${obj}'` : 'NULL'}, ${drvId ? `'${drvId}'` : 'NULL'}, ${from}, ${to ?? 'NULL'}, now())`;
        const attempt = async (name: string, sql: string) => {
          await tx.$executeRawUnsafe('SAVEPOINT s');
          try {
            await tx.$executeRawUnsafe(sql);
            outcomes[name] = 'accepted';
            await tx.$executeRawUnsafe('RELEASE SAVEPOINT s');
          } catch (e) {
            const text = String(e);
            const named = /TransportFleetAllocation_[A-Za-z_]+_(?:check|excl|fkey)/.exec(text)?.[0] ?? /Code: `\d+`/.exec(text)?.[0];
            outcomes[name] = `rejected ${named ?? text.slice(0, 160)}`;
            await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT s');
          }
        };
        const T0 = `'2026-12-01T00:00:00Z'::timestamptz`;
        const T1 = `'2026-12-10T00:00:00Z'::timestamptz`;
        const T2 = `'2026-12-20T00:00:00Z'::timestamptz`;
        await attempt('neither vehicle nor driver', ins(a1, c1, null, null, T0, null));
        await attempt('validTo before validFrom', ins(a1, c1, veh.id, null, T1, T0));
        await attempt('vehicle on agreement 1 (closed)', ins(a1, c1, veh.id, null, T0, T1));
        await attempt('same vehicle, same agreement, overlapping', ins(a1, c1, veh.id, null, `'2026-12-05T00:00:00Z'::timestamptz`, T2));
        await attempt('same vehicle, same agreement, adjacent', ins(a1, c1, veh.id, null, T1, T2));
        await attempt('same vehicle, other agreement, overlapping', ins(a2, c2, veh.id, null, T0, null));
        await attempt('driver open-ended', ins(a1, c1, null, drv.id, T0, null));
        await attempt('same driver, same agreement, later', ins(a1, c1, null, drv.id, T2, null));
        // Restrict on the provider: an ordinary delete of the provider company is refused while an allocation exists.
        await attempt('delete provider company', `DELETE FROM "Company" WHERE id = '${p}'`);
        // Cascade on the vehicle: deleting it removes its allocations.
        await attempt('delete vehicle', `DELETE FROM "TrackedObject" WHERE id = '${veh.id}'`);
        const [left] = await tx.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM "TransportFleetAllocation" WHERE "objectId" IS NOT NULL AND "providerCompanyId" = '${p}'`);
        outcomes['vehicle allocations after vehicle delete'] = String(Number(left.n));
        // Cascade on the agreement.
        await attempt('delete agreement 1', `DELETE FROM "TransportServiceAgreement" WHERE id = '${a1}'`);
        const [left2] = await tx.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM "TransportFleetAllocation" WHERE "agreementId" = '${a1}'`);
        outcomes['allocations after agreement delete'] = String(Number(left2.n));
        throw new Rollback();
      })
      .catch((e) => {
        if (!(e instanceof Rollback)) throw e;
      });
    expect(outcomes['neither vehicle nor driver']).toMatch(/TransportFleetAllocation_target_check/);
    expect(outcomes['validTo before validFrom']).toMatch(/TransportFleetAllocation_validity_check/);
    expect(outcomes['vehicle on agreement 1 (closed)']).toBe('accepted');
    expect(outcomes['same vehicle, same agreement, overlapping']).toMatch(/TransportFleetAllocation_vehicle_overlap_excl|23P01/);
    expect(outcomes['same vehicle, same agreement, adjacent']).toBe('accepted');
    expect(outcomes['same vehicle, other agreement, overlapping']).toBe('accepted');
    expect(outcomes['driver open-ended']).toBe('accepted');
    expect(outcomes['same driver, same agreement, later']).toMatch(/TransportFleetAllocation_driver_overlap_excl|23P01/);
    expect(outcomes['delete provider company']).toMatch(/rejected/);
    expect(outcomes['delete vehicle']).toBe('accepted');
    expect(outcomes['vehicle allocations after vehicle delete']).toBe('0');
    expect(outcomes['delete agreement 1']).toBe('accepted');
    expect(outcomes['allocations after agreement delete']).toBe('0');
    const left = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM "Company" WHERE name LIKE 'etms-fa-db-test %'`;
    expect(Number(left[0].n)).toBe(0);
  });
});

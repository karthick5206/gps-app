/**
 * Migration etms_people on a real PostgreSQL with all migrations applied (doc 15 §9.5 "Raw-SQL object inventory",
 * "Constraint behaviour", §9.6 tenant-purge cases 1, 3, 4, 5 for the E2 tables). Not part of the normal run
 * (testRegex is *.spec.ts):
 *   ETMS_DB_TEST_URL=postgresql://user:pass@127.0.0.1:5432/veetrax_assess \
 *     npx jest --testRegex 'etms-people\.db-test\.ts$' --runInBand
 * Allowed databases: veetrax_assess or any *_test database; never veetracer. Every test runs inside ONE transaction that
 * is always rolled back (savepoints around each rejected row), so no row is left behind.
 */
import { randomUUID } from 'crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { planPurge, rootCondition, stepSql, type Catalog, type FkEdge } from '../purge/purge-plan';

const URL_ = process.env.ETMS_DB_TEST_URL ?? '';
const dbName = /\/([a-z0-9_]+)(\?|$)/i.exec(URL_)?.[1] ?? '';
const allowed = dbName === 'veetrax_assess' || /_test$/i.test(dbName);
const d = URL_ && allowed ? describe : describe.skip;

class Rollback extends Error {}
type Tx = Prisma.TransactionClient;

/** Same catalogue query as PurgeService.loadCatalog (first column of composite FKs only). */
async function loadCatalog(tx: Tx): Promise<Catalog> {
  const fks = await tx.$queryRawUnsafe<FkEdge[]>(`
    SELECT c.relname AS child, a.attname AS col, p.relname AS parent, pa.attname AS "refCol", con.confdeltype::text AS del
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_class p ON p.oid = con.confrelid
    JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
    JOIN pg_attribute pa ON pa.attrelid = con.confrelid AND pa.attnum = con.confkey[1]
    WHERE con.contype = 'f' AND n.nspname = 'public'`);
  const cols = await tx.$queryRawUnsafe<{ table: string; column: string }[]>(`
    SELECT c.table_name AS "table", c.column_name AS "column" FROM information_schema.columns c
    JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE' AND c.table_name <> '_prisma_migrations'`);
  const columns = new Map<string, Set<string>>();
  for (const { table, column } of cols) (columns.get(table) ?? columns.set(table, new Set()).get(table)!).add(column);
  return { fks, columns };
}

/** A company with a branch, two places, a user, a vehicle, a driver, a passenger (linked to the user) and consents. */
async function seedGraph(tx: Tx, partnerId: string, tag: string) {
  const ids = { company: randomUUID(), branch: randomUUID(), office: randomUUID(), stop: randomUUID(), user: randomUUID(), object: randomUUID(), driver: randomUUID(), profile: randomUUID() };
  await tx.$executeRawUnsafe(`INSERT INTO "Company" (id, "partnerId", name, "updatedAt") VALUES ('${ids.company}', '${partnerId}', 'etms-people-db-test ${tag}', now())`);
  await tx.$executeRawUnsafe(`INSERT INTO "Branch" (id, "companyId", name, "updatedAt") VALUES ('${ids.branch}', '${ids.company}', 'North', now())`);
  await tx.$executeRawUnsafe(`INSERT INTO "Poi" (id, "companyId", name, category, lat, lng, "updatedAt") VALUES ('${ids.office}', '${ids.company}', 'HQ', 'OFFICE', 13.0, 80.2, now()), ('${ids.stop}', '${ids.company}', 'Stop', 'SHUTTLE_STOP', 12.9, 80.2, now())`);
  await tx.$executeRawUnsafe(`INSERT INTO "User" (id, "companyId", name, email, "updatedAt") VALUES ('${ids.user}', '${ids.company}', 'Passenger ${tag}', 'etms-db-${tag}-${ids.user.slice(0, 8)}@t.test', now())`);
  await tx.$executeRawUnsafe(`INSERT INTO "TrackedObject" (id, "companyId", name, "updatedAt") VALUES ('${ids.object}', '${ids.company}', 'Van ${tag}', now())`);
  await tx.$executeRawUnsafe(`INSERT INTO "Driver" (id, "companyId", name, "userId", "updatedAt") VALUES ('${ids.driver}', '${ids.company}', 'Driver ${tag}', NULL, now())`);
  await tx.$executeRawUnsafe(
    `INSERT INTO "EmployeeTransportProfile" (id, "companyId", "branchId", "userId", "employeeCode", "displayName", "homeLat", "homeLng", "officePoiId", "defaultStopPoiId", "updatedAt")
     VALUES ('${ids.profile}', '${ids.company}', '${ids.branch}', '${ids.user}', 'E1', 'Asha ${tag}', 13.06, 80.24, '${ids.office}', '${ids.stop}', now())`,
  );
  await tx.$executeRawUnsafe(
    `INSERT INTO "EmployeeTransportConsent" (id, "companyId", "profileId", purpose, "noticeVersion", granted, channel) VALUES
     (gen_random_uuid(), '${ids.company}', '${ids.profile}', 'TRANSPORT_PROFILE', 'v1', true, 'ADMIN_ON_BEHALF'),
     (gen_random_uuid(), '${ids.company}', '${ids.profile}', 'TRANSPORT_PROFILE', 'v1', false, 'WEB')`,
  );
  await tx.$executeRawUnsafe(`INSERT INTO "TransportVehicleProfile" ("objectId", "companyId", seats, "updatedAt") VALUES ('${ids.object}', '${ids.company}', 12, now())`);
  return ids;
}

async function counts(tx: Tx, company: string) {
  const [r] = await tx.$queryRawUnsafe<Record<string, bigint>[]>(`SELECT
    (SELECT count(*) FROM "EmployeeTransportProfile" WHERE "companyId" = '${company}') AS profiles,
    (SELECT count(*) FROM "EmployeeTransportConsent" WHERE "companyId" = '${company}') AS consents,
    (SELECT count(*) FROM "TransportVehicleProfile" WHERE "companyId" = '${company}') AS vehicles,
    (SELECT count(*) FROM "Company" WHERE id = '${company}') AS company`);
  return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Number(v)]));
}

async function inRollback(prisma: PrismaClient, fn: (tx: Tx, partnerId: string) => Promise<void>): Promise<void> {
  await prisma
    .$transaction(
      async (tx) => {
        const [partner] = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Partner" LIMIT 1`;
        if (!partner) throw new Error('no Partner row: run the seed first');
        await fn(tx, partner.id);
        throw new Rollback();
      },
      { timeout: 120_000, maxWait: 10_000 },
    )
    .catch((e) => {
      if (!(e instanceof Rollback)) throw e;
    });
}

d(`etms_people on ${dbName}`, () => {
  jest.setTimeout(180_000);
  const prisma = new PrismaClient({ datasourceUrl: URL_ });
  afterAll(async () => {
    const left = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM "Company" WHERE name LIKE 'etms-people-db-test %'`;
    expect(Number(left[0].n)).toBe(0);
    await prisma.$disconnect();
  });

  it('creates the documented tables, indexes, CHECKs and FK actions (doc 15 §4, §7.2)', async () => {
    const idx = await prisma.$queryRaw<{ indexname: string }[]>`SELECT indexname FROM pg_indexes WHERE tablename IN ('EmployeeTransportProfile', 'EmployeeTransportConsent', 'TransportVehicleProfile', 'Driver')`;
    expect(idx.map((i) => i.indexname)).toEqual(
      expect.arrayContaining([
        'EmployeeTransportProfile_companyId_employeeCode_key',
        'EmployeeTransportProfile_id_companyId_key',
        'EmployeeTransportProfile_userId_key',
        'EmployeeTransportProfile_companyId_isActive_idx',
        'EmployeeTransportProfile_companyId_officePoiId_idx',
        'EmployeeTransportConsent_profileId_purpose_occurredAt_idx',
        'TransportVehicleProfile_companyId_idx',
        'Driver_userId_key',
      ]),
    );
    const cons = await prisma.$queryRaw<{ conname: string; contype: string; confdeltype: string; cols: string[] }[]>`
      SELECT con.conname, con.contype, con.confdeltype,
             ARRAY(SELECT a.attname::text FROM unnest(con.conkey) WITH ORDINALITY k(n, o) JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.n ORDER BY k.o) AS cols
      FROM pg_constraint con WHERE con.conrelid IN ('"EmployeeTransportProfile"'::regclass, '"EmployeeTransportConsent"'::regclass, '"TransportVehicleProfile"'::regclass, '"Driver"'::regclass)`;
    const by = Object.fromEntries(cons.map((c) => [c.conname, c]));
    for (const n of ['EmployeeTransportProfile_home_pair_check', 'EmployeeTransportProfile_home_range_check', 'EmployeeTransportProfile_emergency_contacts_check', 'TransportVehicleProfile_seats_check', 'TransportVehicleProfile_wheelchair_check']) {
      expect(by[n]?.contype).toBe('c');
    }
    const fk = (n: string) => by[n]?.confdeltype;
    expect(fk('EmployeeTransportProfile_companyId_fkey')).toBe('r');
    expect(fk('EmployeeTransportProfile_branchId_fkey')).toBe('n');
    expect(fk('EmployeeTransportProfile_userId_fkey')).toBe('n');
    expect(fk('EmployeeTransportProfile_officePoiId_fkey')).toBe('n');
    expect(fk('EmployeeTransportProfile_defaultStopPoiId_fkey')).toBe('n');
    expect(fk('EmployeeTransportConsent_profileId_companyId_fkey')).toBe('r');
    expect(by.EmployeeTransportConsent_profileId_companyId_fkey.cols).toEqual(['profileId', 'companyId']); // row id first (doc 15 §1.2)
    expect(fk('TransportVehicleProfile_objectId_fkey')).toBe('c');
    expect(fk('Driver_userId_fkey')).toBe('n');
    // No FK on consent / vehicle-profile companyId: the purge planner's logical key reaches them (doc 15 §1.2).
    const companyFks = cons.filter((c) => c.contype === 'f' && c.cols[0] === 'companyId' && !c.conname.startsWith('Driver_')).map((c) => c.conname);
    expect(companyFks).toEqual(['EmployeeTransportProfile_companyId_fkey']);
  });

  it('constraints reject bad rows (savepoints; whole transaction rolled back)', async () => {
    const outcomes: Record<string, string> = {};
    await inRollback(prisma, async (tx, partnerId) => {
      const a = await seedGraph(tx, partnerId, 'A');
      const b = await seedGraph(tx, partnerId, 'B');
      const attempt = async (name: string, sql: string) => {
        await tx.$executeRawUnsafe('SAVEPOINT s');
        try {
          await tx.$executeRawUnsafe(sql);
          outcomes[name] = 'accepted';
          await tx.$executeRawUnsafe('RELEASE SAVEPOINT s');
        } catch (e) {
          const text = String(e);
          const named = /(EmployeeTransport|TransportVehicle|Driver)[A-Za-z]*_[A-Za-z_]+_(?:check|key|fkey)/.exec(text)?.[0] ?? /Code: `\d+`/.exec(text)?.[0];
          outcomes[name] = `rejected ${named ?? text.slice(0, 160)}`;
          await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT s');
        }
      };
      const profile = (cols: string, vals: string, code = randomUUID().slice(0, 8)) =>
        `INSERT INTO "EmployeeTransportProfile" (id, "companyId", "employeeCode", "displayName", "updatedAt"${cols ? ', ' + cols : ''}) VALUES (gen_random_uuid(), '${a.company}', '${code}', 'X', now()${vals ? ', ' + vals : ''})`;
      await attempt('lone latitude', profile('"homeLat"', '13.0'));
      await attempt('null island', profile('"homeLat", "homeLng"', '0, 0'));
      await attempt('latitude 91', profile('"homeLat", "homeLng"', '91, 80'));
      await attempt('valid US point', profile('"homeLat", "homeLng"', '40.7128, -74.006'));
      await attempt('4 emergency contacts', profile('"emergencyContacts"', `'[{},{},{},{}]'::jsonb`));
      await attempt('emergency contacts object', profile('"emergencyContacts"', `'{}'::jsonb`));
      await attempt('duplicate employee code', profile('', '', 'E1'));
      await attempt('new code in company A', profile('', '', 'X1'));
      await attempt('same code in another company', profile('', '', 'X1').replace(`'${a.company}'`, `'${b.company}'`));
      await attempt('second profile on the same user', profile('"userId"', `'${a.user}'`));
      await attempt(
        'consent pointing at another company profile',
        `INSERT INTO "EmployeeTransportConsent" (id, "companyId", "profileId", purpose, "noticeVersion", granted, channel) VALUES (gen_random_uuid(), '${b.company}', '${a.profile}', 'TRANSPORT_PROFILE', 'v1', true, 'WEB')`,
      );
      await attempt('seats 0', `UPDATE "TransportVehicleProfile" SET seats = 0 WHERE "objectId" = '${a.object}'`);
      await attempt('seats 101', `UPDATE "TransportVehicleProfile" SET seats = 101 WHERE "objectId" = '${a.object}'`);
      await attempt('negative wheelchair spaces', `UPDATE "TransportVehicleProfile" SET "wheelchairSpaces" = -1 WHERE "objectId" = '${a.object}'`);
      await attempt('driver login twice', `UPDATE "Driver" SET "userId" = '${a.user}' WHERE id IN ('${a.driver}', '${b.driver}')`);
      await attempt('app hard-delete of a profile with consent evidence', `DELETE FROM "EmployeeTransportProfile" WHERE id = '${a.profile}'`);
      await attempt('app delete of the customer company', `DELETE FROM "Company" WHERE id = '${a.company}'`);
      await attempt('delete a place used as office (SET NULL)', `DELETE FROM "Poi" WHERE id = '${a.office}'`);
      const [after] = await tx.$queryRawUnsafe<{ officePoiId: string | null }[]>(`SELECT "officePoiId" FROM "EmployeeTransportProfile" WHERE id = '${a.profile}'`);
      outcomes['office after place delete'] = String(after.officePoiId);
    });
    console.log(JSON.stringify(outcomes, null, 2));
    expect(outcomes['lone latitude']).toMatch(/EmployeeTransportProfile_home_pair_check/);
    expect(outcomes['null island']).toMatch(/EmployeeTransportProfile_home_range_check/);
    expect(outcomes['latitude 91']).toMatch(/EmployeeTransportProfile_home_range_check/);
    expect(outcomes['valid US point']).toBe('accepted');
    expect(outcomes['4 emergency contacts']).toMatch(/EmployeeTransportProfile_emergency_contacts_check/);
    expect(outcomes['emergency contacts object']).toMatch(/EmployeeTransportProfile_emergency_contacts_check/);
    expect(outcomes['duplicate employee code']).toMatch(/EmployeeTransportProfile_companyId_employeeCode_key|23505/);
    expect(outcomes['new code in company A']).toBe('accepted');
    expect(outcomes['same code in another company']).toBe('accepted');
    expect(outcomes['second profile on the same user']).toMatch(/EmployeeTransportProfile_userId_key|23505/);
    expect(outcomes['consent pointing at another company profile']).toMatch(/EmployeeTransportConsent_profileId_companyId_fkey|23503/);
    expect(outcomes['seats 0']).toMatch(/TransportVehicleProfile_seats_check/);
    expect(outcomes['seats 101']).toMatch(/TransportVehicleProfile_seats_check/);
    expect(outcomes['negative wheelchair spaces']).toMatch(/TransportVehicleProfile_wheelchair_check/);
    expect(outcomes['driver login twice']).toMatch(/Driver_userId_key|23505/);
    expect(outcomes['app hard-delete of a profile with consent evidence']).toMatch(/rejected/);
    expect(outcomes['app delete of the customer company']).toMatch(/rejected/);
    expect(outcomes['delete a place used as office (SET NULL)']).toBe('accepted');
    expect(outcomes['office after place delete']).toBe('null');
  });

  it('purge: company → E2 rows gone, other company untouched; vehicle → seat profile gone; user → links NULL, rows kept (doc 15 §6, §9.6)', async () => {
    const results: Record<string, unknown> = {};
    await inRollback(prisma, async (tx, partnerId) => {
      const cat = await loadCatalog(tx);
      // §9.6 item 1: the composite consent FK is seen as profileId → id; reachability of every E2 table from a company.
      expect(cat.fks).toEqual(expect.arrayContaining([expect.objectContaining({ child: 'EmployeeTransportConsent', col: 'profileId', parent: 'EmployeeTransportProfile', refCol: 'id', del: 'r' })]));
      const companyPlan = planPurge(cat, 'Company', rootCondition(randomUUID()));
      for (const t of ['EmployeeTransportProfile', 'EmployeeTransportConsent', 'TransportVehicleProfile']) expect(companyPlan.some((s) => s.table === t && !s.nullCol)).toBe(true);

      const a = await seedGraph(tx, partnerId, 'PA');
      const b = await seedGraph(tx, partnerId, 'PB');
      await tx.$executeRawUnsafe(`UPDATE "Driver" SET "userId" = '${b.user}' WHERE id = '${b.driver}'`);
      // User purge (company B's passenger / driver login): links set NULL, profile, consents and driver survive.
      for (const s of planPurge(cat, 'User', rootCondition(b.user))) await tx.$executeRawUnsafe(stepSql(s));
      const [u] = await tx.$queryRawUnsafe<{ puser: string | null; duser: string | null; profiles: bigint; consents: bigint }[]>(
        `SELECT (SELECT "userId" FROM "EmployeeTransportProfile" WHERE id = '${b.profile}') AS puser, (SELECT "userId" FROM "Driver" WHERE id = '${b.driver}') AS duser,
                (SELECT count(*) FROM "EmployeeTransportProfile" WHERE id = '${b.profile}') AS profiles, (SELECT count(*) FROM "EmployeeTransportConsent" WHERE "profileId" = '${b.profile}') AS consents`,
      );
      results.userPurge = { profileUserId: u.puser, driverUserId: u.duser, profiles: Number(u.profiles), consents: Number(u.consents) };
      // Vehicle purge: the seat profile goes with the vehicle (CASCADE).
      for (const s of planPurge(cat, 'TrackedObject', rootCondition(b.object))) await tx.$executeRawUnsafe(stepSql(s));
      results.vehiclePurge = await counts(tx, b.company);
      // Company purge of A: every E2 row of A gone; B untouched.
      for (const s of planPurge(cat, 'Company', rootCondition(a.company))) await tx.$executeRawUnsafe(stepSql(s));
      results.companyA = await counts(tx, a.company);
      results.companyB = await counts(tx, b.company);
    });
    console.log(JSON.stringify(results, null, 2));
    expect(results.userPurge).toEqual({ profileUserId: null, driverUserId: null, profiles: 1, consents: 2 });
    expect(results.vehiclePurge).toEqual({ profiles: 1, consents: 2, vehicles: 0, company: 1 });
    expect(results.companyA).toEqual({ profiles: 0, consents: 0, vehicles: 0, company: 0 });
    expect(results.companyB).toEqual({ profiles: 1, consents: 2, vehicles: 0, company: 1 });
  });
});

/**
 * WP 2.1 / 12 §4 exit criteria on the real database: a 10k-row import commits within 60 s and re-importing the same file
 * creates 0 rows. Writes to a scratch company that is deleted again in afterAll (import commits in its own transactions).
 */
d(`etms_people import performance on ${dbName}`, () => {
  jest.setTimeout(300_000);
  const prisma = new PrismaClient({ datasourceUrl: URL_ });
  const companyId = randomUUID();
  afterAll(async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE "companyId" = '${companyId}'`);
    await prisma.$executeRawUnsafe(`DELETE FROM "EmployeeTransportProfile" WHERE "companyId" = '${companyId}'`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Poi" WHERE "companyId" = '${companyId}'`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Company" WHERE id = '${companyId}'`);
    await prisma.$disconnect();
  });

  it('10,000 rows: commit ≤ 60 s, second commit creates 0 rows', async () => {
    const { PassengerImportService } = await import('./people/passenger-import.service');
    const { AuditService } = await import('../audit/audit.service');
    const [partner] = await prisma.$queryRaw<{ id: string }[]>`SELECT id FROM "Partner" LIMIT 1`;
    await prisma.$executeRawUnsafe(`INSERT INTO "Company" (id, "partnerId", name, "updatedAt") VALUES ('${companyId}', '${partner.id}', 'etms-people-db-test import', now())`);
    await prisma.$executeRawUnsafe(`INSERT INTO "Poi" (id, "companyId", name, category, lat, lng, "updatedAt") VALUES (gen_random_uuid(), '${companyId}', 'HQ', 'OFFICE', 13.0, 80.2, now())`);
    const lines = ['employee_code,name,mobile,email,home_lat,home_lng,office'];
    for (let i = 0; i < 10_000; i++) {
      lines.push(`S${String(i).padStart(5, '0')},Synthetic Passenger ${i},+9198${String(10_000_000 + i).slice(-8)},s${i}@synthetic.test,${(12.8 + (i % 400) / 1000).toFixed(6)},${(80.1 + (i % 300) / 1000).toFixed(6)},HQ`);
    }
    const file = { buffer: Buffer.from(lines.join('\n'), 'utf8') };
    const svc = new PassengerImportService(prisma as never, new AuditService(prisma as never), { enabled: false, search: async () => [] } as never);
    const ctx = { userId: randomUUID(), companyId, homeCompanyId: companyId, dataScope: 'COMPANY', ip: null } as never;
    const t0 = Date.now();
    const first = await svc.run(ctx, file, { commit: true, geocode: false });
    const firstMs = Date.now() - t0;
    const t1 = Date.now();
    const second = await svc.run(ctx, file, { commit: true, geocode: false });
    const secondMs = Date.now() - t1;
    const stored = await prisma.employeeTransportProfile.count({ where: { companyId } });
    console.log(JSON.stringify({ rows: 10_000, firstCommitMs: firstMs, creates: first.creates, errors: first.errors, secondCommitMs: secondMs, secondCreates: second.creates, secondUnchanged: second.unchanged, stored }, null, 2));
    expect(first).toMatchObject({ creates: 10_000, errors: 0 });
    expect(firstMs).toBeLessThan(60_000);
    expect(second).toMatchObject({ creates: 0, updates: 0, unchanged: 10_000 });
    expect(stored).toBe(10_000);
  });
});

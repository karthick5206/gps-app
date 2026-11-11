/**
 * Migration etms_accounts on a real PostgreSQL with all migrations applied (doc 15 §9.5 "Raw-SQL object inventory" and
 * "Constraint behaviour"). Not part of the normal run (testRegex is *.spec.ts):
 *   ETMS_DB_TEST_URL=postgresql://user:pass@127.0.0.1:5432/veetrax_assess \
 *     npx jest --testRegex 'etms-accounts\.db-test\.ts$' --runInBand
 * Allowed databases: veetrax_assess or any *_test database; never veetracer. Everything runs inside ONE transaction
 * that is always rolled back (savepoints around each rejected row), so no row is left behind.
 */
import { PrismaClient } from '@prisma/client';

const URL_ = process.env.ETMS_DB_TEST_URL ?? '';
const dbName = /\/([a-z0-9_]+)(\?|$)/i.exec(URL_)?.[1] ?? '';
const allowed = dbName === 'veetrax_assess' || /_test$/i.test(dbName);
const d = URL_ && allowed ? describe : describe.skip;

class Rollback extends Error {}

d(`etms_accounts on ${dbName}`, () => {
  jest.setTimeout(60_000);
  const prisma = new PrismaClient({ datasourceUrl: URL_ });
  afterAll(() => prisma.$disconnect());

  it('creates the documented raw-SQL objects and RESTRICT foreign keys', async () => {
    const idx = await prisma.$queryRaw<{ indexname: string; indexdef: string }[]>`SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'TransportServiceAgreement' ORDER BY indexname`;
    const live = idx.find((i) => i.indexname === 'TransportServiceAgreement_live_pair_key');
    expect(live?.indexdef).toMatch(/UNIQUE INDEX .*WHERE .*status.*DRAFT.*PROPOSED.*ACTIVE.*SUSPENDED/);
    expect(idx.map((i) => i.indexname)).toEqual(expect.arrayContaining(['TransportServiceAgreement_providerCompanyId_status_idx', 'TransportServiceAgreement_customerCompanyId_status_idx']));
    const cons = await prisma.$queryRaw<{ conname: string; contype: string; confdeltype: string }[]>`
      SELECT conname, contype, confdeltype FROM pg_constraint WHERE conrelid = '"TransportServiceAgreement"'::regclass ORDER BY conname`;
    const byName = Object.fromEntries(cons.map((c) => [c.conname, c]));
    for (const n of ['parties', 'validity', 'version', 'lists', 'active_approved', 'ended']) expect(byName[`TransportServiceAgreement_${n}_check`]?.contype).toBe('c');
    expect(byName.TransportServiceAgreement_providerCompanyId_fkey?.confdeltype).toBe('r');
    expect(byName.TransportServiceAgreement_customerCompanyId_fkey?.confdeltype).toBe('r');
    // No column named companyId: the purge planner's logical key never reaches the table (doc 15 §1.2).
    const cols = await prisma.$queryRaw<{ column_name: string }[]>`SELECT column_name FROM information_schema.columns WHERE table_name = 'TransportServiceAgreement'`;
    expect(cols.map((c) => c.column_name)).not.toContain('companyId');
    const access = await prisma.$queryRaw<{ ok: boolean }[]>`SELECT 'ACCESS' = ANY (enum_range(NULL::"AuditAction")::text[]) AS ok`;
    expect(access[0].ok).toBe(true);
  });

  it('constraints reject bad rows (savepoints; whole transaction rolled back)', async () => {
    const outcomes: Record<string, string> = {};
    await prisma
      .$transaction(async (tx) => {
        const [partner] = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Partner" LIMIT 1`;
        if (!partner) throw new Error('no Partner row: run the seed first');
        const [p] = await tx.$queryRaw<{ id: string }[]>`INSERT INTO "Company" (id, "partnerId", name, "updatedAt") VALUES (gen_random_uuid(), ${partner.id}::uuid, 'etms-db-test provider', now()) RETURNING id`;
        const [c] = await tx.$queryRaw<{ id: string }[]>`INSERT INTO "Company" (id, "partnerId", name, "updatedAt") VALUES (gen_random_uuid(), ${partner.id}::uuid, 'etms-db-test customer', now()) RETURNING id`;
        const insert = (cols: string) =>
          `INSERT INTO "TransportServiceAgreement" (id, "providerCompanyId", "customerCompanyId", "validFrom", "updatedAt"${cols ? ', ' + cols.split('|')[0] : ''}) VALUES (gen_random_uuid(), '${p.id}', '${c.id}', now(), now()${cols ? ', ' + cols.split('|')[1] : ''})`;
        const attempt = async (name: string, sql: string) => {
          await tx.$executeRawUnsafe('SAVEPOINT s');
          try {
            await tx.$executeRawUnsafe(sql);
            outcomes[name] = 'accepted';
            await tx.$executeRawUnsafe('RELEASE SAVEPOINT s');
          } catch (e) {
            const text = String(e);
            const named = /TransportServiceAgreement_[A-Za-z_]+_(?:check|key|fkey)/.exec(text)?.[0] ?? /Code: `\d+`/.exec(text)?.[0];
            outcomes[name] = `rejected ${named ?? text.slice(0, 160)}`;
            await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT s');
          }
        };
        await attempt('same party', insert('').replace(`'${c.id}', now(), now())`, `'${p.id}', now(), now())`));
        await attempt('validTo before validFrom', insert(`"validTo"|now() - interval '1 day'`));
        await attempt('version 0', insert(`version|0`));
        await attempt('NULL grants', insert(`grants|NULL`));
        await attempt('ACTIVE without approvals', insert(`status|'ACTIVE'`));
        await attempt('ENDED without endedAt', insert(`status|'ENDED'`));
        await attempt('first draft', insert(''));
        await attempt('second live draft', insert(''));
        await attempt('ended row beside the live one', insert(`status, "endedAt"|'ENDED', now()`));
        await attempt('ACTIVE with both approvals', insert(`status, "approvedByCustomerAt", "approvedByProviderAt"|'ENDED', now(), now()`).replace(`'ENDED', now(), now())`, `'ACTIVE', now(), now())`));
        // RESTRICT: an ordinary delete of a party company is refused while an agreement exists.
        await attempt('delete provider company', `DELETE FROM "Company" WHERE id = '${p.id}'`);
        throw new Rollback();
      })
      .catch((e) => {
        if (!(e instanceof Rollback)) throw e;
      });
    expect(outcomes['same party']).toMatch(/TransportServiceAgreement_parties_check/);
    expect(outcomes['validTo before validFrom']).toMatch(/TransportServiceAgreement_validity_check/);
    expect(outcomes['version 0']).toMatch(/TransportServiceAgreement_version_check/);
    expect(outcomes['NULL grants']).toMatch(/TransportServiceAgreement_lists_check/);
    expect(outcomes['ACTIVE without approvals']).toMatch(/TransportServiceAgreement_active_approved_check/);
    expect(outcomes['ENDED without endedAt']).toMatch(/TransportServiceAgreement_ended_check/);
    expect(outcomes['first draft']).toBe('accepted');
    expect(outcomes['second live draft']).toMatch(/TransportServiceAgreement_live_pair_key|23505/) // only unique index besides the uuid pkey;
    expect(outcomes['ended row beside the live one']).toBe('accepted');
    expect(outcomes['ACTIVE with both approvals']).toMatch(/TransportServiceAgreement_live_pair_key|23505/) // only unique index besides the uuid pkey;
    expect(outcomes['delete provider company']).toMatch(/rejected/);
    console.log(JSON.stringify(outcomes, null, 2));
    const left = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM "Company" WHERE name LIKE 'etms-db-test %'`;
    expect(Number(left[0].n)).toBe(0);
  });
});

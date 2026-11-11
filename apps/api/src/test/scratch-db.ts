/**
 * Database-name guard for DB-backed tests (doc 16 §5.1 C-4). A DB test may only open a scratch database:
 * - the name must end in `_test` (e.g. `veetrax_ci_test`, `veetrax_etms_test`);
 * - `veetracer` (production / dev data) is always refused;
 * - outside CI only, `veetrax_assess` is also accepted for the read-only / always-rolled-back ETMS DB tests (the local
 *   isolated instance, doc 16 §2); in CI (`CI=true`) only `_test` databases are accepted.
 * Returns the database name when allowed, null otherwise (the caller skips its suite).
 */
export function scratchDbName(url: string | undefined, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!url) return null;
  let name = '';
  try {
    name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
  } catch {
    return null;
  }
  if (!/^[a-z0-9_]+$/i.test(name) || /^veetracer$/i.test(name)) return null;
  if (/_test$/i.test(name)) return name;
  if (env.CI !== 'true' && name === 'veetrax_assess') return name;
  return null;
}

/**
 * `describe` for a DB suite on `url`, or `describe.skip` when no allowed scratch DB is configured. With
 * `DB_TEST_REQUIRED=1` (the CI `api-db` job) a missing or refused database fails the run instead of skipping silently.
 */
export function dbDescribe(url: string | undefined): { d: jest.Describe; dbName: string } {
  const dbName = scratchDbName(url) ?? '';
  if (!dbName && process.env.DB_TEST_REQUIRED === '1') {
    throw new Error('DB_TEST_REQUIRED=1 but no allowed scratch database: the URL must name a *_test database (never veetracer)');
  }
  return { d: dbName ? describe : describe.skip, dbName };
}

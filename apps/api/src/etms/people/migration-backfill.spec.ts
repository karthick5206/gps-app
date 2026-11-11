import { readFileSync } from 'fs';
import { join } from 'path';
import { ETMS_E2_TEMPLATE_PERMISSIONS, ETMS_ROLE_TEMPLATES } from '@veetracer/shared';

/**
 * QA B3: the etms_people migration backfills `etms_passengers` into the E1a role templates of companies that switched
 * etms on before E2. The SQL must stay in step with the code (ETMS_E2_TEMPLATE_PERMISSIONS and the template name /
 * description / scope that identify an unchanged template). The DB behaviour is tested in etms-people.db-test.ts.
 */
export const MIGRATION = join(__dirname, '../../../prisma/migrations/20261115090000_etms_people/migration.sql');

export function backfillSql(): string {
  const sql = readFileSync(MIGRATION, 'utf8').replace(/\r\n/g, '\n');
  const m = /-- ETMS-E2-BACKFILL-BEGIN[^\n]*\n([\s\S]*?)-- ETMS-E2-BACKFILL-END/.exec(sql);
  if (!m) throw new Error('backfill block missing');
  return m[1];
}

describe('etms_people migration: role template backfill (QA B3)', () => {
  const statements = backfillSql()
    .replace(/^\s*--.*$/gm, '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);

  it('one idempotent INSERT per E2 template, with exactly the E2 actions and the template identity', () => {
    expect(statements).toHaveLength(Object.keys(ETMS_E2_TEMPLATE_PERMISSIONS).length);
    for (const [name, perms] of Object.entries(ETMS_E2_TEMPLATE_PERMISSIONS)) {
      const def = ETMS_ROLE_TEMPLATES.find((t) => t.name === name)!;
      const stmt = statements.find((s) => s.includes(`r."name" = '${name}'`))!;
      expect(stmt).toBeDefined();
      expect(stmt).toContain(`r."description" = '${def.description}'`);
      expect(stmt).toContain(`r."dataScope" = '${def.dataScope}'`);
      expect(stmt).toContain('NOT r."isSystem"');
      expect(stmt).toMatch(/ON CONFLICT \("roleId", "menu"\) DO NOTHING$/);
      for (const [menu, actions] of Object.entries(perms)) {
        expect(stmt).toContain(`'${menu}', ARRAY[${(actions ?? []).map((a) => `'${a}'`).join(', ')}]`);
      }
    }
  });
});

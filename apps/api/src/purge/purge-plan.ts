/**
 * Permanent delete ("purge") planning for Super Admin: everything that belongs to a device, vehicle/person, user or
 * company, in an order PostgreSQL accepts. Built from the database catalogue, so new tables are covered without code
 * changes:
 * - foreign keys: children are deleted before their parent (SET NULL ones are left to the database; self-references
 *   are nulled first),
 * - logical links without a foreign key (history tables keep companyId / objectId / deviceId without constraints):
 *   every table with that column is cleared too.
 * Statements are plain SQL with subqueries on the rows about to go, so the whole plan runs in one transaction.
 */

export interface FkEdge {
  child: string;
  col: string;
  parent: string;
  refCol: string;
  /** pg confdeltype: a = no action, r = restrict, c = cascade, n = set null, d = set default */
  del: string;
}

export interface Catalog {
  fks: FkEdge[];
  /** table → its column names */
  columns: Map<string, Set<string>>;
}

export const PURGE_KINDS = ['device', 'object', 'user', 'company'] as const;
export type PurgeKind = (typeof PURGE_KINDS)[number];

export const PURGE_TABLE: Record<PurgeKind, string> = { device: 'Device', object: 'TrackedObject', user: 'User', company: 'Company' };

/** Columns that point at a row of the table without a foreign key (history, logs). */
const LOGICAL_KEY: Record<string, string> = { Company: 'companyId', TrackedObject: 'objectId', Device: 'deviceId' };

const MAX_DEPTH = 12;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const q = (ident: string) => `"${ident.replace(/"/g, '""')}"`;

/** WHERE condition for one root row (ids are validated, identifiers come from the catalogue). */
export function rootCondition(id: string): string {
  if (!UUID_RE.test(id)) throw new Error('Invalid id');
  return `"id" = '${id.toLowerCase()}'`;
}

export interface PlanStep {
  table: string;
  /** SQL condition selecting the rows of `table` to remove (or update, for `nullCol`). */
  where: string;
  /** Self-reference to clear before the delete (e.g. User.managerId). */
  nullCol?: string;
}

/** Ordered steps (children first) that remove the rows of `table` matching `where` and everything depending on them. */
export function planPurge(cat: Catalog, table: string, where: string): PlanStep[] {
  const steps: PlanStep[] = [];
  const seen = new Set<string>();
  const add = (s: PlanStep) => {
    const key = `${s.table}|${s.nullCol ?? ''}|${s.where}`;
    if (!seen.has(key)) {
      seen.add(key);
      steps.push(s);
    }
  };
  const walk = (t: string, cond: string, path: string[]) => {
    if (path.length > MAX_DEPTH) throw new Error(`Purge plan too deep at ${[...path, t].join(' → ')}`);
    const rows = (col: string) => `SELECT ${q(col)} FROM ${q(t)} WHERE ${cond}`;
    for (const fk of cat.fks) {
      if (fk.parent !== t) continue;
      if (fk.child === t) {
        add({ table: t, where: `${q(fk.col)} IN (${rows(fk.refCol)})`, nullCol: fk.col });
        continue;
      }
      if (fk.del === 'n' || fk.del === 'd' || path.includes(fk.child)) continue;
      walk(fk.child, `${q(fk.col)} IN (${rows(fk.refCol)})`, [...path, t]);
    }
    const key = LOGICAL_KEY[t];
    if (key) {
      for (const [other, cols] of cat.columns) {
        if (other === t || path.includes(other) || !cols.has(key)) continue;
        if (cat.fks.some((f) => f.child === other && f.col === key)) continue;
        walk(other, `${q(key)} IN (${rows('id')})`, [...path, t]);
      }
    }
    add({ table: t, where: cond });
  };
  walk(table, where, []);
  return steps;
}

export function stepSql(s: PlanStep): string {
  return s.nullCol ? `UPDATE ${q(s.table)} SET ${q(s.nullCol)} = NULL WHERE ${s.where}` : `DELETE FROM ${q(s.table)} WHERE ${s.where}`;
}

export function countSql(s: PlanStep): string {
  return `SELECT count(*)::bigint AS n FROM ${q(s.table)} WHERE ${s.where}`;
}

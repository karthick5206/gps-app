/** Report table helpers (RP-6): quick filter and column visibility. Pure so node --test can run them. */

type Row = Record<string, unknown>;
interface Col {
  id: string;
  value: (row: Row) => string | number | null;
}

/** localStorage key for a report type's hidden columns (same `vt.columns.*` family as the master pages). */
export function columnsKey(type: string): string {
  return `vt.columns.report.${type}`;
}

/** Visible column ids in order; the first column (the row's name) is always shown. */
export function visibleColumnIds(ids: readonly string[], hidden: Record<string, boolean>): string[] {
  return ids.filter((id, i) => i === 0 || hidden[id] !== false);
}

export function quickFilterText(row: Row, columns: readonly Col[]): string {
  return columns
    .map((c) => c.value(row))
    .filter((v) => v !== null && v !== undefined && v !== '')
    .join(' ')
    .toLowerCase();
}

/** Rows whose column values contain every word of `query` (case-insensitive). Empty query = all rows. */
export function filterRows<T extends Row>(rows: readonly T[], columns: readonly Col[], query: string): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...rows];
  return rows.filter((r) => {
    const text = quickFilterText(r, columns);
    return words.every((w) => text.includes(w));
  });
}

/**
 * "Export filtered view" (batch 2): what the page sends so the export holds exactly the rows the table shows, in its
 * order, without its hidden columns. Rows travel as short row keys; the API re-runs the report and keeps only rows
 * with those keys. Pure so node --test can run it.
 */
import { reportRowKey } from '@veetracer/shared';

export interface TableView {
  /** Rows after the chart selection and quick filter, in the table's sort order. */
  rows: Record<string, unknown>[];
  /** English headers of the hidden columns. */
  hiddenHeaders: string[];
  /** Chart selection and/or quick-filter text, e.g. "Vehicle: Bus 07 · “depot”". */
  label: string;
  /** True when rows are filtered or columns hidden (the view differs from the whole report). */
  differs: boolean;
}

/** Most rows a view export can name (the on-screen result is capped at 10,000 rows). */
export const VIEW_EXPORT_MAX = 10_000;

export function viewExportBody(view: TableView): { rows: string; hiddenColumns: string[]; label: string } {
  return {
    rows: view.rows.slice(0, VIEW_EXPORT_MAX).map((r) => reportRowKey(r)).join(''),
    hiddenColumns: view.hiddenHeaders.slice(0, 100).map((h) => h.slice(0, 80)),
    label: view.label.slice(0, 200),
  };
}

/** Label of the view: chart chip text and the quick filter in quotes. */
export function viewLabel(chip: string | null, query: string): string {
  const q = query.trim();
  return [chip, q ? `“${q}”` : null].filter(Boolean).join(' · ');
}

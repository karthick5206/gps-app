import { ArrowDownIcon, ArrowUpDownIcon, ArrowUpIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { computeTotals, type ReportColumn, type Row } from './report-columns';

const PAGE = 200;
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function compare(a: string | number | null, b: string | number | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1; // nulls last
  if (b === null) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return collator.compare(String(a), String(b));
}

/** Client-side sortable results table with sticky header and totals row. */
export function ReportTable({ columns, rows, totals: apiTotals, className }: { columns: ReportColumn[]; rows: Row[]; totals?: Record<string, number>; className?: string }) {
  const { t } = useTranslation();
  const [sort, setSort] = useState<{ id: string; desc: boolean } | null>(null);
  const [limit, setLimit] = useState(PAGE);

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.id === sort.id);
    if (!col) return rows;
    const keyed = rows.map((r) => ({ r, k: col.value(r) }));
    keyed.sort((x, y) => {
      const c = compare(x.k, y.k);
      return sort.desc ? -c : c;
    });
    return keyed.map((x) => x.r);
  }, [rows, columns, sort]);

  const totals = useMemo(() => computeTotals(columns, rows, apiTotals), [columns, rows, apiTotals]);
  const hasTotals = Object.keys(totals).length > 0 && rows.length > 0;

  const toggle = (id: string) =>
    setSort((s) => (s?.id !== id ? { id, desc: false } : !s.desc ? { id, desc: true } : null));

  const shown = sorted.slice(0, limit);

  return (
    <div className={cn('flex min-h-0 flex-col', className)}>
      <div className="max-h-[65vh] min-h-0 overflow-auto">
        <table className="w-full caption-bottom border-separate border-spacing-0 text-sm">
          <thead className="sticky top-0 z-10">
            <tr>
              {columns.map((c) => {
                const active = sort?.id === c.id;
                return (
                  <th
                    key={c.id}
                    scope="col"
                    aria-sort={active ? (sort!.desc ? 'descending' : 'ascending') : undefined}
                    className={cn('h-10 border-b bg-muted px-3 text-xs font-medium tracking-wide whitespace-nowrap text-muted-foreground uppercase', c.numeric ? 'text-right' : 'text-left')}
                  >
                    <button
                      type="button"
                      onClick={() => toggle(c.id)}
                      className={cn('-mx-1 inline-flex items-center gap-1 rounded px-1 uppercase hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none', c.numeric && 'flex-row-reverse')}
                    >
                      {t(c.header)}
                      {active ? sort!.desc ? <ArrowDownIcon className="size-3.5" /> : <ArrowUpIcon className="size-3.5" /> : <ArrowUpDownIcon className="size-3.5 opacity-40" />}
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {shown.map((r, i) => (
              <tr key={i} className="hover:bg-muted/40">
                {columns.map((c) => {
                  const v = c.value(r);
                  return (
                    <td key={c.id} className={cn('border-b px-3 py-2 align-middle whitespace-nowrap', c.numeric && 'text-right tabular-nums', c.className)}>
                      {c.render ? c.render(r) : c.format && typeof v === 'number' ? c.format(v) : (v ?? <span className="text-muted-foreground">—</span>)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
          {hasTotals && (
            <tfoot className="sticky bottom-0 z-10">
              <tr>
                {columns.map((c, i) => {
                  const v = totals[c.id];
                  return (
                    <td key={c.id} className={cn('border-t-2 bg-muted px-3 py-2 font-semibold whitespace-nowrap', c.numeric && 'text-right tabular-nums')}>
                      {i === 0 ? t('Total') : v === undefined ? '' : c.format ? c.format(v) : v.toLocaleString()}
                    </td>
                  );
                })}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      {sorted.length > limit && (
        <div className="flex items-center justify-center gap-3 border-t p-2 text-sm text-muted-foreground">
          {t('Showing {{shown}} of {{total}} rows', { shown: limit.toLocaleString(), total: sorted.length.toLocaleString() })}
          <Button size="sm" variant="outline" onClick={() => setLimit((l) => l + PAGE * 5)}>
            {t('Show more')}
          </Button>
        </div>
      )}
    </div>
  );
}

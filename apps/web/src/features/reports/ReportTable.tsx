import { ArrowDownIcon, ArrowUpDownIcon, ArrowUpIcon, Columns3Icon, PlayCircleIcon, SearchIcon, XIcon } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/features/auth/auth-context';
import { historyLink } from '@/features/history/time-range';
import { useMediaQuery } from '@/features/history/use-history';
import { storage } from '@/lib/storage';
import { cn } from '@/lib/utils';
import { computeTotals, type DrillWindow, type ReportColumn, type Row } from './report-columns';
import { reportZoneLabel } from './report-time';
import { columnsKey, filterRows, visibleColumnIds } from './table-state';

const PAGE = 200;
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function compare(a: string | number | null, b: string | number | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1; // nulls last
  if (b === null) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return collator.compare(String(a), String(b));
}

/** A selection made outside the table (a chart click); shown as a removable chip. */
export interface ExternalFilter {
  label: string;
  test: (row: Row) => boolean;
  onClear: () => void;
}

/** "Play in History" for a row (RP-3); opens the History page for that vehicle and window in a new tab. */
function PlayInHistory({ row, drill, compact }: { row: Row; drill: DrillWindow; compact?: boolean }) {
  const { t } = useTranslation();
  const w = drill(row);
  const to = w ? historyLink(w.objectId, w.from, w.to) : null;
  if (!to) return null;
  return (
    <Link
      to={to}
      target="_blank"
      rel="noreferrer"
      title={t('Play in History')}
      aria-label={t('Play in History')}
      className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs font-medium whitespace-nowrap text-primary hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      <PlayCircleIcon className="size-4" />
      {!compact && t('Play in History')}
    </Link>
  );
}

function cellContent(c: ReportColumn, r: Row) {
  const v = c.value(r);
  return c.render ? c.render(r) : c.format && typeof v === 'number' ? c.format(v) : (v ?? <span className="text-muted-foreground">—</span>);
}

/**
 * Results table: client sort, sticky header / first column / totals, column chooser (saved per report type, like the
 * master pages), quick filter, chart selection chip, "Play in History" row action and a card layout under 640 px.
 * With no filter the totals row shows the API totals exactly as before; with a filter it shows the filtered rows'
 * totals, labelled as such.
 */
export function ReportTable({
  type,
  columns,
  rows,
  totals: apiTotals,
  drill,
  filter,
  className,
}: {
  /** Report type: column choices are saved per type. */
  type?: string;
  columns: ReportColumn[];
  rows: Row[];
  totals?: Record<string, number>;
  drill?: DrillWindow;
  filter?: ExternalFilter | null;
  className?: string;
}) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const cards = useMediaQuery('(max-width: 639px)');
  const [sort, setSort] = useState<{ id: string; desc: boolean } | null>(null);
  const [limit, setLimit] = useState(PAGE);
  const [query, setQuery] = useState('');
  const [hidden, setHidden] = useState<Record<string, boolean>>(() => (type ? storage.getJson(columnsKey(type), {}) : {}));
  useEffect(() => {
    if (type) storage.setJson(columnsKey(type), hidden);
  }, [type, hidden]);
  const zone = reportZoneLabel();
  const showDrill = !!drill && can('history');

  const visibleIds = visibleColumnIds(
    columns.map((c) => c.id),
    hidden,
  );
  const shownColumns = columns.filter((c) => visibleIds.includes(c.id));
  const header = (c: ReportColumn) => (c.zoned && zone ? `${t(c.header)} (${zone})` : t(c.header));

  const filtered = useMemo(() => {
    const byChart = filter ? rows.filter(filter.test) : rows;
    return filterRows(byChart, shownColumns, query);
    // shownColumns is derived from columns + hidden
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, filter, query, columns, hidden]);
  const isFiltered = !!filter || !!query.trim();

  const sorted = useMemo(() => {
    if (!sort) return filtered;
    const col = columns.find((c) => c.id === sort.id);
    if (!col) return filtered;
    const keyed = filtered.map((r) => ({ r, k: col.value(r) }));
    keyed.sort((x, y) => {
      const c = compare(x.k, y.k);
      return sort.desc ? -c : c;
    });
    return keyed.map((x) => x.r);
  }, [filtered, columns, sort]);

  // Unfiltered: API totals first (they cover every row, also beyond the 10,000 shown). Filtered: the shown rows only.
  const totals = useMemo(() => (isFiltered ? computeTotals(columns, filtered) : computeTotals(columns, rows, apiTotals)), [isFiltered, columns, filtered, rows, apiTotals]);
  const hasTotals = Object.keys(totals).length > 0 && filtered.length > 0;
  const totalLabel = isFiltered ? t('Total (filtered)') : t('Total');

  const toggle = (id: string) => setSort((s) => (s?.id !== id ? { id, desc: false } : !s.desc ? { id, desc: true } : null));
  const shown = sorted.slice(0, limit);

  const toolbar = (
    <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
      <div className="relative min-w-40 flex-1 sm:max-w-72">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setLimit(PAGE);
          }}
          placeholder={t('Filter rows…')}
          aria-label={t('Filter rows')}
          className="h-9 pl-8"
        />
      </div>
      {filter && (
        <span className="inline-flex items-center gap-1 rounded-full border border-primary/40 bg-accent py-0.5 pr-1 pl-2.5 text-xs text-accent-foreground">
          {filter.label}
          <button type="button" onClick={filter.onClear} aria-label={t('Clear chart selection')} className="rounded-full p-0.5 hover:bg-background/60">
            <XIcon className="size-3" />
          </button>
        </span>
      )}
      <span className="flex-1" />
      <span className="text-xs text-muted-foreground tabular-nums">
        {isFiltered ? t('{{shown}} of {{total}} rows', { shown: filtered.length.toLocaleString(), total: rows.length.toLocaleString() }) : t('{{rows}} rows', { rows: rows.length.toLocaleString() })}
      </span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="icon" className="size-9" aria-label={t('Choose columns')}>
            <Columns3Icon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="max-h-80 overflow-y-auto">
          <DropdownMenuLabel>{t('Visible columns')}</DropdownMenuLabel>
          {columns.slice(1).map((c) => (
            <DropdownMenuCheckboxItem key={c.id} checked={hidden[c.id] !== false} onCheckedChange={(v) => setHidden((h) => ({ ...h, [c.id]: !!v }))} onSelect={(e) => e.preventDefault()}>
              {header(c)}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );

  const more = sorted.length > limit && (
    <div className="flex items-center justify-center gap-3 border-t p-2 text-sm text-muted-foreground">
      {t('Showing {{shown}} of {{total}} rows', { shown: limit.toLocaleString(), total: sorted.length.toLocaleString() })}
      <Button size="sm" variant="outline" onClick={() => setLimit((l) => l + PAGE * 5)}>
        {t('Show more')}
      </Button>
    </div>
  );

  if (cards) {
    const [first, ...rest] = shownColumns;
    return (
      <div className={cn('flex min-h-0 flex-col', className)}>
        {toolbar}
        <ul className="divide-y" aria-label={t('Report rows')}>
          {shown.map((r, i) => (
            <li key={i} className="space-y-2 px-3 py-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 text-sm font-medium">{cellContent(first, r)}</div>
                {showDrill && <PlayInHistory row={r} drill={drill!} compact />}
              </div>
              <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
                {rest.map((c) => (
                  <div key={c.id} className="min-w-0">
                    <dt className="text-[11px] tracking-wide text-muted-foreground uppercase">{header(c)}</dt>
                    <dd className={cn('truncate', c.numeric && 'tabular-nums')}>{cellContent(c, r)}</dd>
                  </div>
                ))}
              </dl>
            </li>
          ))}
        </ul>
        {more}
        {hasTotals && (
          <div className="border-t-2 bg-muted px-3 py-3">
            <p className="mb-1.5 text-xs font-semibold">{totalLabel}</p>
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
              {shownColumns
                .filter((c) => totals[c.id] !== undefined)
                .map((c) => (
                  <div key={c.id}>
                    <dt className="text-[11px] tracking-wide text-muted-foreground uppercase">{header(c)}</dt>
                    <dd className="font-semibold tabular-nums">{c.format ? c.format(totals[c.id]) : totals[c.id].toLocaleString()}</dd>
                  </div>
                ))}
            </dl>
          </div>
        )}
      </div>
    );
  }

  const stickyFirst = 'sticky left-0 z-[1] border-r';
  return (
    <div className={cn('flex min-h-0 flex-col', className)}>
      {toolbar}
      <div className="max-h-[65vh] min-h-0 overflow-auto">
        <table className="w-full caption-bottom border-separate border-spacing-0 text-sm">
          <thead className="sticky top-0 z-10">
            <tr>
              {shownColumns.map((c, i) => {
                const active = sort?.id === c.id;
                return (
                  <th
                    key={c.id}
                    scope="col"
                    aria-sort={active ? (sort!.desc ? 'descending' : 'ascending') : undefined}
                    className={cn('h-10 border-b bg-muted px-3 text-xs font-medium tracking-wide whitespace-nowrap text-muted-foreground uppercase', c.numeric ? 'text-right' : 'text-left', i === 0 && stickyFirst)}
                  >
                    <button
                      type="button"
                      onClick={() => toggle(c.id)}
                      className={cn('-mx-1 inline-flex items-center gap-1 rounded px-1 uppercase hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none', c.numeric && 'flex-row-reverse')}
                    >
                      {header(c)}
                      {active ? sort!.desc ? <ArrowDownIcon className="size-3.5" /> : <ArrowUpIcon className="size-3.5" /> : <ArrowUpDownIcon className="size-3.5 opacity-40" />}
                    </button>
                  </th>
                );
              })}
              {showDrill && (
                <th scope="col" className="sticky right-0 h-10 border-b border-l bg-muted px-2 text-xs font-medium text-muted-foreground">
                  <span className="sr-only">{t('Actions')}</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {shown.map((r, i) => (
              <tr key={i} className="group">
                {shownColumns.map((c, ci) => (
                  <td
                    key={c.id}
                    className={cn(
                      'border-b bg-card px-3 py-2 align-middle whitespace-nowrap group-hover:bg-[color-mix(in_oklab,var(--muted)_60%,var(--card))]',
                      c.numeric && 'text-right tabular-nums',
                      c.className,
                      ci === 0 && stickyFirst,
                    )}
                  >
                    {cellContent(c, r)}
                  </td>
                ))}
                {showDrill && (
                  <td className="sticky right-0 border-b border-l bg-card px-1 py-1 group-hover:bg-[color-mix(in_oklab,var(--muted)_60%,var(--card))]">
                    <PlayInHistory row={r} drill={drill!} />
                  </td>
                )}
              </tr>
            ))}
          </tbody>
          {hasTotals && (
            <tfoot className="sticky bottom-0 z-10">
              <tr>
                {shownColumns.map((c, i) => {
                  const v = totals[c.id];
                  return (
                    <td key={c.id} className={cn('border-t-2 bg-muted px-3 py-2 font-semibold whitespace-nowrap', c.numeric && 'text-right tabular-nums', i === 0 && stickyFirst)}>
                      {i === 0 ? totalLabel : v === undefined ? '' : c.format ? c.format(v) : v.toLocaleString()}
                    </td>
                  );
                })}
                {showDrill && <td className="sticky right-0 border-t-2 border-l bg-muted" />}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      {more}
    </div>
  );
}

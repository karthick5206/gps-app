/**
 * Small hand-rolled SVG/CSS chart kit for report insights (no chart dependency). The bar chart is the one SummaryCharts
 * used, generalised (any period/day keys, any segments, optional click-to-select); RankedBars follows dashboard
 * BarList; Heatmap is a single-hue (primary) sequential grid; KpiStrip is the tile row above the charts.
 */
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Card } from '@/components/ui/card';
import { statusColor } from '@/lib/status-tokens';
import { cn } from '@/lib/utils';
import type { Kpi, Segment, ValueFormat } from './insights';
import { formatHm } from './report-format';

export function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

export function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

/** Bar with 4 px rounded top, square at the baseline. */
function barPath(x: number, y: number, w: number, h: number, round: boolean): string {
  if (h <= 0) return '';
  const r = round ? Math.min(4, w / 2, h) : 0;
  return `M${x},${y + h}V${y + r}${r ? `Q${x},${y} ${x + r},${y}` : ''}H${x + w - r}${r ? `Q${x + w},${y} ${x + w},${y + r}` : ''}V${y + h}Z`;
}

export const TONE_COLOR: Record<Segment['tone'], string> = {
  primary: 'var(--primary)',
  running: statusColor('RUNNING'),
  idle: statusColor('IDLE'),
  stopped: statusColor('OFF'),
  critical: 'var(--destructive)',
  warning: 'var(--warning)',
  info: 'var(--info)',
  muted: 'var(--muted-foreground)',
};

const km1 = (v: number) => v.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 });

export function formatValue(v: number | null | undefined, f: ValueFormat): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  switch (f) {
    case 'km':
      return `${km1(v)} km`;
    case 'hm':
      return formatHm(v);
    case 'hours':
      return formatHm(v * 3600);
    case 'pct':
      return `${Number.isInteger(v) ? v : v.toFixed(1)}%`;
    case 'kph':
      return `${Math.round(v)} km/h`;
    case 'sec':
      return v < 120 ? `${Math.round(v)} s` : formatHm(v);
    default:
      return Math.round(v).toLocaleString();
  }
}

export function axisValue(v: number, f: ValueFormat): string {
  if (f === 'hours') return `${Number.isInteger(v) ? v : v.toFixed(1)}h`;
  if (f === 'hm') return `${Math.round(v / 3600)}h`;
  return v >= 1000 ? `${(v / 1000).toFixed(v % 1000 ? 1 : 0)}k` : String(Math.round(v * 10) / 10);
}

export interface ChartSegment {
  key: string;
  label: string;
  color: string;
}

export interface ChartBar {
  key: string;
  values: Record<string, number>;
  extra?: { label: string; value: number; format: ValueFormat }[];
}

const H = 200;
const PAD = { l: 44, r: 8, t: 10, b: 24 };

/** Stacked vertical bars; clicking a bar selects its key (day / period) when `onSelect` is given. */
export function BarChart({
  title,
  data,
  segments,
  format,
  axisFormat,
  shortLabel,
  longLabel,
  onSelect,
  selected,
  action,
}: {
  title: string;
  data: ChartBar[];
  segments: ChartSegment[];
  format: (v: number) => string;
  axisFormat: (v: number) => string;
  shortLabel: (key: string) => string;
  longLabel: (key: string) => string;
  onSelect?: (key: string) => void;
  selected?: string | null;
  action?: ReactNode;
}) {
  const { t } = useTranslation();
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const totals = data.map((d) => segments.reduce((s, seg) => s + (d.values[seg.key] ?? 0), 0));
  const max = niceMax(Math.max(0, ...totals));
  const plotW = Math.max(0, width - PAD.l - PAD.r);
  const plotH = H - PAD.t - PAD.b;
  const band = data.length ? plotW / data.length : 0;
  const barW = Math.max(2, Math.min(36, band * 0.7));
  const y = (v: number) => PAD.t + plotH - (v / max) * plotH;
  const labelEvery = Math.max(1, Math.ceil(data.length / Math.max(1, Math.floor(plotW / 56))));
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
  const dim = (i: number) => (selected ? data[i].key !== selected : hover !== null && hover !== i);

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        <div className="flex flex-wrap items-center gap-3">
          {segments.length > 1 && (
            <ul className="flex flex-wrap gap-3 text-xs text-muted-foreground">
              {segments.map((s) => (
                <li key={s.key} className="flex items-center gap-1.5">
                  <span className="size-2.5 rounded-sm" style={{ backgroundColor: s.color }} aria-hidden />
                  {s.label}
                </li>
              ))}
            </ul>
          )}
          {action}
        </div>
      </div>
      <div ref={ref} className="relative mt-2" onMouseLeave={() => setHover(null)}>
        {width > 0 && (
          <svg width={width} height={H} role="img" aria-label={title} className="block overflow-visible">
            {ticks.map((tk) => (
              <g key={tk}>
                <line x1={PAD.l} x2={width - PAD.r} y1={y(tk)} y2={y(tk)} stroke="var(--border)" strokeDasharray={tk === 0 ? undefined : '3 3'} />
                <text x={PAD.l - 6} y={y(tk)} dy="0.32em" textAnchor="end" className="fill-muted-foreground text-[10px] tabular-nums">
                  {axisFormat(tk)}
                </text>
              </g>
            ))}
            {data.map((d, i) => {
              const x = PAD.l + i * band + (band - barW) / 2;
              let acc = 0;
              const visible = segments.filter((s) => (d.values[s.key] ?? 0) > 0);
              return (
                <g key={d.key} opacity={dim(i) ? 0.45 : 1}>
                  {visible.map((s, k) => {
                    const v = d.values[s.key] ?? 0;
                    const top = y(acc + v);
                    const h = y(acc) - top - (k > 0 ? 2 : 0); // 2 px surface gap between stacked segments
                    acc += v;
                    return <path key={s.key} d={barPath(x, top, barW, Math.max(0, h), k === visible.length - 1)} fill={s.color} />;
                  })}
                  {i % labelEvery === 0 && (
                    <text x={x + barW / 2} y={H - 8} textAnchor="middle" className="fill-muted-foreground text-[10px]">
                      {shortLabel(d.key)}
                    </text>
                  )}
                  <rect
                    x={PAD.l + i * band}
                    y={PAD.t}
                    width={band}
                    height={plotH}
                    fill="transparent"
                    className={onSelect ? 'cursor-pointer' : undefined}
                    onMouseEnter={() => setHover(i)}
                    onClick={onSelect ? () => onSelect(d.key) : undefined}
                  >
                    <title>{longLabel(d.key)}</title>
                  </rect>
                </g>
              );
            })}
          </svg>
        )}
        {hover !== null && data[hover] && (
          <div
            className="pointer-events-none absolute top-0 z-10 min-w-36 rounded-md border bg-popover px-2.5 py-2 text-xs text-popover-foreground shadow-md"
            style={{ left: Math.min(Math.max(0, PAD.l + hover * band + band / 2 - 72), Math.max(0, width - 150)) }}
          >
            <p className="font-medium">{longLabel(data[hover].key)}</p>
            {segments.map((s) => (
              <p key={s.key} className="mt-0.5 flex items-center justify-between gap-3 tabular-nums">
                <span className="flex items-center gap-1.5 text-muted-foreground">
                  <span className="size-2 rounded-sm" style={{ backgroundColor: s.color }} />
                  {s.label}
                </span>
                {format(data[hover].values[s.key] ?? 0)}
              </p>
            ))}
            {data[hover].extra?.map((e) => (
              <p key={e.label} className="mt-0.5 flex items-center justify-between gap-3 tabular-nums">
                <span className="text-muted-foreground">{t(e.label)}</span>
                {formatValue(e.value, e.format)}
              </p>
            ))}
            {onSelect && <p className="mt-1 text-[10px] text-muted-foreground">{t('Click to filter the table')}</p>}
          </div>
        )}
      </div>
      {/* Text alternative: the same values as a list for screen readers. */}
      <ul className="sr-only">
        {data.map((d) => (
          <li key={d.key}>
            {longLabel(d.key)}: {segments.map((s) => `${s.label} ${format(d.values[s.key] ?? 0)}`).join(', ')}
          </li>
        ))}
      </ul>
    </Card>
  );
}

export interface RankedRow {
  key: string;
  label: string;
  sub?: string | null;
  value: number;
}

/** Ranked horizontal bars (largest = full width); each row is a button when `onSelect` is given. */
export function RankedBars({
  title,
  items,
  total,
  format,
  onSelect,
  selected,
  color = 'var(--primary)',
}: {
  title: string;
  items: RankedRow[];
  total: number;
  format: (v: number) => string;
  onSelect?: (item: RankedRow) => void;
  selected?: string | null;
  color?: string;
}) {
  const { t } = useTranslation();
  const max = Math.max(0, ...items.map((i) => i.value));
  return (
    <Card className="p-4">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        {total > items.length && <span className="text-xs text-muted-foreground">{t('Top {{n}} of {{total}}', { n: items.length, total })}</span>}
      </div>
      {!items.length ? (
        <p className="py-6 text-center text-sm text-muted-foreground">{t('Nothing to show')}</p>
      ) : (
        <ol className="mt-3 space-y-1">
          {items.map((i) => {
            const body = (
              <>
                <div className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="min-w-0 truncate">
                    <span className="font-medium">{i.label}</span>
                    {i.sub && <span className="ml-1.5 text-xs text-muted-foreground">{i.sub}</span>}
                  </span>
                  <span className="shrink-0 font-medium tabular-nums">{format(i.value)}</span>
                </div>
                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
                  <div className="h-full rounded-full" style={{ width: `${max ? Math.max((i.value / max) * 100, i.value ? 2 : 0) : 0}%`, backgroundColor: color }} />
                </div>
              </>
            );
            return (
              <li key={i.key}>
                {onSelect ? (
                  <button
                    type="button"
                    onClick={() => onSelect(i)}
                    aria-pressed={selected === i.key}
                    className={cn('w-full rounded-md px-1.5 py-1 text-left transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none', selected === i.key && 'bg-accent', selected && selected !== i.key && 'opacity-60')}
                  >
                    {body}
                  </button>
                ) : (
                  <div className="px-1.5 py-1">{body}</div>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </Card>
  );
}

/** Vehicle × type grid, one hue (primary) from light to dark by count; a cell click selects that pair. */
export function Heatmap({
  title,
  rows,
  cols,
  cells,
  max,
  hiddenRows,
  hiddenCols,
  onSelect,
  selected,
}: {
  title: string;
  rows: { key: string; label: string; sub?: string | null; total: number }[];
  cols: { key: string; label: string; total: number }[];
  cells: Record<string, { count: number; critical: number }>;
  max: number;
  hiddenRows: number;
  hiddenCols: number;
  onSelect?: (row: { key: string; label: string }, col: { key: string; label: string }) => void;
  selected?: string | null;
}) {
  const { t } = useTranslation();
  const shade = (n: number) => (n <= 0 ? 'transparent' : `color-mix(in oklab, var(--primary) ${Math.round(12 + (n / Math.max(1, max)) * 78)}%, var(--card))`);
  const ink = (n: number) => (n / Math.max(1, max) > 0.5 ? 'var(--primary-foreground)' : 'var(--foreground)');
  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>0</span>
          <span className="h-2 w-24 rounded-full" style={{ background: 'linear-gradient(90deg, color-mix(in oklab, var(--primary) 12%, var(--card)), var(--primary))' }} aria-hidden />
          <span className="tabular-nums">{max.toLocaleString()}</span>
        </div>
      </div>
      {!rows.length ? (
        <p className="py-6 text-center text-sm text-muted-foreground">{t('Nothing to show')}</p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="border-separate border-spacing-0.5 text-xs">
            <thead>
              <tr>
                <th scope="col" className="sticky left-0 z-[1] bg-card" />
                {cols.map((c) => (
                  <th key={c.key} scope="col" className="h-24 min-w-11 align-bottom font-normal text-muted-foreground">
                    <span className="inline-block max-h-24 rotate-180 truncate whitespace-nowrap [writing-mode:vertical-rl]" title={c.label}>
                      {c.label}
                    </span>
                  </th>
                ))}
                <th scope="col" className="px-2 text-right align-bottom font-medium text-muted-foreground">
                  {t('Total')}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key}>
                  <th scope="row" className="sticky left-0 z-[1] max-w-40 truncate bg-card pr-2 text-left font-medium" title={r.label}>
                    {r.label}
                  </th>
                  {cols.map((c) => {
                    const cell = cells[`${r.key}|${c.key}`];
                    const count = cell?.count ?? 0;
                    const key = `${r.key}|${c.key}`;
                    const label = `${r.label} · ${c.label}: ${count.toLocaleString()}${cell?.critical ? ` (${t('{{n}} critical', { n: cell.critical })})` : ''}`;
                    return (
                      <td key={c.key} className="p-0">
                        <button
                          type="button"
                          disabled={!count || !onSelect}
                          onClick={() => onSelect?.(r, c)}
                          title={label}
                          aria-label={label}
                          aria-pressed={selected === key}
                          className={cn(
                            'flex h-8 w-11 items-center justify-center rounded-sm border tabular-nums transition-shadow focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none enabled:hover:ring-2 enabled:hover:ring-ring/60',
                            count ? 'border-transparent' : 'border-dashed border-border text-muted-foreground/50',
                            selected === key && 'ring-2 ring-ring',
                            selected && selected !== key && 'opacity-50',
                          )}
                          style={{ backgroundColor: shade(count), color: count ? ink(count) : undefined }}
                        >
                          {count ? count.toLocaleString() : '·'}
                        </button>
                      </td>
                    );
                  })}
                  <td className="px-2 text-right font-semibold tabular-nums">{r.total.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {(hiddenRows > 0 || hiddenCols > 0) && (
        <p className="mt-2 text-xs text-muted-foreground">
          {t('Busiest {{rows}} vehicles and {{cols}} event types shown; the table below has every row.', { rows: rows.length, cols: cols.length })}
        </p>
      )}
    </Card>
  );
}

const TONE_TEXT: Record<NonNullable<Kpi['tone']>, string> = {
  default: '',
  warning: 'text-warning',
  danger: 'text-destructive',
};

/** KPI tiles; values from the API totals unless marked as derived from the shown rows. */
export function KpiStrip({ kpis, partial }: { kpis: Kpi[]; partial: boolean }) {
  const { t } = useTranslation();
  return (
    <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6" aria-label={t('Key figures')}>
      {kpis.map((k) => (
        <div key={k.id} className="rounded-xl border bg-card px-3 py-2.5 shadow-xs">
          <dt className="truncate text-xs text-muted-foreground">{t(k.label)}</dt>
          <dd className={cn('mt-0.5 text-lg font-semibold tracking-tight tabular-nums', k.tone && TONE_TEXT[k.tone])}>
            {formatValue(k.value, k.format)}
            {k.fromRows && partial && (
              <span className="ml-1 align-super text-xs text-warning" title={t('From the rows shown only')}>
                *
              </span>
            )}
          </dd>
          {k.hint && <p className="truncate text-[11px] text-muted-foreground">{t(k.hint.text, k.hint.vars)}</p>}
        </div>
      ))}
    </dl>
  );
}

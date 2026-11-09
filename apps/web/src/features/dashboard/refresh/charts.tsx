/** Hand-rolled SVG/CSS charts for the uiRefresh dashboard (no chart library). Theme tokens only. */
import { InboxIcon, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { BarItem, Slice } from '../charts';
import { EmptyHint } from './kit';

/**
 * Donut with centred total and a full legend. Legend labels wrap instead of truncating (the full text is also the
 * row's tooltip). `onSelect` makes legend rows buttons, exactly like the classic Donut.
 */
export function DonutR({ title, slices, centerLabel, onSelect, emptyText, emptyIcon = InboxIcon }: { title: string; slices: Slice[]; centerLabel?: string; onSelect?: (key: string) => void; emptyText?: string; emptyIcon?: LucideIcon }) {
  const { t } = useTranslation();
  const total = slices.reduce((s, x) => s + x.value, 0);
  if (!total && emptyText) return <EmptyHint icon={emptyIcon} text={emptyText} />;
  const r = 44;
  const c = 2 * Math.PI * r;
  let offset = 0;
  return (
    <figure className="flex flex-row items-center gap-3 sm:gap-4">
      <svg viewBox="0 0 120 120" className="size-24 shrink-0 -rotate-90 sm:size-28" role="img" aria-label={`${title}: ${slices.map((s) => `${s.label} ${s.value}`).join(', ')}`}>
        <circle cx="60" cy="60" r={r} fill="none" stroke="var(--muted)" strokeWidth="12" />
        {total > 0 &&
          slices.map((s) => {
            if (!s.value) return null;
            const len = (s.value / total) * c;
            const el = (
              <circle key={s.key} cx="60" cy="60" r={r} fill="none" stroke={s.color} strokeWidth="12" strokeDasharray={`${Math.max(len - 2, 0.5)} ${c}`} strokeDashoffset={-offset} className="motion-safe:transition-[stroke-dasharray] motion-safe:duration-500">
                <title>{`${s.label}: ${s.value}`}</title>
              </circle>
            );
            offset += len;
            return el;
          })}
        <text x="60" y="60" textAnchor="middle" className="fill-foreground text-[22px] font-semibold tabular-nums" transform="rotate(90 60 60)">
          {total.toLocaleString()}
        </text>
        <text x="60" y="76" textAnchor="middle" className="fill-muted-foreground text-[10px]" transform="rotate(90 60 60)">
          {centerLabel ?? t('total')}
        </text>
      </svg>
      <figcaption className="w-full min-w-0">
        <span className="sr-only">{title}</span>
        <ul className="space-y-0.5">
          {slices.map((s) => {
            const pct = total ? Math.round((s.value / total) * 100) : 0;
            const content = (
              <>
                <span className="mt-1.5 size-2.5 shrink-0 rounded-full ring-1 ring-black/5" style={{ backgroundColor: s.color }} aria-hidden />
                <span className="min-w-0 flex-1 break-words">{s.label}</span>
                <span className="font-semibold tabular-nums">{s.value.toLocaleString()}</span>
                <span className="w-10 text-right text-xs leading-5 text-muted-foreground tabular-nums">{pct}%</span>
              </>
            );
            return (
              <li key={s.key} title={`${s.label}: ${s.value.toLocaleString()} (${pct}%)`}>
                {onSelect ? (
                  <button type="button" onClick={() => onSelect(s.key)} className="flex w-full items-start gap-2 rounded-md px-1.5 py-1 text-left text-sm hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
                    {content}
                  </button>
                ) : (
                  <div className="flex items-start gap-2 px-1.5 py-1 text-sm">{content}</div>
                )}
              </li>
            );
          })}
        </ul>
      </figcaption>
    </figure>
  );
}

/**
 * Ranked list with bars (largest value = full width): rank number, name + sub-line, value, bar in a semantic colour.
 * Same props as the classic BarList; an empty list shows an icon + sentence.
 */
export function RankList({ items, format, empty, color = 'var(--primary)', action, emptyIcon = InboxIcon, ranked = true, columns = false }: { items: BarItem[]; format: (v: number) => string; empty: string; color?: string; action?: (item: BarItem) => ReactNode; emptyIcon?: LucideIcon; ranked?: boolean; columns?: boolean }) {
  const max = Math.max(0, ...items.map((i) => i.value));
  if (!items.length) return <EmptyHint icon={emptyIcon} text={empty} />;
  return (
    <ol className={columns ? "gap-x-8 md:columns-2" : "divide-y divide-border/70"}>
      {items.map((i, n) => (
        <li key={i.key} className={columns ? "flex break-inside-avoid items-center gap-2.5 border-b border-border/70 py-1.5 sm:gap-3 sm:py-2" : "flex items-center gap-2.5 py-1.5 first:pt-0 last:pb-0 sm:gap-3 sm:py-2"}>
          {ranked && (
            <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-[11px] font-semibold text-muted-foreground tabular-nums" aria-hidden>
              {n + 1}
            </span>
          )}
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="min-w-0 truncate" title={i.sub ? `${i.label} · ${i.sub}` : i.label}>
                <span className="font-medium">{i.label}</span>
                {i.sub && <span className="ml-1.5 text-xs text-muted-foreground">{i.sub}</span>}
              </span>
              <span className="flex shrink-0 items-center gap-2 font-semibold tabular-nums">
                {format(i.value)}
                {action?.(i)}
              </span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
              <div className="h-full rounded-full motion-safe:transition-[width] motion-safe:duration-500" style={{ width: `${max ? Math.max((i.value / max) * 100, i.value ? 2 : 0) : 0}%`, backgroundColor: color }} />
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}

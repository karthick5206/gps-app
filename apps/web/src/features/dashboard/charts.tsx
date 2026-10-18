import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

export interface Slice {
  key: string;
  label: string;
  value: number;
  color: string;
}

/** Donut with a centred total and a clickable legend; zero-value slices stay in the legend. */
export function Donut({ title, slices, centerLabel, onSelect }: { title: string; slices: Slice[]; centerLabel?: string; onSelect?: (key: string) => void }) {
  const { t } = useTranslation();
  const total = slices.reduce((s, x) => s + x.value, 0);
  const r = 42;
  const c = 2 * Math.PI * r;
  let offset = 0;
  return (
    <figure className="flex flex-col items-center gap-4 sm:flex-row sm:items-center">
      <svg viewBox="0 0 120 120" className="size-36 shrink-0 -rotate-90" role="img" aria-label={`${title}: ${slices.map((s) => `${s.label} ${s.value}`).join(', ')}`}>
        <circle cx="60" cy="60" r={r} fill="none" stroke="var(--muted)" strokeWidth="14" />
        {total > 0 &&
          slices.map((s) => {
            if (!s.value) return null;
            const len = (s.value / total) * c;
            const el = (
              <circle
                key={s.key}
                cx="60"
                cy="60"
                r={r}
                fill="none"
                stroke={s.color}
                strokeWidth="14"
                strokeDasharray={`${Math.max(len - 1.5, 0.5)} ${c}`}
                strokeDashoffset={-offset}
                className="transition-[stroke-dasharray] duration-500"
              >
                <title>{`${s.label}: ${s.value}`}</title>
              </circle>
            );
            offset += len;
            return el;
          })}
        <text x="60" y="58" textAnchor="middle" className="fill-foreground text-[20px] font-semibold" transform="rotate(90 60 60)">
          {total.toLocaleString()}
        </text>
        <text x="60" y="74" textAnchor="middle" className="fill-muted-foreground text-[9px]" transform="rotate(90 60 60)">
          {centerLabel ?? t('total')}
        </text>
      </svg>
      <figcaption className="w-full min-w-0 space-y-1">
        <p className="mb-1.5 text-sm font-semibold">{title}</p>
        <ul className="space-y-0.5">
          {slices.map((s) => {
            const pct = total ? Math.round((s.value / total) * 100) : 0;
            const content = (
              <>
                <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: s.color }} />
                <span className="min-w-0 flex-1 truncate">{s.label}</span>
                <span className="font-medium tabular-nums">{s.value.toLocaleString()}</span>
                <span className="w-9 text-right text-xs text-muted-foreground tabular-nums">{pct}%</span>
              </>
            );
            return (
              <li key={s.key}>
                {onSelect ? (
                  <button type="button" onClick={() => onSelect(s.key)} className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-sm hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-none">
                    {content}
                  </button>
                ) : (
                  <div className="flex items-center gap-2 px-1.5 py-1 text-sm">{content}</div>
                )}
              </li>
            );
          })}
        </ul>
      </figcaption>
    </figure>
  );
}

export interface BarItem {
  key: string;
  label: string;
  sub?: string | null;
  value: number;
}

/** Ranked horizontal bars (largest value = full width). */
export function BarList({ items, format, empty, color = 'var(--primary)', action }: { items: BarItem[]; format: (v: number) => string; empty: string; color?: string; action?: (item: BarItem) => ReactNode }) {
  const max = Math.max(0, ...items.map((i) => i.value));
  if (!items.length) return <p className="py-6 text-center text-sm text-muted-foreground">{empty}</p>;
  return (
    <ol className="space-y-2">
      {items.map((i) => (
        <li key={i.key} className="space-y-1">
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="min-w-0 truncate">
              <span className="font-medium">{i.label}</span>
              {i.sub && <span className="ml-1.5 text-xs text-muted-foreground">{i.sub}</span>}
            </span>
            <span className="flex shrink-0 items-center gap-2 font-medium tabular-nums">
              {format(i.value)}
              {action?.(i)}
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div className={cn('h-full rounded-full transition-[width] duration-500')} style={{ width: `${max ? Math.max((i.value / max) * 100, i.value ? 2 : 0) : 0}%`, backgroundColor: color }} />
          </div>
        </li>
      ))}
    </ol>
  );
}

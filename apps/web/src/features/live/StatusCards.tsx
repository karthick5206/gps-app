import { MOVEMENT_STATUSES, STATUS_META, type MovementStatus } from '@veetracer/shared';
import { useTranslation } from 'react-i18next';
import { StatusDot } from '@/components/status-badge';
import { statusColor } from '@/lib/status-tokens';
import { formatNumber } from '@/lib/format';
import { cn } from '@/lib/utils';

/** Share of the fleet as a whole percent; "<1" for a non-zero share that rounds to 0. */
export function sharePct(count: number, total: number): string {
  if (!total || !count) return '0';
  const p = Math.round((count / total) * 100);
  return p < 1 ? '<1' : String(p);
}

/**
 * Status cards over the live list: count, a bar of its share of the fleet and the percentage. Clicking one filters
 * the list and the map to that status (several can be on); "All" clears the filter.
 */
export function StatusCards({
  counts,
  statuses,
  onToggle,
  onAll,
}: {
  counts: Record<MovementStatus, number> & { total: number };
  statuses: readonly MovementStatus[];
  onToggle: (s: MovementStatus) => void;
  onAll: () => void;
}) {
  const { t } = useTranslation();
  const all = statuses.length === 0;
  return (
    <div className="space-y-1.5" role="group" aria-label={t('Filter by status')}>
      <button
        type="button"
        aria-pressed={all}
        onClick={onAll}
        className={cn(
          'flex w-full items-center justify-between rounded-md border px-2.5 py-1.5 text-xs font-semibold transition-colors',
          all ? 'border-primary bg-primary text-primary-foreground' : 'hover:bg-muted',
        )}
      >
        <span>{t('All')}</span>
        <span className="tabular-nums">{formatNumber(counts.total)}</span>
      </button>
      <div className="grid grid-cols-3 gap-1.5">
        {MOVEMENT_STATUSES.map((s) => {
          const on = statuses.includes(s);
          const color = statusColor(s);
          const pct = sharePct(counts[s], counts.total);
          const label = t(STATUS_META[s].label);
          return (
            <button
              key={s}
              type="button"
              aria-pressed={on}
              aria-label={t('{{status}}: {{count}}, {{pct}}% of fleet', { status: label, count: formatNumber(counts[s]), pct })}
              onClick={() => onToggle(s)}
              title={label}
              className={cn('flex min-w-0 flex-col gap-1 rounded-md border bg-card px-2 py-1.5 text-left transition-colors', !on && 'hover:bg-muted')}
              style={on ? { borderColor: color, backgroundColor: `color-mix(in oklab, ${color} 12%, var(--card))` } : undefined}
            >
              <span className="flex min-w-0 items-center gap-1.5 text-[11px] font-semibold text-muted-foreground">
                <StatusDot status={s} className="size-2 shrink-0" />
                <span className="truncate">{label}</span>
              </span>
              <span className="text-lg leading-none font-bold tabular-nums">{formatNumber(counts[s])}</span>
              <span className="block h-1 overflow-hidden rounded-full bg-muted" aria-hidden>
                <span className="block h-1 rounded-full" style={{ width: `${counts[s] ? Math.max((counts[s] / (counts.total || 1)) * 100, 3) : 0}%`, backgroundColor: color }} />
              </span>
              <span className="text-[10px] text-muted-foreground tabular-nums" aria-hidden>
                {t('{{pct}}% of fleet', { pct })}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

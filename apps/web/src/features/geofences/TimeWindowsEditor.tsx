import type { TimeWindow } from '@veetracer/shared';
import { PlusIcon, Trash2Icon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { DAY_LETTER, DAY_SHORT, DEFAULT_WINDOW, formatWindow, validateWindow, wrapsMidnight } from './time-windows';

/** Mon–Sun toggle buttons for a set of ISO weekdays (1–7). */
export function DayToggles({ days, onChange, disabled }: { days: number[]; onChange: (days: number[]) => void; disabled?: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="flex gap-1" role="group" aria-label={t('Days')}>
      {DAY_LETTER.map((letter, i) => {
        const d = i + 1;
        const on = days.includes(d);
        return (
          <button
            key={d}
            type="button"
            disabled={disabled}
            aria-pressed={on}
            aria-label={t(DAY_SHORT[i])}
            title={t(DAY_SHORT[i])}
            onClick={() => onChange(on ? days.filter((x) => x !== d) : [...days, d].sort((a, b) => a - b))}
            className={cn(
              'size-8 rounded-md border text-xs font-semibold transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-none disabled:opacity-50',
              on ? 'border-primary bg-primary text-primary-foreground' : 'border-input bg-card text-muted-foreground hover:bg-accent',
            )}
          >
            {letter}
          </button>
        );
      })}
    </div>
  );
}

/** One window: day toggles + from/to times with an overnight hint. */
export function TimeWindowRow({
  value,
  onChange,
  onRemove,
  disabled,
}: {
  value: TimeWindow;
  onChange: (w: TimeWindow) => void;
  onRemove?: () => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const tr = (k: string, v?: Record<string, string>) => t(k, v);
  const error = validateWindow(value, tr);
  return (
    <div className="space-y-1.5 rounded-lg border p-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <DayToggles days={value.days} onChange={(days) => onChange({ ...value, days })} disabled={disabled} />
        <div className="flex items-center gap-1.5">
          <Input type="time" aria-label={t('From')} value={value.from} disabled={disabled} onChange={(e) => onChange({ ...value, from: e.target.value })} className="h-8 w-[7.75rem]" />
          <span className="text-xs text-muted-foreground">{t('to')}</span>
          <Input type="time" aria-label={t('To')} value={value.to} disabled={disabled} onChange={(e) => onChange({ ...value, to: e.target.value })} className="h-8 w-[7.75rem]" />
        </div>
        {onRemove && (
          <Button variant="ghost" size="icon-sm" aria-label={t('Remove window')} onClick={onRemove} disabled={disabled} className="ml-auto">
            <Trash2Icon />
          </Button>
        )}
      </div>
      <p className={cn('text-xs', error ? 'text-destructive' : 'text-muted-foreground')}>
        {error ?? `${formatWindow(value, tr)}${wrapsMidnight(value) ? ` — ${t('ends the next morning')}` : ''}`}
      </p>
    </div>
  );
}

/** List editor for geofence time windows; empty list = always active. */
export function TimeWindowsEditor({ value, onChange, disabled }: { value: TimeWindow[]; onChange: (v: TimeWindow[]) => void; disabled?: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-2">
      {value.length === 0 && <p className="text-sm text-muted-foreground">{t('Always active. Add a window to limit when this geofence raises alerts.')}</p>}
      {value.map((w, i) => (
        <TimeWindowRow
          key={i}
          value={w}
          disabled={disabled}
          onChange={(next) => onChange(value.map((x, j) => (j === i ? next : x)))}
          onRemove={() => onChange(value.filter((_, j) => j !== i))}
        />
      ))}
      <Button variant="outline" size="sm" onClick={() => onChange([...value, { ...DEFAULT_WINDOW }])} disabled={disabled || value.length >= 10}>
        <PlusIcon /> {t('Add time window')}
      </Button>
    </div>
  );
}

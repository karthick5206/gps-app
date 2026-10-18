import { CalendarRangeIcon } from 'lucide-react';
import type { TFunction } from 'i18next';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Combobox } from '@/components/ui/multi-select';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { formatClock } from './history-format';
import { MAX_RANGE_DAYS, PRESET_LABELS, fromLocalInput, presetRange, toLocalInput, validateRange, type RangePreset, type TimeRange } from './time-range';
import { useVehicleOptions } from './use-history';

/** Translates the English messages returned by the pure `validateRange` helper. */
function rangeErrorText(t: TFunction, error: string): string {
  if (error === 'Choose a valid start and end') return t('Choose a valid start and end');
  if (error === 'End must be after start') return t('End must be after start');
  if (error === `Choose at most ${MAX_RANGE_DAYS} days`) return t('Choose at most {{days}} days', { days: MAX_RANGE_DAYS });
  return t(error);
}

function CustomRange({ range, active, onApply }: { range: TimeRange; active: boolean; onApply: (r: TimeRange) => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState(toLocalInput(range.from));
  const [to, setTo] = useState(toLocalInput(range.to));
  const parsed = { from: fromLocalInput(from), to: fromLocalInput(to) };
  const error = !parsed.from || !parsed.to ? 'Choose a valid start and end' : validateRange({ from: parsed.from, to: parsed.to });
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) {
          setFrom(toLocalInput(range.from));
          setTo(toLocalInput(range.to));
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button variant={active ? 'default' : 'outline'} size="sm" aria-pressed={active}>
          <CalendarRangeIcon />
          {active ? `${formatClock(range.from.getTime(), true, false)} – ${formatClock(range.to.getTime(), true, false)}` : t(PRESET_LABELS.custom)}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 space-y-3 p-4">
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (error || !parsed.from || !parsed.to) return;
            onApply({ from: parsed.from, to: parsed.to });
            setOpen(false);
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="h-from">{t('From')}</Label>
            <Input id="h-from" type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="h-to">{t('To')}</Label>
            <Input id="h-to" type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} aria-invalid={!!error} />
          </div>
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {rangeErrorText(t, error)}
            </p>
          )}
          <Button type="submit" size="sm" className="w-full" disabled={!!error}>
            {t('Show history')}
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  );
}

export function HistoryToolbar({
  objectId,
  onObjectChange,
  range,
  preset,
  onRangeChange,
  className,
}: {
  objectId: string | null;
  onObjectChange: (id: string | null) => void;
  range: TimeRange;
  preset: RangePreset;
  onRangeChange: (r: TimeRange) => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const vehicles = useVehicleOptions(search);
  return (
    <div className={cn('flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center', className)}>
      <Combobox
        value={objectId}
        onChange={onObjectChange}
        options={vehicles.options}
        loading={vehicles.loading}
        onSearch={vehicles.remoteSearch ? setSearch : undefined}
        placeholder={t('Select a vehicle…')}
        searchPlaceholder={t('Search name or plate…')}
        emptyText={t('No vehicles found')}
        clearable={false}
        className="w-full sm:w-72"
        id="history-vehicle"
      />
      <div className="-mx-1 flex items-center gap-1.5 overflow-x-auto px-1 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0" role="group" aria-label={t('Period')}>
        {(['today', 'yesterday', 'last7'] as const).map((p) => (
          <Button key={p} size="sm" variant={preset === p ? 'default' : 'outline'} aria-pressed={preset === p} onClick={() => onRangeChange(presetRange(p))}>
            {t(PRESET_LABELS[p])}
          </Button>
        ))}
        <CustomRange range={range} active={preset === 'custom'} onApply={onRangeChange} />
      </div>
    </div>
  );
}

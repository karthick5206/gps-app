import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { DATE_PRESETS, matchPreset, presetRange, type DatePresetId } from './date-presets';

/** Preset buttons for a calendar-day range; `today` is the company's today (report periods are company days). */
export function DatePresets({ from, to, today, onChange, presets = DATE_PRESETS.map((p) => p.id), className }: { from: string; to: string; today: string; onChange: (range: [string, string]) => void; presets?: DatePresetId[]; className?: string }) {
  const { t } = useTranslation();
  const active = matchPreset(from, to, today);
  return (
    <div role="group" aria-label={t('Date presets')} className={cn('flex flex-wrap gap-1.5', className)}>
      {DATE_PRESETS.filter((p) => presets.includes(p.id)).map((p) => {
        const on = active === p.id;
        return (
          <Button key={p.id} type="button" size="sm" variant={on ? 'secondary' : 'outline'} aria-pressed={on} onClick={() => onChange(presetRange(p.id, today))} className={cn(on && 'border-primary/40 text-primary')}>
            {t(p.label)}
          </Button>
        );
      })}
    </div>
  );
}

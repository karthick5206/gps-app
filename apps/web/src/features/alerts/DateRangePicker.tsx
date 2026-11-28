import { CalendarIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { fromDateTimeInput, PRESET_LABEL, presetRange, toDateTimeInput, type RangePreset } from './date-range';

export interface DateRangeValue {
  preset: RangePreset;
  from: Date;
  to: Date;
}

export function rangeFromPreset(preset: Exclude<RangePreset, 'custom'>): DateRangeValue {
  return { preset, ...presetRange(preset) };
}

/** Preset select plus from/to date + time inputs when "Custom" is chosen (end minute inclusive). */
export function DateRangePicker({ value, onChange, presets = ['today', 'yesterday', '7d', '30d', 'custom'] }: { value: DateRangeValue; onChange: (v: DateRangeValue) => void; presets?: RangePreset[] }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        value={value.preset}
        onValueChange={(p) => {
          const preset = p as RangePreset;
          onChange(preset === 'custom' ? { ...value, preset } : rangeFromPreset(preset));
        }}
      >
        <SelectTrigger className="h-9 w-auto min-w-[9.5rem]" aria-label={t('Date range')}>
          <CalendarIcon className="size-4 opacity-60" />
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {presets.map((p) => (
            <SelectItem key={p} value={p}>
              {t(PRESET_LABEL[p])}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {value.preset === 'custom' && (
        <>
          <Input
            type="datetime-local"
            aria-label={t('From date')}
            className="h-9 w-[12.5rem]"
            value={toDateTimeInput(value.from)}
            max={toDateTimeInput(value.to)}
            onChange={(e) => {
              const d = fromDateTimeInput(e.target.value);
              if (d) onChange({ ...value, from: d });
            }}
          />
          <span className="text-xs text-muted-foreground">{t('to')}</span>
          <Input
            type="datetime-local"
            aria-label={t('To date')}
            className="h-9 w-[12.5rem]"
            value={toDateTimeInput(value.to)}
            min={toDateTimeInput(value.from)}
            onChange={(e) => {
              const d = fromDateTimeInput(e.target.value, true);
              if (d) onChange({ ...value, to: d });
            }}
          />
        </>
      )}
    </div>
  );
}

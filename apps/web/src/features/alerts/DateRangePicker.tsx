import { CalendarIcon } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { fromDateInput, PRESET_LABEL, presetRange, toDateInput, type RangePreset } from './date-range';

export interface DateRangeValue {
  preset: RangePreset;
  from: Date;
  to: Date;
}

export function rangeFromPreset(preset: Exclude<RangePreset, 'custom'>): DateRangeValue {
  return { preset, ...presetRange(preset) };
}

/** Preset select plus from/to date inputs when "Custom" is chosen. */
export function DateRangePicker({ value, onChange, presets = ['today', 'yesterday', '7d', '30d', 'custom'] }: { value: DateRangeValue; onChange: (v: DateRangeValue) => void; presets?: RangePreset[] }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        value={value.preset}
        onValueChange={(p) => {
          const preset = p as RangePreset;
          onChange(preset === 'custom' ? { ...value, preset } : rangeFromPreset(preset));
        }}
      >
        <SelectTrigger className="h-9 w-auto min-w-[9.5rem]" aria-label="Date range">
          <CalendarIcon className="size-4 opacity-60" />
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {presets.map((p) => (
            <SelectItem key={p} value={p}>
              {PRESET_LABEL[p]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {value.preset === 'custom' && (
        <>
          <Input type="date" aria-label="From date" className="h-9 w-[9.5rem]" value={toDateInput(value.from)} max={toDateInput(value.to)} onChange={(e) => e.target.value && onChange({ ...value, from: fromDateInput(e.target.value) })} />
          <span className="text-xs text-muted-foreground">to</span>
          <Input type="date" aria-label="To date" className="h-9 w-[9.5rem]" value={toDateInput(value.to)} min={toDateInput(value.from)} onChange={(e) => e.target.value && onChange({ ...value, to: fromDateInput(e.target.value, true) })} />
        </>
      )}
    </div>
  );
}

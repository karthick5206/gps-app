import { ALERT_TYPES, type ReportOptions, type ReportType } from '@veetracer/shared';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { MultiSelect } from '@/components/ui/multi-select';

const ALERT_OPTIONS = ALERT_TYPES.map((t) => ({ value: t.code, label: t.label, description: t.category }));

/** Defaults shown in the inputs; the API applies the same values when an option is omitted. */
export const OPTION_DEFAULTS = { haltMin: 30, drivingMin: 240, breakMin: 15, minOverspeedSec: 10, inactiveAfterMin: 1440 } as const;

/** Options relevant to a report type (others are dropped from the request). */
export function optionsFor(type: ReportType, o: ReportOptions): ReportOptions | undefined {
  switch (type) {
    case 'HALT':
      return { minDurationMin: o.minDurationMin ?? OPTION_DEFAULTS.haltMin };
    case 'STOPS':
    case 'IDLE':
      return o.minDurationMin ? { minDurationMin: o.minDurationMin } : undefined;
    case 'ALERTS':
    case 'EVENT_SUMMARY':
      return o.alertTypes?.length ? { alertTypes: o.alertTypes } : undefined;
    case 'CONTINUOUS_DRIVING':
      return { drivingMin: o.drivingMin ?? OPTION_DEFAULTS.drivingMin, breakMin: o.breakMin ?? OPTION_DEFAULTS.breakMin };
    case 'OVERSPEED':
      return { minOverspeedSec: o.minOverspeedSec ?? OPTION_DEFAULTS.minOverspeedSec };
    case 'DEVICE_STATUS':
      return { inactiveAfterMin: o.inactiveAfterMin ?? OPTION_DEFAULTS.inactiveAfterMin };
    default:
      return undefined;
  }
}

function NumberField({
  id,
  label,
  hint,
  value,
  fallback,
  min,
  max,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  value: number | undefined;
  fallback: number | undefined;
  min: number;
  max: number;
  onChange: (v: number | undefined) => void;
}) {
  return (
    <Field label={label} htmlFor={id} hint={hint} className="sm:w-48">
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        placeholder={fallback === undefined ? 'Any' : String(fallback)}
        value={value ?? ''}
        onChange={(e) => {
          const n = e.target.value === '' ? undefined : Math.round(Number(e.target.value));
          onChange(n === undefined || !Number.isFinite(n) ? undefined : Math.min(max, Math.max(min, n)));
        }}
      />
    </Field>
  );
}

/** Extra inputs for the selected report type; renders nothing for types without options. */
export function ReportOptionsFields({ type, value, onChange }: { type: ReportType; value: ReportOptions; onChange: (v: ReportOptions) => void }) {
  const set = (patch: Partial<ReportOptions>) => onChange({ ...value, ...patch });
  switch (type) {
    case 'HALT':
    case 'STOPS':
    case 'IDLE':
      return (
        <NumberField
          id="r-min-duration"
          label="Minimum duration (min)"
          hint={type === 'HALT' ? 'Parked at least this long' : 'Leave empty for all stops'}
          value={value.minDurationMin}
          fallback={type === 'HALT' ? OPTION_DEFAULTS.haltMin : undefined}
          min={1}
          max={10_080}
          onChange={(minDurationMin) => set({ minDurationMin })}
        />
      );
    case 'ALERTS':
    case 'EVENT_SUMMARY':
      return (
        <Field label="Event types" className="sm:w-80">
          <MultiSelect value={value.alertTypes ?? []} onChange={(alertTypes) => set({ alertTypes })} options={ALERT_OPTIONS} placeholder="All event types" />
        </Field>
      );
    case 'CONTINUOUS_DRIVING':
      return (
        <div className="flex flex-col gap-3 sm:flex-row">
          <NumberField id="r-driving" label="Driving limit (min)" hint="Report stretches at least this long" value={value.drivingMin} fallback={OPTION_DEFAULTS.drivingMin} min={30} max={1440} onChange={(drivingMin) => set({ drivingMin })} />
          <NumberField id="r-break" label="Required break (min)" hint="A stop this long resets driving" value={value.breakMin} fallback={OPTION_DEFAULTS.breakMin} min={1} max={240} onChange={(breakMin) => set({ breakMin })} />
        </div>
      );
    case 'OVERSPEED':
      return (
        <NumberField
          id="r-overspeed"
          label="Ignore shorter than (s)"
          hint="Skip brief spikes above the limit"
          value={value.minOverspeedSec}
          fallback={OPTION_DEFAULTS.minOverspeedSec}
          min={0}
          max={3600}
          onChange={(minOverspeedSec) => set({ minOverspeedSec })}
        />
      );
    case 'DEVICE_STATUS':
      return (
        <NumberField
          id="r-inactive"
          label="Inactive after (min)"
          hint="No data for this long = inactive"
          value={value.inactiveAfterMin}
          fallback={OPTION_DEFAULTS.inactiveAfterMin}
          min={5}
          max={43_200}
          onChange={(inactiveAfterMin) => set({ inactiveAfterMin })}
        />
      );
    default:
      return null;
  }
}

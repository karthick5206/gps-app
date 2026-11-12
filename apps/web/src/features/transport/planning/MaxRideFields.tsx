import { MAX_RIDE_REASON_LENGTH, type RoutingCapabilities } from '@veetracer/shared';
import { useTranslation } from 'react-i18next';
import { Checkbox } from '@/components/ui/checkbox';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { MAX_RIDE_MINUTES, MAX_RIDE_REASON_ERROR, canOverrideMaxRide, maxRideReasonValid, parseMaxRideMinutes, policyLabel, type MaxRideOverrideDraft } from './max-ride';

/**
 * Owner decision 1: the per-plan max-ride override in the optimise / re-optimise dialogs. Rendered only for callers the
 * capabilities authorise (etms_settings:edit, whole company); everyone else sees the company policy line only. The
 * reason is mandatory and lands in the audit log (the API checks both again).
 */
export function MaxRideOverrideFields({ idPrefix, caps, value, onChange, showErrors, hadOverride }: { idPrefix: string; caps: RoutingCapabilities | undefined; value: MaxRideOverrideDraft; onChange: (d: MaxRideOverrideDraft) => void; showErrors: boolean; hadOverride?: boolean }) {
  const { t } = useTranslation();
  const policy = <p className="text-xs text-muted-foreground">{policyLabel(caps, t)}</p>;
  if (!canOverrideMaxRide(caps)) return policy;
  const minutes = parseMaxRideMinutes(value.minutes);
  const minutesError = value.enabled && (!minutes.ok || minutes.seconds === null) ? t('Enter the maximum ride time in minutes (15–240).') : undefined;
  // D-L4: the shared override reason rule (as the publish override and the API).
  const reasonError = value.enabled && !maxRideReasonValid(value.reason) ? t(MAX_RIDE_REASON_ERROR) : undefined;
  return (
    <fieldset className="grid gap-2 rounded-md border p-3">
      <legend className="px-1 text-sm font-medium">{t('Maximum ride time')}</legend>
      {policy}
      <div className="flex items-start gap-2 text-sm">
        <Checkbox id={`${idPrefix}-ovr`} checked={value.enabled} onCheckedChange={(v) => onChange({ ...value, enabled: v === true })} className="mt-0.5" />
        <label htmlFor={`${idPrefix}-ovr`}>{t('Override the company maximum ride time for this plan')}</label>
      </div>
      {!value.enabled && hadOverride && <p className="text-xs text-muted-foreground">{t('Turning this off returns the plan to the company policy at the next optimisation.')}</p>}
      {value.enabled && (
        <div className="grid gap-3 sm:grid-cols-[10rem_minmax(0,1fr)]">
          <Field label={t('Maximum ride time for this plan (minutes)')} htmlFor={`${idPrefix}-ovr-min`} error={showErrors ? minutesError : undefined}>
            <Input id={`${idPrefix}-ovr-min`} type="number" inputMode="numeric" min={MAX_RIDE_MINUTES.min} max={MAX_RIDE_MINUTES.max} step={1} value={value.minutes} onChange={(e) => onChange({ ...value, minutes: e.target.value })} className="h-9" aria-invalid={showErrors && !!minutesError} />
          </Field>
          <Field label={t('Reason for the override')} htmlFor={`${idPrefix}-ovr-reason`} hint={t('Required: at least {{n}} characters, in words. Recorded in the audit log with your name.', { n: MAX_RIDE_REASON_LENGTH.min })} error={showErrors ? reasonError : undefined}>
            <Input id={`${idPrefix}-ovr-reason`} value={value.reason} maxLength={300} onChange={(e) => onChange({ ...value, reason: e.target.value })} className="h-9" aria-invalid={showErrors && !!reasonError} />
          </Field>
        </div>
      )}
    </fieldset>
  );
}

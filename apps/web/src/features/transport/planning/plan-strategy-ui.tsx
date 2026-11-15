import { ROUTE_PLAN_PREFERENCE_BOUNDS, type RoutingStrategy } from '@veetracer/shared';
import { ChevronDownIcon, ChevronRightIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Checkbox } from '@/components/ui/checkbox';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { SimpleSelect } from '../dispatch/e3-ui';
import { MAX_RIDE_MINUTES } from './max-ride';
import { formatDuration } from './planner-format';
import { OCCUPANCY_CHOICES, ROUTING_STRATEGIES, ROUTING_STRATEGY_INFO, type OccupancyChoice, type PreferencesDraft, type StrategyDraft } from './plan-strategy';
import { WeightsEditor } from './planner-ui';

/**
 * E4 WP-W: the strategy picker (five cards with the shared trade-off text; a radio group) — the primary optimise control.
 * Raw weights stay under "Advanced" and win over the strategy when used.
 */
export function StrategyPicker({ value, onChange, idPrefix, showErrors, disabled }: { value: StrategyDraft; onChange: (d: StrategyDraft) => void; idPrefix: string; showErrors?: boolean; disabled?: boolean }) {
  const { t } = useTranslation();
  const name = `${idPrefix}-strategy`;
  return (
    <div className="grid min-w-0 gap-3">
      <fieldset className="grid min-w-0 gap-2" disabled={disabled}>
        <legend className="mb-1 text-sm font-medium">{t('Strategy')}</legend>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {ROUTING_STRATEGIES.map((s) => {
            const info = ROUTING_STRATEGY_INFO[s];
            const on = value.strategy === s;
            return (
              <label key={s} className={cn('grid min-w-0 cursor-pointer gap-1 rounded-lg border bg-card p-3 text-sm outline-none has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring', on ? 'border-primary bg-primary/5' : 'hover:bg-muted/50')}>
                <span className="flex items-center gap-2">
                  <input type="radio" name={name} value={s} checked={on} onChange={() => onChange({ ...value, strategy: s })} className="size-4 accent-[var(--color-primary)]" />
                  <span className="font-medium">{t(info.label)}</span>
                </span>
                <span className="text-xs">{t(info.summary)}</span>
                <span className="text-xs text-muted-foreground">{t(info.tradeOffs)}</span>
              </label>
            );
          })}
        </div>
      </fieldset>
      <Disclosure idPrefix={`${idPrefix}-adv`} label={t('Advanced: explicit weights')} defaultOpen={value.useWeights}>
        <div className="flex items-start gap-2 text-sm">
          <Checkbox id={`${idPrefix}-useweights`} checked={value.useWeights} onCheckedChange={(v) => onChange({ ...value, useWeights: v === true })} className="mt-0.5" disabled={disabled} />
          <label htmlFor={`${idPrefix}-useweights`}>{t('Use my own weights instead of the strategy')}</label>
        </div>
        {value.useWeights && <WeightsEditor idPrefix={`${idPrefix}-w`} showErrors={showErrors} value={value.weights} onChange={(w) => onChange({ ...value, weights: w })} disabled={disabled} />}
      </Disclosure>
    </div>
  );
}

/** Strategies of "Generate alternatives" (2–5 checkboxes). */
export function AlternativesPicker({ value, onChange, idPrefix, error }: { value: RoutingStrategy[]; onChange: (s: RoutingStrategy, on: boolean) => void; idPrefix: string; error?: string | null }) {
  const { t } = useTranslation();
  return (
    <fieldset className="grid min-w-0 gap-2">
      <legend className="mb-1 text-sm font-medium">{t('Strategies to compare (2–5)')}</legend>
      <p className="text-xs text-muted-foreground">{t('One plan is made per strategy, each optimised on its own. Compare them, then keep one.')}</p>
      <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
        {ROUTING_STRATEGIES.map((s) => (
          <div key={s} className="flex items-start gap-2 rounded-md border bg-card p-2 text-sm">
            <Checkbox id={`${idPrefix}-${s}`} checked={value.includes(s)} onCheckedChange={(v) => onChange(s, v === true)} className="mt-0.5" />
            <label htmlFor={`${idPrefix}-${s}`} className="grid min-w-0 gap-0.5">
              <span className="font-medium">{t(ROUTING_STRATEGY_INFO[s].label)}</span>
              <span className="text-xs text-muted-foreground">{t(ROUTING_STRATEGY_INFO[s].summary)}</span>
            </label>
          </div>
        ))}
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive-fg">
          {t(error)}
        </p>
      )}
    </fieldset>
  );
}

/**
 * Optional run preferences. The max ride may only tighten the plan's limit (`capS`); pins / locks only on a saved plan
 * (`preserve`), and "keep locked routes" only for users with Route planning → edit (`canEditLocks`).
 */
export function PreferencesFields({ idPrefix, value, onChange, capS, preserve, canEditLocks, capped, errors }: { idPrefix: string; value: PreferencesDraft; onChange: (d: PreferencesDraft) => void; capS: number | null; preserve: boolean; canEditLocks: boolean; capped?: boolean; errors?: string[] }) {
  const { t } = useTranslation();
  const set = <K extends keyof PreferencesDraft>(k: K, v: PreferencesDraft[K]) => onChange({ ...value, [k]: v });
  const B = ROUTE_PLAN_PREFERENCE_BOUNDS;
  const capMin = capS ? Math.min(MAX_RIDE_MINUTES.max, Math.floor(capS / 60)) : MAX_RIDE_MINUTES.max;
  const occLabel = (c: OccupancyChoice) => (c === 'none' ? t('No preference') : `${Math.round(Number(c) * 100)} %`);
  return (
    <Disclosure idPrefix={`${idPrefix}-prefs`} label={t('Advanced: preferences')}>
      <div className="grid min-w-0 gap-3 sm:grid-cols-2">
        <Field label={t('Maximum ride time for this run (minutes)')} htmlFor={`${idPrefix}-ride`} hint={capS ? t('Leave empty to use the plan’s limit ({{value}}). Only a shorter time is allowed.', { value: formatDuration(capS, t) }) : t('Leave empty for the plan’s limit. 15–240 minutes.')}>
          <Input id={`${idPrefix}-ride`} type="number" inputMode="numeric" min={MAX_RIDE_MINUTES.min} max={capMin} step={1} value={value.maxRideMinutes} onChange={(e) => set('maxRideMinutes', e.target.value)} className="h-9" />
        </Field>
        <Field label={t('Preferred occupancy')} htmlFor={`${idPrefix}-occ`} hint={t('Higher fills vehicles more before another one is used.')}>
          <SimpleSelect id={`${idPrefix}-occ`} value={value.occupancy} onChange={(v) => set('occupancy', v as OccupancyChoice)} label={t('Preferred occupancy')} options={OCCUPANCY_CHOICES.map((c) => ({ value: c, label: occLabel(c) }))} />
        </Field>
        <Field label={t('Vehicle size')} htmlFor={`${idPrefix}-size`}>
          <SimpleSelect
            id={`${idPrefix}-size`}
            value={value.vehicleSize}
            onChange={(v) => set('vehicleSize', v as PreferencesDraft['vehicleSize'])}
            label={t('Vehicle size')}
            options={[
              { value: 'ANY', label: t('Any size') },
              { value: 'SMALLER', label: t('Prefer smaller vehicles') },
              { value: 'LARGER', label: t('Prefer larger vehicles') },
            ]}
          />
        </Field>
        <div className="grid content-start gap-2 text-sm">
          <CheckRow id={`${idPrefix}-keepdir`} checked={value.keepDirections} onChange={(v) => set('keepDirections', v)} label={t('Keep passengers from different directions apart')} />
          <CheckRow id={`${idPrefix}-detour`} checked={value.detourOn} onChange={(v) => set('detourOn', v)} label={t('Limit detours')} />
        </div>
        {value.detourOn && (
          <div className="grid gap-3 sm:col-span-2 sm:grid-cols-2">
            <Field label={t('Ride at most this many times the direct trip')} htmlFor={`${idPrefix}-ratio`} hint={t('{{min}}–{{max}}', { min: B.detourRatio.min, max: B.detourRatio.max })}>
              <Input id={`${idPrefix}-ratio`} type="text" inputMode="decimal" value={value.detourRatio} onChange={(e) => set('detourRatio', e.target.value)} className="h-9" />
            </Field>
            <Field label={t('Or at most this many extra minutes')} htmlFor={`${idPrefix}-extra`} hint={t('{{min}}–{{max}}', { min: B.detourExtraMin.min, max: B.detourExtraMin.max })}>
              <Input id={`${idPrefix}-extra`} type="number" inputMode="numeric" min={B.detourExtraMin.min} max={B.detourExtraMin.max} step={1} value={value.detourExtraMin} onChange={(e) => set('detourExtraMin', e.target.value)} className="h-9" />
            </Field>
          </div>
        )}
        {preserve && (
          <div className="grid content-start gap-2 text-sm sm:col-span-2">
            <CheckRow id={`${idPrefix}-pins`} checked={value.preservePins} onChange={(v) => set('preservePins', v)} label={t('Keep pinned passengers on their vehicle')} />
            {canEditLocks && <CheckRow id={`${idPrefix}-locks`} checked={value.preserveLocks} onChange={(v) => set('preserveLocks', v)} label={t('Keep locked routes as they are')} />}
          </div>
        )}
      </div>
      {capped && <p className="text-xs text-warning-fg">{t('The maximum ride time is above the plan’s limit; the limit ({{value}}) will be used.', { value: formatDuration(capS, t) })}</p>}
      {!!errors?.length && (
        <ul role="alert" className="list-disc ps-5 text-sm text-destructive-fg">
          {errors.map((e) => (
            <li key={e}>{t(e)}</li>
          ))}
        </ul>
      )}
    </Disclosure>
  );
}

function CheckRow({ id, checked, onChange, label }: { id: string; checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <div className="flex items-start gap-2">
      <Checkbox id={id} checked={checked} onCheckedChange={(v) => onChange(v === true)} className="mt-0.5" />
      <label htmlFor={id}>{label}</label>
    </div>
  );
}

/** A labelled show / hide section (button with aria-expanded). */
export function Disclosure({ idPrefix, label, defaultOpen = false, children }: { idPrefix: string; label: string; defaultOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  const uid = useId();
  const panel = `${idPrefix}-${uid}`;
  const Icon = open ? ChevronDownIcon : ChevronRightIcon;
  return (
    <div className="grid min-w-0 gap-2">
      <button type="button" aria-expanded={open} aria-controls={panel} onClick={() => setOpen((v) => !v)} className="inline-flex items-center gap-1 justify-self-start rounded-md text-sm font-medium text-primary outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">
        <Icon className="size-4" aria-hidden /> {label}
      </button>
      {open && (
        <div id={panel} className="grid min-w-0 gap-3 rounded-md border p-3">
          {children}
        </div>
      )}
    </div>
  );
}

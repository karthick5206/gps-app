import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/features/auth/auth-context';
import { Panel } from '@/features/dashboard/refresh/kit';
import { errorMessage } from '@/lib/api';
import { MAX_RIDE_MINUTES, maxRidePolicyNote, minutesText, parseMaxRideMinutes } from './planning/max-ride';
import { plannerFlagOn, useCapabilities } from './planning/planner-client';
import { useTransportSettings, useUpdateTransportSettings } from './use-agreements';

/**
 * Owner decision 1 (2026-11-11): the company maximum ride time per passenger (Company.settings.etms.maxRideS). Empty =
 * no limit. Route optimisation snapshots it into each plan unless a Transport admin set an override for that plan.
 * Changed only by whole-company users with etms_settings:edit (the API enforces it and audits the change).
 */
export function MaxRidePolicy() {
  const { t } = useTranslation();
  const { can, me } = useAuth();
  const settings = useTransportSettings(true);
  const update = useUpdateTransportSettings();
  // D-L5: say that optimisation uses the value only when the API reports routing enabled.
  const flag = plannerFlagOn();
  const caps = useCapabilities(flag);
  const editable = can('etms_settings', 'edit') && me?.dataScope === 'COMPANY';
  const saved = minutesText(settings.data?.maxRideS);
  const [draft, setDraft] = useState<string | null>(null);
  useEffect(() => setDraft(null), [saved]);
  const value = draft ?? saved;
  const parsed = parseMaxRideMinutes(value);
  const dirty = value.trim() !== saved;
  const save = () => {
    if (!parsed.ok) return;
    update.mutate({ maxRideS: parsed.seconds }, { onSuccess: () => toast.success(t('Maximum ride time saved.')), onError: (e) => toast.error(errorMessage(e)) });
  };
  return (
    <Panel title={t('Maximum ride time')} subtitle={t(maxRidePolicyNote(flag ? caps.data?.enabled : false))} id="etms-max-ride">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <Field label={t('Maximum ride time (minutes)')} htmlFor="etms-max-ride-min" hint={t('Leave empty for no limit. 15–240 minutes.')} error={!parsed.ok ? t(parsed.error) : undefined} className="sm:w-64">
          <Input id="etms-max-ride-min" type="number" inputMode="numeric" min={MAX_RIDE_MINUTES.min} max={MAX_RIDE_MINUTES.max} step={1} value={value} disabled={!editable || settings.isLoading || update.isPending} onChange={(e) => setDraft(e.target.value)} className="h-9" aria-invalid={!parsed.ok} />
        </Field>
        {editable && (
          <Button size="sm" onClick={save} disabled={!dirty || !parsed.ok || update.isPending} className="self-start sm:mb-5 sm:self-auto">
            {t('Save')}
          </Button>
        )}
      </div>
      {!editable && <p className="mt-2 text-xs text-muted-foreground">{t('Only a Transport admin with whole-company access can change this.')}</p>}
    </Panel>
  );
}

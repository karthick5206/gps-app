import { DEFAULT_NIGHT_FROM, DEFAULT_NIGHT_TO, DEFAULT_REACHED_HOME_MIN, REACHED_HOME_BOUNDS_MIN } from '@veetracer/shared';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { useAuth } from '@/features/auth/auth-context';
import { Panel } from '@/features/dashboard/refresh/kit';
import { errorMessage } from '@/lib/api';
import { useTransportSettings, useUpdateTransportSettings } from './use-agreements';

/**
 * v1.16.7 night-shift safety (Company.settings.etms.nightSafety / nightFrom / nightTo / reachedHomeMin): escort check
 * on night trips in Daily transport and the reached-home watch (a night drop not confirmed by the passenger in time).
 */
export function NightSafetySetting() {
  const { t } = useTranslation();
  const { can, me } = useAuth();
  const settings = useTransportSettings(true);
  const update = useUpdateTransportSettings();
  const editable = can('etms_settings', 'edit') && me?.dataScope === 'COMPANY';
  const s = settings.data;
  const [from, setFrom] = useState(DEFAULT_NIGHT_FROM);
  const [to, setTo] = useState(DEFAULT_NIGHT_TO);
  const [mins, setMins] = useState(String(DEFAULT_REACHED_HOME_MIN));
  useEffect(() => {
    if (!s) return;
    setFrom(s.nightFrom ?? DEFAULT_NIGHT_FROM);
    setTo(s.nightTo ?? DEFAULT_NIGHT_TO);
    setMins(String(s.reachedHomeMin ?? DEFAULT_REACHED_HOME_MIN));
  }, [s]);
  const on = s?.nightSafety === true;
  const n = Number(mins);
  const minsOk = Number.isInteger(n) && n >= REACHED_HOME_BOUNDS_MIN.min && n <= REACHED_HOME_BOUNDS_MIN.max;
  const save = (patch: Parameters<typeof update.mutate>[0], msg: string) => update.mutate(patch, { onSuccess: () => toast.success(msg), onError: (e) => toast.error(errorMessage(e)) });
  return (
    <Panel title={t('Night-shift safety')} subtitle={t('Escort check on night trips and reached-home confirmation')} id="etms-night-safety">
      <div className="space-y-3 text-sm">
        <label className="flex items-start gap-3">
          <Switch checked={on} disabled={!editable || update.isPending} onCheckedChange={(v) => save({ nightSafety: v }, v ? t('Night-shift safety is on') : t('Night-shift safety is off'))} />
          <span className="min-w-0">
            <span className="font-medium">{t('Use night-shift safety rules')}</span>
            <span className="block text-xs text-muted-foreground">
              {t('Daily transport warns when someone is the first pickup or last drop alone inside the night window, and flags night drops the employee has not confirmed in the app in time.')}
            </span>
          </span>
        </label>
        <div className="flex flex-wrap items-end gap-3">
          <label className="grid gap-1 text-xs">
            <span className="text-muted-foreground">{t('Night from')}</span>
            <Input type="time" value={from} onChange={(e) => setFrom(e.target.value)} className="h-9 w-32" disabled={!editable} />
          </label>
          <label className="grid gap-1 text-xs">
            <span className="text-muted-foreground">{t('Night to')}</span>
            <Input type="time" value={to} onChange={(e) => setTo(e.target.value)} className="h-9 w-32" disabled={!editable} />
          </label>
          <label className="grid gap-1 text-xs">
            <span className="text-muted-foreground">{t('Reached-home wait (minutes)')}</span>
            <Input type="number" min={REACHED_HOME_BOUNDS_MIN.min} max={REACHED_HOME_BOUNDS_MIN.max} value={mins} onChange={(e) => setMins(e.target.value)} className="h-9 w-32" disabled={!editable} />
          </label>
          {editable && (
            <Button size="sm" variant="outline" disabled={!minsOk || !from || !to || update.isPending} onClick={() => save({ nightFrom: from, nightTo: to, reachedHomeMin: n }, t('Night window saved'))}>
              {t('Save')}
            </Button>
          )}
        </div>
        {!editable && <p className="text-xs text-muted-foreground">{t('Only a Transport admin with whole-company access can change this.')}</p>}
      </div>
    </Panel>
  );
}

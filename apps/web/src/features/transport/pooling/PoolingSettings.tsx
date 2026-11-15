import { RIDE_PREFERENCES, SHARING_POLICY_TEXT_MAX, type LiveDispatchPolicy, type RidePreference } from '@veetracer/shared';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input, Textarea } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { useAuth } from '@/features/auth/auth-context';
import { Panel } from '@/features/dashboard/refresh/kit';
import { Segmented } from '../dispatch/point-card';
import {
  DRIVER_HOURS_FIELDS,
  driverHoursDraftOf,
  driverHoursInputOf,
  liveSwitch,
  policyDraftOf,
  policyInputOf,
  poolingDraftOf,
  poolingInputOf,
  RIDE_PREFERENCE_LABEL,
  type DriverHoursDraft,
  type LimitsDraft,
  type PolicyDraft,
  type PoolingSettingsDraft,
} from './pooling-format';
import { poolingErrorText } from './pooling-ui';
import { usePoolingSettings, useSaveDriverPolicy, useSavePoolingSettings, useSaveSharingPolicy, useSharingPolicy } from './use-pooling';

function useEditable() {
  const { can, me } = useAuth();
  return can('etms_settings', 'edit') && me?.dataScope === 'COMPANY';
}

function ReadOnlyNote({ editable }: { editable: boolean }) {
  const { t } = useTranslation();
  return editable ? null : <p className="text-xs text-muted-foreground">{t('Only a Transport admin with whole-company access can change this.')}</p>;
}

function Problems({ list }: { list: string[] }) {
  if (!list.length) return null;
  return (
    <ul role="alert" className="list-disc ps-5 text-sm text-destructive-fg">
      {list.map((p) => (
        <li key={p}>{p}</li>
      ))}
    </ul>
  );
}

function LimitsFields({ idPrefix, title, value, onChange, disabled }: { idPrefix: string; title: string; value: LimitsDraft; onChange: (v: LimitsDraft) => void; disabled: boolean }) {
  const { t } = useTranslation();
  const set = (patch: Partial<LimitsDraft>) => onChange({ ...value, ...patch });
  return (
    <fieldset className="grid gap-2 rounded-lg border p-3">
      <legend className="px-1 text-sm font-semibold">{title}</legend>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Field label={t('Max wait (minutes)')} htmlFor={`${idPrefix}-wait`}>
          <Input id={`${idPrefix}-wait`} type="number" min={0} value={value.maxWaitMin} disabled={disabled} onChange={(e) => set({ maxWaitMin: e.target.value })} className="h-9" />
        </Field>
        <Field label={t('Detour ratio (×)')} htmlFor={`${idPrefix}-ratio`}>
          <Input id={`${idPrefix}-ratio`} type="number" min={1} max={3} step={0.1} value={value.ratio} disabled={disabled} onChange={(e) => set({ ratio: e.target.value })} className="h-9" />
        </Field>
        <Field label={t('Or extra (minutes)')} htmlFor={`${idPrefix}-extra`}>
          <Input id={`${idPrefix}-extra`} type="number" min={0} value={value.extraMin} disabled={disabled} onChange={(e) => set({ extraMin: e.target.value })} className="h-9" />
        </Field>
        <Field label={t('Max ride (minutes)')} htmlFor={`${idPrefix}-ride`} hint={t('Empty = company maximum.')}>
          <Input id={`${idPrefix}-ride`} type="number" min={5} value={value.maxRideMin} disabled={disabled} onChange={(e) => set({ maxRideMin: e.target.value })} className="h-9" />
        </Field>
      </div>
    </fieldset>
  );
}

/**
 * Sharing policy (doc 20 §3.1): the text passengers accept, the limits per pooled preference (P2 defaults), whether
 * flexible rides are offered and the priorities (P6). Saving creates a NEW version; accepted bookings keep theirs.
 */
export function SharingPolicyPanel() {
  const { t } = useTranslation();
  const editable = useEditable();
  const policy = useSharingPolicy();
  const save = useSaveSharingPolicy();
  const [draft, setDraft] = useState<PolicyDraft | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const version = policy.data?.version;
  useEffect(() => {
    if (policy.data) setDraft(policyDraftOf(policy.data));
    setProblems([]);
  }, [version]); // eslint-disable-line react-hooks/exhaustive-deps
  if ((policy.isSuccess && !policy.data) || policy.isError) return null; // older server (no pooling) or no access
  const p = policy.data;
  const submit = () => {
    if (!draft) return;
    const r = policyInputOf(draft, t);
    if (!r.ok) {
      setProblems(r.errors);
      return;
    }
    setProblems([]);
    save.mutate(r.value, { onSuccess: (row) => toast.success(t('Sharing policy saved as version {{v}}.', { v: row.version })), onError: (e) => toast.error(poolingErrorText(e, t)) });
  };
  return (
    <Panel
      title={t('Sharing policy')}
      subtitle={t('What passengers accept for shared and flexible rides. Saving creates a new version; bookings keep the version they accepted.')}
      id="etms-sharing-policy"
      action={p && <Badge variant="muted">{p.version > 0 ? t('Version {{v}}', { v: p.version }) : t('Default (not saved yet)')}</Badge>}
    >
      {!draft || !p ? (
        <Skeleton className="h-40 w-full" />
      ) : (
        <div className="grid gap-3">
          <Field label={t('Policy text')} htmlFor="sp-text" hint={t('Shown to the passenger before they accept. At most {{n}} characters.', { n: SHARING_POLICY_TEXT_MAX })}>
            <Textarea id="sp-text" rows={4} maxLength={SHARING_POLICY_TEXT_MAX} value={draft.text} disabled={!editable} onChange={(e) => setDraft({ ...draft, text: e.target.value })} />
          </Field>
          <LimitsFields idPrefix="sp-shared" title={t('Shared ride limits')} value={draft.SHARED} disabled={!editable} onChange={(v) => setDraft({ ...draft, SHARED: v })} />
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={draft.allowFlexible} disabled={!editable} onCheckedChange={(v) => setDraft({ ...draft, allowFlexible: v })} />
            {t('Offer flexible rides (shared or private, whichever serves best)')}
          </label>
          {draft.allowFlexible && <LimitsFields idPrefix="sp-flex" title={t('Flexible ride limits')} value={draft.FLEXIBLE} disabled={!editable} onChange={(v) => setDraft({ ...draft, FLEXIBLE: v })} />}
          <fieldset className="grid gap-2">
            <legend className="mb-1 text-sm font-medium">{t('Priority when vehicles are short')}</legend>
            <div className="grid grid-cols-3 gap-3">
              {RIDE_PREFERENCES.map((k: RidePreference) => (
                <Field key={k} label={t(RIDE_PREFERENCE_LABEL[k])} htmlFor={`sp-prio-${k}`}>
                  <Input id={`sp-prio-${k}`} type="number" min={0.1} max={10} step={0.1} value={draft.priority[k]} disabled={!editable} onChange={(e) => setDraft({ ...draft, priority: { ...draft.priority, [k]: e.target.value } })} className="h-9" />
                </Field>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">{t('Higher = served first. Default private 3, flexible 1.5, shared 1.')}</p>
          </fieldset>
          <p className="text-xs text-muted-foreground">{p.companyMaxRideS ? t('Company maximum ride: {{n}} min (Maximum ride time).', { n: Math.round(p.companyMaxRideS / 60) }) : t('No company maximum ride time is set.')}</p>
          <Problems list={problems} />
          {editable && (
            <Button size="sm" className="justify-self-start" onClick={submit} disabled={save.isPending}>
              {t('Save as new version')}
            </Button>
          )}
          <ReadOnlyNote editable={editable} />
        </div>
      )}
    </Panel>
  );
}

/**
 * Pooling / live dispatch (doc 20 §5): the company switch (default OFF; the server kill switch wins), P4 policy for
 * unpublished / scheduled work, the delay policy and threshold.
 */
export function PoolingSettingsPanel() {
  const { t } = useTranslation();
  const editable = useEditable();
  const settings = usePoolingSettings();
  const save = useSavePoolingSettings();
  const [draft, setDraft] = useState<PoolingSettingsDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = JSON.stringify(settings.data ?? null);
  useEffect(() => {
    if (settings.data) setDraft(poolingDraftOf(settings.data));
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  // Older server (no pooling) or no Dispatch view permission (the GET needs etms_dispatch view).
  if ((settings.isSuccess && !settings.data) || settings.isError) return null;
  const sw = liveSwitch(settings.data);
  const submit = () => {
    if (!draft) return;
    const r = poolingInputOf(draft);
    if (!r.ok) {
      setError(t(r.error));
      return;
    }
    setError(null);
    save.mutate(r.value, { onSuccess: () => toast.success(t('Pooling settings saved.')), onError: (e) => toast.error(poolingErrorText(e, t)) });
  };
  const policyChoice = (id: string, label: string, value: LiveDispatchPolicy, onChange: (v: LiveDispatchPolicy) => void, hint: string) => (
    <Field label={label} hint={hint}>
      <Segmented<LiveDispatchPolicy>
        id={id}
        label={label}
        value={value}
        onChange={(v) => editable && onChange(v)}
        options={[
          { value: 'AUTO', label: t('Assign automatically'), disabled: !editable },
          { value: 'PROPOSE', label: t('Propose to dispatcher'), disabled: !editable },
        ]}
      />
    </Field>
  );
  return (
    <Panel
      title={t('Pooling and live dispatch')}
      subtitle={t('Find a seat for new and changed bookings as they come in.')}
      id="etms-pooling"
      action={<Badge variant={sw === 'on' ? 'success' : 'muted'}>{sw === 'on' ? t('On') : t('Off')}</Badge>}
    >
      {!draft ? (
        <Skeleton className="h-32 w-full" />
      ) : (
        <div className="grid gap-3 text-sm">
          {sw === 'off-server' && <p className="rounded-md border border-warning/40 bg-warning-soft p-2 text-warning-fg">{t('Live dispatch is switched off on this server (ETMS_LIVE_DISPATCH=off). The company switch has no effect until it is switched back on.')}</p>}
          <label className="flex items-start gap-3">
            <Switch checked={draft.liveDispatch} disabled={!editable} onCheckedChange={(v) => setDraft({ ...draft, liveDispatch: v })} />
            <span className="grid gap-0.5">
              <span className="font-medium">{t('Live dispatch')}</span>
              <span className="text-xs text-muted-foreground">{t('Off by default. When on, each new booking is offered to a vehicle within its accepted limits; started trips only get proposals for the dispatcher.')}</span>
            </span>
          </label>
          {policyChoice('pl-sched', t('Unpublished plans and scheduled trips'), draft.scheduledPolicy, (v) => setDraft({ ...draft, scheduledPolicy: v }), t('Started trips are always proposed to the dispatcher.'))}
          {policyChoice('pl-delay', t('When a trip runs late'), draft.delayPolicy, (v) => setDraft({ ...draft, delayPolicy: v }), t('Only passengers not yet picked up move; boarded passengers of a breakdown are always the dispatcher’s decision.'))}
          <Field label={t('Delay threshold (minutes)')} htmlFor="pl-delay-min" error={error ?? undefined} className="sm:w-64">
            <Input id="pl-delay-min" type="number" min={1} max={240} value={draft.delayThresholdMin} disabled={!editable} onChange={(e) => setDraft({ ...draft, delayThresholdMin: e.target.value })} className="h-9" />
          </Field>
          {editable && (
            <Button size="sm" className="justify-self-start" onClick={submit} disabled={save.isPending}>
              {t('Save')}
            </Button>
          )}
          <ReadOnlyNote editable={editable} />
        </div>
      )}
    </Panel>
  );
}

/** Driver working-hour policy (P7: none unless set). Plans and live dispatch refuse trips that break it (DRIVER_HOURS). */
export function DriverHoursPanel() {
  const { t } = useTranslation();
  const editable = useEditable();
  const settings = usePoolingSettings();
  const save = useSaveDriverPolicy();
  const [draft, setDraft] = useState<DriverHoursDraft | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const key = JSON.stringify(settings.data?.driverHours ?? null);
  useEffect(() => {
    if (settings.data) setDraft(driverHoursDraftOf(settings.data.driverHours));
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  if ((settings.isSuccess && !settings.data) || settings.isError) return null;
  const submit = () => {
    if (!draft) return;
    const r = driverHoursInputOf(draft, t);
    if (!r.ok) {
      setProblems(r.errors);
      return;
    }
    setProblems([]);
    save.mutate(r.value, { onSuccess: () => toast.success(r.value ? t('Driver working hours saved.') : t('Driver working-hour policy removed.')), onError: (e) => toast.error(poolingErrorText(e, t)) });
  };
  return (
    <Panel title={t('Driver working hours')} subtitle={t('Leave every field empty for no policy. Plans and live dispatch refuse trips that would break it.')} id="etms-driver-hours" action={<Badge variant="muted">{settings.data?.driverHours ? t('Set') : t('Not set')}</Badge>}>
      {!draft ? (
        <Skeleton className="h-32 w-full" />
      ) : (
        <div className="grid gap-3">
          <div className="grid gap-3 sm:grid-cols-2">
            {DRIVER_HOURS_FIELDS.map((f) => (
              <Field key={f.key} label={t(f.label)} htmlFor={`dh-${f.key}`} hint={t(f.hint)}>
                <Input id={`dh-${f.key}`} type="number" min={0} step={f.key === 'breakS' ? 1 : 0.25} value={draft[f.key]} disabled={!editable} onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })} className="h-9" />
              </Field>
            ))}
          </div>
          <Problems list={problems} />
          {editable && (
            <Button size="sm" className="justify-self-start" onClick={submit} disabled={save.isPending}>
              {t('Save')}
            </Button>
          )}
          <ReadOnlyNote editable={editable} />
        </div>
      )}
    </Panel>
  );
}

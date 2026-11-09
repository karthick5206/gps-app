import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import {
  SIM_OWNERSHIPS,
  SIM_REASON_REQUIRED,
  SIM_STATUS_LABELS,
  SIM_TRANSITIONS,
  type DeviceDto,
  type SimCardDto,
  type SimImportReport,
  type SimPlanDto,
  type SimProviderDto,
  type SimStatus,
  type StockLocationDto,
} from '@veetracer/shared';
import { CheckCircle2Icon, DownloadIcon, FileUpIcon, XCircleIcon } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { z } from 'zod';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input, Textarea } from '@/components/ui/input';
import { Combobox, type Option } from '@/components/ui/multi-select';
import { FormDialog, useSaveMutation } from '@/features/masters/FormDialog';
import { SelectField, TextField } from '@/features/masters/form-fields';
import { nullIfBlank, optionalText, str } from '@/features/masters/form-schema';
import type { MasterFormProps } from '@/features/masters/types';
import { useEntityOptions } from '@/features/masters/use-options';
import { rupeesToPaise } from '@/features/inventory/inventory-format';
import { locationOption, PlainSelect } from '@/features/inventory/shared';
import { api, downloadFile, errorMessage } from '@/lib/api';
import { planOption, providerOption, SimStatusBadge, useInvalidateSims } from './sim-shared';

const OWNERSHIP_OPTIONS: Option[] = SIM_OWNERSHIPS.map((o) => ({ value: o, label: o === 'CUSTOMER' ? 'Customer (BYO)' : o.charAt(0) + o.slice(1).toLowerCase() }));
const NONE = '';

// ───────────── Register / edit ─────────────

const simSchema = z.object({
  iccid: z.string().trim().refine((v) => /^\d{18,22}$/.test(v.replace(/[\s-]/g, '').replace(/[fF]$/, '')), 'ICCID: 18-22 digits'),
  msisdn: z.string().trim().refine((v) => v === '' || /^\+?[\d\s\-()]{8,20}$/.test(v), 'Mobile number: 8-15 digits'),
  imsi: z.string().trim().refine((v) => v === '' || /^\d{6,15}$/.test(v), 'IMSI: 6-15 digits'),
  providerId: z.string().min(1, 'Required'),
  planId: z.string(),
  ownership: z.enum(SIM_OWNERSHIPS),
  locationId: z.string(),
  renewalDueAt: z.string(),
  note: optionalText(500),
});
type SimValues = z.infer<typeof simSchema>;

export function SimForm({ record, open, onOpenChange }: MasterFormProps<SimCardDto>) {
  const form = useForm<SimValues>({
    resolver: zodResolver(simSchema),
    defaultValues: {
      iccid: str(record?.iccid),
      msisdn: str(record?.msisdn),
      imsi: str(record?.imsi),
      providerId: record?.provider.id ?? NONE,
      planId: record?.plan?.id ?? NONE,
      ownership: record?.ownership ?? 'PLATFORM',
      locationId: record?.location?.id ?? NONE,
      renewalDueAt: str(record?.renewalDueAt),
      note: str(record?.note),
    },
  });
  const providerId = form.watch('providerId');
  const providers = useEntityOptions<SimProviderDto>('/sims/providers', providerOption, { enabled: open });
  const plans = useEntityOptions<SimPlanDto>('/sims/plans', planOption, { enabled: open && !!providerId, params: { providerId } });
  const locations = useEntityOptions<StockLocationDto>('/inventory/locations', locationOption, { enabled: open });
  const save = useSaveMutation({ endpoint: '/sims', id: record?.id ?? null, entity: 'SIM', onSaved: () => onOpenChange(false) });
  const submit = form.handleSubmit((v) => {
    const common = { msisdn: nullIfBlank(v.msisdn), imsi: nullIfBlank(v.imsi), planId: v.planId || null, ownership: v.ownership, locationId: v.locationId || null, note: nullIfBlank(v.note) };
    save.mutate(record ? common : { ...common, iccid: v.iccid, providerId: v.providerId, renewalDueAt: v.renewalDueAt || null });
  });
  return (
    <FormDialog open={open} onOpenChange={onOpenChange} title={record ? 'Edit SIM' : 'Register SIM'} description={record ? 'Status, device and renewal have their own actions.' : 'New SIMs start as Available.'} wide pending={save.isPending} error={save.error} onSubmit={submit}>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField form={form} name="iccid" label="ICCID" required disabled={!!record} placeholder="8991 0000 0000 0000 000" />
        <TextField form={form} name="msisdn" label="Mobile number (MSISDN)" placeholder="+91 98450 12345" />
        <SelectField form={form} name="providerId" label="Provider" required options={record ? [{ value: record.provider.id, label: record.provider.name }] : providers.options} />
        <SelectField form={form} name="planId" label="Plan" options={plans.options} placeholder={providerId ? 'Select…' : 'Choose a provider first'} />
        <TextField form={form} name="imsi" label="IMSI" />
        <SelectField form={form} name="ownership" label="Ownership" options={OWNERSHIP_OPTIONS} hint="Customer-provided (BYO) SIMs are tracked only." />
        <SelectField form={form} name="locationId" label="Stock location" options={locations.options} />
        {!record && <TextField form={form} name="renewalDueAt" label="Renewal due" type="date" />}
        <TextField form={form} name="note" label="Note" multiline className="sm:col-span-2" />
      </div>
    </FormDialog>
  );
}

// ───────────── Actions ─────────────

interface ActionProps {
  sim: SimCardDto | null;
  onOpenChange: (open: boolean) => void;
}

function useSimAction<B>(sim: SimCardDto | null, path: string, success: string, done: () => void) {
  const { t } = useTranslation();
  const invalidate = useInvalidateSims();
  return useMutation({
    mutationFn: (body: B) => api.post<unknown>(`/sims/${sim!.id}/${path}`, body),
    onSuccess: () => {
      toast.success(t(success, { iccid: sim?.iccid }));
      invalidate();
      done();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
}

export function SimStatusDialog({ sim, onOpenChange }: ActionProps) {
  const { t } = useTranslation();
  const [status, setStatus] = useState('');
  const [reason, setReason] = useState('');
  useEffect(() => {
    setStatus('');
    setReason('');
  }, [sim]);
  const save = useSimAction<object>(sim, 'status', 'SIM {{iccid}} updated', () => onOpenChange(false));
  if (!sim) return null;
  const allowed = SIM_TRANSITIONS[sim.status];
  const needsReason = !!status && SIM_REASON_REQUIRED.includes(status as SimStatus);
  return (
    <FormDialog
      open={!!sim}
      onOpenChange={onOpenChange}
      title="Change SIM status"
      description={sim.iccid}
      pending={save.isPending}
      error={save.error}
      submitLabel="Change status"
      onSubmit={(e) => {
        e.preventDefault();
        if (status) save.mutate({ status, reason: reason.trim() || undefined });
      }}
    >
      <div className="flex items-center gap-2 text-sm">
        <span className="text-muted-foreground">{t('Current')}</span>
        <SimStatusBadge status={sim.status} />
      </div>
      {allowed.length ? (
        <PlainSelect id="ss-status" label="New status" required value={status} onChange={setStatus} options={allowed.map((s) => ({ value: s, label: SIM_STATUS_LABELS[s] }))} />
      ) : (
        <p className="text-sm text-muted-foreground">{t('Deactivated is final.')}</p>
      )}
      <Field label={t('Reason')} htmlFor="ss-reason" required={needsReason} hint={needsReason ? undefined : t('Optional')}>
        <Textarea id="ss-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
      </Field>
      {(status === 'DEACTIVATED' || status === 'DAMAGED') && sim.device && <p className="text-xs text-destructive-fg">{t('Take the SIM out of its device first.')}</p>}
    </FormDialog>
  );
}

const deviceOption = (d: DeviceDto): Option => ({ value: d.id, label: d.uniqueId, description: d.companyName ?? undefined });

/** Fit the SIM to a device (moves it if it is in another device). Never edits the device record. */
export function SimAssignDialog({ sim, onOpenChange }: ActionProps) {
  const { t } = useTranslation();
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [reason, setReason] = useState('');
  const devices = useEntityOptions<DeviceDto>('/admin/devices', deviceOption, { q, enabled: !!sim });
  useEffect(() => {
    setDeviceId(null);
    setReason('');
    setQ('');
  }, [sim]);
  const save = useSimAction<object>(sim, 'assign', 'SIM {{iccid}} fitted', () => onOpenChange(false));
  if (!sim) return null;
  return (
    <FormDialog
      open={!!sim}
      onOpenChange={onOpenChange}
      title={sim.device ? 'Move SIM to another device' : 'Fit SIM to device'}
      description={sim.device ? t('Now in {{imei}}', { imei: sim.device.uniqueId }) : sim.iccid}
      pending={save.isPending}
      error={save.error}
      submitLabel={sim.device ? 'Move' : 'Fit'}
      onSubmit={(e) => {
        e.preventDefault();
        if (deviceId) save.mutate({ deviceId, reason: reason.trim() || undefined });
      }}
    >
      <Field label={t('Device (IMEI)')} htmlFor="sa-dev" required hint={t('A SIM already in that device is taken out (recorded in its history).')}>
        <Combobox id="sa-dev" value={deviceId} onChange={setDeviceId} options={devices.options} onSearch={setQ} loading={devices.loading} placeholder={t('Search IMEI…')} />
      </Field>
      <Field label={t('Reason')} htmlFor="sa-reason" hint={t('Optional')}>
        <Input id="sa-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
      </Field>
      <p className="text-xs text-muted-foreground">{t("The device's own SIM number and the tracker-reported ICCID are not changed; differences show as a reconciliation flag.")}</p>
    </FormDialog>
  );
}

export function SimRenewDialog({ sim, onOpenChange }: ActionProps) {
  const { t } = useTranslation();
  const [date, setDate] = useState('');
  const [planId, setPlanId] = useState('');
  const [note, setNote] = useState('');
  const plans = useEntityOptions<SimPlanDto>('/sims/plans', planOption, { enabled: !!sim, params: { providerId: sim?.provider.id } });
  useEffect(() => {
    setDate('');
    setPlanId('');
    setNote('');
  }, [sim]);
  const save = useSimAction<object>(sim, 'renew', 'SIM {{iccid}} renewed', () => onOpenChange(false));
  if (!sim) return null;
  return (
    <FormDialog
      open={!!sim}
      onOpenChange={onOpenChange}
      title="Record renewal"
      description={t('{{iccid}} · due {{d}}', { iccid: sim.iccid, d: sim.renewalDueAt ?? '—' })}
      pending={save.isPending}
      error={save.error}
      submitLabel="Save renewal"
      onSubmit={(e) => {
        e.preventDefault();
        if (date) save.mutate({ renewalDueAt: date, planId: planId || undefined, note: note.trim() || undefined });
      }}
    >
      <Field label={t('Next renewal due')} htmlFor="sr-date" required>
        <Input id="sr-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </Field>
      <PlainSelect id="sr-plan" label="Plan" value={planId} onChange={setPlanId} options={plans.options} allowEmpty={`Unchanged${sim.plan ? ` (${sim.plan.name})` : ''}`} />
      <Field label={t('Note')} htmlFor="sr-note" hint={t('Optional, e.g. payment reference')}>
        <Input id="sr-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
      </Field>
      {sim.status === 'EXPIRED' && <p className="text-xs text-muted-foreground">{t('An expired SIM becomes Active again.')}</p>}
    </FormDialog>
  );
}

export function SimUsageDialog({ sim, onOpenChange }: ActionProps) {
  const { t } = useTranslation();
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [dataMb, setDataMb] = useState('');
  const [sms, setSms] = useState('');
  const [cost, setCost] = useState('');
  const [note, setNote] = useState('');
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setStart('');
    setEnd('');
    setDataMb('');
    setSms('');
    setCost('');
    setNote('');
    setErr(null);
  }, [sim]);
  const save = useSimAction<object>(sim, 'usage', 'Usage recorded for {{iccid}}', () => onOpenChange(false));
  if (!sim) return null;
  return (
    <FormDialog
      open={!!sim}
      onOpenChange={onOpenChange}
      title="Add usage / cost entry"
      description={t('Entries are kept as history; correct a mistake with a new entry.')}
      pending={save.isPending}
      error={err ? new Error(err) : save.error}
      submitLabel="Add entry"
      onSubmit={(e) => {
        e.preventDefault();
        if (!start || !end) return setErr(t('Choose the billing period'));
        if (end < start) return setErr(t('The period ends before it starts'));
        const paise = rupeesToPaise(cost);
        if (paise !== null && Number.isNaN(paise)) return setErr(t('Cost must be an amount in rupees'));
        setErr(null);
        save.mutate({ periodStart: start, periodEnd: end, dataMb: dataMb ? Number(dataMb) : null, smsCount: sms ? Number(sms) : null, costPaise: paise, note: note.trim() || null });
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('Period from')} htmlFor="su-s" required>
          <Input id="su-s" type="date" value={start} onChange={(e) => setStart(e.target.value)} />
        </Field>
        <Field label={t('Period to')} htmlFor="su-e" required>
          <Input id="su-e" type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
        </Field>
        <Field label={t('Data used (MB)')} htmlFor="su-d">
          <Input id="su-d" type="number" min={0} value={dataMb} onChange={(e) => setDataMb(e.target.value)} />
        </Field>
        <Field label={t('SMS count')} htmlFor="su-sms">
          <Input id="su-sms" type="number" min={0} value={sms} onChange={(e) => setSms(e.target.value)} />
        </Field>
        <Field label={t('Cost (₹)')} htmlFor="su-c">
          <Input id="su-c" inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} />
        </Field>
        <Field label={t('Note')} htmlFor="su-n">
          <Input id="su-n" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
        </Field>
      </div>
    </FormDialog>
  );
}

/** Operator CSV import with a dry-run preview first. */
export function SimImportDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t } = useTranslation();
  const invalidate = useInvalidateSims();
  const [providerId, setProviderId] = useState('');
  const [locationId, setLocationId] = useState('');
  const [csv, setCsv] = useState('');
  const [fileName, setFileName] = useState('');
  const [report, setReport] = useState<SimImportReport | null>(null);
  const providers = useEntityOptions<SimProviderDto>('/sims/providers', providerOption, { enabled: open });
  const locations = useEntityOptions<StockLocationDto>('/inventory/locations', locationOption, { enabled: open });
  useEffect(() => {
    if (!open) return;
    setProviderId('');
    setLocationId('');
    setCsv('');
    setFileName('');
    setReport(null);
  }, [open]);
  useEffect(() => setReport(null), [csv, providerId, locationId]);
  const body = (dryRun: boolean) => ({ csv, providerId: providerId || undefined, locationId: locationId || undefined, dryRun });
  const check = useMutation({ mutationFn: () => api.post<SimImportReport>('/sims/import', body(true)), onSuccess: setReport, onError: (e) => toast.error(errorMessage(e)) });
  const apply = useMutation({
    mutationFn: () => api.post<SimImportReport>('/sims/import', body(false)),
    onSuccess: (r) => {
      if (!r.applied) return setReport(r);
      toast.success(t('Registered {{n}} SIMs', { n: r.summary.create }));
      invalidate();
      onOpenChange(false);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const clean = !!report && report.summary.errors === 0;
  const errorsShown = useMemo(() => report?.rows.filter((r) => r.errors.length) ?? [], [report]);
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Import SIMs from CSV"
      description="Step 1 checks the operator file (dry run). Step 2 registers every row as Available."
      wide
      pending={check.isPending || apply.isPending}
      error={check.error ?? apply.error}
      submitLabel={clean ? t('Register {{n}} SIMs', { n: report!.summary.create }) : 'Check file (dry run)'}
      onSubmit={(e) => {
        e.preventDefault();
        if (!csv.trim()) return toast.error(t('Choose a CSV file'));
        if (clean) apply.mutate();
        else check.mutate();
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <PlainSelect id="si-prov" label="Default provider" value={providerId} onChange={setProviderId} options={providers.options} allowEmpty="From the file" hint="Used for rows without a provider column." />
        <PlainSelect id="si-loc" label="Stock location" value={locationId} onChange={setLocationId} options={locations.options} allowEmpty="None" />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" asChild>
          <label className="cursor-pointer">
            <FileUpIcon /> {fileName || t('Choose CSV file')}
            <input
              type="file"
              accept=".csv,text/csv"
              className="sr-only"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                if (f.size > 200_000) return toast.error(t('The file is larger than 200 kB'));
                setFileName(f.name);
                setCsv(await f.text());
              }}
            />
          </label>
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => void downloadFile('/sims/import/template', 'sim-import-template.csv').catch((err) => toast.error(errorMessage(err)))}>
          <DownloadIcon /> {t('Template')}
        </Button>
      </div>
      <Field label={t('Or paste CSV')} htmlFor="si-csv">
        <Textarea id="si-csv" rows={5} value={csv} onChange={(e) => setCsv(e.target.value)} className="font-mono text-xs" placeholder={'iccid,msisdn,provider,plan,renewal_due\n8991000000000000001,919845012345,Airtel IoT,M2M 1GB,2027-06-30'} />
      </Field>
      {report && (
        <div className="space-y-2 rounded-lg border p-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            {clean ? <CheckCircle2Icon className="size-4 text-success" /> : <XCircleIcon className="size-4 text-destructive" />}
            <span className="font-medium">{clean ? t('Ready to register') : t('Fix these rows, then check again')}</span>
            <Badge variant="info">{t('{{n}} new', { n: report.summary.create })}</Badge>
            {report.summary.errors > 0 && <Badge variant="destructive">{t('{{n}} errors', { n: report.summary.errors })}</Badge>}
          </div>
          {errorsShown.length > 0 && (
            <ul className="max-h-40 space-y-1 overflow-auto text-xs">
              {errorsShown.map((r) => (
                <li key={r.line}>
                  <span className="font-mono">
                    {t('Line')} {r.line}
                    {r.iccid ? ` · ${r.iccid}` : ''}
                  </span>
                  : <span className="text-destructive-fg">{r.errors.join('; ')}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </FormDialog>
  );
}

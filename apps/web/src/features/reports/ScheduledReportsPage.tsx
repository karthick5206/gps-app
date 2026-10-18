import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { REPORT_TYPES, SINGLE_OBJECT_REPORT_TYPES, type ReportFormat, type ReportPeriod, type ReportScheduleDto, type ReportType } from '@veetracer/shared';
import type { TFunction } from 'i18next';
import { CalendarClockIcon, HistoryIcon, PlayIcon } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { z } from 'zod';
import { Badge } from '@/components/ui/badge';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/features/auth/auth-context';
import { ActiveBadge, DateCell, Muted } from '@/features/masters/cells';
import { FormDialog, useInvalidateMaster, useSaveMutation } from '@/features/masters/FormDialog';
import { MultiSelectField, SelectField, SwitchField, TextField } from '@/features/masters/form-fields';
import { requiredText } from '@/features/masters/form-schema';
import { MasterPage } from '@/features/masters/MasterPage';
import type { MasterColumn, MasterFormProps } from '@/features/masters/types';
import { api, errorMessage } from '@/lib/api';
import { i18n } from '@/lib/i18n';
import { RecipientChips } from './RecipientChips';
import { REPORT_DEF_MAP } from './report-columns';
import { isEmail } from './report-format';
import { PERIOD_OPTIONS } from './ReportsPage';
import { RunsSheet, runsQueryKey } from './RunsSheet';
import { EMPTY_SCOPE, ScopePicker } from './ScopePicker';

const ENDPOINT = '/report-schedules';
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const FREQUENCIES = [
  { value: 'DAILY', label: 'Daily' },
  { value: 'WEEKLY', label: 'Weekly' },
  { value: 'MONTHLY', label: 'Monthly' },
];
const FORMATS: { value: ReportFormat; label: string }[] = [
  { value: 'XLSX', label: 'Excel (XLSX)' },
  { value: 'PDF', label: 'PDF' },
  { value: 'CSV', label: 'CSV' },
];
// Raw single-vehicle reports (Positions) are run on demand only.
const TYPE_OPTIONS = REPORT_TYPES.filter((t) => !SINGLE_OBJECT_REPORT_TYPES.includes(t)).map((t) => ({ value: t, label: REPORT_DEF_MAP[t].label }));

const makeSchema = (t: TFunction) =>
  z
  .object({
    name: requiredText(120),
    reportTypes: z.array(z.string()).min(1, t('Choose at least one report')),
    scope: z.object({ branchIds: z.array(z.string()), groupIds: z.array(z.string()), objectIds: z.array(z.string()) }),
    period: z.enum(['DAY', 'WEEK', 'MONTH']),
    frequency: z.enum(['DAILY', 'WEEKLY', 'MONTHLY']),
    dayOfWeek: z.string(),
    dayOfMonth: z.string(),
    timeOfDay: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, t('Use HH:mm')),
    format: z.enum(['XLSX', 'PDF', 'CSV']),
    recipients: z.array(z.string()).min(1, t('Add at least one recipient')).max(50, t('At most {{max}} recipients', { max: 50 })),
    isActive: z.boolean(),
  })
  .superRefine((v, ctx) => {
    if (v.frequency === 'WEEKLY' && !/^[1-7]$/.test(v.dayOfWeek)) ctx.addIssue({ code: 'custom', path: ['dayOfWeek'], message: t('Choose a day') });
    if (v.frequency === 'MONTHLY') {
      const d = Number(v.dayOfMonth);
      if (!Number.isInteger(d) || d < 1 || d > 28) ctx.addIssue({ code: 'custom', path: ['dayOfMonth'], message: t('Day 1–28') });
    }
    v.recipients.forEach((r, i) => !isEmail(r) && ctx.addIssue({ code: 'custom', path: ['recipients', i], message: t('Not a valid email: {{emails}}', { emails: r }) }));
  });
type Values = z.infer<ReturnType<typeof makeSchema>>;

function ScheduleForm({ record, open, onOpenChange }: MasterFormProps<ReportScheduleDto>) {
  const { t } = useTranslation();
  const { me } = useAuth();
  const schema = useMemo(() => makeSchema(t), [t]);
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: record?.name ?? '',
      reportTypes: record?.reportTypes ?? ['SUMMARY'],
      scope: record?.scope ?? EMPTY_SCOPE,
      period: record?.period ?? 'DAY',
      frequency: record?.frequency ?? 'DAILY',
      dayOfWeek: record?.dayOfWeek ? String(record.dayOfWeek) : '1',
      dayOfMonth: record?.dayOfMonth ? String(record.dayOfMonth) : '1',
      timeOfDay: record?.timeOfDay ?? '07:00',
      format: record?.format ?? 'XLSX',
      recipients: record?.recipients ?? (me?.user.email ? [me.user.email] : []),
      isActive: record?.isActive ?? true,
    },
  });
  const frequency = useWatch({ control: form.control, name: 'frequency' });
  const [chipError, setChipError] = useState<string | null>(null);
  const save = useSaveMutation({ endpoint: ENDPOINT, id: record?.id ?? null, entity: t('Scheduled report'), onSaved: () => onOpenChange(false) });
  const recipientsError = form.formState.errors.recipients;
  const recipientMessage =
    chipError ?? recipientsError?.message ?? (Array.isArray(recipientsError) ? recipientsError.find((e) => e?.message)?.message : undefined);

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      wide
      title={record ? t('Edit scheduled report') : t('Add scheduled report')}
      description={t('Reports cover the previous complete period and are emailed at the chosen time ({{timezone}}).', { timezone: me?.company.timezone ?? t('company time zone') })}
      pending={save.isPending}
      error={save.error}
      onSubmit={form.handleSubmit((v) => {
        if (chipError) return;
        save.mutate({
          name: v.name.trim(),
          reportTypes: v.reportTypes as ReportType[],
          scope: v.scope,
          period: v.period as ReportPeriod,
          frequency: v.frequency,
          dayOfWeek: v.frequency === 'WEEKLY' ? Number(v.dayOfWeek) : null,
          dayOfMonth: v.frequency === 'MONTHLY' ? Number(v.dayOfMonth) : null,
          timeOfDay: v.timeOfDay,
          format: v.format,
          recipients: v.recipients,
          isActive: v.isActive,
        });
      })}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField form={form} name="name" label={t('Name')} required className="sm:col-span-2" placeholder={t('e.g. Daily fleet summary')} />
        <MultiSelectField form={form} name="reportTypes" label={t('Reports')} required options={TYPE_OPTIONS.map((o) => ({ ...o, label: t(o.label) }))} placeholder={t('Choose reports…')} className="sm:col-span-2" />
        <SelectField form={form} name="period" label={t('Summary grouping')} options={PERIOD_OPTIONS.map((o) => ({ ...o, label: t(o.label) }))} hint={t('Used by the Summary report')} />
        <SelectField form={form} name="format" label={t('File format')} required options={FORMATS.map((o) => ({ ...o, label: t(o.label) }))} />
      </div>
      <Controller control={form.control} name="scope" render={({ field }) => <ScopePicker value={field.value} onChange={field.onChange} />} />
      <p className="-mt-2 text-xs text-muted-foreground">{t('Leave empty to include every vehicle the owner can access when the report runs.')}</p>
      <div className="grid gap-4 sm:grid-cols-3">
        <SelectField form={form} name="frequency" label={t('Frequency')} required options={FREQUENCIES.map((o) => ({ ...o, label: t(o.label) }))} />
        {frequency === 'WEEKLY' && <SelectField form={form} name="dayOfWeek" label={t('Day of week')} required options={DAYS.map((d, i) => ({ value: String(i + 1), label: t(d) }))} />}
        {frequency === 'MONTHLY' && (
          <SelectField form={form} name="dayOfMonth" label={t('Day of month')} required options={Array.from({ length: 28 }, (_, i) => ({ value: String(i + 1), label: String(i + 1) }))} />
        )}
        <Field label={t('Time')} htmlFor="f-timeOfDay" required error={form.formState.errors.timeOfDay?.message}>
          <Input id="f-timeOfDay" type="time" step={60} {...form.register('timeOfDay')} aria-invalid={!!form.formState.errors.timeOfDay} />
        </Field>
      </div>
      <Field label={t('Recipients')} htmlFor="f-recipients" required error={recipientMessage} hint={t('Press Enter, comma or space after each email. Paste a list to add many.')}>
        <Controller
          control={form.control}
          name="recipients"
          render={({ field }) => (
            <RecipientChips
              id="f-recipients"
              value={field.value}
              onChange={(v) => {
                field.onChange(v);
                if (form.formState.isSubmitted) void form.trigger('recipients');
              }}
              invalid={!!recipientMessage}
              onInvalidChange={setChipError}
            />
          )}
        />
      </Field>
      <SwitchField form={form} name="isActive" label={t('Active')} hint={t("Inactive schedules don't run automatically; Run now still works.")} />
    </FormDialog>
  );
}

function scheduleLabel(r: ReportScheduleDto): string {
  if (r.frequency === 'WEEKLY') return i18n.t('Weekly · {{day}} {{time}}', { day: i18n.t(DAYS[(r.dayOfWeek ?? 1) - 1]), time: r.timeOfDay });
  if (r.frequency === 'MONTHLY') return i18n.t('Monthly · day {{day}}, {{time}}', { day: r.dayOfMonth ?? 1, time: r.timeOfDay });
  return i18n.t('Daily · {{time}}', { time: r.timeOfDay });
}

const columns: MasterColumn<ReportScheduleDto>[] = [
  { id: 'name', header: 'Name', sortable: true, hideable: false, cell: (r) => <span className="font-medium">{r.name}</span> },
  {
    id: 'reportTypes',
    header: 'Reports',
    cell: (r) => (
      <span className="inline-flex flex-wrap gap-1">
        {r.reportTypes.map((t) => (
          <Badge key={t} variant="secondary">
            {REPORT_DEF_MAP[t] ? i18n.t(REPORT_DEF_MAP[t].label) : t}
          </Badge>
        ))}
      </span>
    ),
  },
  { id: 'frequency', header: 'Schedule', sortable: true, cell: (r) => <span className="tabular-nums">{scheduleLabel(r)}</span> },
  { id: 'format', header: 'Format', cell: (r) => r.format },
  {
    id: 'recipients',
    header: 'Recipients',
    cell: (r) =>
      r.recipients.length ? (
        <span title={r.recipients.join(', ')}>
          {r.recipients[0]}
          {r.recipients.length > 1 && <span className="text-xs text-muted-foreground"> +{r.recipients.length - 1}</span>}
        </span>
      ) : (
        <Muted>—</Muted>
      ),
  },
  { id: 'period', header: 'Grouping', defaultHidden: true, cell: (r) => {
      const label = PERIOD_OPTIONS.find((p) => p.value === r.period)?.label;
      return label ? i18n.t(label) : r.period;
    },
  },
  { id: 'ownerName', header: 'Owner', cell: (r) => r.ownerName },
  { id: 'nextRunAt', header: 'Next run', sortable: true, cell: (r) => (r.isActive ? <DateCell value={r.nextRunAt} /> : <Muted>{i18n.t('Paused')}</Muted>) },
  { id: 'lastRunAt', header: 'Last run', sortable: true, cell: (r) => <DateCell value={r.lastRunAt} relative /> },
  { id: 'isActive', header: 'Status', cell: (r) => <ActiveBadge active={r.isActive} /> },
  { id: 'updatedAt', header: 'Updated', sortable: true, defaultHidden: true, cell: (r) => <DateCell value={r.updatedAt} relative /> },
];

const rowLabel = (r: ReportScheduleDto) => r.name;

export function ScheduledReportsPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const invalidate = useInvalidateMaster();
  const [runsFor, setRunsFor] = useState<{ id: string; name: string } | null>(null);

  const runNow = useMutation({
    mutationFn: (r: ReportScheduleDto) => api.post<unknown>(`${ENDPOINT}/${r.id}/run-now`),
    onSuccess: (_, r) => {
      toast.success(t('{{name}}: run started. The report will be emailed when ready.', { name: r.name }));
      queryClient.invalidateQueries({ queryKey: runsQueryKey(r.id) });
      invalidate(ENDPOINT);
      setRunsFor({ id: r.id, name: r.name });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const canRun = can('report_schedules', 'edit'); // API: POST /report-schedules/:id/run-now needs edit
  const rowActions = useCallback(
    (r: ReportScheduleDto) => (
      <>
        {canRun && (
          <DropdownMenuItem onSelect={() => runNow.mutate(r)} disabled={runNow.isPending}>
            <PlayIcon /> {t('Run now')}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={() => setRunsFor({ id: r.id, name: r.name })}>
          <HistoryIcon /> {t('Run history')}
        </DropdownMenuItem>
      </>
    ),
    [canRun, runNow, t],
  );

  return (
    <>
      <MasterPage
        menu="report_schedules"
        title={t('Scheduled Reports')}
        description={t('Email reports automatically every day, week or month.')}
        endpoint={ENDPOINT}
        columns={columns}
        rowLabel={rowLabel}
        defaultSort={{ id: 'name', desc: false }}
        Form={ScheduleForm}
        rowActions={rowActions}
        emptyIcon={CalendarClockIcon}
      />
      <RunsSheet target={runsFor} onClose={() => setRunsFor(null)} />
    </>
  );
}

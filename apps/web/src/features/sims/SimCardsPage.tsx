import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery } from '@tanstack/react-query';
import {
  SIM_PROVIDER_KINDS,
  SIM_STATUS_LABELS,
  SIM_STATUSES,
  type SimCardDto,
  type SimEventDto,
  type SimPlanDto,
  type SimProviderDto,
  type SimStatus,
  type SimSummaryDto,
} from '@veetracer/shared';
import { BellRingIcon, CalendarClockIcon, CpuIcon, EyeIcon, FileUpIcon, HistoryIcon, LayersIcon, ListChecksIcon, NetworkIcon, ReceiptIndianRupeeIcon, CardSimIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import type { Option } from '@/components/ui/multi-select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAuth } from '@/features/auth/auth-context';
import { formatRupees, daysLeft, renewalText } from '@/features/inventory/inventory-format';
import { StatTile, StatusChips } from '@/features/inventory/shared';
import { ActiveBadge, Dash, DateCell, Muted } from '@/features/masters/cells';
import { FormDialog, useSaveMutation } from '@/features/masters/FormDialog';
import { SelectField, SwitchField, TextField } from '@/features/masters/form-fields';
import { numericText, requiredText, str } from '@/features/masters/form-schema';
import { MasterPage } from '@/features/masters/MasterPage';
import type { MasterColumn, MasterFilter, MasterFormProps } from '@/features/masters/types';
import { useEntityOptions } from '@/features/masters/use-options';
import { api } from '@/lib/api';
import { i18n } from '@/lib/i18n';
import { storage } from '@/lib/storage';
import { SimDetailSheet, type SimAction } from './SimDetailSheet';
import { SimAssignDialog, SimForm, SimImportDialog, SimRenewDialog, SimStatusDialog, SimUsageDialog } from './SimDialogs';
import { planOption, providerOption, RenewalBadge, SIM_STATUS_VARIANT, SimStatusBadge } from './sim-shared';

const ASSIGNED_OPTIONS: Option[] = [
  { value: 'true', label: 'In a device' },
  { value: 'false', label: 'Not in a device' },
];
const RENEWAL_OPTIONS: Option[] = [
  { value: '0', label: 'Overdue' },
  { value: '30', label: 'Due within 30 days' },
  { value: '60', label: 'Due within 60 days' },
];
const RECONCILE_OPTIONS: Option[] = [{ value: 'true', label: 'Differs from device' }];

function simColumns(open: (s: SimCardDto) => void): MasterColumn<SimCardDto>[] {
  return [
    {
      id: 'iccid',
      header: 'ICCID',
      sortable: true,
      hideable: false,
      cell: (r) => (
        <button type="button" onClick={() => open(r)} className="font-mono text-xs font-medium text-primary hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
          {r.iccid}
        </button>
      ),
    },
    { id: 'msisdn', header: 'Mobile no.', sortable: true, cell: (r) => (r.msisdn ? <span className="tabular-nums">+{r.msisdn}</span> : <Muted>—</Muted>) },
    { id: 'provider', header: 'Provider', cell: (r) => r.provider.name },
    { id: 'plan', header: 'Plan', cell: (r) => <Dash value={r.plan?.name} /> },
    {
      id: 'status',
      header: 'Status',
      sortable: true,
      cell: (r) => (
        <span className="inline-flex items-center gap-1">
          <SimStatusBadge status={r.status} />
          {r.reconcile.length > 0 && (
            <Badge variant="warning" title={r.reconcile.join(', ')}>
              {i18n.t('Check')}
            </Badge>
          )}
        </span>
      ),
    },
    { id: 'device', header: 'Device', cell: (r) => (r.device ? <span className="font-mono text-xs">{r.device.uniqueId}</span> : <Muted>—</Muted>) },
    { id: 'customer', header: 'Customer', cell: (r) => <Dash value={r.device?.companyName} /> },
    { id: 'renewalDueAt', header: 'Renewal due', sortable: true, cell: (r) => <RenewalBadge state={r.renewalState} date={r.renewalDueAt} /> },
    { id: 'planCost', header: 'Plan cost', defaultHidden: true, cell: (r) => <Dash value={r.plan ? formatRupees(r.plan.costPaise) : null} /> },
    { id: 'ownership', header: 'Ownership', defaultHidden: true, cell: (r) => r.ownership },
    { id: 'location', header: 'Location', defaultHidden: true, cell: (r) => <Dash value={r.location?.code} /> },
    { id: 'statusChangedAt', header: 'Status since', sortable: true, defaultHidden: true, cell: (r) => <DateCell value={r.statusChangedAt} relative /> },
  ];
}

function useSimActions() {
  const [detail, setDetail] = useState<string | null>(null);
  const [action, setAction] = useState<{ kind: SimAction; sim: SimCardDto } | null>(null);
  const close = () => setAction(null);
  const act = (kind: SimAction, sim: SimCardDto) => setAction({ kind, sim });
  const ui = (
    <>
      <SimDetailSheet simId={detail} onClose={() => setDetail(null)} onAction={act} />
      <SimStatusDialog sim={action?.kind === 'status' ? action.sim : null} onOpenChange={(o) => !o && close()} />
      <SimAssignDialog sim={action?.kind === 'assign' ? action.sim : null} onOpenChange={(o) => !o && close()} />
      <SimRenewDialog sim={action?.kind === 'renew' ? action.sim : null} onOpenChange={(o) => !o && close()} />
      <SimUsageDialog sim={action?.kind === 'usage' ? action.sim : null} onOpenChange={(o) => !o && close()} />
    </>
  );
  return { setDetail, act, ui };
}

function SimRowActions({ r, open, act }: { r: SimCardDto; open: (id: string) => void; act: (k: SimAction, s: SimCardDto) => void }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  return (
    <>
      <DropdownMenuItem onSelect={() => open(r.id)}>
        <EyeIcon /> {t('Details & history')}
      </DropdownMenuItem>
      {can('sa_sim_cards', 'edit') && (
        <>
          <DropdownMenuItem onSelect={() => act('status', r)}>
            <ListChecksIcon /> {t('Change status')}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => act('assign', r)}>
            <CpuIcon /> {r.device ? t('Move to device') : t('Fit to device')}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => act('renew', r)}>
            <CalendarClockIcon /> {t('Renew')}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => act('usage', r)}>
            <ReceiptIndianRupeeIcon /> {t('Add usage')}
          </DropdownMenuItem>
        </>
      )}
    </>
  );
}

function SimsTab({ summary }: { summary?: SimSummaryDto }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const [status, setStatus] = useState<SimStatus | null>(null);
  const [importing, setImporting] = useState(false);
  const { setDetail, act, ui } = useSimActions();
  const providers = useEntityOptions<SimProviderDto>('/sims/providers', providerOption);
  const plans = useEntityOptions<SimPlanDto>('/sims/plans', planOption);
  const filters = useMemo<MasterFilter[]>(
    () => [
      { key: 'providerId', label: 'Providers', options: providers.options },
      { key: 'planId', label: 'Plans', options: plans.options },
      { key: 'assigned', label: 'Device', options: ASSIGNED_OPTIONS },
      { key: 'renewalWithin', label: 'Renewal', options: RENEWAL_OPTIONS },
      { key: 'reconcile', label: 'Reconciliation', options: RECONCILE_OPTIONS },
    ],
    [providers.options, plans.options],
  );
  const columns = useMemo(() => simColumns((s) => setDetail(s.id)), [setDetail]);
  const fixedParams = useMemo(() => ({ simStatus: status ?? undefined }), [status]);
  return (
    <>
      <MasterPage
        menu="sa_sim_cards"
        title="SIM cards"
        description="Every managed SIM with its status, device, plan and renewal. The device's own SIM fields are never overwritten."
        endpoint="/sims"
        columns={columns}
        rowLabel={(r) => r.iccid}
        filters={filters}
        statusFilter={false}
        fixedParams={fixedParams}
        defaultSort={{ id: 'iccid', desc: false }}
        Form={SimForm}
        history={false}
        bulkActions={false}
        emptyIcon={CardSimIcon}
        aboveTable={
          <div className="space-y-3">
            {summary && (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <StatTile label="In devices" value={summary.assigned} sub={t('{{n}} SIMs in total', { n: Object.values(summary.byStatus).reduce((a, b) => a + b, 0) })} />
                <StatTile label="Renewals due (30 days)" value={summary.renewalsDue} tone={summary.renewalsDue ? 'warning' : 'default'} />
                <StatTile label="Renewals overdue" value={summary.renewalsOverdue} tone={summary.renewalsOverdue ? 'destructive' : 'default'} />
                <StatTile label="Active plan cost" value={formatRupees(summary.activePlanCostPaise, { compact: true })} sub={t('{{n}} reconciliation flags', { n: summary.reconcileIssues })} />
              </div>
            )}
            <StatusChips statuses={SIM_STATUSES} labels={SIM_STATUS_LABELS} counts={summary?.byStatus} value={status} onChange={setStatus} variant={SIM_STATUS_VARIANT} />
          </div>
        }
        headerActions={
          can('sa_sim_cards', 'create') && (
            <Button variant="outline" onClick={() => setImporting(true)}>
              <FileUpIcon /> <span className="hidden sm:inline">{t('Import CSV')}</span>
            </Button>
          )
        }
        rowActions={(r) => <SimRowActions r={r} open={setDetail} act={act} />}
      />
      {ui}
      <SimImportDialog open={importing} onOpenChange={setImporting} />
    </>
  );
}

/** Expiry reminders as a report (no outbound messages). */
function RenewalsTab() {
  const { t } = useTranslation();
  const [within, setWithin] = useState(30);
  const { setDetail, act, ui } = useSimActions();
  const q = useQuery({ queryKey: ['sims', 'renewals', within], queryFn: () => api.get<{ withinDays: number; items: SimCardDto[] }>('/sims/renewals', { withinDays: within }) });
  const items = q.data?.items ?? [];
  return (
    <div className="w-full space-y-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">{t('Renewal reminders')}</h2>
          <p className="text-sm text-muted-foreground">{t('SIMs whose renewal is overdue or due soon. This is a report: no SMS or e-mail is sent.')}</p>
        </div>
        <div className="flex gap-1.5">
          {[7, 30, 60, 90].map((d) => (
            <Button key={d} size="sm" variant={within === d ? 'default' : 'outline'} onClick={() => setWithin(d)}>
              {t('{{n}} days', { n: d })}
            </Button>
          ))}
        </div>
      </div>
      <div className="overflow-hidden rounded-xl border bg-card">
        <table className="w-full text-sm">
          <thead className="bg-muted/60 text-left text-xs text-muted-foreground uppercase">
            <tr>
              <th className="px-3 py-2 font-medium">{t('ICCID')}</th>
              <th className="px-3 py-2 font-medium">{t('Mobile no.')}</th>
              <th className="hidden px-3 py-2 font-medium md:table-cell">{t('Provider / plan')}</th>
              <th className="hidden px-3 py-2 font-medium sm:table-cell">{t('Device / customer')}</th>
              <th className="px-3 py-2 font-medium">{t('Renewal due')}</th>
              <th className="px-3 py-2 font-medium">
                <span className="sr-only">{t('Actions')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {q.isPending ? (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center text-muted-foreground">
                  {t('Loading…')}
                </td>
              </tr>
            ) : items.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-3 py-10 text-center text-muted-foreground">
                  <BellRingIcon className="mx-auto mb-2 size-6 opacity-60" />
                  {t('Nothing due in the next {{n}} days.', { n: within })}
                </td>
              </tr>
            ) : (
              items.map((s) => (
                <tr key={s.id} className="border-t">
                  <td className="px-3 py-2">
                    <button type="button" className="font-mono text-xs font-medium text-primary hover:underline" onClick={() => setDetail(s.id)}>
                      {s.iccid}
                    </button>
                    <div className="mt-0.5">
                      <SimStatusBadge status={s.status} />
                    </div>
                  </td>
                  <td className="px-3 py-2 tabular-nums">{s.msisdn ? `+${s.msisdn}` : '—'}</td>
                  <td className="hidden px-3 py-2 md:table-cell">
                    {s.provider.name}
                    {s.plan && <span className="text-muted-foreground"> · {s.plan.name}</span>}
                  </td>
                  <td className="hidden px-3 py-2 sm:table-cell">
                    {s.device ? <span className="font-mono text-xs">{s.device.uniqueId}</span> : '—'}
                    {s.device?.companyName && <div className="text-xs text-muted-foreground">{s.device.companyName}</div>}
                  </td>
                  <td className="px-3 py-2">
                    <RenewalBadge state={s.renewalState} date={s.renewalDueAt} />
                    <div className={s.renewalState === 'OVERDUE' ? 'text-xs text-destructive-fg' : 'text-xs text-muted-foreground'}>{t(renewalText(daysLeft(s.renewalDueAt)))}</div>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Button size="sm" variant="outline" onClick={() => act('renew', s)}>
                      <CalendarClockIcon /> <span className="hidden sm:inline">{t('Renew')}</span>
                    </Button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {ui}
    </div>
  );
}

// ───────────── Providers & plans ─────────────

const KIND_OPTIONS: Option[] = SIM_PROVIDER_KINDS.map((k) => ({ value: k, label: k === 'MNO' ? 'Mobile network operator' : k === 'ESIM' ? 'eSIM' : 'M2M aggregator' }));

const providerSchema = z.object({ name: requiredText(80), kind: z.enum(SIM_PROVIDER_KINDS), phone: z.string(), email: z.string(), isActive: z.boolean() });
type ProviderValues = z.infer<typeof providerSchema>;

function ProviderForm({ record, open, onOpenChange }: MasterFormProps<SimProviderDto>) {
  const form = useForm<ProviderValues>({
    resolver: zodResolver(providerSchema),
    defaultValues: { name: str(record?.name), kind: record?.kind ?? 'MNO', phone: str(record?.supportContact.phone), email: str(record?.supportContact.email), isActive: record?.isActive ?? true },
  });
  const save = useSaveMutation({ endpoint: '/sims/providers', id: record?.id ?? null, entity: 'SIM provider', onSaved: () => onOpenChange(false) });
  const submit = form.handleSubmit((v) => {
    const supportContact: Record<string, string> = {};
    if (v.phone.trim()) supportContact.phone = v.phone.trim();
    if (v.email.trim()) supportContact.email = v.email.trim();
    save.mutate({ name: v.name, kind: v.kind, supportContact, isActive: v.isActive });
  });
  return (
    <FormDialog open={open} onOpenChange={onOpenChange} title={record ? 'Edit provider' : 'Add provider'} pending={save.isPending} error={save.error} onSubmit={submit}>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField form={form} name="name" label="Name" required />
        <SelectField form={form} name="kind" label="Kind" options={KIND_OPTIONS} />
        <TextField form={form} name="phone" label="Support phone" />
        <TextField form={form} name="email" label="Support e-mail" type="email" />
      </div>
      <SwitchField form={form} name="isActive" label="Active" />
    </FormDialog>
  );
}

const providerColumns: MasterColumn<SimProviderDto>[] = [
  { id: 'name', header: 'Name', sortable: true, hideable: false, cell: (r) => <span className="font-medium">{r.name}</span> },
  { id: 'kind', header: 'Kind', sortable: true, cell: (r) => <Badge variant="secondary">{i18n.t(KIND_OPTIONS.find((k) => k.value === r.kind)?.label ?? r.kind)}</Badge> },
  { id: 'contact', header: 'Support', cell: (r) => <Dash value={[r.supportContact.phone, r.supportContact.email].filter(Boolean).join(' · ') || null} /> },
  { id: 'simCount', header: 'SIMs', cell: (r) => <span className="tabular-nums">{r.simCount}</span> },
  { id: 'isActive', header: 'Status', cell: (r) => <ActiveBadge active={r.isActive} /> },
];

const planSchema = z.object({
  providerId: z.string().min(1, 'Required'),
  name: requiredText(80),
  dataMbPerMonth: numericText({ max: 10_000_000, integer: true }),
  smsPerMonth: numericText({ max: 1_000_000, integer: true }),
  validityDays: numericText({ min: 1, max: 3650, integer: true, required: true }),
  cost: numericText({ max: 1_000_000, required: true }),
  price: numericText({ max: 1_000_000 }),
  isActive: z.boolean(),
});
type PlanValues = z.infer<typeof planSchema>;

function PlanForm({ record, open, onOpenChange }: MasterFormProps<SimPlanDto>) {
  const providers = useEntityOptions<SimProviderDto>('/sims/providers', providerOption, { enabled: open });
  const form = useForm<PlanValues>({
    resolver: zodResolver(planSchema),
    defaultValues: {
      providerId: record?.providerId ?? '',
      name: str(record?.name),
      dataMbPerMonth: str(record?.dataMbPerMonth),
      smsPerMonth: str(record?.smsPerMonth),
      validityDays: str(record?.validityDays ?? 365),
      cost: record ? String(record.costPaise / 100) : '',
      price: record?.pricePaise != null ? String(record.pricePaise / 100) : '',
      isActive: record?.isActive ?? true,
    },
  });
  const save = useSaveMutation({ endpoint: '/sims/plans', id: record?.id ?? null, entity: 'SIM plan', onSaved: () => onOpenChange(false) });
  const toPaise = (v: string) => Math.round(Number(v) * 100);
  const submit = form.handleSubmit((v) =>
    save.mutate({
      providerId: v.providerId,
      name: v.name,
      dataMbPerMonth: v.dataMbPerMonth ? Number(v.dataMbPerMonth) : null,
      smsPerMonth: v.smsPerMonth ? Number(v.smsPerMonth) : null,
      validityDays: Number(v.validityDays),
      costPaise: toPaise(v.cost),
      pricePaise: v.price ? toPaise(v.price) : null,
      isActive: v.isActive,
    }),
  );
  return (
    <FormDialog open={open} onOpenChange={onOpenChange} title={record ? 'Edit plan' : 'Add plan'} wide pending={save.isPending} error={save.error} onSubmit={submit}>
      <div className="grid gap-4 sm:grid-cols-3">
        <SelectField form={form} name="providerId" label="Provider" required options={providers.options} />
        <TextField form={form} name="name" label="Name" required className="sm:col-span-2" placeholder="M2M 1 GB / year" />
        <TextField form={form} name="dataMbPerMonth" label="Data (MB / month)" type="number" />
        <TextField form={form} name="smsPerMonth" label="SMS / month" type="number" />
        <TextField form={form} name="validityDays" label="Validity (days)" type="number" required />
        <TextField form={form} name="cost" label="Cost to VeeTrax (₹)" required hint="Per validity period. Never shown to customers." />
        <TextField form={form} name="price" label="Customer price (₹)" hint="Leave empty while SIM billing is undecided (QI-3)." />
      </div>
      <SwitchField form={form} name="isActive" label="Active" />
    </FormDialog>
  );
}

const planColumns: MasterColumn<SimPlanDto>[] = [
  { id: 'name', header: 'Name', sortable: true, hideable: false, cell: (r) => <span className="font-medium">{r.name}</span> },
  { id: 'providerName', header: 'Provider', sortable: true, cell: (r) => r.providerName },
  { id: 'data', header: 'Data / SMS', cell: (r) => <Dash value={[r.dataMbPerMonth != null ? `${r.dataMbPerMonth} MB` : null, r.smsPerMonth != null ? `${r.smsPerMonth} SMS` : null].filter(Boolean).join(' · ') || null} /> },
  { id: 'validityDays', header: 'Validity', sortable: true, cell: (r) => `${r.validityDays} ${i18n.t('days')}` },
  { id: 'costPaise', header: 'Cost', sortable: true, cell: (r) => <span className="tabular-nums">{formatRupees(r.costPaise)}</span> },
  { id: 'pricePaise', header: 'Customer price', cell: (r) => (r.pricePaise == null ? <Muted>{i18n.t('Not billed')}</Muted> : <span className="tabular-nums">{formatRupees(r.pricePaise)}</span>) },
  { id: 'isActive', header: 'Status', cell: (r) => <ActiveBadge active={r.isActive} /> },
];

const EVENT_KIND_LABEL: Record<SimEventDto['kind'], string> = {
  REGISTER: 'Registered',
  STATUS: 'Status change',
  ASSIGN: 'Fitted',
  UNASSIGN: 'Taken out',
  RENEW: 'Renewed',
  EDIT: 'Edited',
  USAGE: 'Usage entry',
};

const eventColumns: MasterColumn<SimEventDto>[] = [
  { id: 'at', header: 'When', sortable: true, hideable: false, cell: (r) => <DateCell value={r.at} /> },
  { id: 'iccidRef', header: 'ICCID', cell: (r) => <span className="font-mono text-xs">{r.iccidRef}</span> },
  { id: 'kind', header: 'Event', sortable: true, cell: (r) => i18n.t(EVENT_KIND_LABEL[r.kind]) },
  {
    id: 'status',
    header: 'Status',
    cell: (r) => (r.toStatus ? <span className="inline-flex items-center gap-1">{r.fromStatus && r.fromStatus !== r.toStatus && <><SimStatusBadge status={r.fromStatus} />→</>}<SimStatusBadge status={r.toStatus} /></span> : <Muted>—</Muted>),
  },
  { id: 'deviceRef', header: 'Device', cell: (r) => <Dash value={r.deviceRef} /> },
  { id: 'reason', header: 'Reason / note', cell: (r) => <Dash value={[r.reason, r.note].filter(Boolean).join(' · ') || null} /> },
  { id: 'createdByName', header: 'By', cell: (r) => <Dash value={r.createdByName} /> },
];

const TABS = [
  { value: 'sims', label: 'SIM cards', icon: CardSimIcon },
  { value: 'renewals', label: 'Renewals', icon: BellRingIcon },
  { value: 'providers', label: 'Providers', icon: NetworkIcon },
  { value: 'plans', label: 'Plans', icon: LayersIcon },
  { value: 'history', label: 'History', icon: HistoryIcon },
] as const;
const TAB_KEY = 'veetrax.sims.tab';

/** Platform → SIM Cards (Super Admin). */
export function SimCardsPage() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<string>(() => {
    const v = new URLSearchParams(window.location.search).get('tab') ?? storage.getJson<string>(TAB_KEY, 'sims');
    return TABS.some((x) => x.value === v) ? v : 'sims';
  });
  const summary = useQuery({ queryKey: ['sims', 'summary'], queryFn: () => api.get<SimSummaryDto>('/sims/summary') });
  return (
    <Tabs
      value={tab}
      onValueChange={(v) => {
        setTab(v);
        storage.setJson(TAB_KEY, v);
      }}
      className="flex h-full min-h-0 flex-col"
    >
      <div className="overflow-x-auto px-4 pt-4 sm:px-6">
        <TabsList>
          {TABS.map(({ value, label, icon: Icon }) => (
            <TabsTrigger key={value} value={value}>
              <Icon className="size-4" />
              {t(label)}
              {value === 'renewals' && summary.data && summary.data.renewalsOverdue + summary.data.renewalsDue > 0 && (
                <Badge variant={summary.data.renewalsOverdue ? 'destructive' : 'warning'} className="ml-1">
                  {summary.data.renewalsOverdue + summary.data.renewalsDue}
                </Badge>
              )}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>
      <TabsContent value="sims" className="min-h-0 flex-1">
        <SimsTab summary={summary.data} />
      </TabsContent>
      <TabsContent value="renewals" className="min-h-0 flex-1 overflow-y-auto">
        <RenewalsTab />
      </TabsContent>
      <TabsContent value="providers" className="min-h-0 flex-1">
        <MasterPage menu="sa_sim_cards" title="SIM providers" description="Network operators and M2M aggregators." endpoint="/sims/providers" columns={providerColumns} rowLabel={(r) => r.name} Form={ProviderForm} history={false} bulkActions={false} defaultSort={{ id: 'name', desc: false }} emptyIcon={NetworkIcon} />
      </TabsContent>
      <TabsContent value="plans" className="min-h-0 flex-1">
        <MasterPage menu="sa_sim_cards" title="SIM plans" description="Data plans with validity, cost to VeeTrax and the optional customer price." endpoint="/sims/plans" columns={planColumns} rowLabel={(r) => `${r.providerName} · ${r.name}`} Form={PlanForm} history={false} bulkActions={false} defaultSort={{ id: 'name', desc: false }} emptyIcon={LayersIcon} />
      </TabsContent>
      <TabsContent value="history" className="min-h-0 flex-1">
        <MasterPage menu="sa_sim_cards" title="SIM history" description="Append-only log of every SIM change." endpoint="/sims/events" columns={eventColumns} rowLabel={(r) => r.iccidRef} statusFilter={false} readOnly bulkActions={false} defaultSort={{ id: 'at', desc: true }} emptyIcon={HistoryIcon} />
      </TabsContent>
    </Tabs>
  );
}

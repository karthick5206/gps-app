import { zodResolver } from '@hookform/resolvers/zod';
import { RETENTION_OPTIONS, type CompanyDto, type CompanyFeature } from '@veetracer/shared';
import { Building2Icon, LogInIcon } from 'lucide-react';
import { useCallback, useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { usePurgeAction } from '@/features/platform/PurgeDialog';
import { useNavigate } from 'react-router';
import { z } from 'zod';
import { Badge } from '@/components/ui/badge';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import type { Option } from '@/components/ui/multi-select';
import { useAuth } from '@/features/auth/auth-context';
import { passwordRule } from '@/features/auth/password-rules';
import { timezoneOptions } from '@/features/admin/timezones';
import { DateCell } from '@/features/masters/cells';
import { humanize } from '@/lib/format';
import { i18n } from '@/lib/i18n';
import { FormDialog, useSaveMutation } from '@/features/masters/FormDialog';
import { ComboboxField, SelectField, SwitchField, TextField } from '@/features/masters/form-fields';
import { nullIfBlank, requiredText, str } from '@/features/masters/form-schema';
import { MasterPage } from '@/features/masters/MasterPage';
import type { MasterColumn, MasterFormProps } from '@/features/masters/types';

const ENDPOINT = '/admin/companies';
const ACCOUNT_TYPES: Option[] = [
  { value: 'BUSINESS', label: 'Business' },
  { value: 'INDIVIDUAL', label: 'Individual' },
  { value: 'FAMILY', label: 'Family' },
];
const STATUS_OPTIONS: Option[] = [
  { value: 'ACTIVE', label: 'Active' },
  { value: 'SUSPENDED', label: 'Suspended' },
];

const email = z.string().trim().refine((v) => v === '' || z.string().email().safeParse(v).success, 'Enter a valid email');
const mobile = z.string().trim().refine((v) => v === '' || /^\+[1-9]\d{7,14}$/.test(v), 'Use international format, e.g. +919876543210');

/** The first-admin block is only validated on create; editing never touches it. */
function schemaFor(isCreate: boolean) {
  return z
    .object({
      name: requiredText(120),
      accountType: z.enum(['BUSINESS', 'INDIVIDUAL', 'FAMILY']),
      timezone: z.string({ invalid_type_error: 'Required' }).min(1, 'Required'),
      status: z.enum(['ACTIVE', 'SUSPENDED']),
      retentionDays: z.string().min(1, 'Required'),
      insightsPlus: z.boolean(),
      etms: z.boolean(),
      etmsProvider: z.boolean(),
      admin: z.object({ name: z.string().trim().max(100), email, mobile, password: z.string() }),
    })
    .superRefine((v, ctx) => {
      if (!isCreate) return;
      if (!v.admin.name) ctx.addIssue({ code: 'custom', path: ['admin', 'name'], message: 'Required' });
      if (!v.admin.email && !v.admin.mobile) ctx.addIssue({ code: 'custom', path: ['admin', 'email'], message: 'Email or mobile is required' });
      const pw = passwordRule.safeParse(v.admin.password);
      if (!pw.success) ctx.addIssue({ code: 'custom', path: ['admin', 'password'], message: pw.error.issues[0]?.message ?? 'Invalid password' });
    });
}
type Values = z.infer<ReturnType<typeof schemaFor>>;

/** Add-on switches → COMPANY_FEATURES. Every add-on needs a switch here: the PATCH replaces the whole list. */
function featureList(v: Pick<Values, 'insightsPlus' | 'etms' | 'etmsProvider'>): CompanyFeature[] {
  const out: CompanyFeature[] = [];
  if (v.insightsPlus) out.push('attendanceInsightsPlus');
  if (v.etms) out.push('etms');
  // Transport provider (ETMS E1b) needs Employee transport itself.
  if (v.etms && v.etmsProvider) out.push('etmsProvider');
  return out;
}

function CompanyForm({ record, open, onOpenChange }: MasterFormProps<CompanyDto>) {
  const { t } = useTranslation();
  const tzOptions = useMemo(timezoneOptions, []);
  const retentionSelect = useMemo(() => RETENTION_OPTIONS.map((d) => ({ value: String(d), label: t('{{n}} days', { n: d }) })), [t]);
  const schema = useMemo(() => schemaFor(!record), [record]);
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: str(record?.name),
      accountType: record?.accountType ?? 'BUSINESS',
      timezone: record?.timezone ?? 'Asia/Kolkata',
      status: record?.status ?? 'ACTIVE',
      retentionDays: String(record?.retentionDays ?? 90),
      insightsPlus: record?.features.includes('attendanceInsightsPlus') ?? false,
      etms: record?.features.includes('etms') ?? false,
      etmsProvider: record?.features.includes('etmsProvider') ?? false,
      admin: { name: '', email: '', mobile: '', password: '' },
    },
  });
  const save = useSaveMutation({ endpoint: ENDPOINT, id: record?.id ?? null, entity: 'Company', onSaved: () => onOpenChange(false) });
  const submit = form.handleSubmit((v) =>
    save.mutate(
      record
        ? { name: v.name, accountType: v.accountType, timezone: v.timezone, status: v.status, retentionDays: Number(v.retentionDays), features: featureList(v) }
        : {
            name: v.name,
            accountType: v.accountType,
            timezone: v.timezone,
            retentionDays: Number(v.retentionDays),
            features: featureList(v),
            admin: { name: v.admin.name, email: nullIfBlank(v.admin.email), mobile: nullIfBlank(v.admin.mobile), password: v.admin.password },
          },
    ),
  );

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={record ? 'Edit company' : 'Add company'}
      description={record ? undefined : 'Creates the company with system roles, a "Head Office" branch and its first Admin user.'}
      wide={!record}
      pending={save.isPending}
      error={save.error}
      onSubmit={submit}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField form={form} name="name" label="Company name" required className="sm:col-span-2" />
        <SelectField form={form} name="accountType" label="Account type" required options={ACCOUNT_TYPES} />
        <ComboboxField form={form} name="timezone" label="Time zone" required options={tzOptions} />
        <SelectField form={form} name="retentionDays" label="History kept" required options={retentionSelect} hint="Positions, trips, stops and alerts older than this are deleted automatically. Daily summaries are kept." />
        {/* Add-ons (Company.settings.features): the basic Employee insights are always on. */}
        <SwitchField form={form} name="etms" label="Employee transport" hint="Adds the Employee transport menus (agreements, transport settings). Switching it on also creates the Transport admin, dispatcher, passenger and driver roles once. Switching it off hides the menus; data is kept." className="sm:col-span-2" />
        <SwitchField form={form} name="etmsProvider" label="Transport provider" hint="The company may run transport for other companies under service agreements (customer picker, fleet allocations). Needs Employee transport." className="sm:col-span-2" />
        <SwitchField form={form} name="insightsPlus" label="Advanced attendance insights" hint="Adds comparisons with the previous period and the team, pattern charts, the 12-month trend, periods up to 6 months and PNG / PDF download to Staff attendance → Employee." className="sm:col-span-2" />
        {record && <SelectField form={form} name="status" label="Status" required options={STATUS_OPTIONS} hint="Suspended companies can't sign in and their data is not processed." />}
      </div>
      {!record && (
        <fieldset className="space-y-4 rounded-lg border p-4">
          <legend className="px-1 text-sm font-semibold">{t('First admin user')}</legend>
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField form={form} name="admin.name" label="Full name" required className="sm:col-span-2" />
            <TextField form={form} name="admin.email" label="Email" type="email" autoComplete="off" />
            <TextField form={form} name="admin.mobile" label="Mobile" type="tel" placeholder="+919876543210" />
            <TextField form={form} name="admin.password" label="Password" type="password" required autoComplete="new-password" hint="At least 8 characters with a letter and a digit." />
          </div>
        </fieldset>
      )}
    </FormDialog>
  );
}

const columns: MasterColumn<CompanyDto>[] = [
  { id: 'name', header: 'Name', sortable: true, hideable: false, cell: (r) => <span className="font-medium">{r.name}</span> },
  { id: 'accountType', header: 'Type', sortable: true, cell: (r) => i18n.t(humanize(r.accountType)) },
  { id: 'status', header: 'Status', sortable: true, cell: (r) => <Badge variant={r.status === 'ACTIVE' ? 'success' : 'destructive'}>{i18n.t(humanize(r.status))}</Badge> },
  { id: 'timezone', header: 'Time zone', defaultHidden: true, cell: (r) => r.timezone },
  {
    id: 'features',
    header: 'Add-ons',
    cell: (r) =>
      r.features.length ? (
        <span className="inline-flex flex-wrap gap-1">
          {r.features.includes('etms') && <Badge variant="secondary">{i18n.t('Employee transport')}</Badge>}
          {r.features.includes('etmsProvider') && <Badge variant="secondary">{i18n.t('Transport provider')}</Badge>}
          {r.features.includes('attendanceInsightsPlus') && <Badge variant="secondary">{i18n.t('Advanced insights')}</Badge>}
        </span>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
  },
  { id: 'retentionDays', header: 'History kept', cell: (r) => i18n.t('{{n}} days', { n: r.retentionDays }) },
  { id: 'branchCount', header: 'Branches', cell: (r) => <span className="tabular-nums">{r.branchCount}</span> },
  { id: 'userCount', header: 'Users', cell: (r) => <span className="tabular-nums">{r.userCount}</span> },
  { id: 'objectCount', header: 'Objects', sortable: true, cell: (r) => <span className="tabular-nums">{r.objectCount}</span> },
  { id: 'deviceCount', header: 'Devices', cell: (r) => <span className="tabular-nums">{r.deviceCount}</span> },
  { id: 'createdAt', header: 'Created', sortable: true, cell: (r) => <DateCell value={r.createdAt} /> },
];

const rowLabel = (r: CompanyDto) => r.name;

export function CompaniesPage() {
  const { t } = useTranslation();
  const { switchCompany } = useAuth();
  const navigate = useNavigate();
  const purge = usePurgeAction('company');
  const rowActions = useCallback(
    (r: CompanyDto) => (
      <DropdownMenuItem
        onSelect={() => {
          switchCompany(r.id);
          navigate('/');
        }}
      >
        <LogInIcon /> {t('Act as this company')}
      </DropdownMenuItem>
    ),
    [switchCompany, navigate, t],
  );
  return (
    <>
    <MasterPage
      menu="sa_companies"
      title="Companies"
      description="Customer accounts on the platform. Use “Act as this company” to work inside one."
      endpoint={ENDPOINT}
      columns={columns}
      rowLabel={rowLabel}
      defaultSort={{ id: 'name', desc: false }}
      Form={CompanyForm}
      rowActions={(r) => (
        <>
          {rowActions(r)}
          {purge.item(r.id)}
        </>
      )}
      emptyIcon={Building2Icon}
    />
    {purge.dialog}
    </>
  );
}

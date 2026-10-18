import { zodResolver } from '@hookform/resolvers/zod';
import type { CompanyDto } from '@veetracer/shared';
import { Building2Icon, LogInIcon } from 'lucide-react';
import { useCallback, useMemo } from 'react';
import { useForm } from 'react-hook-form';
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
import { FormDialog, useSaveMutation } from '@/features/masters/FormDialog';
import { ComboboxField, SelectField, TextField } from '@/features/masters/form-fields';
import { nullIfBlank, requiredText, str } from '@/features/masters/form-schema';
import { MasterPage } from '@/features/masters/MasterPage';
import type { MasterColumn, MasterFormProps } from '@/features/masters/types';

const ENDPOINT = '/admin/companies';
const ACCOUNT_TYPES: Option[] = [
  { value: 'BUSINESS', label: 'Business' },
  { value: 'INDIVIDUAL', label: 'Individual' },
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
      accountType: z.enum(['BUSINESS', 'INDIVIDUAL']),
      timezone: z.string({ invalid_type_error: 'Required' }).min(1, 'Required'),
      status: z.enum(['ACTIVE', 'SUSPENDED']),
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

function CompanyForm({ record, open, onOpenChange }: MasterFormProps<CompanyDto>) {
  const tzOptions = useMemo(timezoneOptions, []);
  const schema = useMemo(() => schemaFor(!record), [record]);
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: str(record?.name),
      accountType: record?.accountType ?? 'BUSINESS',
      timezone: record?.timezone ?? 'Asia/Kolkata',
      status: record?.status ?? 'ACTIVE',
      admin: { name: '', email: '', mobile: '', password: '' },
    },
  });
  const save = useSaveMutation({ endpoint: ENDPOINT, id: record?.id ?? null, entity: 'Company', onSaved: () => onOpenChange(false) });
  const submit = form.handleSubmit((v) =>
    save.mutate(
      record
        ? { name: v.name, accountType: v.accountType, timezone: v.timezone, status: v.status }
        : {
            name: v.name,
            accountType: v.accountType,
            timezone: v.timezone,
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
        {record && <SelectField form={form} name="status" label="Status" required options={STATUS_OPTIONS} hint="Suspended companies can't sign in and their data is not processed." />}
      </div>
      {!record && (
        <fieldset className="space-y-4 rounded-lg border p-4">
          <legend className="px-1 text-sm font-semibold">First admin user</legend>
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
  { id: 'accountType', header: 'Type', sortable: true, cell: (r) => humanize(r.accountType) },
  { id: 'status', header: 'Status', sortable: true, cell: (r) => <Badge variant={r.status === 'ACTIVE' ? 'success' : 'destructive'}>{humanize(r.status)}</Badge> },
  { id: 'timezone', header: 'Time zone', defaultHidden: true, cell: (r) => r.timezone },
  { id: 'branchCount', header: 'Branches', cell: (r) => <span className="tabular-nums">{r.branchCount}</span> },
  { id: 'userCount', header: 'Users', cell: (r) => <span className="tabular-nums">{r.userCount}</span> },
  { id: 'objectCount', header: 'Objects', sortable: true, cell: (r) => <span className="tabular-nums">{r.objectCount}</span> },
  { id: 'deviceCount', header: 'Devices', cell: (r) => <span className="tabular-nums">{r.deviceCount}</span> },
  { id: 'createdAt', header: 'Created', sortable: true, cell: (r) => <DateCell value={r.createdAt} /> },
];

const rowLabel = (r: CompanyDto) => r.name;

export function CompaniesPage() {
  const { switchCompany } = useAuth();
  const navigate = useNavigate();
  const rowActions = useCallback(
    (r: CompanyDto) => (
      <DropdownMenuItem
        onSelect={() => {
          switchCompany(r.id);
          navigate('/');
        }}
      >
        <LogInIcon /> Act as this company
      </DropdownMenuItem>
    ),
    [switchCompany, navigate],
  );
  return (
    <MasterPage
      menu="sa_companies"
      title="Companies"
      description="Customer accounts on the platform. Use “Act as this company” to work inside one."
      endpoint={ENDPOINT}
      columns={columns}
      rowLabel={rowLabel}
      defaultSort={{ id: 'name', desc: false }}
      Form={CompanyForm}
      rowActions={rowActions}
      emptyIcon={Building2Icon}
    />
  );
}

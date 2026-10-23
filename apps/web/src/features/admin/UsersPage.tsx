import { zodResolver } from '@hookform/resolvers/zod';
import type { BranchDto, RoleDto, TrackedObjectDto, UserDto } from '@veetracer/shared';
import { UsersIcon } from 'lucide-react';
import { usePurgeAction } from '@/features/platform/PurgeDialog';
import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import type { Option } from '@/components/ui/multi-select';
import { useAuth } from '@/features/auth/auth-context';
import { passwordRule } from '@/features/auth/password-rules';
import { ActiveBadge, Dash, DateCell, NameList } from '@/features/masters/cells';
import { FormDialog, useSaveMutation } from '@/features/masters/FormDialog';
import { ComboboxField, MultiSelectField, SwitchField, TextField } from '@/features/masters/form-fields';
import { nullIfBlank, requiredText, str } from '@/features/masters/form-schema';
import { MasterPage } from '@/features/masters/MasterPage';
import type { MasterColumn, MasterFilter, MasterFormProps } from '@/features/masters/types';
import { named, useEntityOptions } from '@/features/masters/use-options';
import { i18n } from '@/lib/i18n';

const ENDPOINT = '/users';

const objectOption = (o: TrackedObjectDto): Option => ({ value: o.id, label: o.name, description: o.plateNumber ?? undefined });
const roleOption = (r: RoleDto): Option => ({ value: r.id, label: r.name, description: r.dataScope === 'COMPANY' ? i18n.t('Whole company') : i18n.t('Assigned only') });
/** Roles have no active/inactive status, so don't send the default status filter. */
const ROLE_PARAMS = { status: undefined };

function schemaFor(isCreate: boolean) {
  return z
    .object({
      name: requiredText(100),
      email: z.string().trim().max(150).refine((v) => v === '' || z.string().email().safeParse(v).success, 'Enter a valid email'),
      mobile: z.string().trim().refine((v) => v === '' || /^\+[1-9]\d{7,14}$/.test(v), 'Use international format, e.g. +919876543210'),
      password: z.string().refine((v) => v === '' || passwordRule.safeParse(v).success, 'At least 8 characters with a letter and a digit'),
      managerId: z.string().nullable(),
      roleIds: z.array(z.string()).min(1, 'Assign at least one role'),
      branchIds: z.array(z.string()),
      objectIds: z.array(z.string()),
      isActive: z.boolean(),
    })
    .refine((v) => v.email !== '' || v.mobile !== '', { path: ['email'], message: 'Email or mobile is required' })
    .refine((v) => !isCreate || v.email === '' || v.password !== '', { path: ['password'], message: 'Set a password for email sign-in' });
}
type Values = z.infer<ReturnType<typeof schemaFor>>;

function UserForm({ record, open, onOpenChange }: MasterFormProps<UserDto>) {
  const { can } = useAuth();
  const schema = useMemo(() => schemaFor(!record), [record]);
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: str(record?.name),
      email: str(record?.email),
      mobile: str(record?.mobile),
      password: '',
      managerId: record?.managerId ?? null,
      roleIds: record?.roles.map((r) => r.id) ?? [],
      branchIds: record?.branches.map((b) => b.id) ?? [],
      objectIds: record?.objects.map((o) => o.id) ?? [],
      isActive: record?.isActive ?? true,
    },
  });
  // Tried even without the roles menu (e.g. Managers creating users); a 403 just leaves the list empty.
  const roles = useEntityOptions<RoleDto>('/roles', roleOption, { enabled: open, params: ROLE_PARAMS });
  const branches = useEntityOptions<BranchDto>('/branches', named, { enabled: open && can('branches') });
  const [managerQ, setManagerQ] = useState('');
  const managers = useEntityOptions<UserDto>('/users', named, { q: managerQ, enabled: open });
  const [objectQ, setObjectQ] = useState('');
  const objects = useEntityOptions<TrackedObjectDto>('/objects', objectOption, { q: objectQ, enabled: open && can('objects') });
  const managerOptions = useMemo(() => managers.options.filter((o) => o.value !== record?.id), [managers.options, record?.id]);

  const save = useSaveMutation({ endpoint: ENDPOINT, id: record?.id ?? null, entity: 'User', onSaved: () => onOpenChange(false) });
  const submit = form.handleSubmit((v) =>
    save.mutate({
      name: v.name,
      email: nullIfBlank(v.email),
      mobile: nullIfBlank(v.mobile),
      ...(v.password ? { password: v.password } : {}),
      managerId: v.managerId,
      roleIds: v.roleIds,
      branchIds: v.branchIds,
      objectIds: v.objectIds,
      isActive: v.isActive,
    }),
  );

  return (
    <FormDialog open={open} onOpenChange={onOpenChange} title={record ? 'Edit user' : 'Add user'} wide pending={save.isPending} error={save.error} onSubmit={submit}>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField form={form} name="name" label="Full name" required className="sm:col-span-2" />
        <TextField form={form} name="email" label="Email" type="email" autoComplete="off" />
        <TextField form={form} name="mobile" label="Mobile" type="tel" placeholder="+919876543210" hint="Used for OTP sign-in." />
        <TextField
          form={form}
          name="password"
          label={record ? 'New password' : 'Password'}
          type="password"
          autoComplete="new-password"
          hint={record ? 'Leave empty to keep the current password.' : 'Optional for mobile-only users.'}
        />
        <ComboboxField
          form={form}
          name="managerId"
          label="Manager"
          options={managerOptions}
          loading={managers.loading}
          onSearch={setManagerQ}
          selectedOption={record?.managerId ? { value: record.managerId, label: record.managerName ?? '—' } : null}
          placeholder="No manager"
        />
        <MultiSelectField
          form={form}
          name="roleIds"
          label="Roles"
          required
          className="sm:col-span-2"
          options={roles.options}
          loading={roles.loading}
          selectedOptions={record?.roles.map(named)}
          hint="Users with only ASSIGNED-scope roles see objects in their branches plus their mapped objects."
        />
        <MultiSelectField
          form={form}
          name="branchIds"
          label="Branches"
          options={branches.options}
          loading={branches.loading}
          selectedOptions={record?.branches.map(named)}
          placeholder="No branches"
        />
        <MultiSelectField
          form={form}
          name="objectIds"
          label="Mapped objects"
          options={objects.options}
          loading={objects.loading}
          onSearch={setObjectQ}
          selectedOptions={record?.objects.map(named)}
          placeholder="No individual objects"
        />
      </div>
      <SwitchField form={form} name="isActive" label="Active" hint="Inactive users can't sign in." />
    </FormDialog>
  );
}

const columns: MasterColumn<UserDto>[] = [
  { id: 'name', header: 'Name', sortable: true, hideable: false, cell: (r) => <span className="font-medium">{r.name}</span> },
  { id: 'email', header: 'Email', sortable: true, cell: (r) => <Dash value={r.email} /> },
  { id: 'mobile', header: 'Mobile', cell: (r) => <Dash value={r.mobile} /> },
  { id: 'roles', header: 'Roles', cell: (r) => <NameList items={r.roles} /> },
  { id: 'branches', header: 'Branches', cell: (r) => <NameList items={r.branches} /> },
  { id: 'objects', header: 'Mapped objects', defaultHidden: true, cell: (r) => <NameList items={r.objects} /> },
  { id: 'managerName', header: 'Manager', defaultHidden: true, cell: (r) => <Dash value={r.managerName} /> },
  { id: 'lastLoginAt', header: 'Last sign-in', sortable: true, cell: (r) => <DateCell value={r.lastLoginAt} relative /> },
  { id: 'isActive', header: 'Status', cell: (r) => <ActiveBadge active={r.isActive} /> },
  { id: 'createdAt', header: 'Created', sortable: true, defaultHidden: true, cell: (r) => <DateCell value={r.createdAt} /> },
];

const rowLabel = (r: UserDto) => r.name;

export function UsersPage() {
  const { can } = useAuth();
  const purge = usePurgeAction('user');
  const roles = useEntityOptions<RoleDto>('/roles', roleOption, { enabled: can('roles'), params: ROLE_PARAMS });
  const branches = useEntityOptions<BranchDto>('/branches', named, { enabled: can('branches') });
  const filters = useMemo<MasterFilter[]>(
    () => [
      ...(can('roles') ? [{ key: 'roleId', label: 'Roles', options: roles.options }] : []),
      ...(can('branches') ? [{ key: 'branchId', label: 'Branches', options: branches.options }] : []),
    ],
    [can, roles.options, branches.options],
  );
  return (
    <>
    <MasterPage
      menu="users"
      title="Users"
      description="People who can sign in, their roles and what they can see."
      endpoint={ENDPOINT}
      columns={columns}
      rowLabel={rowLabel}
      filters={filters}
      defaultSort={{ id: 'name', desc: false }}
      Form={UserForm}
      emptyIcon={UsersIcon}
      rowActions={(r) => purge.item(r.id)}
    />
    {purge.dialog}
    </>
  );
}

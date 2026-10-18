import { zodResolver } from '@hookform/resolvers/zod';
import type { DataScope, MenuKey, PermissionMap, RoleDto } from '@veetracer/shared';
import { LockIcon, ShieldCheckIcon } from 'lucide-react';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';
import type { Option } from '@/components/ui/multi-select';
import { Badge } from '@/components/ui/badge';
import { Field } from '@/components/ui/field';
import { DateCell } from '@/features/masters/cells';
import { FormDialog, useSaveMutation } from '@/features/masters/FormDialog';
import { SelectField, TextField } from '@/features/masters/form-fields';
import { nullIfBlank, optionalText, requiredText, str } from '@/features/masters/form-schema';
import { MasterPage } from '@/features/masters/MasterPage';
import type { MasterColumn, MasterFormProps } from '@/features/masters/types';
import { PermissionMatrix } from './PermissionMatrix';

const ENDPOINT = '/roles';

const SCOPE_OPTIONS: Option[] = [
  { value: 'COMPANY', label: 'Whole company' },
  { value: 'ASSIGNED', label: 'Assigned branches & objects only' },
];

const schema = z.object({
  name: requiredText(60),
  description: optionalText(200),
  dataScope: z.enum(['COMPANY', 'ASSIGNED']),
  permissions: z.record(z.string(), z.array(z.string())).refine((p) => Object.keys(p).length > 0, 'Grant at least one permission'),
});
type Values = z.infer<typeof schema>;

function toMap(role: RoleDto | null): PermissionMap {
  return Object.fromEntries((role?.permissions ?? []).map((p) => [p.menu, p.actions])) as PermissionMap;
}

function RoleForm({ record, open, onOpenChange }: MasterFormProps<RoleDto>) {
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { name: str(record?.name), description: str(record?.description), dataScope: record?.dataScope ?? 'ASSIGNED', permissions: toMap(record) },
  });
  const save = useSaveMutation({ endpoint: ENDPOINT, id: record?.id ?? null, entity: 'Role', onSaved: () => onOpenChange(false) });
  const submit = form.handleSubmit((v) =>
    save.mutate({
      name: v.name,
      description: nullIfBlank(v.description),
      dataScope: v.dataScope as DataScope,
      permissions: Object.entries(v.permissions).map(([menu, actions]) => ({ menu: menu as MenuKey, actions })),
    }),
  );
  const permMessage = form.formState.errors.permissions?.message;
  const permError = typeof permMessage === 'string' ? permMessage : undefined;

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={record ? `Edit role${record.isSystem ? ' (system)' : ''}` : 'Add role'}
      description={record?.isSystem ? 'System roles can be edited but not deleted.' : undefined}
      wide
      pending={save.isPending}
      error={save.error}
      onSubmit={submit}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField form={form} name="name" label="Name" required />
        <SelectField form={form} name="dataScope" label="Data scope" required options={SCOPE_OPTIONS} />
        <TextField form={form} name="description" label="Description" className="sm:col-span-2" />
      </div>
      <Field label="Permissions" error={permError}>
        <Controller
          control={form.control}
          name="permissions"
          render={({ field }) => <PermissionMatrix value={field.value as PermissionMap} onChange={field.onChange} />}
        />
      </Field>
    </FormDialog>
  );
}

const columns: MasterColumn<RoleDto>[] = [
  {
    id: 'name',
    header: 'Name',
    sortable: true,
    hideable: false,
    cell: (r) => (
      <span className="inline-flex items-center gap-1.5 font-medium">
        {r.name}
        {r.isSystem && <LockIcon className="size-3 text-muted-foreground" aria-label="System role" />}
      </span>
    ),
  },
  { id: 'description', header: 'Description', cell: (r) => <span className="block max-w-sm truncate">{r.description ?? '—'}</span> },
  {
    id: 'dataScope',
    header: 'Data scope',
    sortable: true,
    cell: (r) => <Badge variant={r.dataScope === 'COMPANY' ? 'default' : 'secondary'}>{r.dataScope === 'COMPANY' ? 'Whole company' : 'Assigned'}</Badge>,
  },
  { id: 'permissions', header: 'Menus', cell: (r) => <span className="tabular-nums">{r.permissions.length}</span> },
  { id: 'userCount', header: 'Users', sortable: true, cell: (r) => <span className="tabular-nums">{r.userCount}</span> },
  { id: 'isSystem', header: 'Type', cell: (r) => <Badge variant={r.isSystem ? 'muted' : 'outline'}>{r.isSystem ? 'System' : 'Custom'}</Badge> },
  { id: 'updatedAt', header: 'Updated', sortable: true, defaultHidden: true, cell: (r) => <DateCell value={r.updatedAt} relative /> },
];

const rowLabel = (r: RoleDto) => r.name;
const canDelete = (r: RoleDto) => !r.isSystem;

export function RolesPage() {
  return (
    <MasterPage
      menu="roles"
      title="Roles & Permissions"
      description="What each role can see and do. Data scope limits users to their branches and mapped objects."
      endpoint={ENDPOINT}
      columns={columns}
      rowLabel={rowLabel}
      statusFilter={false}
      defaultSort={{ id: 'name', desc: false }}
      Form={RoleForm}
      canDeleteRow={canDelete}
      emptyIcon={ShieldCheckIcon}
    />
  );
}

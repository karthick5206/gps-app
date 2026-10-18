import { zodResolver } from '@hookform/resolvers/zod';
import type { BranchDto } from '@veetracer/shared';
import { WarehouseIcon } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { ActiveBadge, DateCell, Dash } from '../cells';
import { FormDialog, useSaveMutation } from '../FormDialog';
import { SwitchField, TextField } from '../form-fields';
import { nullIfBlank, optionalText, requiredText, str } from '../form-schema';
import { MasterPage } from '../MasterPage';
import type { MasterColumn, MasterFormProps } from '../types';

const ENDPOINT = '/branches';

const schema = z.object({
  name: requiredText(100),
  code: optionalText(20),
  address: optionalText(300),
  isActive: z.boolean(),
});
type Values = z.infer<typeof schema>;

function BranchForm({ record, open, onOpenChange }: MasterFormProps<BranchDto>) {
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { name: str(record?.name), code: str(record?.code), address: str(record?.address), isActive: record?.isActive ?? true },
  });
  const save = useSaveMutation({ endpoint: ENDPOINT, id: record?.id ?? null, entity: 'Branch', onSaved: () => onOpenChange(false) });
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={record ? 'Edit branch' : 'Add branch'}
      pending={save.isPending}
      error={save.error}
      onSubmit={form.handleSubmit((v) => save.mutate({ name: v.name, code: nullIfBlank(v.code), address: nullIfBlank(v.address), isActive: v.isActive }))}
    >
      <div className="grid gap-4 sm:grid-cols-[2fr_1fr]">
        <TextField form={form} name="name" label="Name" required />
        <TextField form={form} name="code" label="Code" placeholder="e.g. CHN" />
      </div>
      <TextField form={form} name="address" label="Address" multiline />
      <SwitchField form={form} name="isActive" label="Active" hint="Inactive branches can't be assigned to new objects." />
    </FormDialog>
  );
}

const columns: MasterColumn<BranchDto>[] = [
  { id: 'name', header: 'Name', sortable: true, hideable: false, cell: (r) => <span className="font-medium">{r.name}</span> },
  { id: 'code', header: 'Code', sortable: true, cell: (r) => <Dash value={r.code} /> },
  { id: 'address', header: 'Address', cell: (r) => <span className="block max-w-xs truncate">{r.address ?? '—'}</span> },
  { id: 'objectCount', header: 'Objects', sortable: true, cell: (r) => <span className="tabular-nums">{r.objectCount}</span> },
  { id: 'isActive', header: 'Status', cell: (r) => <ActiveBadge active={r.isActive} /> },
  { id: 'createdAt', header: 'Created', sortable: true, defaultHidden: true, cell: (r) => <DateCell value={r.createdAt} /> },
  { id: 'updatedAt', header: 'Updated', sortable: true, defaultHidden: true, cell: (r) => <DateCell value={r.updatedAt} relative /> },
];

const rowLabel = (r: BranchDto) => r.name;

export function BranchesPage() {
  return (
    <MasterPage
      menu="branches"
      title="Branches"
      description="Offices and depots that objects and users belong to."
      endpoint={ENDPOINT}
      columns={columns}
      rowLabel={rowLabel}
      defaultSort={{ id: 'name', desc: false }}
      Form={BranchForm}
      emptyIcon={WarehouseIcon}
    />
  );
}

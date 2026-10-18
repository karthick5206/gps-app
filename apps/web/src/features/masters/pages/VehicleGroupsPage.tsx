import { zodResolver } from '@hookform/resolvers/zod';
import type { TrackedObjectDto, VehicleGroupDto } from '@veetracer/shared';
import { LayersIcon } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { ActiveBadge, DateCell, NameList } from '../cells';
import { FormDialog, useSaveMutation } from '../FormDialog';
import { MultiSelectField, TextField } from '../form-fields';
import { nullIfBlank, optionalText, requiredText, str } from '../form-schema';
import { MasterPage } from '../MasterPage';
import type { MasterColumn, MasterFormProps } from '../types';
import { named, useEntityOptions } from '../use-options';

const ENDPOINT = '/vehicle-groups';

const schema = z.object({
  name: requiredText(100),
  description: optionalText(300),
  objectIds: z.array(z.string()),
});
type Values = z.infer<typeof schema>;

const objectOption = (o: TrackedObjectDto) => ({ value: o.id, label: o.name, description: o.plateNumber ?? undefined });

function VehicleGroupForm({ record, open, onOpenChange }: MasterFormProps<VehicleGroupDto>) {
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { name: str(record?.name), description: str(record?.description), objectIds: record?.objects.map((o) => o.id) ?? [] },
  });
  const [q, setQ] = useState('');
  const objects = useEntityOptions<TrackedObjectDto>('/objects', objectOption, { q, enabled: open });
  const save = useSaveMutation({ endpoint: ENDPOINT, id: record?.id ?? null, entity: 'Vehicle group', onSaved: () => onOpenChange(false) });
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={record ? 'Edit vehicle group' : 'Add vehicle group'}
      description="Activate or deactivate groups from the list's bulk actions."
      pending={save.isPending}
      error={save.error}
      onSubmit={form.handleSubmit((v) => save.mutate({ name: v.name, description: nullIfBlank(v.description), objectIds: v.objectIds }))}
    >
      <TextField form={form} name="name" label="Name" required />
      <TextField form={form} name="description" label="Description" multiline />
      <MultiSelectField
        form={form}
        name="objectIds"
        label="Objects"
        placeholder="Add vehicles and objects…"
        options={objects.options}
        loading={objects.loading}
        onSearch={setQ}
        selectedOptions={record?.objects.map(named)}
      />
    </FormDialog>
  );
}

const columns: MasterColumn<VehicleGroupDto>[] = [
  { id: 'name', header: 'Name', sortable: true, hideable: false, cell: (r) => <span className="font-medium">{r.name}</span> },
  { id: 'description', header: 'Description', cell: (r) => <span className="block max-w-xs truncate">{r.description ?? '—'}</span> },
  { id: 'objects', header: 'Objects', cell: (r) => <NameList items={r.objects} max={3} /> },
  { id: 'objectCount', header: 'Count', cell: (r) => <span className="tabular-nums">{r.objects.length}</span>, detail: false },
  { id: 'isActive', header: 'Status', cell: (r) => <ActiveBadge active={r.isActive} /> },
  { id: 'updatedAt', header: 'Updated', sortable: true, defaultHidden: true, cell: (r) => <DateCell value={r.updatedAt} relative /> },
];

const rowLabel = (r: VehicleGroupDto) => r.name;

export function VehicleGroupsPage() {
  return (
    <MasterPage
      menu="vehicle_groups"
      title="Vehicle Groups"
      description="Group vehicles for filtering on the live map and, later, reports and alerts."
      endpoint={ENDPOINT}
      columns={columns}
      rowLabel={rowLabel}
      defaultSort={{ id: 'name', desc: false }}
      Form={VehicleGroupForm}
      emptyIcon={LayersIcon}
    />
  );
}

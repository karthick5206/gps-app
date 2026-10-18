import { zodResolver } from '@hookform/resolvers/zod';
import type { DeviceModelDto } from '@veetracer/shared';
import { BoxesIcon } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Badge } from '@/components/ui/badge';
import { ActiveBadge, Muted } from '@/features/masters/cells';
import { FormDialog, useSaveMutation } from '@/features/masters/FormDialog';
import { SwitchField, TextField } from '@/features/masters/form-fields';
import { numericText, requiredText, str } from '@/features/masters/form-schema';
import { MasterPage } from '@/features/masters/MasterPage';
import type { MasterColumn, MasterFormProps } from '@/features/masters/types';

const ENDPOINT = '/device-models';

function jsonArray(label: string) {
  return z.string().superRefine((v, ctx) => {
    if (!v.trim()) return;
    try {
      if (!Array.isArray(JSON.parse(v))) ctx.addIssue({ code: 'custom', message: `${label} must be a JSON array` });
    } catch {
      ctx.addIssue({ code: 'custom', message: 'Invalid JSON' });
    }
  });
}

const schema = z.object({
  brand: requiredText(60),
  model: requiredText(60),
  protocol: requiredText(30),
  capabilities: z.string().trim(),
  timeOffsetMinutes: numericText({ min: -840, max: 840, integer: true }),
  fields: jsonArray('Fields'),
  commands: jsonArray('Commands'),
  isActive: z.boolean(),
});
type Values = z.infer<typeof schema>;

const pretty = (v: unknown) => (Array.isArray(v) && v.length ? JSON.stringify(v, null, 2) : '');

function DeviceModelForm({ record, open, onOpenChange }: MasterFormProps<DeviceModelDto>) {
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      brand: str(record?.brand),
      model: str(record?.model),
      protocol: record?.protocol ?? 'GT06',
      capabilities: record?.capabilities.join(', ') ?? '',
      timeOffsetMinutes: str(record?.timeOffsetMinutes ?? 0),
      fields: pretty(record?.fields),
      commands: pretty(record?.commands),
      isActive: record?.isActive ?? true,
    },
  });
  const save = useSaveMutation({ endpoint: ENDPOINT, id: record?.id ?? null, entity: 'Device model', onSaved: () => onOpenChange(false) });
  const submit = form.handleSubmit((v) =>
    save.mutate({
      brand: v.brand,
      model: v.model,
      protocol: v.protocol.toUpperCase(),
      capabilities: v.capabilities
        .split(',')
        .map((c) => c.trim())
        .filter(Boolean),
      timeOffsetMinutes: Number(v.timeOffsetMinutes || 0),
      fields: v.fields.trim() ? JSON.parse(v.fields) : [],
      commands: v.commands.trim() ? JSON.parse(v.commands) : [],
      isActive: v.isActive,
    }),
  );

  return (
    <FormDialog open={open} onOpenChange={onOpenChange} title={record ? 'Edit device model' : 'Add device model'} wide pending={save.isPending} error={save.error} onSubmit={submit}>
      <div className="grid gap-4 sm:grid-cols-3">
        <TextField form={form} name="brand" label="Brand" required placeholder="Concox" />
        <TextField form={form} name="model" label="Model" required placeholder="GT06N" />
        <TextField form={form} name="protocol" label="Protocol" required placeholder="GT06" />
        <TextField form={form} name="capabilities" label="Capabilities" className="sm:col-span-2" placeholder="ignition, sos, power_cut" hint="Comma-separated." />
        <TextField form={form} name="timeOffsetMinutes" label="Time offset (min)" type="number" hint="Added to device timestamps." />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField form={form} name="fields" label="Fields (JSON)" multiline placeholder='[{"key":"fuel","label":"Fuel","unit":"%","type":"number"}]' />
        <TextField form={form} name="commands" label="Commands (JSON)" multiline placeholder='[{"key":"engine_cut","label":"Engine cut"}]' />
      </div>
      <SwitchField form={form} name="isActive" label="Active" />
    </FormDialog>
  );
}

const columns: MasterColumn<DeviceModelDto>[] = [
  { id: 'brand', header: 'Brand', sortable: true, cell: (r) => r.brand },
  { id: 'model', header: 'Model', sortable: true, hideable: false, cell: (r) => <span className="font-medium">{r.model}</span> },
  { id: 'protocol', header: 'Protocol', sortable: true, cell: (r) => <Badge variant="secondary">{r.protocol}</Badge> },
  {
    id: 'capabilities',
    header: 'Capabilities',
    cell: (r) =>
      r.capabilities.length ? (
        <span className="inline-flex flex-wrap gap-1">
          {r.capabilities.map((c) => (
            <Badge key={c} variant="outline">
              {c}
            </Badge>
          ))}
        </span>
      ) : (
        <Muted>—</Muted>
      ),
  },
  { id: 'timeOffsetMinutes', header: 'Time offset', defaultHidden: true, cell: (r) => `${r.timeOffsetMinutes} min` },
  { id: 'deviceCount', header: 'Devices', sortable: true, cell: (r) => <span className="tabular-nums">{r.deviceCount}</span> },
  { id: 'isActive', header: 'Status', cell: (r) => <ActiveBadge active={r.isActive} /> },
];

const rowLabel = (r: DeviceModelDto) => `${r.brand} ${r.model}`;

export function DeviceModelsPage() {
  return (
    <MasterPage
      menu="sa_device_models"
      title="Device Models"
      description="Supported tracker models, their protocol and capabilities."
      endpoint={ENDPOINT}
      columns={columns}
      rowLabel={rowLabel}
      defaultSort={{ id: 'brand', desc: false }}
      Form={DeviceModelForm}
      emptyIcon={BoxesIcon}
    />
  );
}

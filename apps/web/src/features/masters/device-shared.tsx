import { zodResolver } from '@hookform/resolvers/zod';
import type { CompanyDto, DeviceDto, DeviceModelDto } from '@veetracer/shared';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import type { Option } from '@/components/ui/multi-select';
import { ActiveBadge, Dash, DateCell, Muted } from './cells';
import { FormDialog, useSaveMutation } from './FormDialog';
import { ComboboxField, SwitchField, TextField } from './form-fields';
import { nullIfBlank, optionalText, requiredText, str } from './form-schema';
import type { MasterColumn } from './types';
import { named, useEntityOptions } from './use-options';

/** Platform-wide device inventory (Super Admin). */
export const INVENTORY_ENDPOINT = '/admin/devices';

export const modelOption = (m: DeviceModelDto): Option => ({ value: m.id, label: `${m.brand} ${m.model}`, description: m.protocol });

const schema = z.object({
  uniqueId: requiredText(32).regex(/^[A-Za-z0-9_-]+$/, 'Letters, digits, - and _ only'),
  modelId: z.string({ invalid_type_error: 'Required' }).min(1, 'Required'),
  companyId: z.string().nullable(),
  simNumber: optionalText(20),
  simOperator: optionalText(50),
  firmware: optionalText(50),
  isActive: z.boolean(),
});
type Values = z.infer<typeof schema>;

/**
 * Device create/edit. `withCompany` (platform inventory) adds the company assignment;
 * company admins manage devices inside their own company only.
 */
export function DeviceForm({
  endpoint,
  withCompany,
  record,
  initialUniqueId,
  open,
  onOpenChange,
}: {
  endpoint: string;
  withCompany: boolean;
  record: DeviceDto | null;
  initialUniqueId?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      uniqueId: record?.uniqueId ?? initialUniqueId ?? '',
      modelId: record?.modelId ?? '',
      companyId: record?.companyId ?? null,
      simNumber: str(record?.simNumber),
      simOperator: str(record?.simOperator),
      firmware: str(record?.firmware),
      isActive: record?.isActive ?? true,
    },
  });
  const models = useEntityOptions<DeviceModelDto>('/device-models', modelOption, { enabled: open });
  const [companyQ, setCompanyQ] = useState('');
  const companies = useEntityOptions<CompanyDto>('/admin/companies', named, { q: companyQ, enabled: open && withCompany });
  const save = useSaveMutation({ endpoint, id: record?.id ?? null, entity: 'Device', onSaved: () => onOpenChange(false) });

  const submit = form.handleSubmit((v) =>
    save.mutate({
      uniqueId: v.uniqueId,
      modelId: v.modelId,
      simNumber: nullIfBlank(v.simNumber),
      simOperator: nullIfBlank(v.simOperator),
      firmware: nullIfBlank(v.firmware),
      isActive: v.isActive,
      ...(withCompany ? { companyId: v.companyId } : {}),
    }),
  );

  return (
    <FormDialog open={open} onOpenChange={onOpenChange} title={record ? 'Edit device' : 'Add device'} pending={save.isPending} error={save.error} onSubmit={submit}>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField form={form} name="uniqueId" label="IMEI / unique ID" required className="sm:col-span-2" placeholder="868120000000001" />
        <ComboboxField
          form={form}
          name="modelId"
          label="Model"
          required
          className="sm:col-span-2"
          options={models.options}
          loading={models.loading}
          selectedOption={record ? { value: record.modelId, label: record.modelName } : null}
        />
        {withCompany && (
          <ComboboxField
            form={form}
            name="companyId"
            label="Company"
            className="sm:col-span-2"
            options={companies.options}
            loading={companies.loading}
            onSearch={setCompanyQ}
            selectedOption={record?.companyId ? { value: record.companyId, label: record.companyName ?? record.companyId } : null}
            placeholder="Platform stock (unassigned)"
          />
        )}
        <TextField form={form} name="simNumber" label="SIM number" type="tel" />
        <TextField form={form} name="simOperator" label="SIM operator" />
        <TextField form={form} name="firmware" label="Firmware" />
      </div>
      <SwitchField form={form} name="isActive" label="Active" hint="Positions from inactive devices are ignored." />
    </FormDialog>
  );
}

export function deviceColumns(withCompany: boolean): MasterColumn<DeviceDto>[] {
  return [
    { id: 'uniqueId', header: 'IMEI / ID', sortable: true, hideable: false, cell: (r) => <span className="font-mono text-xs font-medium">{r.uniqueId}</span> },
    { id: 'modelName', header: 'Model', sortable: true, cell: (r) => r.modelName },
    { id: 'protocol', header: 'Protocol', defaultHidden: true, cell: (r) => r.protocol },
    ...(withCompany
      ? [{ id: 'companyName', header: 'Company', sortable: true, cell: (r: DeviceDto) => r.companyName ?? <Muted>Platform stock</Muted> }]
      : []),
    { id: 'object', header: 'Object', cell: (r) => r.object?.name ?? <Muted>Unassigned</Muted> },
    { id: 'simNumber', header: 'SIM', cell: (r) => <Dash value={r.simNumber} /> },
    { id: 'simOperator', header: 'Operator', defaultHidden: true, cell: (r) => <Dash value={r.simOperator} /> },
    { id: 'firmware', header: 'Firmware', defaultHidden: true, cell: (r) => <Dash value={r.firmware} /> },
    { id: 'lastSeenAt', header: 'Last seen', sortable: true, cell: (r) => <DateCell value={r.lastSeenAt} relative /> },
    { id: 'isActive', header: 'Status', cell: (r) => <ActiveBadge active={r.isActive} /> },
    { id: 'createdAt', header: 'Created', sortable: true, defaultHidden: true, cell: (r) => <DateCell value={r.createdAt} /> },
  ];
}

export const ASSIGNED_OPTIONS: Option[] = [
  { value: 'true', label: 'Assigned' },
  { value: 'false', label: 'Unassigned' },
];

export const deviceRowLabel = (r: DeviceDto) => r.uniqueId;

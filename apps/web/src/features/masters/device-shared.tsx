import { zodResolver } from '@hookform/resolvers/zod';
import { DEFAULT_SPEED_LIMIT_KPH, type CompanyDto, type DeviceDto, type DeviceModelDto } from '@veetracer/shared';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import type { Option } from '@/components/ui/multi-select';
import { useAuth } from '@/features/auth/auth-context';
import { IoSensorsSection } from '@/features/io-sensors/IoSensorsSection';
import { useIoSensors } from '@/features/io-sensors/use-io-sensors';
import { api, errorMessage } from '@/lib/api';
import { i18n } from '@/lib/i18n';
import { ActiveBadge, Dash, DateCell, Muted } from './cells';
import { FormDialog, useSaveMutation } from './FormDialog';
import { ComboboxField, SwitchField, TextField } from './form-fields';
import { nullIfBlank, numberOrNull, numericText, optionalText, requiredText, str } from './form-schema';
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
  speedLimitKph: numericText({ min: 5, max: 250, integer: true }),
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
  const { t } = useTranslation();
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      uniqueId: record?.uniqueId ?? initialUniqueId ?? '',
      modelId: record?.modelId ?? '',
      companyId: record?.companyId ?? null,
      simNumber: str(record?.simNumber),
      simOperator: str(record?.simOperator),
      firmware: str(record?.firmware),
      speedLimitKph: str(record?.object?.speedLimitKph),
      isActive: record?.isActive ?? true,
    },
  });
  const models = useEntityOptions<DeviceModelDto>('/device-models', modelOption, { enabled: open });
  const [companyQ, setCompanyQ] = useState('');
  const companies = useEntityOptions<CompanyDto>('/admin/companies', named, { q: companyQ, enabled: open && withCompany });
  const save = useSaveMutation({ endpoint, id: record?.id ?? null, entity: 'Device', onSaved: () => onOpenChange(false) });
  const { can } = useAuth();
  // The overspeed limit belongs to the vehicle the device is fitted to (it moves with the vehicle on a device swap).
  const vehicle = !withCompany ? record?.object ?? null : null;
  const canSetLimit = !!vehicle && can('objects', 'edit');
  const typeDefault = vehicle?.vehicleType ? DEFAULT_SPEED_LIMIT_KPH[vehicle.vehicleType] : null;
  // AC / door sensors are wired to the tracker: company devices only, once the device exists.
  const withIo = !withCompany && !!record;
  const io = useIoSensors(withIo ? record.id : null, open && withIo);

  const submit = form.handleSubmit(async (v) => {
    if (canSetLimit && numberOrNull(v.speedLimitKph) !== (vehicle.speedLimitKph ?? null)) {
      try {
        await api.patch(`/objects/${vehicle.id}`, { speedLimitKph: numberOrNull(v.speedLimitKph) });
      } catch (err) {
        toast.error(t('Speed limit not saved: {{error}}', { error: errorMessage(err) }));
        return;
      }
    }
    if (withIo && io.dirty) {
      try {
        await io.save();
      } catch (err) {
        toast.error(t('AC / Door settings not saved: {{error}}', { error: t(errorMessage(err)) }));
        return;
      }
    }
    save.mutate({
      uniqueId: v.uniqueId,
      modelId: v.modelId,
      simNumber: nullIfBlank(v.simNumber),
      simOperator: nullIfBlank(v.simOperator),
      firmware: nullIfBlank(v.firmware),
      isActive: v.isActive,
      ...(withCompany ? { companyId: v.companyId } : {}),
    });
  });

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
        {!withCompany && (
          <TextField
            form={form}
            name="speedLimitKph"
            label="Overspeed alert limit (km/h)"
            type="number"
            className="sm:col-span-2"
            disabled={!canSetLimit}
            placeholder={typeDefault ? t('Default {{n}}', { n: typeDefault }) : 'e.g. 50'}
            hint={
              vehicle
                ? typeDefault
                  ? t('Applies to {{name}}. Overspeed alerts fire above this speed. Leave empty for the vehicle-type default ({{n}} km/h).', { name: vehicle.name, n: typeDefault })
                  : t('Applies to {{name}}. Overspeed alerts fire above this speed. Leave empty for the vehicle-type default.', { name: vehicle.name })
                : 'Fit this device to a vehicle (Vehicles & Objects) to set its overspeed limit here.'
            }
          />
        )}
      </div>
      <SwitchField form={form} name="isActive" label="Active" hint="Positions from inactive devices are ignored." />
      {withIo ? <IoSensorsSection io={io} /> : null}
    </FormDialog>
  );
}

export function deviceColumns(withCompany: boolean): MasterColumn<DeviceDto>[] {
  return [
    { id: 'uniqueId', header: 'IMEI / ID', sortable: true, hideable: false, cell: (r) => <span className="font-mono text-xs font-medium">{r.uniqueId}</span> },
    { id: 'modelName', header: 'Model', sortable: true, cell: (r) => r.modelName },
    { id: 'protocol', header: 'Protocol', defaultHidden: true, cell: (r) => r.protocol },
    ...(withCompany
      ? [{ id: 'companyName', header: 'Company', sortable: true, cell: (r: DeviceDto) => r.companyName ?? <Muted>{i18n.t('Platform stock')}</Muted> }]
      : []),
    { id: 'object', header: 'Object', cell: (r) => r.object?.name ?? <Muted>{i18n.t('Unassigned')}</Muted> },
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

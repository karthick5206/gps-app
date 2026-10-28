import { zodResolver } from '@hookform/resolvers/zod';
import {
  DEFAULT_SPEED_LIMIT_KPH,
  OBJECT_TYPES,
  VEHICLE_TYPES,
  type BranchDto,
  type DeviceDto,
  type TrackedObjectDto,
  type VehicleGroupDto,
  type VehicleType,
} from '@veetracer/shared';
import { FileCheck2Icon, FuelIcon, TruckIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { FuelSettingsDialog, type FuelTarget } from '@/features/fuel/FuelSettingsDialog';
import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { usePurgeAction } from '@/features/platform/PurgeDialog';
import { useWithCompanyColumn } from '@/features/platform/all-companies';
import { useTransferAction } from '@/features/platform/TransferDialog';
import { z } from 'zod';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import type { Option } from '@/components/ui/multi-select';
import { ComplianceSheet, type ComplianceTarget } from '@/features/documents/CompliancePanel';
import { useAuth } from '@/features/auth/auth-context';
import { ActiveBadge, Dash, DateCell, Muted, NameList } from '../cells';
import { humanize } from '@/lib/format';
import { i18n } from '@/lib/i18n';
import { FormDialog, useSaveMutation } from '../FormDialog';
import { ComboboxField, SelectField, SwitchField, TextField } from '../form-fields';
import { nullIfBlank, numberOrNull, numericText, optionalText, requiredText, str } from '../form-schema';
import { MasterPage } from '../MasterPage';
import type { MasterColumn, MasterFilter, MasterFormProps } from '../types';
import { named, useEntityOptions } from '../use-options';

const ENDPOINT = '/objects';
const OBJECT_TYPE_OPTIONS: Option[] = OBJECT_TYPES.map((t) => ({ value: t, label: humanize(t) }));
const VEHICLE_TYPE_OPTIONS: Option[] = VEHICLE_TYPES.map((t) => ({ value: t, label: humanize(t) }));

const schema = z
  .object({
    name: requiredText(100),
    type: z.enum(OBJECT_TYPES),
    vehicleType: z.string(),
    plateNumber: optionalText(20),
    make: optionalText(50),
    model: optionalText(50),
    color: optionalText(30),
    branchId: z.string().nullable(),
    speedLimitKph: numericText({ min: 1, max: 300, integer: true }),
    deviceId: z.string().nullable(),
    isActive: z.boolean(),
  })
  .refine((v) => v.type !== 'VEHICLE' || v.vehicleType !== '', { path: ['vehicleType'], message: 'Choose a vehicle type' });
type Values = z.infer<typeof schema>;

const deviceOption = (d: DeviceDto): Option => ({ value: d.id, label: d.uniqueId, description: d.modelName });

function ObjectForm({ record, open, onOpenChange }: MasterFormProps<TrackedObjectDto>) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: str(record?.name),
      type: record?.type ?? 'VEHICLE',
      vehicleType: record?.vehicleType ?? '',
      plateNumber: str(record?.plateNumber),
      make: str(record?.make),
      model: str(record?.model),
      color: str(record?.color),
      branchId: record?.branchId ?? null,
      speedLimitKph: str(record?.speedLimitKph),
      deviceId: record?.device?.id ?? null,
      isActive: record?.isActive ?? true,
    },
  });
  const type = form.watch('type');
  const vehicleType = form.watch('vehicleType') as VehicleType | '';
  const [fuel, setFuel] = useState<FuelTarget | null>(null);

  const branches = useEntityOptions<BranchDto>('/branches', named, { enabled: open && can('branches') });
  const [deviceQ, setDeviceQ] = useState('');
  const devices = useEntityOptions<DeviceDto>('/devices', deviceOption, { q: deviceQ, enabled: open && can('devices'), params: { assigned: false } });
  const currentDevice = record?.device ? { value: record.device.id, label: record.device.uniqueId, description: record.device.modelName } : null;
  const deviceOptions = useMemo(
    () => (currentDevice && !devices.options.some((o) => o.value === currentDevice.value) ? [currentDevice, ...devices.options] : devices.options),
    [devices.options, currentDevice],
  );

  const save = useSaveMutation({ endpoint: ENDPOINT, id: record?.id ?? null, entity: 'Object', onSaved: () => onOpenChange(false) });
  const submit = form.handleSubmit((v) =>
    save.mutate({
      name: v.name,
      type: v.type,
      vehicleType: v.type === 'VEHICLE' ? v.vehicleType : null,
      plateNumber: nullIfBlank(v.plateNumber),
      make: nullIfBlank(v.make),
      model: nullIfBlank(v.model),
      color: nullIfBlank(v.color),
      branchId: v.branchId,
      speedLimitKph: numberOrNull(v.speedLimitKph),
      deviceId: v.deviceId,
      isActive: v.isActive,
    }),
  );

  return (
    <FormDialog open={open} onOpenChange={onOpenChange} title={record ? 'Edit object' : 'Add object'} wide pending={save.isPending} error={save.error} onSubmit={submit}>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField form={form} name="name" label="Name" required className="sm:col-span-2" />
        <SelectField form={form} name="type" label="Object type" required options={OBJECT_TYPE_OPTIONS} />
        {type === 'VEHICLE' ? (
          <SelectField form={form} name="vehicleType" label="Vehicle type" required options={VEHICLE_TYPE_OPTIONS} />
        ) : (
          <div className="hidden sm:block" />
        )}
        <TextField form={form} name="plateNumber" label="Plate number" placeholder="TN-01-AB-1234" />
        {can('branches') && <ComboboxField form={form} name="branchId" label="Branch" options={branches.options} loading={branches.loading} placeholder="No branch" />}
        <TextField form={form} name="make" label="Make" />
        <TextField form={form} name="model" label="Model" />
        <TextField form={form} name="color" label="Colour" />
        <TextField
          form={form}
          name="speedLimitKph"
          label="Overspeed alert limit (km/h)"
          type="number"
          placeholder="e.g. 50"
          hint={
            vehicleType
              ? t('Overspeed alerts fire above this speed (it overrides company and group alert settings). Leave empty for the default ({{n}} km/h).', { n: DEFAULT_SPEED_LIMIT_KPH[vehicleType] })
              : t('Overspeed alerts fire above this speed (it overrides company and group alert settings). Leave empty for the default.')
          }
        />
        {can('devices') && (
          <ComboboxField
            form={form}
            name="deviceId"
            label="Assigned device"
            className="sm:col-span-2"
            options={deviceOptions}
            loading={devices.loading}
            onSearch={setDeviceQ}
            selectedOption={currentDevice}
            placeholder="No device"
            hint="Assigning a device closes its previous assignment (device swap)."
          />
        )}
      </div>
      <SwitchField form={form} name="isActive" label="Active" hint="Inactive objects are hidden from the live map and ignored by the processor." />
      {record && type === 'VEHICLE' && can('objects', 'edit') && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-dashed p-3">
          <div className="text-sm">
            <p className="font-medium">{t('Fuel sensor')}</p>
            <p className="text-xs text-muted-foreground">{t('Sensor source, tank capacity, calibration and refill / theft thresholds.')}</p>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={() => setFuel({ objectId: record.id, label: rowLabel(record) })}>
            <FuelIcon /> {t('Fuel settings')}
          </Button>
        </div>
      )}
      <FuelSettingsDialog target={fuel} onClose={() => setFuel(null)} />
    </FormDialog>
  );
}

const columns: MasterColumn<TrackedObjectDto>[] = [
  { id: 'name', header: 'Name', sortable: true, hideable: false, cell: (r) => <span className="font-medium">{r.name}</span> },
  { id: 'plateNumber', header: 'Plate', sortable: true, cell: (r) => <Dash value={r.plateNumber} /> },
  {
    id: 'type',
    header: 'Type',
    sortable: true,
    cell: (r) => (
      <span>
        {i18n.t(humanize(r.vehicleType ?? r.type))}
        {r.vehicleType && <Muted> · {i18n.t('Vehicle')}</Muted>}
      </span>
    ),
  },
  { id: 'branchName', header: 'Branch', sortable: true, cell: (r) => <Dash value={r.branchName} /> },
  {
    id: 'device',
    header: 'Device',
    cell: (r) => (r.device ? <span className="font-mono text-xs">{r.device.uniqueId}</span> : <Muted>{i18n.t('Unassigned')}</Muted>),
  },
  { id: 'deviceModel', header: 'Device model', defaultHidden: true, cell: (r) => <Dash value={r.device?.modelName} /> },
  { id: 'groups', header: 'Groups', cell: (r) => <NameList items={r.groups} /> },
  { id: 'make', header: 'Make / model', defaultHidden: true, cell: (r) => <Dash value={[r.make, r.model].filter(Boolean).join(' ') || null} /> },
  { id: 'color', header: 'Colour', defaultHidden: true, cell: (r) => <Dash value={r.color} /> },
  {
    id: 'speedLimitKph',
    header: 'Overspeed limit',
    cell: (r) => (r.speedLimitKph ? `${r.speedLimitKph} km/h` : <Muted>{r.vehicleType ? i18n.t('{{n}} km/h (default)', { n: DEFAULT_SPEED_LIMIT_KPH[r.vehicleType] }) : '—'}</Muted>),
  },
  { id: 'isActive', header: 'Status', cell: (r) => <ActiveBadge active={r.isActive} /> },
  { id: 'createdAt', header: 'Created', sortable: true, defaultHidden: true, cell: (r) => <DateCell value={r.createdAt} /> },
];

const rowLabel = (r: TrackedObjectDto) => (r.plateNumber ? `${r.name} (${r.plateNumber})` : r.name);

export function ObjectsPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const [compliance, setCompliance] = useState<ComplianceTarget | null>(null);
  const [fuel, setFuel] = useState<FuelTarget | null>(null);
  const branches = useEntityOptions<BranchDto>('/branches', named, { enabled: can('branches') });
  const purge = usePurgeAction('object');
  const transfer = useTransferAction('object');
  const cols = useWithCompanyColumn(columns);
  const groups = useEntityOptions<VehicleGroupDto>('/vehicle-groups', named, { enabled: can('vehicle_groups') });
  const filters = useMemo<MasterFilter[]>(
    () => [
      ...(can('branches') ? [{ key: 'branchId', label: 'Branches', options: branches.options }] : []),
      ...(can('vehicle_groups') ? [{ key: 'groupId', label: 'Groups', options: groups.options }] : []),
      { key: 'type', label: 'Object types', options: OBJECT_TYPE_OPTIONS },
      { key: 'vehicleType', label: 'Vehicle types', options: VEHICLE_TYPE_OPTIONS },
    ],
    [can, branches.options, groups.options],
  );

  return (
    <>
    <MasterPage
      menu="objects"
      title="Vehicles & Objects"
      description="Everything you track — vehicles, people, assets and pets — and the device fitted to each."
      endpoint={ENDPOINT}
      columns={cols}
      rowLabel={rowLabel}
      filters={filters}
      defaultSort={{ id: 'name', desc: false }}
      Form={ObjectForm}
      emptyIcon={TruckIcon}
      rowActions={(r) => (
              <>
                {can('documents') && (
                  <DropdownMenuItem onSelect={() => setCompliance({ objectId: r.id, label: rowLabel(r) })}>
                    <FileCheck2Icon /> {t('Documents & service')}
                  </DropdownMenuItem>
                )}
                {can('objects', 'edit') && r.type === 'VEHICLE' && (
                  <DropdownMenuItem onSelect={() => setFuel({ objectId: r.id, label: rowLabel(r) })}>
                    <FuelIcon /> {t('Fuel settings')}
                  </DropdownMenuItem>
                )}
                {transfer.item({ id: r.id, name: rowLabel(r), companyId: r.companyId })}
                {purge.item(r.id)}
              </>
            )}
    />
    <ComplianceSheet target={compliance} onClose={() => setCompliance(null)} />
    <FuelSettingsDialog target={fuel} onClose={() => setFuel(null)} />
    {transfer.dialog}
    {purge.dialog}
    </>
  );
}

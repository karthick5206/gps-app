import type { DeviceDto, DeviceModelDto } from '@veetracer/shared';
import { BinaryIcon, CpuIcon } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { useAuth } from '@/features/auth/auth-context';
import { ASSIGNED_OPTIONS, DeviceForm, deviceColumns, deviceRowLabel, modelOption } from '../device-shared';
import { MasterPage } from '../MasterPage';
import { RawPacketsSheet } from '../RawPacketsSheet';
import type { MasterFilter, MasterFormProps } from '../types';
import { useEntityOptions } from '../use-options';

const ENDPOINT = '/devices';
const columns = deviceColumns(false);

function CompanyDeviceForm(props: MasterFormProps<DeviceDto>) {
  return <DeviceForm endpoint={ENDPOINT} withCompany={false} {...props} />;
}

export function DevicesPage() {
  const { t } = useTranslation();
  const models = useEntityOptions<DeviceModelDto>('/device-models', modelOption);
  const { can } = useAuth();
  const [rawFor, setRawFor] = useState<DeviceDto | null>(null);
  const rowActions = useCallback(
    (r: DeviceDto) => (
      <DropdownMenuItem onSelect={() => setRawFor(r)}>
        <BinaryIcon /> {t('Raw data')}
      </DropdownMenuItem>
    ),
    [t],
  );
  const filters = useMemo<MasterFilter[]>(
    () => [
      { key: 'modelId', label: 'Models', options: models.options },
      { key: 'assigned', label: 'Assignment', options: ASSIGNED_OPTIONS },
    ],
    [models.options],
  );
  return (
    <>
    <MasterPage
      menu="devices"
      title="Devices"
      description="GPS trackers and phones in your company. Assign them to objects from the Vehicles & Objects page."
      endpoint={ENDPOINT}
      columns={columns}
      rowLabel={deviceRowLabel}
      filters={filters}
      defaultSort={{ id: 'uniqueId', desc: false }}
      Form={CompanyDeviceForm}
      emptyIcon={CpuIcon}
      rowActions={can('devices', 'edit') ? rowActions : undefined}
    />
    <RawPacketsSheet device={rawFor} onClose={() => setRawFor(null)} />
    </>
  );
}

import type { DeviceDto, DeviceModelDto } from '@veetracer/shared';
import { CpuIcon } from 'lucide-react';
import { useMemo } from 'react';
import { ASSIGNED_OPTIONS, DeviceForm, deviceColumns, deviceRowLabel, modelOption } from '../device-shared';
import { MasterPage } from '../MasterPage';
import type { MasterFilter, MasterFormProps } from '../types';
import { useEntityOptions } from '../use-options';

const ENDPOINT = '/devices';
const columns = deviceColumns(false);

function CompanyDeviceForm(props: MasterFormProps<DeviceDto>) {
  return <DeviceForm endpoint={ENDPOINT} withCompany={false} {...props} />;
}

export function DevicesPage() {
  const models = useEntityOptions<DeviceModelDto>('/device-models', modelOption);
  const filters = useMemo<MasterFilter[]>(
    () => [
      { key: 'modelId', label: 'Models', options: models.options },
      { key: 'assigned', label: 'Assignment', options: ASSIGNED_OPTIONS },
    ],
    [models.options],
  );
  return (
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
    />
  );
}

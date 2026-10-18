import type { CompanyDto, DeviceDto, DeviceModelDto } from '@veetracer/shared';
import { HardDriveIcon } from 'lucide-react';
import { useMemo } from 'react';
import { ASSIGNED_OPTIONS, DeviceForm, INVENTORY_ENDPOINT, deviceColumns, deviceRowLabel, modelOption } from '@/features/masters/device-shared';
import { MasterPage } from '@/features/masters/MasterPage';
import type { MasterFilter, MasterFormProps } from '@/features/masters/types';
import { named, useEntityOptions } from '@/features/masters/use-options';

const columns = deviceColumns(true);

function InventoryDeviceForm(props: MasterFormProps<DeviceDto>) {
  return <DeviceForm endpoint={INVENTORY_ENDPOINT} withCompany {...props} />;
}

export function DeviceInventoryPage() {
  const models = useEntityOptions<DeviceModelDto>('/device-models', modelOption);
  const companies = useEntityOptions<CompanyDto>('/admin/companies', named);
  const filters = useMemo<MasterFilter[]>(
    () => [
      { key: 'companyId', label: 'Companies', options: companies.options },
      { key: 'modelId', label: 'Models', options: models.options },
      { key: 'assigned', label: 'Assignment', options: ASSIGNED_OPTIONS },
    ],
    [companies.options, models.options],
  );
  return (
    <MasterPage
      menu="sa_device_inventory"
      title="Device Inventory"
      description="Every device on the platform. Assign stock devices to a company."
      endpoint={INVENTORY_ENDPOINT}
      columns={columns}
      rowLabel={deviceRowLabel}
      filters={filters}
      defaultSort={{ id: 'uniqueId', desc: false }}
      Form={InventoryDeviceForm}
      emptyIcon={HardDriveIcon}
    />
  );
}

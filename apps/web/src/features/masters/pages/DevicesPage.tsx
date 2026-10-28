import type { DeviceDto, DeviceModelDto } from '@veetracer/shared';
import { BinaryIcon, CpuIcon } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { usePurgeAction } from '@/features/platform/PurgeDialog';
import { useWithCompanyColumn } from '@/features/platform/all-companies';
import { useTransferAction } from '@/features/platform/TransferDialog';
import { FamilyDialog } from '@/features/family/FamilyDialog';
import { UsersRoundIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
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
  const { can, me } = useAuth();
  const personal = !!me && me.company.accountType !== 'BUSINESS';
  const [family, setFamily] = useState(false);
  const [rawFor, setRawFor] = useState<DeviceDto | null>(null);
  const purge = usePurgeAction('device');
  const transfer = useTransferAction('device');
  const cols = useWithCompanyColumn(columns);
  const rowActions = useCallback(
    (r: DeviceDto) => (
      <>
        {can('devices', 'edit') && (
          <DropdownMenuItem onSelect={() => setRawFor(r)}>
            <BinaryIcon /> {t('Raw data')}
          </DropdownMenuItem>
        )}
        {transfer.item({ id: r.id, name: r.uniqueId, companyId: r.companyId })}
        {purge.item(r.id)}
      </>
    ),
    [t, can, purge, transfer],
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
      columns={cols}
      rowLabel={deviceRowLabel}
      filters={filters}
      defaultSort={{ id: 'uniqueId', desc: false }}
      Form={CompanyDeviceForm}
      emptyIcon={CpuIcon}
      rowActions={rowActions}
      headerActions={
        personal && can('devices', 'create') ? (
          <Button variant="outline" onClick={() => setFamily(true)}>
            <UsersRoundIcon /> {t('Family members')}
          </Button>
        ) : undefined
      }
    />
    <FamilyDialog open={family} onOpenChange={setFamily} />
    <RawPacketsSheet device={rawFor} onClose={() => setRawFor(null)} />
    {transfer.dialog}
    {purge.dialog}
    </>
  );
}

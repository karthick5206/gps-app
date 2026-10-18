import type { UnknownDeviceDto } from '@veetracer/shared';
import { PlusCircleIcon, RadarIcon } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { useAuth } from '@/features/auth/auth-context';
import { Dash, DateCell } from '@/features/masters/cells';
import { DeviceForm, INVENTORY_ENDPOINT } from '@/features/masters/device-shared';
import { MasterPage } from '@/features/masters/MasterPage';
import type { MasterColumn } from '@/features/masters/types';

const columns: MasterColumn<UnknownDeviceDto>[] = [
  { id: 'uniqueId', header: 'IMEI / ID', sortable: true, hideable: false, cell: (r) => <span className="font-mono text-xs font-medium">{r.uniqueId}</span> },
  { id: 'protocol', header: 'Protocol', sortable: true, cell: (r) => r.protocol },
  { id: 'remoteAddress', header: 'Remote address', cell: (r) => <Dash value={r.remoteAddress} /> },
  { id: 'firstSeenAt', header: 'First seen', sortable: true, cell: (r) => <DateCell value={r.firstSeenAt} /> },
  { id: 'lastSeenAt', header: 'Last seen', sortable: true, cell: (r) => <DateCell value={r.lastSeenAt} relative /> },
  { id: 'packetCount', header: 'Packets', sortable: true, cell: (r) => <span className="tabular-nums">{r.packetCount.toLocaleString()}</span> },
];

const ENDPOINT = '/admin/unknown-devices';
const rowId = (r: UnknownDeviceDto) => r.uniqueId;

export function UnknownDevicesPage() {
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const [registering, setRegistering] = useState<string | null>(null);
  const closeRegister = () => {
    setRegistering(null);
    // A registered device may disappear from this list.
    queryClient.invalidateQueries({ queryKey: ['master', ENDPOINT] });
  };
  const rowActions = useCallback(
    (r: UnknownDeviceDto) =>
      can('sa_device_inventory', 'create') ? (
        <DropdownMenuItem onSelect={() => setRegistering(r.uniqueId)}>
          <PlusCircleIcon /> Register device
        </DropdownMenuItem>
      ) : null,
    [can],
  );
  return (
    <>
      <MasterPage
        menu="sa_unknown_devices"
        title="Unknown Devices"
        description="Trackers that connected to the gateway but aren't registered. Register them to start tracking."
        endpoint={ENDPOINT}
        columns={columns}
        rowLabel={rowId}
        getRowId={rowId}
        statusFilter={false}
        readOnly
        defaultSort={{ id: 'lastSeenAt', desc: true }}
        rowActions={rowActions}
        emptyIcon={RadarIcon}
      />
      {registering && (
        <DeviceForm endpoint={INVENTORY_ENDPOINT} withCompany record={null} initialUniqueId={registering} open onOpenChange={(o) => !o && closeRegister()} />
      )}
    </>
  );
}

import { INVENTORY_STATUS_LABELS, INVENTORY_STATUSES, type DeviceStockDto, type InventoryStatus, type StockLocationDto } from '@veetracer/shared';
import { WarehouseIcon } from 'lucide-react';
import { useMemo } from 'react';
import { Badge } from '@/components/ui/badge';
import type { Option } from '@/components/ui/multi-select';
import { Dash, DateCell, Muted } from '@/features/masters/cells';
import { MasterPage } from '@/features/masters/MasterPage';
import type { MasterColumn, MasterFilter } from '@/features/masters/types';
import { useEntityOptions } from '@/features/masters/use-options';
import { i18n } from '@/lib/i18n';

type BadgeVariant = 'default' | 'secondary' | 'success' | 'warning' | 'destructive' | 'muted' | 'outline';

const STATUS_VARIANT: Record<InventoryStatus, BadgeVariant> = {
  IN_STOCK: 'secondary',
  RESERVED: 'default',
  ASSIGNED: 'default',
  ACTIVE: 'success',
  FAULTY: 'destructive',
  UNDER_REPAIR: 'warning',
  RETURNED: 'outline',
  RETIRED: 'muted',
};

const STATUS_OPTIONS: Option[] = INVENTORY_STATUSES.map((s) => ({ value: s, label: INVENTORY_STATUS_LABELS[s] }));
const MISMATCH_OPTIONS: Option[] = [{ value: 'true', label: 'Differs from assignment' }];
const locationOption = (l: StockLocationDto): Option => ({ value: l.id, label: `${l.code} · ${l.name}` });

function StatusBadge({ status }: { status: InventoryStatus }) {
  return <Badge variant={STATUS_VARIANT[status]}>{i18n.t(INVENTORY_STATUS_LABELS[status])}</Badge>;
}

const rupees = (paise: number | null) => (paise === null ? null : `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`);

const columns: MasterColumn<DeviceStockDto>[] = [
  { id: 'uniqueId', header: 'IMEI / ID', sortable: true, hideable: false, cell: (r) => <span className="font-mono text-xs font-medium">{r.uniqueId}</span> },
  { id: 'modelName', header: 'Model', cell: (r) => r.modelName },
  {
    id: 'status',
    header: 'Stock status',
    sortable: true,
    cell: (r) => (
      <span className="inline-flex items-center gap-1">
        <StatusBadge status={r.status} />
        {r.mismatch && (
          <Badge variant="warning" title={i18n.t('The device assignment says {{s}}', { s: INVENTORY_STATUS_LABELS[r.derivedStatus] })}>
            {i18n.t('Check')}
          </Badge>
        )}
      </span>
    ),
  },
  { id: 'location', header: 'Location', cell: (r) => (r.location ? `${r.location.code} · ${r.location.name}` : <Muted>—</Muted>) },
  { id: 'holder', header: 'Held by partner', defaultHidden: true, cell: (r) => <Dash value={r.holderPartner?.name} /> },
  { id: 'company', header: 'Customer', cell: (r) => r.company?.name ?? <Muted>{i18n.t('Platform stock')}</Muted> },
  { id: 'object', header: 'Vehicle', cell: (r) => <Dash value={r.object?.name} /> },
  {
    id: 'licence',
    header: 'Licence',
    cell: (r) =>
      r.licence.status === 'NOT_IN_ACCOUNT' ? (
        <Muted>—</Muted>
      ) : (
        <Badge variant={r.licence.status === 'ACTIVE' ? 'success' : r.licence.status === 'EXPIRED' ? 'destructive' : 'warning'}>
          {r.licence.status === 'ACTIVE' ? i18n.t('Licensed') : r.licence.status === 'EXPIRED' ? i18n.t('Expired') : i18n.t('No seat')}
        </Badge>
      ),
  },
  { id: 'serialNumber', header: 'Serial no.', defaultHidden: true, cell: (r) => <Dash value={r.serialNumber} /> },
  { id: 'supplierName', header: 'Supplier', defaultHidden: true, cell: (r) => <Dash value={r.supplierName} /> },
  { id: 'unitCostPaise', header: 'Unit cost', defaultHidden: true, cell: (r) => <Dash value={rupees(r.unitCostPaise)} /> },
  { id: 'warrantyUntil', header: 'Warranty until', defaultHidden: true, cell: (r) => <Dash value={r.warrantyUntil} /> },
  { id: 'statusChangedAt', header: 'Status since', sortable: true, cell: (r) => <DateCell value={r.statusChangedAt} relative /> },
];

/** Platform → Stock & Movements (Super Admin, read-only in Phase B; changes go through the API until B7). */
export function InventoryStockPage() {
  const locations = useEntityOptions<StockLocationDto>('/inventory/locations', locationOption);
  const filters = useMemo<MasterFilter[]>(
    () => [
      { key: 'stockStatus', label: 'Stock status', options: STATUS_OPTIONS },
      { key: 'locationId', label: 'Locations', options: locations.options },
      { key: 'mismatch', label: 'Assignment check', options: MISMATCH_OPTIONS },
    ],
    [locations.options],
  );
  return (
    <MasterPage
      menu="sa_inventory"
      title="Stock & Movements"
      description="Inventory status, location and history of each device. Customer assignment stays in Device Inventory."
      endpoint="/inventory/stock"
      columns={columns}
      rowLabel={(r) => r.uniqueId}
      getRowId={(r) => r.deviceId}
      filters={filters}
      statusFilter={false}
      defaultSort={{ id: 'uniqueId', desc: false }}
      readOnly
      bulkActions={false}
      emptyIcon={WarehouseIcon}
    />
  );
}

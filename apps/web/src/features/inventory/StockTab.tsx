import { useQuery } from '@tanstack/react-query';
import {
  INVENTORY_STATUS_LABELS,
  INVENTORY_STATUSES,
  statusHoldsLocation,
  type DeviceModelDto,
  type DeviceStockDto,
  type InventoryStatus,
  type StockLocationDto,
  type StockSummaryDto,
  type SupplierDto,
} from '@veetracer/shared';
import { ArrowRightLeftIcon, EyeIcon, FileUpIcon, ListChecksIcon, PackagePlusIcon, ReplaceIcon, SlidersHorizontalIcon, WarehouseIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import type { Option } from '@/components/ui/multi-select';
import { useAuth } from '@/features/auth/auth-context';
import { Dash, DateCell, Muted } from '@/features/masters/cells';
import { modelOption } from '@/features/masters/device-shared';
import { MasterPage } from '@/features/masters/MasterPage';
import type { MasterColumn, MasterFilter } from '@/features/masters/types';
import { useEntityOptions } from '@/features/masters/use-options';
import { api } from '@/lib/api';
import { i18n } from '@/lib/i18n';
import { formatRupees } from './inventory-format';
import { ImportDialog, ReceiveDialog } from './ReceiveImportDialogs';
import { LicenceBadge, locationOption, STOCK_STATUS_VARIANT, StatusChips, StockStatusBadge, supplierOption } from './shared';
import { AdjustDialog, ReplaceDialog, StatusDialog, TransferDialog } from './StockActionDialogs';
import { StockDetailSheet, type StockAction } from './StockDetailSheet';

const MISMATCH_OPTIONS: Option[] = [{ value: 'true', label: 'Differs from assignment' }];

function stockColumns(open: (r: DeviceStockDto) => void): MasterColumn<DeviceStockDto>[] {
  return [
    {
      id: 'uniqueId',
      header: 'IMEI / ID',
      sortable: true,
      hideable: false,
      cell: (r) => (
        <button type="button" onClick={() => open(r)} className="font-mono text-xs font-medium text-primary hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
          {r.uniqueId}
        </button>
      ),
    },
    { id: 'modelName', header: 'Model', cell: (r) => r.modelName },
    {
      id: 'status',
      header: 'Stock status',
      sortable: true,
      cell: (r) => (
        <span className="inline-flex items-center gap-1">
          <StockStatusBadge status={r.status} />
          {r.mismatch && (
            <Badge variant="warning" title={i18n.t('The device assignment says {{s}}', { s: INVENTORY_STATUS_LABELS[r.derivedStatus] })}>
              {i18n.t('Check')}
            </Badge>
          )}
        </span>
      ),
    },
    { id: 'location', header: 'Location', cell: (r) => (r.location ? `${r.location.code} · ${r.location.name}` : <Muted>{i18n.t('At customer')}</Muted>) },
    { id: 'holder', header: 'Held by partner', defaultHidden: true, cell: (r) => <Dash value={r.holderPartner?.name} /> },
    { id: 'company', header: 'Customer', cell: (r) => r.company?.name ?? <Muted>{i18n.t('Platform stock')}</Muted> },
    { id: 'object', header: 'Vehicle', cell: (r) => <Dash value={r.object?.name} /> },
    { id: 'licence', header: 'Licence', cell: (r) => <LicenceBadge licence={r.licence} /> },
    { id: 'serialNumber', header: 'Serial no.', defaultHidden: true, cell: (r) => <Dash value={r.serialNumber} /> },
    { id: 'supplierName', header: 'Supplier', defaultHidden: true, cell: (r) => <Dash value={r.supplierName} /> },
    { id: 'unitCostPaise', header: 'Unit cost', cell: (r) => (r.unitCostPaise === null ? <Muted>—</Muted> : <span className="tabular-nums">{formatRupees(r.unitCostPaise)}</span>) },
    { id: 'warrantyUntil', header: 'Warranty until', defaultHidden: true, cell: (r) => <Dash value={r.warrantyUntil} /> },
    { id: 'statusChangedAt', header: 'Status since', sortable: true, cell: (r) => <DateCell value={r.statusChangedAt} relative /> },
  ];
}

/** Stock list: status chips, filters, search, CSV export, receive / import, detail drawer and stock actions. */
export function StockTab() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const [status, setStatus] = useState<InventoryStatus | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [action, setAction] = useState<{ kind: StockAction; row: DeviceStockDto } | null>(null);
  const [receiving, setReceiving] = useState(false);
  const [importing, setImporting] = useState(false);
  const summary = useQuery({ queryKey: ['inventory', 'summary'], queryFn: () => api.get<StockSummaryDto>('/inventory/stock/summary') });
  const locations = useEntityOptions<StockLocationDto>('/inventory/locations', locationOption);
  const models = useEntityOptions<DeviceModelDto>('/device-models', modelOption);
  const suppliers = useEntityOptions<SupplierDto>('/inventory/suppliers', supplierOption);
  const filters = useMemo<MasterFilter[]>(
    () => [
      { key: 'locationId', label: 'Locations', options: locations.options },
      { key: 'modelId', label: 'Models', options: models.options },
      { key: 'supplierId', label: 'Suppliers', options: suppliers.options },
      { key: 'mismatch', label: 'Assignment check', options: MISMATCH_OPTIONS },
    ],
    [locations.options, models.options, suppliers.options],
  );
  const columns = useMemo(() => stockColumns((r) => setDetail(r.deviceId)), []);
  const fixedParams = useMemo(() => ({ stockStatus: status ?? undefined }), [status]);
  const canCreate = can('sa_inventory', 'create');
  const canEdit = can('sa_inventory', 'edit');
  const act = (kind: StockAction, row: DeviceStockDto) => setAction({ kind, row });
  const close = () => setAction(null);

  return (
    <>
      <MasterPage
        menu="sa_inventory"
        title="Stock"
        description="Every received device with its stock status, location and history. Customer assignment stays in Device Inventory."
        endpoint="/inventory/stock"
        columns={columns}
        rowLabel={(r) => r.uniqueId}
        getRowId={(r) => r.deviceId}
        filters={filters}
        statusFilter={false}
        fixedParams={fixedParams}
        defaultSort={{ id: 'uniqueId', desc: false }}
        readOnly
        bulkActions={false}
        emptyIcon={WarehouseIcon}
        aboveTable={
          <StatusChips statuses={INVENTORY_STATUSES} labels={INVENTORY_STATUS_LABELS} counts={summary.data?.byStatus} value={status} onChange={setStatus} variant={STOCK_STATUS_VARIANT} />
        }
        headerActions={
          canCreate && (
            <>
              <Button variant="outline" onClick={() => setImporting(true)}>
                <FileUpIcon /> <span className="hidden sm:inline">{t('Import CSV')}</span>
              </Button>
              <Button onClick={() => setReceiving(true)}>
                <PackagePlusIcon /> {t('Receive stock')}
              </Button>
            </>
          )
        }
        rowActions={(r) => (
          <>
            <DropdownMenuItem onSelect={() => setDetail(r.deviceId)}>
              <EyeIcon /> {t('Details & history')}
            </DropdownMenuItem>
            {canEdit && (
              <>
                <DropdownMenuItem onSelect={() => act('status', r)}>
                  <ListChecksIcon /> {t('Change status')}
                </DropdownMenuItem>
                {statusHoldsLocation(r.status) && (
                  <DropdownMenuItem onSelect={() => act('transfer', r)}>
                    <ArrowRightLeftIcon /> {t('Transfer')}
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onSelect={() => act('adjust', r)}>
                  <SlidersHorizontalIcon /> {t('Adjust')}
                </DropdownMenuItem>
                {r.object && (
                  <DropdownMenuItem onSelect={() => act('replace', r)}>
                    <ReplaceIcon /> {t('Replace on vehicle')}
                  </DropdownMenuItem>
                )}
              </>
            )}
          </>
        )}
      />
      <StockDetailSheet deviceId={detail} onClose={() => setDetail(null)} onAction={act} />
      <StatusDialog row={action?.kind === 'status' ? action.row : null} onOpenChange={(o) => !o && close()} />
      <TransferDialog row={action?.kind === 'transfer' ? action.row : null} onOpenChange={(o) => !o && close()} />
      <AdjustDialog row={action?.kind === 'adjust' ? action.row : null} onOpenChange={(o) => !o && close()} />
      <ReplaceDialog row={action?.kind === 'replace' ? action.row : null} onOpenChange={(o) => !o && close()} />
      <ReceiveDialog open={receiving} onOpenChange={setReceiving} />
      <ImportDialog open={importing} onOpenChange={setImporting} />
    </>
  );
}

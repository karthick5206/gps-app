import { zodResolver } from '@hookform/resolvers/zod';
import {
  INDIAN_STATES,
  STOCK_LOCATION_KINDS,
  STOCK_MOVEMENT_KINDS,
  type StockLocationDto,
  type StockMovementDto,
  type StockReceiptDto,
  type SupplierDto,
} from '@veetracer/shared';
import { FactoryIcon, HistoryIcon, MapPinnedIcon, ReceiptTextIcon } from 'lucide-react';
import { useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Badge } from '@/components/ui/badge';
import type { Option } from '@/components/ui/multi-select';
import { ActiveBadge, Dash, DateCell, Muted } from '@/features/masters/cells';
import { FormDialog, useSaveMutation } from '@/features/masters/FormDialog';
import { SelectField, SwitchField, TextField } from '@/features/masters/form-fields';
import { nullIfBlank, optionalText, requiredText, str } from '@/features/masters/form-schema';
import { MasterPage } from '@/features/masters/MasterPage';
import type { MasterColumn, MasterFilter, MasterFormProps } from '@/features/masters/types';
import { useEntityOptions } from '@/features/masters/use-options';
import { i18n } from '@/lib/i18n';
import { locationOption, MOVEMENT_KIND_LABELS, StockStatusBadge } from './shared';

const humanKind = (k: string) => k.charAt(0) + k.slice(1).toLowerCase().replace(/_/g, ' ');
const KIND_OPTIONS: Option[] = STOCK_LOCATION_KINDS.map((k) => ({ value: k, label: k === 'SUPPLIER_RMA' ? 'Supplier RMA' : humanKind(k) }));
const STATE_OPTIONS: Option[] = INDIAN_STATES.map((s) => ({ value: s.code, label: `${s.code} · ${s.name}` }));

// ───────────── Locations ─────────────

const locationSchema = z.object({
  kind: z.enum(STOCK_LOCATION_KINDS),
  code: z.string().trim().regex(/^[A-Za-z0-9_-]{1,20}$/, 'Code: 1-20 letters, digits, "-" or "_"'),
  name: requiredText(100),
  address: optionalText(300),
  stateCode: z.string(),
  isActive: z.boolean(),
});
type LocationValues = z.infer<typeof locationSchema>;

function LocationForm({ record, open, onOpenChange }: MasterFormProps<StockLocationDto>) {
  const form = useForm<LocationValues>({
    resolver: zodResolver(locationSchema),
    defaultValues: { kind: record?.kind ?? 'WAREHOUSE', code: str(record?.code), name: str(record?.name), address: str(record?.address), stateCode: str(record?.stateCode), isActive: record?.isActive ?? true },
  });
  const save = useSaveMutation({ endpoint: '/inventory/locations', id: record?.id ?? null, entity: 'Stock location', onSaved: () => onOpenChange(false) });
  const submit = form.handleSubmit((v) => save.mutate({ kind: v.kind, code: v.code.toUpperCase(), name: v.name, address: nullIfBlank(v.address), stateCode: v.stateCode || null, isActive: v.isActive }));
  return (
    <FormDialog open={open} onOpenChange={onOpenChange} title={record ? 'Edit stock location' : 'Add stock location'} pending={save.isPending} error={save.error} onSubmit={submit}>
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField form={form} name="kind" label="Kind" required options={KIND_OPTIONS} />
        <TextField form={form} name="code" label="Code" required placeholder="WH-CHN" />
        <TextField form={form} name="name" label="Name" required className="sm:col-span-2" placeholder="Chennai warehouse" />
        <TextField form={form} name="address" label="Address" multiline className="sm:col-span-2" />
        <SelectField form={form} name="stateCode" label="State (GST)" options={STATE_OPTIONS} />
      </div>
      <SwitchField form={form} name="isActive" label="Active" hint="Inactive locations keep their history but cannot receive stock." />
    </FormDialog>
  );
}

const locationColumns: MasterColumn<StockLocationDto>[] = [
  { id: 'code', header: 'Code', sortable: true, hideable: false, cell: (r) => <span className="font-mono text-xs font-medium">{r.code}</span> },
  { id: 'name', header: 'Name', sortable: true, cell: (r) => <span className="font-medium">{r.name}</span> },
  { id: 'kind', header: 'Kind', sortable: true, cell: (r) => <Badge variant="secondary">{i18n.t(KIND_OPTIONS.find((k) => k.value === r.kind)?.label ?? r.kind)}</Badge> },
  { id: 'address', header: 'Address', defaultHidden: true, cell: (r) => <Dash value={r.address} /> },
  { id: 'stateCode', header: 'State', cell: (r) => <Dash value={r.stateCode} /> },
  { id: 'deviceCount', header: 'Devices', cell: (r) => <span className="tabular-nums">{r.deviceCount}</span> },
  { id: 'isActive', header: 'Status', cell: (r) => <ActiveBadge active={r.isActive} /> },
];

export function LocationsTab() {
  return (
    <MasterPage
      menu="sa_inventory"
      title="Stock locations"
      description="Warehouses, technician vans, in-transit, supplier RMA and scrap. Locations with history cannot be deleted; deactivate them."
      endpoint="/inventory/locations"
      columns={locationColumns}
      rowLabel={(r) => `${r.code} · ${r.name}`}
      Form={LocationForm}
      history={false}
      bulkActions={false}
      defaultSort={{ id: 'code', desc: false }}
      emptyIcon={MapPinnedIcon}
    />
  );
}

// ───────────── Suppliers ─────────────

const supplierSchema = z.object({
  name: requiredText(120),
  gstin: z.string().trim().refine((v) => v === '' || /^[0-9A-Z]{15}$/.test(v.toUpperCase()), 'GSTIN has 15 letters / digits'),
  stateCode: z.string(),
  phone: optionalText(40),
  email: optionalText(120),
  person: optionalText(120),
  isActive: z.boolean(),
});
type SupplierValues = z.infer<typeof supplierSchema>;

function SupplierForm({ record, open, onOpenChange }: MasterFormProps<SupplierDto>) {
  const form = useForm<SupplierValues>({
    resolver: zodResolver(supplierSchema),
    defaultValues: {
      name: str(record?.name),
      gstin: str(record?.gstin),
      stateCode: str(record?.stateCode),
      phone: str(record?.contact.phone),
      email: str(record?.contact.email),
      person: str(record?.contact.person),
      isActive: record?.isActive ?? true,
    },
  });
  const save = useSaveMutation({ endpoint: '/inventory/suppliers', id: record?.id ?? null, entity: 'Supplier', onSaved: () => onOpenChange(false) });
  const submit = form.handleSubmit((v) => {
    const contact: Record<string, string> = {};
    if (v.person.trim()) contact.person = v.person.trim();
    if (v.phone.trim()) contact.phone = v.phone.trim();
    if (v.email.trim()) contact.email = v.email.trim();
    save.mutate({ name: v.name, gstin: v.gstin ? v.gstin.toUpperCase() : null, stateCode: v.stateCode || null, contact, isActive: v.isActive });
  });
  return (
    <FormDialog open={open} onOpenChange={onOpenChange} title={record ? 'Edit supplier' : 'Add supplier'} pending={save.isPending} error={save.error} onSubmit={submit}>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField form={form} name="name" label="Name" required className="sm:col-span-2" />
        <TextField form={form} name="gstin" label="GSTIN" placeholder="29ABCDE1234F1Z5" />
        <SelectField form={form} name="stateCode" label="State (GST)" options={STATE_OPTIONS} />
        <TextField form={form} name="person" label="Contact person" />
        <TextField form={form} name="phone" label="Phone" />
        <TextField form={form} name="email" label="Email" type="email" className="sm:col-span-2" />
      </div>
      <SwitchField form={form} name="isActive" label="Active" />
    </FormDialog>
  );
}

const supplierColumns: MasterColumn<SupplierDto>[] = [
  { id: 'name', header: 'Name', sortable: true, hideable: false, cell: (r) => <span className="font-medium">{r.name}</span> },
  { id: 'gstin', header: 'GSTIN', cell: (r) => (r.gstin ? <span className="font-mono text-xs">{r.gstin}</span> : <Muted>—</Muted>) },
  { id: 'stateCode', header: 'State', cell: (r) => <Dash value={r.stateCode} /> },
  { id: 'contact', header: 'Contact', cell: (r) => <Dash value={[r.contact.person, r.contact.phone, r.contact.email].filter(Boolean).join(' · ') || null} /> },
  { id: 'isActive', header: 'Status', cell: (r) => <ActiveBadge active={r.isActive} /> },
];

export function SuppliersTab() {
  return (
    <MasterPage
      menu="sa_inventory"
      title="Suppliers"
      description="Hardware suppliers used on goods receipts."
      endpoint="/inventory/suppliers"
      columns={supplierColumns}
      rowLabel={(r) => r.name}
      Form={SupplierForm}
      history={false}
      bulkActions={false}
      defaultSort={{ id: 'name', desc: false }}
      emptyIcon={FactoryIcon}
    />
  );
}

// ───────────── Receipts ─────────────

const receiptColumns: MasterColumn<StockReceiptDto>[] = [
  { id: 'receivedAt', header: 'Received', sortable: true, hideable: false, cell: (r) => <DateCell value={r.receivedAt} /> },
  { id: 'supplier', header: 'Supplier', cell: (r) => <Dash value={r.supplier?.name} /> },
  { id: 'supplierInvoiceNo', header: 'Invoice no.', cell: (r) => <Dash value={r.supplierInvoiceNo} /> },
  { id: 'supplierInvoiceAt', header: 'Invoice date', cell: (r) => <Dash value={r.supplierInvoiceAt} /> },
  { id: 'location', header: 'Location', cell: (r) => `${r.location.code} · ${r.location.name}` },
  { id: 'itemCount', header: 'Devices', cell: (r) => <span className="tabular-nums">{r.itemCount}</span> },
  { id: 'source', header: 'Source', cell: (r) => <Badge variant={r.source === 'CSV_IMPORT' ? 'info' : 'secondary'}>{r.source === 'CSV_IMPORT' ? i18n.t('CSV import') : i18n.t('Manual')}</Badge> },
  { id: 'note', header: 'Note', defaultHidden: true, cell: (r) => <Dash value={r.note} /> },
];

export function ReceiptsTab() {
  const locations = useEntityOptions<StockLocationDto>('/inventory/locations', locationOption);
  const filters = useMemo<MasterFilter[]>(() => [{ key: 'locationId', label: 'Locations', options: locations.options }], [locations.options]);
  return (
    <MasterPage
      menu="sa_inventory"
      title="Goods receipts"
      description="Each receipt (manual or CSV import) with supplier, invoice and number of devices."
      endpoint="/inventory/receipts"
      columns={receiptColumns}
      rowLabel={(r) => r.supplierInvoiceNo ?? r.receivedAt.slice(0, 10)}
      filters={filters}
      statusFilter={false}
      readOnly
      bulkActions={false}
      defaultSort={{ id: 'receivedAt', desc: true }}
      emptyIcon={ReceiptTextIcon}
    />
  );
}

// ───────────── Movements ─────────────

const KIND_FILTER: Option[] = STOCK_MOVEMENT_KINDS.map((k) => ({ value: k, label: MOVEMENT_KIND_LABELS[k] }));

const movementColumns: MasterColumn<StockMovementDto>[] = [
  { id: 'at', header: 'When', sortable: true, hideable: false, cell: (r) => <DateCell value={r.at} /> },
  { id: 'itemRef', header: 'IMEI', sortable: true, cell: (r) => <span className="font-mono text-xs">{r.itemRef}</span> },
  { id: 'kind', header: 'Movement', sortable: true, cell: (r) => i18n.t(MOVEMENT_KIND_LABELS[r.kind]) },
  {
    id: 'status',
    header: 'Status',
    cell: (r) => (
      <span className="inline-flex items-center gap-1">
        {r.fromStatus && r.fromStatus !== r.toStatus && (
          <>
            <StockStatusBadge status={r.fromStatus} /> <span className="text-muted-foreground">→</span>
          </>
        )}
        <StockStatusBadge status={r.toStatus} />
      </span>
    ),
  },
  { id: 'route', header: 'From → to', cell: (r) => (r.fromLocation || r.toLocation ? `${r.fromLocation?.code ?? '—'} → ${r.toLocation?.code ?? '—'}` : <Muted>—</Muted>) },
  { id: 'company', header: 'Customer / vehicle', cell: (r) => <Dash value={[r.companyName, r.objectName].filter(Boolean).join(' · ') || null} /> },
  { id: 'reason', header: 'Reason', cell: (r) => <Dash value={r.reason} /> },
  { id: 'reference', header: 'Reference', cell: (r) => <Dash value={r.reference} /> },
  { id: 'createdByName', header: 'By', cell: (r) => <Dash value={r.createdByName} /> },
];

export function MovementsTab() {
  const locations = useEntityOptions<StockLocationDto>('/inventory/locations', locationOption);
  const filters = useMemo<MasterFilter[]>(
    () => [
      { key: 'kind', label: 'Movement', options: KIND_FILTER },
      { key: 'locationId', label: 'Locations', options: locations.options },
      { kind: 'date', key: 'from', label: 'From', bound: 'start' },
      { kind: 'date', key: 'to', label: 'To', bound: 'end' },
    ],
    [locations.options],
  );
  return (
    <MasterPage
      menu="sa_inventory"
      title="Movement ledger"
      description="Append-only history of every stock change: who, when, from / to, reason and reference."
      endpoint="/inventory/movements"
      columns={movementColumns}
      rowLabel={(r) => r.itemRef}
      filters={filters}
      statusFilter={false}
      readOnly
      bulkActions={false}
      defaultSort={{ id: 'at', desc: true }}
      emptyIcon={HistoryIcon}
    />
  );
}

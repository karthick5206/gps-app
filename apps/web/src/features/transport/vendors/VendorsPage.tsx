import { zodResolver } from '@hookform/resolvers/zod';
import type { BranchDto, DriverDto, TrackedObjectDto, TransportVendorAssetsDto, TransportVendorDto } from '@veetracer/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CarFrontIcon, ReceiptIndianRupeeIcon, TruckIcon } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { Field } from '@/components/ui/field';
import { MultiSelect } from '@/components/ui/multi-select';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { useAuth } from '@/features/auth/auth-context';
import { ActiveBadge, Muted } from '@/features/masters/cells';
import { FormDialog, useSaveMutation } from '@/features/masters/FormDialog';
import { MultiSelectField, SwitchField, TextField } from '@/features/masters/form-fields';
import { nullIfBlank, str } from '@/features/masters/form-schema';
import { MasterPage } from '@/features/masters/MasterPage';
import type { MasterColumn, MasterFormProps } from '@/features/masters/types';
import { named, useEntityOptions } from '@/features/masters/use-options';
import { api, errorMessage } from '@/lib/api';
import { RateCardsSheet } from './RateCardsSheet';

export const VENDORS_ENDPOINT = '/transport/vendors';

const schema = z.object({
  name: z.string().trim().min(1, 'Required').max(160),
  gstin: z.string().trim().toUpperCase().refine((v) => !v || /^[0-9A-Z]{15}$/.test(v), 'GSTIN must be 15 letters / digits'),
  pan: z.string().trim().toUpperCase().refine((v) => !v || /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(v), 'PAN must look like ABCDE1234F'),
  contactName: z.string().max(120),
  phone: z.string().max(30),
  email: z.string().trim().refine((v) => !v || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), 'Enter a valid e-mail'),
  address: z.string().max(500),
  bankName: z.string().max(120),
  bankAccount: z.string().max(40),
  ifsc: z.string().trim().toUpperCase().refine((v) => !v || /^[A-Z]{4}0[A-Z0-9]{6}$/.test(v), 'IFSC must look like HDFC0001234'),
  upiId: z.string().max(80),
  branchIds: z.array(z.string()),
  notes: z.string().max(1000),
  isActive: z.boolean(),
});
type Values = z.infer<typeof schema>;

function VendorForm({ record, open, onOpenChange }: MasterFormProps<TransportVendorDto>) {
  const { can } = useAuth();
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    values: {
      name: str(record?.name),
      gstin: str(record?.gstin),
      pan: str(record?.pan),
      contactName: str(record?.contactName),
      phone: str(record?.phone),
      email: str(record?.email),
      address: str(record?.address),
      bankName: str(record?.bankName),
      bankAccount: str(record?.bankAccount),
      ifsc: str(record?.ifsc),
      upiId: str(record?.upiId),
      branchIds: record?.branchIds ?? [],
      notes: str(record?.notes),
      isActive: record?.isActive ?? true,
    },
  });
  const branches = useEntityOptions<BranchDto>('/branches', named, { enabled: open && can('branches') });
  const save = useSaveMutation({ endpoint: VENDORS_ENDPOINT, id: record?.id ?? null, entity: 'Vendor', onSaved: () => onOpenChange(false) });
  const submit = form.handleSubmit((v) =>
    save.mutate({
      name: v.name.trim(),
      gstin: nullIfBlank(v.gstin),
      pan: nullIfBlank(v.pan),
      contactName: nullIfBlank(v.contactName),
      phone: nullIfBlank(v.phone),
      email: nullIfBlank(v.email),
      address: nullIfBlank(v.address),
      bankName: nullIfBlank(v.bankName),
      bankAccount: nullIfBlank(v.bankAccount),
      ifsc: nullIfBlank(v.ifsc),
      upiId: nullIfBlank(v.upiId),
      branchIds: v.branchIds,
      notes: nullIfBlank(v.notes),
      isActive: v.isActive,
    }),
  );
  return (
    <FormDialog open={open} onOpenChange={onOpenChange} title={record ? 'Edit vendor' : 'Add vendor'} description="A cab operator that runs your employee transport. Only the name is required." wide pending={save.isPending} error={save.error} onSubmit={submit}>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField form={form} name="name" label="Vendor name" required className="sm:col-span-2" />
        <TextField form={form} name="gstin" label="GSTIN" placeholder="33ABCDE1234F1Z5" />
        <TextField form={form} name="pan" label="PAN" placeholder="ABCDE1234F" />
        <TextField form={form} name="contactName" label="Contact person" />
        <TextField form={form} name="phone" label="Phone" />
        <TextField form={form} name="email" label="E-mail" />
        <TextField form={form} name="address" label="Address" />
        {can('branches') && <MultiSelectField form={form} name="branchIds" label="Branches served" options={branches.options} loading={branches.loading} placeholder="All branches" hint="Leave empty if the vendor serves every branch." className="sm:col-span-2" />}
        <TextField form={form} name="bankName" label="Bank" />
        <TextField form={form} name="bankAccount" label="Account number" />
        <TextField form={form} name="ifsc" label="IFSC" placeholder="HDFC0001234" />
        <TextField form={form} name="upiId" label="UPI ID" />
        <TextField form={form} name="notes" label="Notes" className="sm:col-span-2" />
      </div>
      <SwitchField form={form} name="isActive" label="Active" />
    </FormDialog>
  );
}

const columns: MasterColumn<TransportVendorDto>[] = [
  { id: 'name', header: 'Vendor', sortable: true, hideable: false, cell: (r) => <span className="font-medium">{r.name}</span> },
  { id: 'gstin', header: 'GSTIN', cell: (r) => (r.gstin ? <span className="font-mono text-xs">{r.gstin}</span> : <Muted>—</Muted>) },
  { id: 'contact', header: 'Contact', cell: (r) => <span className="text-sm">{[r.contactName, r.phone].filter(Boolean).join(' · ') || '—'}</span> },
  { id: 'branches', header: 'Branches', cell: (r) => <span className="text-xs">{r.branchNames.length ? r.branchNames.join(', ') : 'All'}</span> },
  { id: 'fleet', header: 'Vehicles / drivers', cell: (r) => <span className="tabular-nums">{r.vehicleCount} / {r.driverCount}</span> },
  { id: 'cards', header: 'Rate cards', cell: (r) => <span className="tabular-nums">{r.rateCardCount}</span> },
  { id: 'isActive', header: 'Status', cell: (r) => <ActiveBadge active={r.isActive} /> },
];

/** The vendor's vehicles (any type, car … bus) and drivers. A vehicle / driver moves from another vendor when picked here. */
function AssetsSheet({ vendor, onClose }: { vendor: TransportVendorDto | null; onClose: () => void }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const qc = useQueryClient();
  const open = !!vendor;
  const data = useQuery({ queryKey: ['vendor-assets', vendor?.id], enabled: open, queryFn: ({ signal }) => api.get<TransportVendorAssetsDto>(`${VENDORS_ENDPOINT}/${vendor!.id}/assets`, undefined, signal) });
  const [qv, setQv] = useState('');
  const [qd, setQd] = useState('');
  const vehicles = useEntityOptions<TrackedObjectDto>('/objects', (o) => ({ value: o.id, label: o.plateNumber && o.plateNumber !== o.name ? `${o.name} · ${o.plateNumber}` : o.name }), { q: qv, enabled: open, params: { type: 'VEHICLE' } });
  const drivers = useEntityOptions<DriverDto>('/drivers', named, { q: qd, enabled: open && can('drivers') });
  const [objectIds, setObjectIds] = useState<string[]>([]);
  const [driverIds, setDriverIds] = useState<string[]>([]);
  useEffect(() => {
    if (!data.data) return;
    setObjectIds(data.data.vehicles.map((v) => v.objectId));
    setDriverIds(data.data.drivers.map((d) => d.driverId));
  }, [data.data]);
  const selectedVehicles = useMemo(() => (data.data?.vehicles ?? []).map((v) => ({ value: v.objectId, label: v.plateNumber ? `${v.name} · ${v.plateNumber}` : v.name })), [data.data]);
  const selectedDrivers = useMemo(() => (data.data?.drivers ?? []).map((d) => ({ value: d.driverId, label: d.name })), [data.data]);
  const save = useMutation({
    mutationFn: () => api.put<TransportVendorAssetsDto>(`${VENDORS_ENDPOINT}/${vendor!.id}/assets`, { objectIds, driverIds }),
    onSuccess: () => {
      toast.success(t('Vehicles and drivers saved'));
      void qc.invalidateQueries({ queryKey: ['vendor-assets'] });
      void qc.invalidateQueries({ queryKey: ['master', VENDORS_ENDPOINT] });
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const editable = can('etms_vendors', 'edit');
  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>{t('Vehicles & drivers')}</SheetTitle>
          <SheetDescription>{vendor?.name}</SheetDescription>
        </SheetHeader>
        <div className="grid gap-4 overflow-y-auto px-4 pb-4">
          <Field label={t('Vehicles')} hint={t('Cars, vans, tempo travellers, buses … Seats and category are set on each vehicle (Masters → Objects).')}>
            <MultiSelect value={objectIds} onChange={setObjectIds} options={vehicles.options} selectedOptions={selectedVehicles} loading={vehicles.loading} onSearch={setQv} disabled={!editable} placeholder={t('No vehicles')} />
          </Field>
          {data.data?.vehicles.length ? (
            <ul className="divide-y rounded-lg border text-sm">
              {data.data.vehicles.map((v) => (
                <li key={v.objectId} className="flex items-center justify-between gap-2 px-3 py-1.5">
                  <span>
                    {v.name}
                    {v.plateNumber && <span className="text-muted-foreground"> · {v.plateNumber}</span>}
                  </span>
                  <span className="text-xs text-muted-foreground">{[v.category, v.seats ? t('{{n}} seats', { n: v.seats }) : null].filter(Boolean).join(' · ') || '—'}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {can('drivers') && (
            <Field label={t('Drivers')}>
              <MultiSelect value={driverIds} onChange={setDriverIds} options={drivers.options} selectedOptions={selectedDrivers} loading={drivers.loading} onSearch={setQd} disabled={!editable} placeholder={t('No drivers')} />
            </Field>
          )}
          {editable && (
            <Button onClick={() => save.mutate()} disabled={save.isPending} className="justify-self-start">
              {t('Save')}
            </Button>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

/**
 * Transport → Vendors & rate cards (menu etms_vendors, v1.16.9): cab operators with GST / PAN / bank details and the
 * branches they serve, their vehicles and drivers, and their rate cards (per trip, km, slab, monthly, package, seat).
 */
export function VendorsPage() {
  const { t } = useTranslation();
  const [assets, setAssets] = useState<TransportVendorDto | null>(null);
  const [cards, setCards] = useState<TransportVendorDto | null>(null);
  return (
    <>
      <MasterPage<TransportVendorDto>
        menu="etms_vendors"
        title="Vendors & rate cards"
        description="Cab operators that run your employee transport, the branches they serve, their vehicles and drivers, and how they are paid."
        endpoint={VENDORS_ENDPOINT}
        columns={columns}
        rowLabel={(r) => r.name}
        defaultSort={{ id: 'name', desc: false }}
        Form={VendorForm}
        bulkActions={false}
        history={false}
        emptyIcon={TruckIcon}
        rowActions={(r) => (
          <>
            <DropdownMenuItem onSelect={() => setAssets(r)}>
              <CarFrontIcon /> {t('Vehicles & drivers')}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setCards(r)}>
              <ReceiptIndianRupeeIcon /> {t('Rate cards')}
            </DropdownMenuItem>
          </>
        )}
      />
      <AssetsSheet vendor={assets} onClose={() => setAssets(null)} />
      <RateCardsSheet vendor={cards} onClose={() => setCards(null)} />
    </>
  );
}

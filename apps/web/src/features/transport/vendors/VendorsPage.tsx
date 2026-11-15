import { zodResolver } from '@hookform/resolvers/zod';
import type { BranchDto, TransportVendorDto } from '@veetracer/shared';
import { CarFrontIcon, ReceiptIndianRupeeIcon, TruckIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { useAuth } from '@/features/auth/auth-context';
import { ActiveBadge, Muted } from '@/features/masters/cells';
import { FormDialog, useSaveMutation } from '@/features/masters/FormDialog';
import { MultiSelectField, SwitchField, TextField } from '@/features/masters/form-fields';
import { nullIfBlank, str } from '@/features/masters/form-schema';
import { MasterPage } from '@/features/masters/MasterPage';
import type { MasterColumn, MasterFormProps } from '@/features/masters/types';
import { named, useEntityOptions } from '@/features/masters/use-options';
import { RateCardsSheet } from './RateCardsSheet';
import { VendorSetupSheet } from './VendorSetupSheet';

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
  { id: 'name', header: 'Vendor', sortable: true, hideable: false, cell: (r) => <Link to={`/vendors/${r.id}`} className="font-medium text-primary hover:underline">{r.name}</Link> },
  { id: 'gstin', header: 'GSTIN', cell: (r) => (r.gstin ? <span className="font-mono text-xs">{r.gstin}</span> : <Muted>—</Muted>) },
  { id: 'contact', header: 'Contact', cell: (r) => <span className="text-sm">{[r.contactName, r.phone].filter(Boolean).join(' · ') || '—'}</span> },
  { id: 'branches', header: 'Branches', cell: (r) => <span className="text-xs">{r.branchNames.length ? r.branchNames.join(', ') : 'All'}</span> },
  { id: 'isActive', header: 'Status', cell: (r) => <ActiveBadge active={r.isActive} /> },
];

/**
 * Transport → Vendors & rate cards (menu etms_vendors, v1.16.9): cab operators with GST / PAN / bank details and the
 * branches they serve, their vehicles and drivers, and their rate cards (per trip, km, slab, monthly, package, seat).
 */
export function VendorsPage() {
  const { t } = useTranslation();
  const [setup, setSetup] = useState<{ vendor: TransportVendorDto; tab: string } | null>(null);
  const [cards, setCards] = useState<TransportVendorDto | null>(null);
  // v1.16.12: one page per vendor (everything visible); the row buttons open it.
  const navigate = useNavigate();
  const setAssets = (v: TransportVendorDto) => navigate(`/vendors/${v.id}`);
  const setRates = (v: TransportVendorDto) => navigate(`/vendors/${v.id}`);
  // The links are buttons in the row: vehicles / drivers and rate cards open their panels.
  const cols = useMemo<MasterColumn<TransportVendorDto>[]>(
    () => [
      ...columns.slice(0, 4),
      {
        id: 'fleet',
        header: 'Vehicles / drivers',
        cell: (r) => (
          <Button size="sm" variant="outline" className="h-7 tabular-nums" onClick={() => setAssets(r)}>
            <CarFrontIcon /> {r.vehicleCount} / {r.driverCount}
          </Button>
        ),
      },
      {
        id: 'cards',
        header: 'Rate cards',
        cell: (r) => (
          <Button size="sm" variant="outline" className="h-7 tabular-nums" onClick={() => setRates(r)}>
            <ReceiptIndianRupeeIcon /> {r.rateCardCount}
          </Button>
        ),
      },
      ...columns.slice(4),
    ],
    [],
  );
  const guide = (
    <ol className="grid gap-2 rounded-lg border bg-card p-3 text-sm sm:grid-cols-3">
      <li>
        <span className="font-semibold text-primary">1. {t('Add the vendor')}</span>
        <span className="block text-xs text-muted-foreground">{t('Name, GST, bank and the branches they serve (Add).')}</span>
      </li>
      <li>
        <span className="font-semibold text-primary">2. {t('Link vehicles & drivers')}</span>
        <span className="block text-xs text-muted-foreground">{t('Click the vendor name: add vehicles, set each one’s type (Hatchback, Sedan, SUV, Tempo, Bus…) and seats, and the drivers, on one page.')}</span>
      </li>
      <li>
        <span className="font-semibold text-primary">3. {t('Add rate cards')}</span>
        <span className="block text-xs text-muted-foreground">{t('On the same page, enter one rate per vehicle type (per trip or per km). Each vehicle shows the rate it will be billed at.')}</span>
      </li>
    </ol>
  );
  return (
    <>
      <MasterPage<TransportVendorDto>
        menu="etms_vendors"
        title="Vendors & rate cards"
        description="Cab operators that run your employee transport, the branches they serve, their vehicles and drivers, and how they are paid."
        endpoint={VENDORS_ENDPOINT}
        columns={cols}
        aboveTable={guide}
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
            <DropdownMenuItem onSelect={() => setSetup({ vendor: r, tab: 'branches' })}>
              <TruckIcon /> {t('Vendor setup')}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setCards(r)}>
              <ReceiptIndianRupeeIcon /> {t('Rate cards')}
            </DropdownMenuItem>
          </>
        )}
      />
      <VendorSetupSheet vendor={setup?.vendor ?? null} tab={setup?.tab ?? 'branches'} onClose={() => setSetup(null)} onAdvanced={(v) => (setSetup(null), setCards(v))} />
      <RateCardsSheet vendor={cards} onClose={() => setCards(null)} />
    </>
  );
}

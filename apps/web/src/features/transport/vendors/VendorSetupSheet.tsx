import { TRANSPORT_VEHICLE_CATEGORIES, type BranchDto, type DriverDto, type TrackedObjectDto, type TransportRateCardDto, type TransportVendorAssetsDto, type TransportVendorDto } from '@veetracer/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { MultiSelect } from '@/components/ui/multi-select';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAuth } from '@/features/auth/auth-context';
import { named, useEntityOptions } from '@/features/masters/use-options';
import { api, errorMessage } from '@/lib/api';
import { humanize } from '@/lib/format';
import { cn } from '@/lib/utils';

const V = (id: string) => `/transport/vendors/${id}`;
const today = () => new Date().toISOString().slice(0, 10);
const sel = 'h-8 w-full rounded-md border border-input bg-card px-2 text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none';

/**
 * One vendor, set up in order (v1.16.10): 1 Branches · 2 Vehicles (type + seats inline) · 3 Drivers · 4 Rates (one row
 * per vehicle type, per trip or per km). Uses the same APIs as the detailed panels; "Advanced rate cards" keeps the
 * slab / monthly / package models.
 */
export function VendorSetupSheet({ vendor, tab, onClose, onAdvanced }: { vendor: TransportVendorDto | null; tab: string; onClose: () => void; onAdvanced: (v: TransportVendorDto) => void }) {
  const { t } = useTranslation();
  const [current, setCurrent] = useState(tab);
  useEffect(() => setCurrent(tab), [tab, vendor?.id]);
  return (
    <Sheet open={!!vendor} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full sm:max-w-3xl">
        <SheetHeader>
          <SheetTitle>{t('Vendor setup')}</SheetTitle>
          <SheetDescription>{vendor?.name}</SheetDescription>
        </SheetHeader>
        {vendor && (
          <Tabs value={current} onValueChange={setCurrent} className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 pb-4">
            <TabsList className="grid w-full grid-cols-4">
              <TabsTrigger value="branches">1 · {t('Branches')}</TabsTrigger>
              <TabsTrigger value="vehicles">2 · {t('Vehicles')}</TabsTrigger>
              <TabsTrigger value="drivers">3 · {t('Drivers')}</TabsTrigger>
              <TabsTrigger value="rates">4 · {t('Rates')}</TabsTrigger>
            </TabsList>
            <TabsContent value="branches">
              <BranchesTab vendor={vendor} next={() => setCurrent('vehicles')} />
            </TabsContent>
            <TabsContent value="vehicles">
              <VehiclesTab vendor={vendor} next={() => setCurrent('drivers')} />
            </TabsContent>
            <TabsContent value="drivers">
              <DriversTab vendor={vendor} next={() => setCurrent('rates')} />
            </TabsContent>
            <TabsContent value="rates">
              <RatesTab vendor={vendor} onAdvanced={() => onAdvanced(vendor)} />
            </TabsContent>
          </Tabs>
        )}
      </SheetContent>
    </Sheet>
  );
}

function useRefresh(vendorId: string) {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ['vendor-assets', vendorId] });
    void qc.invalidateQueries({ queryKey: ['rate-cards', vendorId] });
    void qc.invalidateQueries({ queryKey: ['master', '/transport/vendors'] });
  };
}

function useAssets(vendorId: string) {
  return useQuery({ queryKey: ['vendor-assets', vendorId], queryFn: ({ signal }) => api.get<TransportVendorAssetsDto>(`${V(vendorId)}/assets`, undefined, signal) });
}

export function BranchesTab({ vendor, next }: { vendor: TransportVendorDto; next?: () => void }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const refresh = useRefresh(vendor.id);
  const branches = useEntityOptions<BranchDto>('/branches', named, { enabled: can('branches') });
  const [ids, setIds] = useState<string[]>(vendor.branchIds);
  const save = useMutation({
    mutationFn: () => api.patch(V(vendor.id), { branchIds: ids }),
    onSuccess: () => {
      toast.success(t('Branches saved'));
      refresh();
      next?.();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <div className="grid gap-3">
      <p className="text-sm text-muted-foreground">{t('Which of your branches does this vendor serve? Leave empty for all branches.')}</p>
      <MultiSelect value={ids} onChange={setIds} options={branches.options} loading={branches.loading} placeholder={t('All branches')} disabled={!can('etms_vendors', 'edit')} />
      {can('etms_vendors', 'edit') && (
        <Button className="justify-self-start" onClick={() => save.mutate()} disabled={save.isPending}>
          {next ? t('Save and next') : t('Save')}
        </Button>
      )}
    </div>
  );
}

export function VehiclesTab({ vendor, next, rateOf }: { vendor: TransportVendorDto; next?: () => void; rateOf?: (category: string) => string }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const refresh = useRefresh(vendor.id);
  const assets = useAssets(vendor.id);
  const [q, setQ] = useState('');
  const options = useEntityOptions<TrackedObjectDto>('/objects', (o) => ({ value: o.id, label: o.plateNumber && o.plateNumber !== o.name ? `${o.name} · ${o.plateNumber}` : o.name }), { q, params: { type: 'VEHICLE' } });
  const [ids, setIds] = useState<string[]>([]);
  const [rows, setRows] = useState<Record<string, { category: string; seats: string }>>({});
  useEffect(() => {
    if (!assets.data) return;
    setIds(assets.data.vehicles.map((v) => v.objectId));
    setRows(Object.fromEntries(assets.data.vehicles.map((v) => [v.objectId, { category: v.category ?? '', seats: v.seats ? String(v.seats) : '' }])));
  }, [assets.data]);
  const selected = useMemo(() => (assets.data?.vehicles ?? []).map((v) => ({ value: v.objectId, label: v.plateNumber ? `${v.name} · ${v.plateNumber}` : v.name })), [assets.data]);
  const names = useMemo(() => new Map([...selected, ...options.options].map((o) => [o.value, o.label])), [selected, options.options]);
  const editable = can('etms_vendors', 'edit');
  const save = useMutation({
    mutationFn: async () => {
      await api.put(`${V(vendor.id)}/assets`, { objectIds: ids, driverIds: (assets.data?.drivers ?? []).map((d) => d.driverId) });
      // Type + seats per vehicle (seats are what make the transport profile; rows without seats are skipped).
      for (const id of ids) {
        const r = rows[id];
        const seats = Number(r?.seats);
        if (r && Number.isInteger(seats) && seats >= 1 && seats <= 100) await api.put(`/transport/vehicles/${id}/profile`, { seats, category: r.category || null });
      }
    },
    onSuccess: () => {
      toast.success(t('Vehicles saved'));
      refresh();
      next?.();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <div className="grid gap-3">
      <p className="text-sm text-muted-foreground">{t('Pick the vendor’s vehicles, then set each one’s type and seats. The type decides which rate applies.')}</p>
      <MultiSelect value={ids} onChange={setIds} options={options.options} selectedOptions={selected} loading={options.loading} onSearch={setQ} placeholder={t('Add vehicles…')} disabled={!editable} />
      {ids.length > 0 && (
        <table className="w-full text-sm">
          <thead className="text-xs text-muted-foreground uppercase">
            <tr>
              <th className="py-1 text-left font-medium">{t('Vehicle')}</th>
              <th className="w-44 py-1 text-left font-medium">{t('Type')}</th>
              <th className="w-24 py-1 text-left font-medium">{t('Seats')}</th>
              {rateOf && <th className="py-1 pl-3 text-left font-medium">{t('Rate applied')}</th>}
            </tr>
          </thead>
          <tbody>
            {ids.map((id) => {
              const r = rows[id] ?? { category: '', seats: '' };
              return (
                <tr key={id} className="border-t">
                  <td className="py-1.5">{names.get(id) ?? id}</td>
                  <td className="py-1.5 pr-2">
                    <select className={sel} value={r.category} disabled={!editable} onChange={(e) => setRows({ ...rows, [id]: { ...r, category: e.target.value } })} aria-label={t('Type')}>
                      <option value="">{t('Choose')}</option>
                      {TRANSPORT_VEHICLE_CATEGORIES.map((c) => (
                        <option key={c} value={c}>
                          {t(humanize(c))}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="py-1.5">
                    <Input type="number" min={1} max={100} value={r.seats} disabled={!editable} onChange={(e) => setRows({ ...rows, [id]: { ...r, seats: e.target.value } })} className="h-8" aria-label={t('Seats')} />
                  </td>
                  {rateOf && <td className="py-1.5 pl-3 text-sm">{r.category ? rateOf(r.category) : <span className="text-muted-foreground">{t('Choose a type')}</span>}</td>}
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {editable && (
        <Button className="justify-self-start" onClick={() => save.mutate()} disabled={save.isPending}>
          {next ? t('Save and next') : t('Save')}
        </Button>
      )}
    </div>
  );
}

export function DriversTab({ vendor, next }: { vendor: TransportVendorDto; next?: () => void }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const refresh = useRefresh(vendor.id);
  const assets = useAssets(vendor.id);
  const [q, setQ] = useState('');
  const options = useEntityOptions<DriverDto>('/drivers', named, { q, enabled: can('drivers') });
  const [ids, setIds] = useState<string[]>([]);
  useEffect(() => {
    if (assets.data) setIds(assets.data.drivers.map((d) => d.driverId));
  }, [assets.data]);
  const selected = useMemo(() => (assets.data?.drivers ?? []).map((d) => ({ value: d.driverId, label: d.name })), [assets.data]);
  const save = useMutation({
    mutationFn: () => api.put(`${V(vendor.id)}/assets`, { objectIds: (assets.data?.vehicles ?? []).map((v) => v.objectId), driverIds: ids }),
    onSuccess: () => {
      toast.success(t('Drivers saved'));
      refresh();
      next?.();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  if (!can('drivers')) return <p className="text-sm text-muted-foreground">{t('Your role cannot see drivers.')}</p>;
  return (
    <div className="grid gap-3">
      <p className="text-sm text-muted-foreground">{t('The drivers employed by this vendor. A driver can drive any of the vendor’s vehicles; you choose the driver per trip in Daily transport.')}</p>
      <MultiSelect value={ids} onChange={setIds} options={options.options} selectedOptions={selected} loading={options.loading} onSearch={setQ} placeholder={t('Add drivers…')} disabled={!can('etms_vendors', 'edit')} />
      {can('etms_vendors', 'edit') && (
        <Button className="justify-self-start" onClick={() => save.mutate()} disabled={save.isPending}>
          {next ? t('Save and next') : t('Save')}
        </Button>
      )}
    </div>
  );
}

/** Simple rates: one row per vehicle type, one model (per trip or per km) for all branches. */
export function RatesTab({ vendor, onAdvanced }: { vendor: TransportVendorDto; onAdvanced: () => void }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const refresh = useRefresh(vendor.id);
  const cards = useQuery({ queryKey: ['rate-cards', vendor.id], queryFn: ({ signal }) => api.get<TransportRateCardDto[]>(`${V(vendor.id)}/rate-cards`, undefined, signal) });
  const [model, setModel] = useState<'TRIP' | 'KM'>('TRIP');
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [minKm, setMinKm] = useState<Record<string, string>>({});
  const [gst, setGst] = useState('5');
  // From the 1st of this month, so trips already run this month are priced too.
  const [from, setFrom] = useState(`${today().slice(0, 7)}-01`);
  // The simple card of a type: all branches, this model, active, latest.
  const simple = (cat: string, m: 'TRIP' | 'KM') =>
    (cards.data ?? []).filter((c) => c.vehicleCategory === cat && !c.branchId && c.model === m && c.isActive).sort((a, b) => b.validFrom.localeCompare(a.validFrom))[0];
  useEffect(() => {
    if (!cards.data) return;
    const anyKm = cards.data.some((c) => c.model === 'KM' && !c.branchId && c.isActive);
    const anyTrip = cards.data.some((c) => c.model === 'TRIP' && !c.branchId && c.isActive);
    const m = anyKm && !anyTrip ? 'KM' : 'TRIP';
    setModel(m);
    setAmounts(Object.fromEntries(TRANSPORT_VEHICLE_CATEGORIES.map((c) => [c, String((m === 'TRIP' ? simple(c, 'TRIP')?.params.perTrip : simple(c, 'KM')?.params.perKm) ?? '')])));
    setMinKm(Object.fromEntries(TRANSPORT_VEHICLE_CATEGORIES.map((c) => [c, String(simple(c, 'KM')?.params.minKm ?? '')])));
    const first = cards.data.find((c) => !c.branchId && c.isActive);
    if (first) setGst(String(first.gstPct));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cards.data]);
  const editable = can('etms_vendors', 'edit');
  const save = useMutation({
    mutationFn: async () => {
      let n = 0;
      for (const cat of TRANSPORT_VEHICLE_CATEGORIES) {
        const a = amounts[cat]?.trim();
        if (!a) continue;
        const value = Number(a);
        if (!Number.isFinite(value) || value < 0) throw new Error(t('{{type}}: enter a valid amount', { type: t(humanize(cat)) }));
        const params = model === 'TRIP' ? { perTrip: value } : { perKm: value, ...(minKm[cat]?.trim() ? { minKm: Number(minKm[cat]) } : {}) };
        const body = { name: `${humanize(cat)} ${model === 'TRIP' ? 'per trip' : 'per km'}`, branchId: null, vehicleCategory: cat, model, params, addons: {}, gstPct: Number(gst) || 0, validFrom: from, validTo: null, isActive: true };
        const existing = simple(cat, model);
        if (existing) await api.put(`${V(vendor.id)}/rate-cards/${existing.id}`, { ...body, addons: existing.addons, validFrom: existing.validFrom });
        else await api.post(`${V(vendor.id)}/rate-cards`, body);
        n++;
      }
      return n;
    },
    onSuccess: (n) => {
      toast.success(t('{{n}} rate(s) saved', { n }));
      refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <div className="grid gap-3">
      <p className="text-sm text-muted-foreground">{t('One rate per vehicle type, for all branches. Leave a type empty if this vendor has none.')}</p>
      <div className="flex flex-wrap items-end gap-3">
        <div className="inline-flex rounded-lg border bg-muted p-[3px]" role="radiogroup" aria-label={t('Pricing')}>
          {(['TRIP', 'KM'] as const).map((m) => (
            <button key={m} type="button" role="radio" aria-checked={model === m} disabled={!editable} onClick={() => setModel(m)} className={cn('h-8 rounded-md px-4 text-sm font-medium', model === m ? 'bg-card shadow-sm' : 'text-muted-foreground')}>
              {m === 'TRIP' ? t('Per trip') : t('Per km')}
            </button>
          ))}
        </div>
        <Field label={t('GST %')} htmlFor="sr-gst">
          <Input id="sr-gst" type="number" min={0} max={40} value={gst} onChange={(e) => setGst(e.target.value)} className="h-8 w-24" disabled={!editable} />
        </Field>
        <Field label={t('From date')} htmlFor="sr-from">
          <Input id="sr-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-8 w-40" disabled={!editable} />
        </Field>
      </div>
      <table className="w-full text-sm">
        <thead className="text-xs text-muted-foreground uppercase">
          <tr>
            <th className="py-1 text-left font-medium">{t('Vehicle type')}</th>
            <th className="w-40 py-1 text-left font-medium">{model === 'TRIP' ? t('₹ per trip') : t('₹ per km')}</th>
            {model === 'KM' && <th className="w-36 py-1 text-left font-medium">{t('Minimum km / trip')}</th>}
          </tr>
        </thead>
        <tbody>
          {TRANSPORT_VEHICLE_CATEGORIES.map((c) => (
            <tr key={c} className="border-t">
              <td className="py-1.5">{t(humanize(c))}</td>
              <td className="py-1.5 pr-2">
                <Input type="number" min={0} step="0.01" value={amounts[c] ?? ''} onChange={(e) => setAmounts({ ...amounts, [c]: e.target.value })} className="h-8" disabled={!editable} aria-label={t('Rate for {{type}}', { type: t(humanize(c)) })} placeholder="—" />
              </td>
              {model === 'KM' && (
                <td className="py-1.5">
                  <Input type="number" min={0} value={minKm[c] ?? ''} onChange={(e) => setMinKm({ ...minKm, [c]: e.target.value })} className="h-8" disabled={!editable} aria-label={t('Minimum km for {{type}}', { type: t(humanize(c)) })} placeholder="—" />
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="flex flex-wrap items-center gap-2">
        {editable && (
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            {t('Save rates')}
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={onAdvanced}>
          {t('Advanced rate cards (slab, monthly, package, branch-wise, add-ons)…')}
        </Button>
      </div>
    </div>
  );
}

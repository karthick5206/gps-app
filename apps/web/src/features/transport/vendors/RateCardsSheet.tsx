import {
  RATE_MODEL_LABEL,
  RATE_MODELS,
  TRANSPORT_VEHICLE_CATEGORIES,
  type BranchDto,
  type RateAddons,
  type RateModel,
  type RateParams,
  type TransportRateCardDto,
  type TransportRateCardInput,
  type TransportVendorDto,
} from '@veetracer/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PencilIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { useAuth } from '@/features/auth/auth-context';
import { named, useEntityOptions } from '@/features/masters/use-options';
import { api, errorMessage } from '@/lib/api';
import { humanize } from '@/lib/format';

const ENDPOINT = (vendorId: string) => `/transport/vendors/${vendorId}/rate-cards`;

/** The number fields each model asks for. */
const MODEL_FIELDS: Record<RateModel, { key: keyof RateParams; label: string }[]> = {
  TRIP: [{ key: 'perTrip', label: '₹ per trip' }],
  KM: [
    { key: 'perKm', label: '₹ per km' },
    { key: 'minKm', label: 'Minimum km per trip' },
    { key: 'baseFare', label: 'Base fare ₹ (optional)' },
  ],
  SLAB: [
    { key: 'baseKm', label: 'First km' },
    { key: 'baseFare', label: '₹ for the first km' },
    { key: 'perKmAfter', label: '₹ per km after' },
  ],
  MONTHLY: [
    { key: 'monthlyFee', label: '₹ per vehicle per month' },
    { key: 'includedKm', label: 'Km included' },
    { key: 'perExtraKm', label: '₹ per extra km' },
  ],
  PACKAGE: [
    { key: 'hours', label: 'Package hours' },
    { key: 'km', label: 'Package km' },
    { key: 'fare', label: 'Package ₹' },
    { key: 'perExtraHour', label: '₹ per extra hour' },
    { key: 'perExtraKm', label: '₹ per extra km' },
  ],
  SEAT: [{ key: 'perSeat', label: '₹ per employee carried' }],
};
const ADDON_FIELDS: { key: keyof RateAddons; label: string }[] = [
  { key: 'nightAllowance', label: 'Night allowance ₹ / trip' },
  { key: 'escortPerNightTrip', label: 'Escort ₹ / night trip' },
  { key: 'waitingFreeMin', label: 'Free waiting (min)' },
  { key: 'waitingPerHour', label: 'Waiting ₹ / hour' },
  { key: 'deadKmPerTrip', label: 'Dead km / trip' },
];

interface Draft {
  id: string | null;
  name: string;
  branchId: string;
  vehicleCategory: string;
  model: RateModel;
  params: Record<string, string>;
  addons: Record<string, string>;
  gstPct: string;
  validFrom: string;
  validTo: string;
  isActive: boolean;
}

const today = () => new Date().toISOString().slice(0, 10);
const blank = (): Draft => ({ id: null, name: '', branchId: '', vehicleCategory: '', model: 'KM', params: {}, addons: {}, gstPct: '5', validFrom: today(), validTo: '', isActive: true });
const toStrings = (o: object) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, String(v)]));
const toNumbers = (o: Record<string, string>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v.trim() !== '').map(([k, v]) => [k, Number(v)]));

function summary(c: TransportRateCardDto): string {
  const p = c.params;
  switch (c.model) {
    case 'TRIP':
      return `₹${p.perTrip ?? 0} / trip`;
    case 'KM':
      return `₹${p.perKm ?? 0} / km${p.minKm ? `, min ${p.minKm} km` : ''}`;
    case 'SLAB':
      return `₹${p.baseFare ?? 0} for ${p.baseKm ?? 0} km, then ₹${p.perKmAfter ?? 0} / km`;
    case 'MONTHLY':
      return `₹${p.monthlyFee ?? 0} / month incl. ${p.includedKm ?? 0} km, ₹${p.perExtraKm ?? 0} / extra km`;
    case 'PACKAGE':
      return `₹${p.fare ?? 0} for ${p.hours ?? 0} h / ${p.km ?? 0} km`;
    case 'SEAT':
      return `₹${p.perSeat ?? 0} / employee`;
  }
}

/** A vendor's rate cards: list, add, edit, delete (menu etms_vendors edit). The statement uses the most specific valid card. */
export function RateCardsSheet({ vendor, onClose }: { vendor: TransportVendorDto | null; onClose: () => void }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const qc = useQueryClient();
  const open = !!vendor;
  const editable = can('etms_vendors', 'edit');
  const cards = useQuery({ queryKey: ['rate-cards', vendor?.id], enabled: open, queryFn: ({ signal }) => api.get<TransportRateCardDto[]>(ENDPOINT(vendor!.id), undefined, signal) });
  const branches = useEntityOptions<BranchDto>('/branches', named, { enabled: open && can('branches') });
  const [d, setD] = useState<Draft | null>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['rate-cards', vendor?.id] });
    void qc.invalidateQueries({ queryKey: ['master', '/transport/vendors'] });
  };
  const save = useMutation({
    mutationFn: (x: Draft) => {
      const body: TransportRateCardInput = {
        name: x.name.trim(),
        branchId: x.branchId || null,
        vehicleCategory: x.vehicleCategory || null,
        model: x.model,
        params: toNumbers(x.params),
        addons: toNumbers(x.addons),
        gstPct: Number(x.gstPct) || 0,
        validFrom: x.validFrom,
        validTo: x.validTo || null,
        isActive: x.isActive,
      };
      return x.id ? api.put(`${ENDPOINT(vendor!.id)}/${x.id}`, body) : api.post(ENDPOINT(vendor!.id), body);
    },
    onSuccess: () => {
      toast.success(t('Rate card saved'));
      setD(null);
      refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const del = useMutation({
    mutationFn: (id: string) => api.delete(`${ENDPOINT(vendor!.id)}/${id}`),
    onSuccess: () => {
      toast.success(t('Rate card deleted'));
      refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const sel = 'h-9 w-full rounded-md border border-input bg-card px-2 text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none';
  return (
    <Sheet open={open} onOpenChange={(o) => !o && (setD(null), onClose())}>
      <SheetContent className="w-full sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle>{t('Rate cards')}</SheetTitle>
          <SheetDescription>{t('{{vendor}}: how trips are priced. The most specific valid card (branch + vehicle category) is used for each trip.', { vendor: vendor?.name ?? '' })}</SheetDescription>
        </SheetHeader>
        <div className="grid gap-3 overflow-y-auto px-4 pb-4">
          {!d && editable && (
            <Button size="sm" className="justify-self-start" onClick={() => setD(blank())}>
              <PlusIcon /> {t('Add rate card')}
            </Button>
          )}
          {d && (
            <div className="grid gap-3 rounded-lg border p-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label={t('Name')} htmlFor="rc-name" required>
                  <Input id="rc-name" value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} placeholder={t('e.g. Sedan per km 2026')} />
                </Field>
                <Field label={t('Pricing model')} htmlFor="rc-model">
                  <select id="rc-model" className={sel} value={d.model} onChange={(e) => setD({ ...d, model: e.target.value as RateModel, params: {} })}>
                    {RATE_MODELS.map((m) => (
                      <option key={m} value={m}>
                        {t(RATE_MODEL_LABEL[m])}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={t('Branch')} htmlFor="rc-branch">
                  <select id="rc-branch" className={sel} value={d.branchId} onChange={(e) => setD({ ...d, branchId: e.target.value })}>
                    <option value="">{t('All branches')}</option>
                    {branches.options.map((b) => (
                      <option key={b.value} value={b.value}>
                        {b.label}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={t('Vehicle category')} htmlFor="rc-cat">
                  <select id="rc-cat" className={sel} value={d.vehicleCategory} onChange={(e) => setD({ ...d, vehicleCategory: e.target.value })}>
                    <option value="">{t('All categories')}</option>
                    {TRANSPORT_VEHICLE_CATEGORIES.map((c) => (
                      <option key={c} value={c}>
                        {t(humanize(c))}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                {MODEL_FIELDS[d.model].map((f) => (
                  <Field key={f.key} label={t(f.label)} htmlFor={`rc-${f.key}`}>
                    <Input id={`rc-${f.key}`} type="number" min={0} step="0.01" value={d.params[f.key] ?? ''} onChange={(e) => setD({ ...d, params: { ...d.params, [f.key]: e.target.value } })} />
                  </Field>
                ))}
              </div>
              <details className="rounded-md border p-2">
                <summary className="cursor-pointer text-sm font-medium">{t('Add-ons (optional)')}</summary>
                <div className="mt-2 grid gap-3 sm:grid-cols-3">
                  {ADDON_FIELDS.map((f) => (
                    <Field key={f.key} label={t(f.label)} htmlFor={`rc-a-${f.key}`}>
                      <Input id={`rc-a-${f.key}`} type="number" min={0} step="0.01" value={d.addons[f.key] ?? ''} onChange={(e) => setD({ ...d, addons: { ...d.addons, [f.key]: e.target.value } })} />
                    </Field>
                  ))}
                </div>
              </details>
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label={t('GST %')} htmlFor="rc-gst">
                  <Input id="rc-gst" type="number" min={0} max={40} step="0.01" value={d.gstPct} onChange={(e) => setD({ ...d, gstPct: e.target.value })} />
                </Field>
                <Field label={t('Valid from')} htmlFor="rc-from" required>
                  <Input id="rc-from" type="date" value={d.validFrom} onChange={(e) => setD({ ...d, validFrom: e.target.value })} />
                </Field>
                <Field label={t('Valid to (optional)')} htmlFor="rc-to">
                  <Input id="rc-to" type="date" value={d.validTo} min={d.validFrom} onChange={(e) => setD({ ...d, validTo: e.target.value })} />
                </Field>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={d.isActive} onChange={(e) => setD({ ...d, isActive: e.target.checked })} /> {t('Active')}
              </label>
              <div className="flex gap-2">
                <Button size="sm" disabled={!d.name.trim() || !d.validFrom || save.isPending} onClick={() => save.mutate(d)}>
                  {t('Save')}
                </Button>
                <Button size="sm" variant="outline" onClick={() => setD(null)}>
                  {t('Cancel')}
                </Button>
              </div>
            </div>
          )}
          {cards.data?.length ? (
            <ul className="divide-y rounded-lg border text-sm">
              {cards.data.map((c) => (
                <li key={c.id} className="flex flex-wrap items-start gap-2 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">
                      {c.name} {!c.isActive && <Badge variant="muted">{t('Inactive')}</Badge>}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {t(RATE_MODEL_LABEL[c.model])}: {summary(c)} · GST {c.gstPct}%
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {c.branchName ?? t('All branches')} · {c.vehicleCategory ? t(humanize(c.vehicleCategory)) : t('All categories')} · {c.validFrom}
                      {c.validTo ? ` – ${c.validTo}` : ` ${t('onwards')}`}
                    </p>
                  </div>
                  {editable && (
                    <>
                      <Button size="icon-sm" variant="ghost" aria-label={t('Edit {{name}}', { name: c.name })} onClick={() => setD({ id: c.id, name: c.name, branchId: c.branchId ?? '', vehicleCategory: c.vehicleCategory ?? '', model: c.model, params: toStrings(c.params), addons: toStrings(c.addons), gstPct: String(c.gstPct), validFrom: c.validFrom, validTo: c.validTo ?? '', isActive: c.isActive })}>
                        <PencilIcon />
                      </Button>
                      <Button size="icon-sm" variant="ghost" aria-label={t('Delete {{name}}', { name: c.name })} onClick={() => window.confirm(t('Delete rate card {{name}}?', { name: c.name })) && del.mutate(c.id)}>
                        <Trash2Icon />
                      </Button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            !cards.isPending && <p className="text-sm text-muted-foreground">{t('No rate cards yet.')}</p>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

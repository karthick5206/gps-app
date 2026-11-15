import { TRANSPORT_VEHICLE_CATEGORIES, type TransportVehicleCategory, type TransportVehicleProfileDto, type TransportVendorDto } from '@veetracer/shared';
import { useAuth } from '@/features/auth/auth-context';
import { named, useEntityOptions } from '@/features/masters/use-options';
import { useQuery } from '@tanstack/react-query';
import { useEffect, type Dispatch, type SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { humanize } from '@/lib/format';
import { parseSeats, SEATS_MAX, SEATS_MIN } from './people-format';
import { TRANSPORT_VEHICLES_ENDPOINT } from './use-people';

/** Optional transport details typed in the vehicle form (all may stay empty). */
export interface VehicleTransportValues {
  seats: string;
  wheelchair: string;
  category: string;
  hasAc: '' | 'yes' | 'no';
  /** v1.16.9: the vendor operating this vehicle ('' = none). */
  vendorId: string;
}

export const EMPTY_TRANSPORT_VALUES: VehicleTransportValues = { seats: '', wheelchair: '', category: '', hasAc: '', vendorId: '' };

/** The PUT body, or null when nothing usable was typed (seats are what make a profile). */
export function transportProfileBody(v: VehicleTransportValues) {
  const seats = parseSeats(v.seats);
  if (seats === null) return null;
  const wheel = /^\s*\d+\s*$/.test(v.wheelchair) ? Math.min(Number(v.wheelchair), seats) : 0;
  return { seats, wheelchairSpaces: wheel, category: (v.category || null) as TransportVehicleCategory | null, hasAc: v.hasAc === '' ? null : v.hasAc === 'yes', notes: null };
}

/**
 * v1.16.7: "Employee transport" section of Masters → Objects → Add / Edit vehicle (companies with the etms add-on).
 * Optional: passenger seats (driver not counted), wheelchair spaces, category and AC. Loads the saved profile when
 * editing; the form saves it after the vehicle (PUT /transport/vehicles/:id/profile).
 */
export function VehicleTransportFields({ objectId, open, value, onChange }: { objectId: string | null; open: boolean; value: VehicleTransportValues; onChange: Dispatch<SetStateAction<VehicleTransportValues>> }) {
  const { t } = useTranslation();
  const saved = useQuery({
    queryKey: ['transport-vehicle-profile', objectId],
    enabled: open && !!objectId,
    queryFn: ({ signal }) => api.get<TransportVehicleProfileDto | null>(`${TRANSPORT_VEHICLES_ENDPOINT}/${objectId}/profile`, undefined, signal).catch(() => null),
  });
  const { can } = useAuth();
  const vendors = useEntityOptions<TransportVendorDto>('/transport/vendors', named, { enabled: open && can('etms_vendors') });
  const savedVendor = useQuery({
    queryKey: ['vehicle-vendor', objectId],
    enabled: open && !!objectId,
    queryFn: ({ signal }) => api.get<{ vendorId: string | null }>(`/transport/vendors/by-vehicle/${objectId}`, undefined, signal).catch(() => ({ vendorId: null })),
  });
  useEffect(() => {
    if (savedVendor.data) onChange((cur) => ({ ...cur, vendorId: savedVendor.data!.vendorId ?? '' }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedVendor.data]);
  useEffect(() => {
    const p = saved.data;
    if (p) onChange((cur) => ({ ...cur, seats: String(p.seats), wheelchair: String(p.wheelchairSpaces ?? 0), category: p.category ?? '', hasAc: p.hasAc === null || p.hasAc === undefined ? '' : p.hasAc ? 'yes' : 'no' }));
    // Only when the saved profile arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved.data]);
  const seatsBad = value.seats !== '' && parseSeats(value.seats) === null;
  const sel = 'h-9 w-full rounded-md border border-input bg-card px-2 text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none';
  return (
    <fieldset className="grid gap-3 rounded-lg border border-dashed p-3 sm:grid-cols-4">
      <legend className="px-1 text-sm font-medium">{t('Employee transport (optional)')}</legend>
      {can('etms_vendors') && (
        <Field label={t('Vendor (cab operator)')} htmlFor="vt-vendor" hint={t('Who runs and bills this vehicle. Vendor billing uses the vendor + this category + the vehicle branch to pick the rate card.')} className="sm:col-span-4">
          <select id="vt-vendor" className={sel} value={value.vendorId} onChange={(e) => onChange({ ...value, vendorId: e.target.value })}>
            <option value="">{t('Own vehicle / no vendor')}</option>
            {vendors.options.map((v) => (
              <option key={v.value} value={v.value}>
                {v.label}
              </option>
            ))}
          </select>
        </Field>
      )}
      <Field label={t('Passenger seats')} htmlFor="vt-seats" hint={t('Driver not counted. Route planning never puts more people in.')} error={seatsBad ? t('{{min}}–{{max}}', { min: SEATS_MIN, max: SEATS_MAX }) : undefined}>
        <Input id="vt-seats" type="number" inputMode="numeric" min={SEATS_MIN} max={SEATS_MAX} value={value.seats} onChange={(e) => onChange({ ...value, seats: e.target.value })} placeholder="e.g. 6" />
      </Field>
      <Field label={t('Wheelchair spaces')} htmlFor="vt-wheel">
        <Input id="vt-wheel" type="number" inputMode="numeric" min={0} max={20} value={value.wheelchair} onChange={(e) => onChange({ ...value, wheelchair: e.target.value })} placeholder="0" />
      </Field>
      <Field label={t('Category')} htmlFor="vt-cat">
        <select id="vt-cat" className={sel} value={value.category} onChange={(e) => onChange({ ...value, category: e.target.value })}>
          <option value="">{t('Not set')}</option>
          {TRANSPORT_VEHICLE_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {t(humanize(c))}
            </option>
          ))}
        </select>
      </Field>
      <Field label={t('AC')} htmlFor="vt-ac">
        <select id="vt-ac" className={sel} value={value.hasAc} onChange={(e) => onChange({ ...value, hasAc: e.target.value as VehicleTransportValues['hasAc'] })}>
          <option value="">{t('Not set')}</option>
          <option value="yes">{t('Yes')}</option>
          <option value="no">{t('No')}</option>
        </select>
      </Field>
    </fieldset>
  );
}

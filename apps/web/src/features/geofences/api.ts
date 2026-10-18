import type { GeofenceDto, GeofenceMode, LookupDto, Paginated } from '@veetracer/shared';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { Option } from '@/components/ui/multi-select';
import { useAuth } from '@/features/auth/auth-context';
import { api } from '@/lib/api';
import { humanize } from '@/lib/format';

export const GEOFENCES_ENDPOINT = '/geofences';

export const MODE_LABEL: Record<GeofenceMode, string> = {
  NORMAL: 'Normal',
  NO_GO: 'No-go',
  KEEP_IN: 'Keep inside',
};

export const MODE_HINT: Record<GeofenceMode, string> = {
  NORMAL: 'Entry and exit alerts at the configured severity',
  NO_GO: 'Vehicles must stay out — entry raises a Critical alert',
  KEEP_IN: 'Vehicles must stay inside — exit raises a Critical alert',
};

export const GEOFENCE_COLORS = ['#0f766e', '#2563eb', '#7c3aed', '#db2777', '#dc2626', '#ea580c', '#ca8a04', '#16a34a', '#0891b2', '#475569'];

/** Fallback when the caller can't read lookups (codes seeded for GEOFENCE_CATEGORY). */
const FALLBACK_CATEGORIES = ['DEPOT', 'CUSTOMER', 'FUEL_STATION', 'SERVICE_CENTER', 'SCHOOL', 'RESTRICTED', 'OTHER'];

/** GEOFENCE_CATEGORY lookup options; falls back to the seeded codes without `lookups:view`. */
export function useCategoryOptions() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const allowed = can('lookups');
  const q = useQuery({
    queryKey: ['options', '/lookups', 'GEOFENCE_CATEGORY'],
    queryFn: ({ signal }) => api.get<Paginated<LookupDto>>('/lookups', { type: 'GEOFENCE_CATEGORY', pageSize: 100, status: 'ACTIVE', sort: 'sortOrder', order: 'asc' }, signal),
    enabled: allowed,
    staleTime: 5 * 60_000,
  });
  return useMemo(() => {
    const items = q.data?.items;
    const options: Option[] = items?.length
      ? items.map((l) => ({ value: l.code, label: l.label }))
      : FALLBACK_CATEGORIES.map((c) => ({ value: c, label: humanize(c) }));
    if (!options.some((o) => o.value === 'OTHER')) options.push({ value: 'OTHER', label: t('Other') });
    const labelOf = (code: string) => options.find((o) => o.value === code)?.label ?? humanize(code);
    return { options, labelOf };
  }, [q.data, t]);
}

/** Loads every active geofence (paged in 100s, capped) — for map layers and pickers. */
export async function fetchAllGeofences(signal?: AbortSignal, max = 2000): Promise<GeofenceDto[]> {
  const out: GeofenceDto[] = [];
  for (let page = 1; out.length < max; page++) {
    const res = await api.get<Paginated<GeofenceDto>>(GEOFENCES_ENDPOINT, { page, pageSize: 100, status: 'ACTIVE' }, signal);
    out.push(...res.items);
    if (res.items.length < 100 || out.length >= res.total) break;
  }
  return out;
}

export function useAllGeofences(enabled = true) {
  return useQuery({
    queryKey: ['master', GEOFENCES_ENDPOINT, 'all'],
    queryFn: ({ signal }) => fetchAllGeofences(signal),
    enabled,
    staleTime: 60_000,
  });
}

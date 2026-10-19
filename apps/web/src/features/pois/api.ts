import { POI_CATEGORIES, type LookupDto, type Paginated, type PoiDto } from '@veetracer/shared';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { Option } from '@/components/ui/multi-select';
import { useAuth } from '@/features/auth/auth-context';
import { GEOFENCE_COLORS } from '@/features/geofences/api';
import { api, buildQuery, downloadFile } from '@/lib/api';
import { humanize } from '@/lib/format';

export const POIS_ENDPOINT = '/pois';

/** Swatches offered in the POI editor (same palette as geofences). */
export const POI_COLORS = GEOFENCE_COLORS;

/** POI_CATEGORY lookup options; falls back to the seeded codes without `lookups:view`. */
export function usePoiCategoryOptions() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const allowed = can('lookups');
  const q = useQuery({
    queryKey: ['options', '/lookups', 'POI_CATEGORY'],
    queryFn: ({ signal }) => api.get<Paginated<LookupDto>>('/lookups', { type: 'POI_CATEGORY', pageSize: 100, status: 'ACTIVE', sort: 'sortOrder', order: 'asc' }, signal),
    enabled: allowed,
    staleTime: 5 * 60_000,
  });
  return useMemo(() => {
    const items = q.data?.items;
    const options: Option[] = items?.length
      ? items.map((l) => ({ value: l.code, label: l.label }))
      : POI_CATEGORIES.map((c) => ({ value: c, label: t(humanize(c)) }));
    if (!options.some((o) => o.value === 'OTHER')) options.push({ value: 'OTHER', label: t('Other') });
    const labelOf = (code: string) => options.find((o) => o.value === code)?.label ?? t(humanize(code));
    return { options, labelOf };
  }, [q.data, t]);
}

/** Loads every active POI (paged in 100s, capped) — for map layers. */
export async function fetchAllPois(signal?: AbortSignal, max = 5000): Promise<PoiDto[]> {
  const out: PoiDto[] = [];
  for (let page = 1; out.length < max; page++) {
    const res = await api.get<Paginated<PoiDto>>(POIS_ENDPOINT, { page, pageSize: 100, status: 'ACTIVE' }, signal);
    out.push(...res.items);
    if (res.items.length < 100 || out.length >= res.total) break;
  }
  return out.slice(0, max);
}

export function useAllPois(enabled = true) {
  return useQuery({
    queryKey: ['master', POIS_ENDPOINT, 'all'],
    queryFn: ({ signal }) => fetchAllPois(signal),
    enabled,
    staleTime: 60_000,
  });
}

export type ExportFormat = 'kml' | 'geojson';
export type ExportInclude = 'all' | 'pois' | 'geofences';

/** Downloads POIs and/or geofences as KML or GeoJSON (`GET /pois/export`). */
export function exportPois(format: ExportFormat, include: ExportInclude): Promise<void> {
  const base = include === 'geofences' ? 'geofences' : include === 'pois' ? 'pois' : 'pois-geofences';
  return downloadFile(`${POIS_ENDPOINT}/export${buildQuery({ format, include })}`, `${base}.${format === 'kml' ? 'kml' : 'geojson'}`);
}

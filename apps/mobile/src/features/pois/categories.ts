import { useQuery } from '@tanstack/react-query';
import { POI_CATEGORIES, type LookupDto, type Paginated } from '@veetracer/shared';
import { useMemo } from 'react';
import { useAuth } from '@/features/auth/auth';
import { api } from '@/lib/api';
import { humanize } from '@/lib/format';
import { i18n } from '@/lib/i18n';

/** Translated label of a seeded POI_CATEGORY code ("FUEL_STATION" → "Fuel station"). */
export const poiCategoryLabel = (code: string) => i18n.t(humanize(code));

/** POI_CATEGORY lookup options (company values included); the seeded codes when the user can't read lookups. */
export function usePoiCategories() {
  const { can } = useAuth();
  const lookups = useQuery({
    queryKey: ['options', '/lookups', 'POI_CATEGORY'],
    queryFn: ({ signal }) => api.get<Paginated<LookupDto>>('/lookups', { type: 'POI_CATEGORY', pageSize: 100, status: 'ACTIVE', sort: 'sortOrder', order: 'asc' }, signal),
    enabled: can('lookups'),
    staleTime: 5 * 60_000,
  });
  return useMemo(() => {
    const rows = lookups.data?.items ?? [];
    const options = rows.length
      ? rows.map((l) => ({ value: l.code, label: l.isSystem ? i18n.t(l.label) : l.label }))
      : POI_CATEGORIES.map((code) => ({ value: code as string, label: poiCategoryLabel(code) }));
    const labels = new Map(options.map((o) => [o.value, o.label]));
    return { options, label: (code: string) => labels.get(code) ?? poiCategoryLabel(code) };
  }, [lookups.data]);
}

/** "250 m" / "1.5 km". */
export const formatRadius = (m: number) => (m >= 1000 ? `${(m / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} km` : `${m} m`);

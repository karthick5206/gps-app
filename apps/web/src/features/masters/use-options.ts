import { useQuery } from '@tanstack/react-query';
import type { Paginated } from '@veetracer/shared';
import { useDeferredValue, useMemo } from 'react';
import type { Option } from '@/components/ui/multi-select';
import { api, type QueryParams } from '@/lib/api';

/** Assumed upper bound accepted by list endpoints for option pickers. */
const OPTION_PAGE_SIZE = 100;

/**
 * Loads active records of a master as picker options. Pass `q` for server-side search
 * (large lists such as objects); omit it to load the first page and filter locally.
 */
export function useEntityOptions<T>(
  endpoint: string,
  toOption: (row: T) => Option,
  { q, enabled = true, params }: { q?: string; enabled?: boolean; params?: QueryParams } = {},
) {
  const search = useDeferredValue(q ?? '');
  const query = useQuery({
    queryKey: ['options', endpoint, search, params],
    queryFn: ({ signal }) =>
      api.get<Paginated<T>>(endpoint, { pageSize: OPTION_PAGE_SIZE, status: 'ACTIVE', q: search, ...params }, signal),
    enabled,
    staleTime: 60_000,
  });
  // `toOption` is expected to be a stable (module-level) function.
  const rows = useMemo(() => query.data?.items ?? [], [query.data]);
  const options = useMemo(() => rows.map(toOption), [rows, toOption]);
  return { rows, options, loading: query.isFetching };
}

export const named = (r: { id: string; name: string }): Option => ({ value: r.id, label: r.name });

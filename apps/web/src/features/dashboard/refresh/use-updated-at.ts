import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useSyncExternalStore } from 'react';

/**
 * Latest `dataUpdatedAt` of the cached queries whose key starts with `prefix` (0 when none). Reads the query cache
 * passively: it adds no observer, so it never triggers a fetch or changes polling.
 */
export function useQueryUpdatedAt(prefix: string): number {
  const queryClient = useQueryClient();
  const cache = queryClient.getQueryCache();
  const subscribe = useCallback((cb: () => void) => cache.subscribe(cb), [cache]);
  const read = useCallback(() => cache.findAll({ queryKey: [prefix] }).reduce((m, q) => Math.max(m, q.state.dataUpdatedAt), 0), [cache, prefix]);
  return useSyncExternalStore(subscribe, read);
}

import type { QueryClient } from '@tanstack/react-query';
import type { AlertDto } from '@veetracer/shared';
import { api } from '@/lib/api';

/**
 * Marks an alert read for the signed-in user (idempotent on the server) and refreshes the alerts list and the tab
 * badge. The open alert's own query is patched rather than refetched, so the SOS screen's siren (which follows the
 * shared status) is not disturbed.
 */
export async function markAlertRead(queryClient: QueryClient, id: string): Promise<void> {
  try {
    await api.post(`/alerts/${id}/read`, {});
  } catch {
    return; // offline: it stays unread and is marked next time it is opened
  }
  queryClient.setQueryData<AlertDto>(['alerts', 'one', id], (d) => (d ? { ...d, read: true } : d));
  await refreshAlertLists(queryClient);
}

/** Alert lists and the unread badge (not open alert screens). */
export function refreshAlertLists(queryClient: QueryClient): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: ['alerts'], predicate: (q) => q.queryKey[1] !== 'one' });
}

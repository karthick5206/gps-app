import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ALERT_TYPE_MAP, type AlertSeverity, type AlertTypeCode, type DriverEventDto, type DriverEventStatus } from '@veetracer/shared';
import { api } from '@/lib/api';

export const eventSeverity = (type: string): AlertSeverity => ALERT_TYPE_MAP[type as AlertTypeCode]?.defaultSeverity ?? 'WARNING';
export const eventLabel = (type: string): string => ALERT_TYPE_MAP[type as AlertTypeCode]?.label ?? type;

export function useDriverEvent(id: string | null, initial?: DriverEventDto | null) {
  return useQuery({
    queryKey: ['driver-events', 'detail', id],
    queryFn: ({ signal }) => api.get<DriverEventDto>(`/driver-events/${id}`, undefined, signal),
    enabled: !!id,
    initialData: initial ?? undefined,
    // Media URLs carry a 30-minute token; refresh well before that.
    staleTime: 60_000,
    refetchInterval: 10 * 60_000,
  });
}

/** Driver event of an alert (snapshot in the alert detail); polls briefly while the snapshot is on its way. */
export function useEventByAlert(alertId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ['driver-events', 'by-alert', alertId],
    queryFn: ({ signal }) => api.get<{ event: DriverEventDto | null }>(`/driver-events/by-alert/${alertId}`, undefined, signal).then((r) => r.event),
    enabled: !!alertId && enabled,
    refetchInterval: (q) => {
      const e = q.state.data;
      const young = e && Date.now() - Date.parse(e.occurredAt) < 3 * 60_000;
      return young && !e.media.length ? 5000 : false;
    },
  });
}

export function useReviewEvent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status, note }: { id: string; status: DriverEventStatus; note?: string | null }) => api.patch<DriverEventDto>(`/driver-events/${id}/review`, { status, note }),
    onSuccess: (e) => {
      qc.setQueryData(['driver-events', 'detail', e.id], e);
      void qc.invalidateQueries({ queryKey: ['driver-events'] });
    },
  });
}

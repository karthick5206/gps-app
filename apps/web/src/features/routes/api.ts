import { useQuery } from '@tanstack/react-query';
import type { RouteDto, RoutePathPreview, RouteScheduleDto } from '@veetracer/shared';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

export const ROUTES_ENDPOINT = '/routes';

/** Full route (stops, path, schedules). Lives under the master key so list writes refresh it too. */
export function useRouteDetail(id: string | null) {
  return useQuery({
    queryKey: ['master', ROUTES_ENDPOINT, 'detail', id],
    queryFn: ({ signal }) => api.get<RouteDto>(`${ROUTES_ENDPOINT}/${id}`, undefined, signal),
    enabled: !!id,
    staleTime: 30_000,
  });
}

export function useRouteSchedules(routeId: string | null) {
  return useQuery({
    queryKey: ['master', ROUTES_ENDPOINT, 'schedules', routeId],
    queryFn: ({ signal }) => api.get<RouteScheduleDto[]>(`${ROUTES_ENDPOINT}/${routeId}/schedules`, undefined, signal),
    enabled: !!routeId,
  });
}

/** `value` once it has stopped changing for `ms`. */
export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

/**
 * Road path preview for the editor (`POST /routes/preview-path`), keyed by the stop positions. `key` is the
 * positionsKey the answer belongs to, so callers can tell a stale preview from a current one.
 */
export function usePathPreview(points: { lat: number; lng: number }[], key: string, enabled: boolean) {
  return useQuery({
    queryKey: ['routes-preview', key],
    queryFn: () => api.post<RoutePathPreview>(`${ROUTES_ENDPOINT}/preview-path`, { points: points.map((p) => ({ lat: p.lat, lng: p.lng })) }),
    enabled: enabled && points.length >= 2,
    staleTime: 10 * 60_000,
    retry: false,
  });
}

import { keepPreviousData, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  PLANNED_TRIP_SOCKET_EVENT,
  type DriverDto,
  type Paginated,
  type PlannedTripCreateInput,
  type PlannedTripDto,
  type PlannedTripLiveUpdate,
  type PlannedTripSummaryDto,
  type PlannedTripUpdateInput,
  type RouteSummaryDto,
} from '@veetracer/shared';
import { useEffect } from 'react';
import { useAuth } from '@/features/auth/auth-context';
import { realtime } from '@/features/live/realtime';
import { named, useEntityOptions } from '@/features/masters/use-options';
import { api, ApiError } from '@/lib/api';
import { applyLiveUpdate } from './trip-format';

/** Day view: every trip of the day is loaded (pages of 200) so the status chips count the whole day. */
const PAGE_SIZE = 200;
const MAX_PAGES = 10;

export interface TripListFilters {
  from: string;
  to: string;
  routeId: string | null;
  objectId: string | null;
  driverId: string | null;
}

export interface TripList {
  items: PlannedTripSummaryDto[];
  total: number;
}

export const tripKeys = {
  all: ['planned-trips'] as const,
  list: (f: TripListFilters) => ['planned-trips', 'list', f] as const,
  detail: (id: string) => ['planned-trips', 'detail', id] as const,
};

export function useTripList(filters: TripListFilters) {
  return useQuery({
    queryKey: tripKeys.list(filters),
    queryFn: async ({ signal }): Promise<TripList> => {
      const items: PlannedTripSummaryDto[] = [];
      let total = 0;
      for (let page = 1; page <= MAX_PAGES; page++) {
        const res = await api.get<Paginated<PlannedTripSummaryDto>>(
          '/planned-trips',
          { from: filters.from, to: filters.to, routeId: filters.routeId, objectId: filters.objectId, driverId: filters.driverId, sort: 'plannedStart', order: 'asc', page, pageSize: PAGE_SIZE },
          signal,
        );
        items.push(...res.items);
        total = res.total;
        if (items.length >= total || res.items.length < PAGE_SIZE) break;
      }
      return { items, total };
    },
    placeholderData: keepPreviousData,
    // Safety net when a live push is missed; the socket keeps it current in between.
    refetchInterval: 60_000,
  });
}

export function useTrip(id: string | undefined) {
  return useQuery({
    queryKey: tripKeys.detail(id ?? ''),
    queryFn: ({ signal }) => api.get<PlannedTripDto>(`/planned-trips/${id}`, undefined, signal),
    enabled: !!id,
    refetchInterval: (q) => (q.state.data && (q.state.data.status === 'STARTED' || q.state.data.status === 'IN_PROGRESS') ? 60_000 : false),
    retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
  });
}

/** Writes a fresh detail into the cache and refreshes the lists. */
function settle(qc: QueryClient, trip: PlannedTripDto) {
  qc.setQueryData(tripKeys.detail(trip.id), trip);
  void qc.invalidateQueries({ queryKey: [...tripKeys.all, 'list'] });
}

export type TripMutation =
  | { kind: 'create'; input: PlannedTripCreateInput }
  | { kind: 'edit'; id: string; input: PlannedTripUpdateInput }
  | { kind: 'start' | 'complete'; id: string }
  | { kind: 'cancel'; id: string; reason: string };

export function useTripMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (m: TripMutation) => {
      switch (m.kind) {
        case 'create':
          return api.post<PlannedTripDto>('/planned-trips', m.input);
        case 'edit':
          return api.patch<PlannedTripDto>(`/planned-trips/${m.id}`, m.input);
        case 'cancel':
          return api.post<PlannedTripDto>(`/planned-trips/${m.id}/cancel`, { reason: m.reason });
        default:
          return api.post<PlannedTripDto>(`/planned-trips/${m.id}/${m.kind}`, {});
      }
    },
    onSuccess: (trip) => settle(qc, trip),
  });
}

/** Applies one live push to every cached list and to the trip's detail. */
export function applyLiveToCache(qc: QueryClient, u: PlannedTripLiveUpdate) {
  qc.setQueriesData<TripList>({ queryKey: [...tripKeys.all, 'list'] }, (old) => {
    if (!old || !old.items.some((t) => t.id === u.id)) return old;
    return { ...old, items: old.items.map((t) => applyLiveUpdate(t, u)) };
  });
  const before = qc.getQueryData<PlannedTripDto>(tripKeys.detail(u.id));
  if (!before) return;
  qc.setQueryData<PlannedTripDto>(tripKeys.detail(u.id), applyLiveUpdate(before, u));
  // Events (deviations, unscheduled stops) and final figures are not in the push: reload the detail when they change.
  if (before.deviationCount !== u.deviationCount || before.status !== u.status) void qc.invalidateQueries({ queryKey: tripKeys.detail(u.id) });
}

/**
 * Live updates: `plannedTrip.update` on the app's `/live` socket (company room) patches the cache; after a
 * reconnect everything is reloaded, since pushes sent while disconnected are lost.
 */
export function usePlannedTripLive() {
  const qc = useQueryClient();
  useEffect(() => {
    const off = realtime.on<[PlannedTripLiveUpdate]>(PLANNED_TRIP_SOCKET_EVENT, (u) => {
      if (u && typeof u.id === 'string') applyLiveToCache(qc, u);
    });
    let last = realtime.getStatus();
    const offStatus = realtime.subscribe(() => {
      const s = realtime.getStatus();
      if (s === 'connected' && last === 'disconnected') void qc.invalidateQueries({ queryKey: tripKeys.all });
      last = s;
    });
    return () => {
      off();
      offStatus();
    };
  }, [qc]);
}

export function useRouteOptions() {
  const { can } = useAuth();
  return useEntityOptions<RouteSummaryDto>('/routes', named, { enabled: can('routes') });
}

export function useDriverOptions(q: string) {
  const { can } = useAuth();
  return useEntityOptions<DriverDto>('/drivers', named, { q, enabled: can('drivers') });
}

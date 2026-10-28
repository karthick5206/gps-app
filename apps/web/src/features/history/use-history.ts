import { useQuery } from '@tanstack/react-query';
import type { GapEstimateResponse, GapEstimateSegment, HistoryResponse, LiveObject, PointQualityResponse, PointQualitySettingsDto, TrackedObjectDto } from '@veetracer/shared';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { Option } from '@/components/ui/multi-select';
import { useAuth } from '@/features/auth/auth-context';
import { liveStore } from '@/features/live/live-store';
import { useEntityOptions } from '@/features/masters/use-options';
import { ApiError, api } from '@/lib/api';

export function useHistory(objectId: string | null, from: Date, to: Date) {
  const fromIso = from.toISOString();
  const toIso = to.toISOString();
  return useQuery({
    queryKey: ['object-history', objectId, fromIso, toIso],
    queryFn: ({ signal }) => api.get<HistoryResponse>(`/objects/${objectId}/history`, { from: fromIso, to: toIso }, signal),
    enabled: !!objectId,
    staleTime: 30_000,
    retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
  });
}

/** Whether History → All points is switched on (platform setting, Super Admin). */
export function usePointQualitySettings() {
  return useQuery({
    queryKey: ['point-quality-settings'],
    queryFn: ({ signal }) => api.get<PointQualitySettingsDto>('/point-quality/settings', undefined, signal),
    staleTime: 60_000,
  });
}

/** Every point of the range with its quality label, and the cleaned track (only while All points is on). */
export function usePointQuality(objectId: string | null, from: Date, to: Date, enabled: boolean) {
  const fromIso = from.toISOString();
  const toIso = to.toISOString();
  return useQuery({
    queryKey: ['point-quality', objectId, fromIso, toIso],
    queryFn: ({ signal }) => api.get<PointQualityResponse>(`/objects/${objectId}/points`, { from: fromIso, to: toIso }, signal),
    enabled: enabled && !!objectId,
    staleTime: 30_000,
    retry: false,
  });
}

const NO_LINES: [number, number][][] = [];

/** Likely roads through the track's data gaps (`POST /routing/estimate-gaps`); none when the server has no engine. */
export function useGapEstimates(trackKey: string | null, segments: GapEstimateSegment[]) {
  const q = useQuery({
    queryKey: ['gap-estimates', trackKey, segments.length],
    queryFn: () => api.post<GapEstimateResponse>('/routing/estimate-gaps', { segments }),
    enabled: !!trackKey && segments.length > 0,
    staleTime: Infinity,
    retry: false,
  });
  return useMemo(() => q.data?.routes.filter((r): r is [number, number][] => r !== null) ?? NO_LINES, [q.data]);
}

const liveOption = (o: LiveObject): Option => ({ value: o.objectId, label: o.name, description: o.plateNumber ?? undefined });
const objectOption = (o: TrackedObjectDto): Option => ({ value: o.id, label: o.name, description: o.plateNumber ?? undefined });
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/**
 * Vehicles the user can pick. Uses the live snapshot (`live_map` — includes every object in scope, also for
 * viewers without the Objects master) and falls back to server-side search on `/objects`.
 */
export function useVehicleOptions(search: string) {
  const { can } = useAuth();
  const useLive = can('live_map');
  const [liveError, setLiveError] = useState(false);
  const version = useSyncExternalStore((cb) => liveStore.subscribe(() => cb()), () => liveStore.getVersion());
  useEffect(() => {
    if (useLive && !liveStore.snapshotLoaded) liveStore.loadSnapshot().catch(() => setLiveError(true));
  }, [useLive]);
  const remote = useEntityOptions<TrackedObjectDto>('/objects', objectOption, { q: search, enabled: (!useLive || liveError) && can('objects') });
  const liveOptions = useMemo(() => {
    void version;
    return liveStore
      .all()
      .map(liveOption)
      .sort((a, b) => collator.compare(a.label, b.label));
  }, [version]);
  if (useLive && !liveError) return { options: liveOptions, loading: !liveStore.snapshotLoaded, remoteSearch: false };
  return { options: remote.options, loading: remote.loading, remoteSearch: true };
}

let geocodeUnavailable = false;

/** Reverse geocodes via `GET /api/geocode/reverse?lat&lng` when the API exposes it; null otherwise. */
export async function reverseGeocode(lat: number, lng: number, signal?: AbortSignal): Promise<string | null> {
  if (geocodeUnavailable) return null;
  try {
    const res = await api.get<{ address?: string | null } | string | null>('/geocode/reverse', { lat: lat.toFixed(6), lng: lng.toFixed(6) }, signal);
    if (typeof res === 'string') return res || null;
    return res?.address ?? null;
  } catch (err) {
    if (err instanceof ApiError && (err.status === 404 || err.status === 405 || err.status === 501)) geocodeUnavailable = true;
    return null;
  }
}

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia(query);
      m.addEventListener('change', cb);
      return () => m.removeEventListener('change', cb);
    },
    () => window.matchMedia(query).matches,
  );
}

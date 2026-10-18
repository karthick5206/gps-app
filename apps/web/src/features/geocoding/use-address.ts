import { useQuery } from '@tanstack/react-query';
import { reverseGeocode } from '@/features/history/use-history';

/**
 * Address of a position via GET /geocode/reverse (cached server-side). Keyed on ~11 m so a moving vehicle refetches
 * only when it has really moved. null while loading or when the server has no geocoder.
 */
export function useAddress(lat: number | null | undefined, lng: number | null | undefined): { address: string | null; loading: boolean } {
  const ok = typeof lat === 'number' && typeof lng === 'number' && Number.isFinite(lat) && Number.isFinite(lng);
  const q = useQuery({
    queryKey: ['address', ok ? lat.toFixed(4) : null, ok ? lng.toFixed(4) : null],
    queryFn: ({ signal }) => reverseGeocode(lat!, lng!, signal),
    enabled: ok,
    staleTime: Infinity,
    gcTime: 30 * 60_000,
    retry: false,
  });
  return { address: q.data ?? null, loading: ok && q.isLoading };
}

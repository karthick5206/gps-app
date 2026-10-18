import { useQuery } from '@tanstack/react-query';
import { MapPinIcon } from 'lucide-react-native';
import { View } from 'react-native';
import { Text } from '@/components/ui';
import { api } from '@/lib/api';
import { useColors } from '@/lib/theme';

/**
 * Address of a position via GET /geocode/reverse (cached server-side). Keyed on ~11 m so a moving vehicle refetches
 * only when it has really moved. null while loading or when the server has no geocoder.
 */
export function useAddress(lat: number | null | undefined, lng: number | null | undefined): { address: string | null; loading: boolean } {
  const ok = typeof lat === 'number' && typeof lng === 'number' && Number.isFinite(lat) && Number.isFinite(lng);
  const q = useQuery({
    queryKey: ['address', ok ? lat.toFixed(4) : null, ok ? lng.toFixed(4) : null],
    queryFn: async ({ signal }) => {
      const res = await api.get<{ address: string | null }>('/geocode/reverse', { lat: lat!.toFixed(6), lng: lng!.toFixed(6) }, signal);
      return res?.address ?? null;
    },
    enabled: ok,
    staleTime: Infinity,
    gcTime: 30 * 60_000,
    retry: false,
  });
  return { address: q.data ?? null, loading: ok && q.isLoading };
}

/** One-line address with a pin icon; renders nothing when there is no address. */
export function AddressLine({ lat, lng, lines = 2 }: { lat: number | null | undefined; lng: number | null | undefined; lines?: number }) {
  const c = useColors();
  const { address } = useAddress(lat, lng);
  if (!address) return null;
  return (
    <View style={{ flexDirection: 'row', gap: 6, alignItems: 'flex-start' }}>
      <MapPinIcon size={14} color={c.mutedForeground} style={{ marginTop: 2 }} />
      <Text size="sm" tone="muted" numberOfLines={lines} style={{ flex: 1 }}>
        {address}
      </Text>
    </View>
  );
}

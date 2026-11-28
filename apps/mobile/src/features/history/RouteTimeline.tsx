import { useQueries } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Pressable, View } from 'react-native';
import { Text } from '@/components/ui';
import { api } from '@/lib/api';
import { SPACE, useColors } from '@/lib/theme';
import { formatClock, formatKm } from './history-format';
import type { TrackIndex } from './playback-core';
import { collapseSameAddress, routeCheckpoints } from './route-timeline';

/**
 * Streets a trip passed, each with the time the vehicle was there (from the GPS points). Addresses use the same
 * cache as the rest of the app (`['address', lat4, lng4]`, GET /geocode/reverse). Tap a row to replay from there.
 */
export function RouteTimeline({ index, from, to, withDate, onSeek }: { index: TrackIndex; from: number; to: number; withDate: boolean; onSeek: (t: number) => void }) {
  const c = useColors();
  const { t } = useTranslation();
  const points = useMemo(() => routeCheckpoints(index, from, to), [index, from, to]);
  const results = useQueries({
    queries: points.map((p) => ({
      queryKey: ['address', p.lat.toFixed(4), p.lng.toFixed(4)],
      queryFn: async ({ signal }: { signal: AbortSignal }) => (await api.get<{ address: string | null }>('/geocode/reverse', { lat: p.lat.toFixed(6), lng: p.lng.toFixed(6) }, signal))?.address ?? null,
      staleTime: Infinity,
      gcTime: 30 * 60_000,
      retry: false,
    })),
  });
  const loading = results.some((r) => r.isLoading);
  const rows = collapseSameAddress(points.map((p, i) => ({ ...p, address: (results[i]?.data as string | null | undefined) ?? null })));
  if (!points.length) return null;

  return (
    <View style={{ marginTop: SPACE.sm, gap: 0 }}>
      {rows.map((r, i) => {
        const last = i === rows.length - 1;
        return (
          <Pressable key={r.t} onPress={() => onSeek(r.t)} accessibilityRole="button" style={({ pressed }) => ({ flexDirection: 'row', gap: SPACE.sm, opacity: pressed ? 0.6 : 1 })}>
            <Text size="xs" weight="600" style={{ width: withDate ? 92 : 44, fontVariant: ['tabular-nums'], paddingTop: 1 }}>
              {formatClock(r.t, withDate, false)}
            </Text>
            {/* Dot and line, like a route. */}
            <View style={{ width: 12, alignItems: 'center' }}>
              <View style={{ width: 10, height: 10, borderRadius: 5, marginTop: 3, backgroundColor: i === 0 || last ? c.primary : c.card, borderWidth: 2, borderColor: c.primary }} />
              {!last && <View style={{ flex: 1, width: 2, backgroundColor: c.border, minHeight: 14 }} />}
            </View>
            <View style={{ flex: 1, paddingBottom: last ? 0 : SPACE.sm }}>
              <Text size="xs" numberOfLines={2}>
                {r.address ?? `${r.lat.toFixed(5)}, ${r.lng.toFixed(5)}`}
              </Text>
              <Text size="xs" tone="muted">
                {i === 0 ? t('Start') : last ? `${t('End')} · ${formatKm(r.km)}` : formatKm(r.km)}
              </Text>
            </View>
          </Pressable>
        );
      })}
      {loading && <ActivityIndicator size="small" color={c.primary} style={{ alignSelf: 'flex-start', marginTop: SPACE.xs }} />}
    </View>
  );
}

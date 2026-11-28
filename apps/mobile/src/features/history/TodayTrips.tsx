import { useQuery } from '@tanstack/react-query';
import type { TripDto } from '@veetracer/shared';
import { router } from 'expo-router';
import { RouteIcon } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { Pressable, ScrollView, View } from 'react-native';
import { Text } from '@/components/ui';
import { useAuth } from '@/features/auth/auth';
import { api } from '@/lib/api';
import { RADIUS, SPACE, useColors } from '@/lib/theme';
import { formatClock, formatKm } from './history-format';
import { startOfDay } from './time-range';

/**
 * Today's finished trips as small cards; a tap opens History and plays that trip straight away
 * (`playFrom` / `playTo` params). Nothing shows when there are no trips yet today.
 */
export function TodayTrips({ objectId }: { objectId: string }) {
  const c = useColors();
  const { t } = useTranslation();
  const { can } = useAuth();
  const from = startOfDay(new Date()).toISOString();
  const trips = useQuery({
    queryKey: ['today-trips', objectId, from],
    queryFn: ({ signal }) => api.get<TripDto[]>(`/objects/${objectId}/trips`, { from, to: new Date().toISOString() }, signal),
    enabled: can('history'),
    staleTime: 60_000,
    refetchInterval: 120_000,
  });
  const list = trips.data ?? [];
  if (!list.length) return null;

  return (
    <View style={{ gap: 6 }}>
      <Text size="xs" tone="muted" weight="600">
        {t("Today's trips ({{n}})", { n: list.length })}
      </Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: SPACE.sm }}>
        {list.map((trip, i) => (
          <Pressable
            key={trip.id}
            accessibilityRole="button"
            accessibilityLabel={t('Play trip {{n}}', { n: i + 1 })}
            onPress={() => router.push({ pathname: '/history/[id]', params: { id: objectId, playFrom: trip.startTime, playTo: trip.endTime } })}
            style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, paddingVertical: 6, borderRadius: RADIUS.md, borderWidth: 1, borderColor: c.border, backgroundColor: pressed ? c.muted : c.card })}
          >
            <RouteIcon size={14} color={c.primary} />
            <View>
              <Text size="xs" weight="600">
                {formatClock(Date.parse(trip.startTime), false, false)}–{formatClock(Date.parse(trip.endTime), false, false)}
              </Text>
              <Text size="xs" tone="muted">
                {formatKm(trip.distanceKm)}
              </Text>
            </View>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

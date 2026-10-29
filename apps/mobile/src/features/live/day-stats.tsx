import { useQuery } from '@tanstack/react-query';
import type { LiveObject, VehicleDayStatsDto } from '@veetracer/shared';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import { Text } from '@/components/ui';
import { AddressLine } from '@/features/geocoding/use-address';
import { formatClock, formatKm } from '@/features/history/history-format';
import { api } from '@/lib/api';
import { formatDuration } from '@/lib/format';
import { SPACE, useColors } from '@/lib/theme';

export type DayStatsMap = Record<string, VehicleDayStatsDto>;

/** Today's figures of every vehicle in scope (GET /live/day-stats); the summarizer refreshes them once a minute. */
export function useDayStats() {
  return useQuery({
    queryKey: ['live-day-stats'],
    queryFn: ({ signal }) => api.get<Record<string, VehicleDayStatsDto>>('/live/day-stats', undefined, signal),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
}

/** "Ignition off since 14:05 (2 h 10 min)"; null for objects without an ignition reading (phones, ID cards). */
function ignitionLine(o: LiveObject, now: number, t: (k: string, v?: Record<string, string>) => string): string | null {
  if (o.ignition === null || o.type === 'PERSON') return null;
  if (o.ignition) return t('Ignition on');
  const since = o.statusSince ? Date.parse(o.statusSince) : NaN;
  if (Number.isNaN(since)) return t('Ignition off');
  const sameDay = new Date(since).toDateString() === new Date(now).toDateString();
  return t('Ignition off since {{time}} ({{duration}})', { time: formatClock(since, !sameDay, false), duration: formatDuration((now - since) / 1000) });
}

/**
 * Under each vehicle in the Vehicles list and on the map: address, ignition, and today's distance, moving / idle time,
 * stops, max speed, current (or last) trip and the odometer. Tapping the vehicle still opens its details.
 */
export function VehicleDayDetails({ o, stats, now }: { o: LiveObject; stats: VehicleDayStatsDto | undefined; now: number }) {
  const c = useColors();
  const { t } = useTranslation();
  if (o.licenceLocked) return null;
  const ign = ignitionLine(o, now, t);
  const items: [string, string][] = stats
    ? [
        [t('Today'), formatKm(stats.distanceKm)],
        [t('Moving'), formatDuration(stats.movingSec)],
        [t('Idle'), formatDuration(stats.idleSec)],
        [t('Stops'), String(stats.stops)],
        [t('Max speed'), `${stats.maxSpeedKph} km/h`],
        ...(stats.trip
          ? ([[stats.trip.ongoing ? t('Current trip') : t('Last trip'), `${formatKm(stats.trip.distanceKm)} · ${formatDuration(stats.trip.durationSec)}`]] as [string, string][])
          : []),
        [t('Odometer'), `${stats.odometerKm.toLocaleString('en-IN')} km`],
      ]
    : [];
  return (
    <View style={{ gap: 4, marginTop: SPACE.xs }}>
      <AddressLine lat={o.lat} lng={o.lng} lines={1} />
      {ign && (
        <Text size="xs" tone="muted" numberOfLines={1}>
          {ign}
        </Text>
      )}
      {items.length > 0 && (
        <View style={styles.grid}>
          {items.map(([label, value]) => (
            <View key={label} style={[styles.cell, { backgroundColor: c.muted }]}>
              <Text size="xs" tone="muted" numberOfLines={1}>
                {label}
              </Text>
              <Text size="xs" weight="700" numberOfLines={1}>
                {value}
              </Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 4 },
  cell: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, minWidth: '31%', flexGrow: 1 },
});

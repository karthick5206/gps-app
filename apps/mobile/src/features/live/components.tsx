import { MOVEMENT_STATUSES, STATUS_META, displayStatus, displayStatusLabel, personActivity, type LiveObject, type MovementStatus } from '@veetracer/shared';
import { Image } from 'expo-image';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, StyleSheet, View } from 'react-native';
import { Chips, Pill, Text } from '@/components/ui';
import { vehicleImage } from '@/features/map/vehicle-icons';
import { relativeTime, timeInStatus } from '@/lib/format';
import { SPACE, statusColor, useScheme } from '@/lib/theme';

export type StatusFilter = MovementStatus | 'ALL';

export function StatusPill({ o, now }: { o: LiveObject; now?: number }) {
  const scheme = useScheme();
  const { t } = useTranslation();
  const meta = STATUS_META[o.status];
  // Licence expired past grace: no position or status is shown until it is renewed.
  if (o.licenceLocked) return <Pill label={t('Licence expired')} color="#dc2626" />;
  // People: activity from speed, without a duration (see displayStatusLabel).
  if (personActivity(o)) return <Pill label={t(displayStatusLabel(o))} color={statusColor(displayStatus(o), scheme)} />;
  return <Pill label={timeInStatus(t(meta.label), o.statusSince, now) ?? t(meta.label)} color={statusColor(o.status, scheme)} />;
}

export function VehicleThumb({ o, size = 36 }: { o: LiveObject; size?: number }) {
  return <Image source={vehicleImage(o)} style={{ width: size, height: size }} contentFit="contain" />;
}

/** Name, plate, status, speed and last update — used in the list and on the map card. */
export function VehicleSummary({ o, now }: { o: LiveObject; now?: number }) {
  return (
    <View style={styles.summary}>
      <VehicleThumb o={o} />
      <View style={{ flex: 1, gap: 3 }}>
        <View style={styles.titleRow}>
          <Text weight="600" numberOfLines={1} style={{ flexShrink: 1 }}>
            {o.name}
          </Text>
          {o.plateNumber && o.plateNumber !== o.name && (
            <Text size="sm" tone="muted" numberOfLines={1}>
              {o.plateNumber}
            </Text>
          )}
        </View>
        <View style={styles.titleRow}>
          <StatusPill o={o} now={now} />
          <Text size="sm" tone="muted">
            {Math.round(o.speedKph)} km/h
          </Text>
          <Text size="sm" tone="muted" style={{ marginLeft: 'auto' }}>
            {relativeTime(o.serverTime ?? o.fixTime, now)}
          </Text>
        </View>
      </View>
    </View>
  );
}

export function useStatusCounts(objects: LiveObject[]) {
  return useMemo(() => {
    const counts: Record<StatusFilter, number> = { ALL: objects.length, RUNNING: 0, IDLE: 0, OFF: 0, OVERSPEED: 0, OFFLINE: 0, NO_DATA: 0 };
    for (const o of objects) counts[o.status]++;
    return counts;
  }, [objects]);
}

export function StatusChips({ objects, value, onChange }: { objects: LiveObject[]; value: StatusFilter; onChange: (v: StatusFilter) => void }) {
  const scheme = useScheme();
  const { t } = useTranslation();
  const counts = useStatusCounts(objects);
  const options = [
    { value: 'ALL' as StatusFilter, label: t('All'), count: counts.ALL },
    ...MOVEMENT_STATUSES.filter((s) => counts[s] > 0 || s === value).map((s) => ({ value: s as StatusFilter, label: t(STATUS_META[s].label), color: statusColor(s, scheme), count: counts[s] })),
  ];
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: SPACE.lg }} keyboardShouldPersistTaps="handled">
      <Chips options={options} value={value} onChange={onChange} />
    </ScrollView>
  );
}

export function matches(o: LiveObject, q: string, status: StatusFilter): boolean {
  if (status !== 'ALL' && o.status !== status) return false;
  if (!q) return true;
  const hay = `${o.name}\u0000${o.plateNumber ?? ''}\u0000${o.uniqueId ?? ''}`.toLowerCase();
  return hay.includes(q.trim().toLowerCase());
}

const styles = StyleSheet.create({
  summary: { flexDirection: 'row', alignItems: 'center', gap: SPACE.md },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
});

import { ALERT_TYPE_MAP, type AlertTypeCode, type TripSafetyOccurrence } from '@veetracer/shared';
import { router } from 'expo-router';
import { FilmIcon, MapIcon, MapPinIcon, XIcon } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { FlatList, Linking, Modal, Pressable, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button, Pill, Text } from '@/components/ui';
import { AlertTypeIcon } from '@/features/alerts/alert-icons';
import { useAuth } from '@/features/auth/auth';
import { formatDateTime } from '@/lib/format';
import { RADIUS, SPACE, useColors } from '@/lib/theme';
import type { Row } from './report-defs';
import { occurrenceMapUrl, occurrencePlace, scoreBand, TRIP_SAFETY_HEADERS, violationBreakdown } from './trip-safety';

/** Score chip: green ≥ 90, amber ≥ 70, else red (same as the web report). */
export function TripSafetyScore({ score }: { score: number }) {
  const c = useColors();
  const { t } = useTranslation();
  const band = scoreBand(score);
  const color = band === 'good' ? c.success : band === 'fair' ? c.warning : c.destructive;
  return <Pill label={t('Score {{n}}', { n: score })} color={color} />;
}

/**
 * TRIP_SAFETY drill-down (mobile counterpart of the web TripSafetyDetails panel): every violation of one trip with
 * type, time, speed and place, a button that opens the place in the phone's maps app and, when the dashcam sent
 * evidence, a link to the driver event (photo / clip).
 */
export function TripSafetySheet({ row, onClose }: { row: Row | null; onClose: () => void }) {
  const c = useColors();
  const { t } = useTranslation();
  const { can } = useAuth();
  const occurrences = (row?.occurrences as TripSafetyOccurrence[] | undefined) ?? [];
  const breakdown = violationBreakdown(row?.counts as Record<string, number> | undefined);
  const evidence = can('driver_events');

  const openEvidence = (id: string) => {
    onClose();
    router.push(`/driver-events/${id}`);
  };

  return (
    <Modal visible={!!row} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={{ flex: 1, backgroundColor: c.background }}>
        <View style={[styles.header, { borderBottomColor: c.border }]}>
          <View style={{ flex: 1, gap: 2 }}>
            <Text weight="700" numberOfLines={1}>
              {String(row?.objectName ?? '')} · {t('{{n}} violations', { n: occurrences.length })}
            </Text>
            <Text size="sm" tone="muted">
              {formatDateTime(row?.startTime as string | undefined)} – {formatDateTime(row?.endTime as string | undefined)}
              {row?.driverName ? ` · ${String(row.driverName)}` : ''}
            </Text>
          </View>
          <Pressable onPress={onClose} hitSlop={10} accessibilityRole="button" accessibilityLabel={t('Close')}>
            <XIcon size={22} color={c.foreground} />
          </Pressable>
        </View>
        <FlatList
          data={occurrences}
          keyExtractor={(o) => o.alertId}
          contentContainerStyle={{ padding: SPACE.lg, gap: SPACE.md }}
          ListHeaderComponent={
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.xs }}>
              {typeof row?.score === 'number' && <TripSafetyScore score={row.score} />}
              {breakdown.map(([type, n]) => (
                <Pill key={type} label={`${t(TRIP_SAFETY_HEADERS[type])} × ${n}`} color={c.mutedForeground} />
              ))}
            </View>
          }
          ListEmptyComponent={
            <Text tone="muted" style={{ textAlign: 'center', marginTop: SPACE.xl }}>
              {t('No violations on this trip.')}
            </Text>
          }
          renderItem={({ item: o }) => {
            const info = ALERT_TYPE_MAP[o.type as AlertTypeCode];
            const place = occurrencePlace(o);
            const mapUrl = occurrenceMapUrl(o);
            return (
              <View style={[styles.item, { borderColor: c.border, backgroundColor: c.card }]}>
                <AlertTypeIcon type={o.type} severity={info?.defaultSeverity ?? 'WARNING'} size={34} />
                <View style={{ flex: 1, gap: SPACE.xs }}>
                  <Text weight="600">{t(info?.label ?? o.type)}</Text>
                  <Text size="xs" tone="muted">
                    {formatDateTime(o.occurredAt)}
                    {o.speedKph !== null ? ` · ${o.speedKph} km/h` : ''}
                  </Text>
                  {place && (
                    <View style={{ flexDirection: 'row', gap: 4, alignItems: 'flex-start' }}>
                      <MapPinIcon size={13} color={c.mutedForeground} style={{ marginTop: 2 }} />
                      <Text size="sm" style={{ flex: 1 }}>
                        {place}
                      </Text>
                    </View>
                  )}
                  {(mapUrl || (o.driverEventId && evidence)) && (
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm, marginTop: SPACE.xs }}>
                      {mapUrl && <Button title={t('Open in maps')} icon={MapIcon} variant="outline" style={styles.smallButton} onPress={() => void Linking.openURL(mapUrl).catch(() => undefined)} />}
                      {o.driverEventId && evidence && (
                        <Button title={o.hasClip ? t('Watch clip') : t('View evidence')} icon={FilmIcon} variant="outline" style={styles.smallButton} onPress={() => openEvidence(o.driverEventId!)} />
                      )}
                    </View>
                  )}
                </View>
              </View>
            );
          }}
        />
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: SPACE.md, padding: SPACE.md, borderBottomWidth: StyleSheet.hairlineWidth },
  item: { flexDirection: 'row', gap: SPACE.md, padding: SPACE.md, borderWidth: StyleSheet.hairlineWidth, borderRadius: RADIUS.md },
  smallButton: { paddingHorizontal: SPACE.md, height: 36 },
});

import { useQuery } from '@tanstack/react-query';
import { BATTERY_STATUS_META, type DashboardFleetHealth } from '@veetracer/shared';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';
import { Card, SectionTitle, Text } from '@/components/ui';
import { api } from '@/lib/api';
import { formatDuration } from '@/lib/format';
import { SPACE, useColors } from '@/lib/theme';

const inr = (v: number) => `₹${Math.round(v).toLocaleString('en-IN')}`;

/**
 * Dashboard "Vehicle health & fuel waste" (GET /dashboard/fleet-health, kept 30 min on the server): batteries needing
 * attention from the tracker voltage and idle cost this month. Rows open the vehicle. Hidden on older servers.
 */
export function FleetHealthSection() {
  const { t } = useTranslation();
  const c = useColors();
  const q = useQuery({
    queryKey: ['dashboard', 'fleet-health'],
    queryFn: ({ signal }) => api.get<DashboardFleetHealth>('/dashboard/fleet-health', undefined, signal),
    staleTime: 10 * 60_000,
    retry: false,
  });
  const d = q.data;
  if (!d) return null;
  const toneColor = (tone: string) => (tone === 'ok' ? c.success : tone === 'warn' ? c.warning : tone === 'bad' ? c.destructive : c.mutedForeground);
  return (
    <>
      <SectionTitle>{t('Vehicle health & fuel waste')}</SectionTitle>
      <View style={styles.row}>
        <Card style={styles.kpi}>
          <Text size="xs" tone="muted" weight="500">
            {t('Batteries needing attention')}
          </Text>
          <Text size="xl" weight="700" style={d.battery.action ? { color: c.destructive } : undefined}>
            {d.battery.action}
          </Text>
          <Text size="xs" tone="muted">
            {t('{{count}} weak', { count: d.battery.weak })}
          </Text>
        </Card>
        <Card style={styles.kpi}>
          <Text size="xs" tone="muted" weight="500">
            {t('Idle cost this month')}
          </Text>
          <Text size="xl" weight="700">
            {inr(d.idle.rupees)}
          </Text>
          <Text size="xs" tone="muted">
            {t('{{l}} L fuel', { l: Math.round(d.idle.litres).toLocaleString('en-IN') })}
          </Text>
        </Card>
      </View>
      {d.battery.list.length > 0 && (
        <Card style={{ gap: SPACE.sm }}>
          {d.battery.list.map((r) => {
            const m = BATTERY_STATUS_META[r.status];
            return (
              <Pressable key={r.objectId} onPress={() => router.push(`/vehicle/${r.objectId}`)} style={styles.line} accessibilityRole="button">
                <Text size="sm" weight="600" numberOfLines={1} style={{ flex: 1 }}>
                  {r.plateNumber || r.objectName}
                </Text>
                {r.restV !== null && (
                  <Text size="xs" tone="muted">
                    {`${r.restV.toFixed(1)} V`}
                  </Text>
                )}
                <Text size="sm" weight="700" style={{ color: toneColor(m.tone) }}>
                  {t(m.label)}
                </Text>
              </Pressable>
            );
          })}
        </Card>
      )}
      {d.idle.top.length > 0 && (
        <Card style={{ gap: SPACE.sm }}>
          <Text size="xs" tone="muted" weight="600">
            {t('Most idle cost this month')}
          </Text>
          {d.idle.top.map((r) => (
            <Pressable key={r.objectId} onPress={() => router.push(`/vehicle/${r.objectId}`)} style={styles.line} accessibilityRole="button">
              <Text size="sm" weight="600" numberOfLines={1} style={{ flex: 1 }}>
                {r.plateNumber || r.objectName}
              </Text>
              <Text size="xs" tone="muted">
                {formatDuration(r.idleSec)}
              </Text>
              <Text size="sm" weight="700" style={{ minWidth: 72, textAlign: 'right' }}>
                {inr(r.rupees)}
              </Text>
            </Pressable>
          ))}
        </Card>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: SPACE.md },
  kpi: { flex: 1, gap: 2 },
  line: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, minHeight: 32 },
});

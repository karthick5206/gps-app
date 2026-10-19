import { useQuery } from '@tanstack/react-query';
import { ALERT_TYPE_MAP, MOVEMENT_STATUSES, STATUS_META, type AlertTypeCode, type DashboardOverview, type DashboardVehicleDistance } from '@veetracer/shared';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { Card, ErrorBanner, SectionTitle, Text } from '@/components/ui';
import { alertIcon } from '@/features/alerts/alert-icons';
import { api, errorMessage } from '@/lib/api';
import { formatDuration } from '@/lib/format';
import { LicenceBanner } from '@/features/licences/LicenceBanner';
import { RADIUS, SPACE, statusColor, useColors, useScheme } from '@/lib/theme';

function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card style={styles.kpi}>
      <Text size="xs" tone="muted" weight="500">
        {label}
      </Text>
      <Text size="xl" weight="700">
        {value}
      </Text>
      {hint && (
        <Text size="xs" tone="muted">
          {hint}
        </Text>
      )}
    </Card>
  );
}

function DistanceList({ rows }: { rows: DashboardVehicleDistance[] }) {
  const c = useColors();
  const { t } = useTranslation();
  const max = Math.max(1, ...rows.map((r) => r.distanceKm));
  return (
    <Card style={{ gap: SPACE.md }}>
      {rows.length === 0 && (
        <Text size="sm" tone="muted">
          {t('No distance recorded today.')}
        </Text>
      )}
      {rows.map((r) => (
        <Pressable key={r.objectId} onPress={() => router.push(`/vehicle/${r.objectId}`)} style={{ gap: 4 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: SPACE.sm }}>
            <Text size="sm" weight="500" numberOfLines={1} style={{ flex: 1 }}>
              {r.plateNumber || r.name}
            </Text>
            <Text size="sm" weight="600">
              {r.distanceKm.toFixed(1)} km
            </Text>
          </View>
          <View style={{ height: 6, borderRadius: 3, backgroundColor: c.muted }}>
            <View style={{ width: `${(r.distanceKm / max) * 100}%`, height: 6, borderRadius: 3, backgroundColor: c.primary }} />
          </View>
          <Text size="xs" tone="muted">
            {t('Running {{duration}}', { duration: formatDuration(r.runningSec) })}
          </Text>
        </Pressable>
      ))}
    </Card>
  );
}

export default function DashboardScreen() {
  const scheme = useScheme();
  const c = useColors();
  const { t } = useTranslation();
  const q = useQuery({
    queryKey: ['dashboard', 'overview'],
    queryFn: ({ signal }) => api.get<DashboardOverview>('/dashboard/overview', { top: 5 }, signal),
    refetchInterval: 60_000,
  });
  const d = q.data;
  return (
    <ScrollView contentContainerStyle={{ padding: SPACE.lg, gap: SPACE.md }} refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => void q.refetch()} />}>
      <LicenceBanner />
      {q.isPending && <ActivityIndicator style={{ margin: SPACE.xl }} />}
      {q.isError && <ErrorBanner message={errorMessage(q.error)} onRetry={() => q.refetch()} />}
      {d && (
        <>
          <SectionTitle>{t('Fleet now · {{count}} vehicles', { count: d.total })}</SectionTitle>
          <View style={styles.grid}>
            {MOVEMENT_STATUSES.map((s) => (
              <Pressable key={s} onPress={() => router.push('/vehicles')} style={[styles.status, { backgroundColor: c.card, borderColor: c.border }]}>
                <View style={[styles.dot, { backgroundColor: statusColor(s, scheme) }]} />
                <Text size="xl" weight="700">
                  {d.byStatus[s] ?? 0}
                </Text>
                <Text size="xs" tone="muted">
                  {t(STATUS_META[s].label)}
                </Text>
              </Pressable>
            ))}
          </View>

          <SectionTitle>{t('Today')}</SectionTitle>
          <View style={styles.grid}>
            <Kpi label={t('Distance')} value={`${Math.round(d.todayDistanceKm).toLocaleString()} km`} />
            <Kpi label={t('Trips')} value={d.todayTrips.toLocaleString()} />
            <Kpi label={t('Devices online')} value={`${d.devicesOnline} / ${d.total}`} />
            <Kpi label={t('Alerts')} value={d.todayAlerts.total.toLocaleString()} hint={d.todayAlerts.critical ? t('{{count}} critical', { count: d.todayAlerts.critical }) : undefined} />
          </View>

          {d.todayAlerts.byType.length > 0 && (
            <>
              <SectionTitle>{t('Alerts today')}</SectionTitle>
              <Card style={{ gap: SPACE.sm }}>
                {d.todayAlerts.byType.map((a) => {
                  const Icon = alertIcon(a.type);
                  return (
                    <Pressable key={a.type} onPress={() => router.push('/alerts')} style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE.sm }}>
                      <Icon size={18} color={c.mutedForeground} />
                      <Text size="sm" style={{ flex: 1 }}>
                        {t(ALERT_TYPE_MAP[a.type as AlertTypeCode]?.label ?? a.type)}
                      </Text>
                      <Text size="sm" weight="600">
                        {a.count}
                      </Text>
                    </Pressable>
                  );
                })}
              </Card>
            </>
          )}

          <SectionTitle>{t('Top distance today')}</SectionTitle>
          <DistanceList rows={d.top} />

          {d.geofences.length > 0 && (
            <>
              <SectionTitle>{t('Inside geofences · {{count}}', { count: d.vehiclesInsideGeofences })}</SectionTitle>
              <Card style={{ gap: SPACE.sm }}>
                {d.geofences.map((g) => (
                  <View key={g.geofenceId} style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE.sm }}>
                    <View style={[styles.dot, { backgroundColor: g.color ?? c.primary }]} />
                    <Text size="sm" style={{ flex: 1 }}>
                      {g.name}
                    </Text>
                    <Text size="sm" weight="600">
                      {g.vehicles}
                    </Text>
                  </View>
                ))}
              </Card>
            </>
          )}
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm },
  kpi: { flexBasis: '48%', flexGrow: 1, gap: 2 },
  status: { flexBasis: '31%', flexGrow: 1, borderWidth: StyleSheet.hairlineWidth, borderRadius: RADIUS.md, padding: SPACE.md, gap: 2 },
  dot: { width: 8, height: 8, borderRadius: 4 },
});

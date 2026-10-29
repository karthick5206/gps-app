import { formatMinutes, type ParkingRowDto, type ParkingWindowDto } from '@veetracer/shared';
import { router, Stack } from 'expo-router';
import { CalendarClockIcon, ShieldAlertIcon, ShieldCheckIcon, ShieldOffIcon } from 'lucide-react-native';
import { useDeferredValue, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, View } from 'react-native';
import { EmergencyAlertsCard } from '@/components/EmergencyAlertsCard';
import { Card, EmptyState, ErrorBanner, Pill, SearchInput, Text } from '@/components/ui';
import { useAuth } from '@/features/auth/auth';
import { daysLabel, useParkingRows } from '@/features/parking/parking';
import { errorMessage } from '@/lib/api';
import { SPACE, useColors } from '@/lib/theme';

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const dayTimeFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });

const windowLabel = (w: ParkingWindowDto, t: (k: string) => string) =>
  `${daysLabel(w.days, t)} ${formatMinutes(w.startMin)}–${formatMinutes(w.endMin)}${w.endMin <= w.startMin ? ' (+1)' : ''}`;

function State({ r }: { r: ParkingRowDto }) {
  const { t } = useTranslation();
  if (r.armedUntil) return <Pill label={t('Armed until {{time}}', { time: timeFmt.format(Date.parse(r.armedUntil)) })} color="#dc2626" />;
  if (r.schedule?.enabled && r.nextStart) return <Pill label={t('Next: {{time}}', { time: dayTimeFmt.format(Date.parse(r.nextStart)) })} color="#0e7490" />;
  return <Pill label={t('Off')} color="#64748b" />;
}

/** Parking mode: vehicles with their weekly armed windows; the calendar icon opens the schedule. */
export default function ParkingScreen() {
  const c = useColors();
  const { t } = useTranslation();
  const { can } = useAuth();
  const canEdit = can('parking_mode', 'edit');
  const list = useParkingRows();
  const [q, setQ] = useState('');
  const search = useDeferredValue(q.trim().toLowerCase());
  const rows = useMemo(() => (list.data ?? []).filter((r) => !search || `${r.name} ${r.plateNumber ?? ''}`.toLowerCase().includes(search)), [list.data, search]);
  const armed = (list.data ?? []).filter((r) => r.armedUntil).length;
  return (
    <>
      <Stack.Screen options={{ title: t('Parking mode') }} />
      <FlatList
        data={rows}
        keyExtractor={(r) => r.objectId}
        contentContainerStyle={{ padding: SPACE.lg, gap: SPACE.sm, flexGrow: 1 }}
        refreshControl={<RefreshControl refreshing={list.isRefetching} onRefresh={() => void list.refetch()} />}
        ListHeaderComponent={
          <View style={{ gap: SPACE.sm, marginBottom: SPACE.xs }}>
            <Text size="sm" tone="muted">
              {t('Armed vehicles sound a loud alarm, also through Do Not Disturb, when they are started or moved.')} {t('Armed now: {{n}}.', { n: armed })}
            </Text>
            <SearchInput value={q} onChangeText={setQ} placeholder={t('Search vehicle or plate')} />
            {list.isError && <ErrorBanner message={errorMessage(list.error)} onRetry={() => void list.refetch()} />}
          </View>
        }
        renderItem={({ item: r }) => (
          <Card onPress={canEdit ? () => router.push(`/parking/${r.objectId}`) : undefined}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE.md }}>
              {r.armedUntil ? <ShieldAlertIcon size={22} color="#dc2626" /> : r.schedule?.enabled ? <ShieldCheckIcon size={22} color={c.primary} /> : <ShieldOffIcon size={22} color={c.mutedForeground} />}
              <View style={{ flex: 1, gap: 3 }}>
                <Text weight="600" numberOfLines={1}>
                  {r.name}
                  {r.plateNumber && r.plateNumber !== r.name ? <Text tone="muted" size="sm">{`  ${r.plateNumber}`}</Text> : null}
                </Text>
                <Text size="sm" tone="muted" numberOfLines={2}>
                  {r.schedule?.windows.length ? r.schedule.windows.map((w) => windowLabel(w, t)).join(' · ') : t('Not set')}
                </Text>
                <State r={r} />
              </View>
              {canEdit && (
                <Pressable onPress={() => router.push(`/parking/${r.objectId}`)} hitSlop={10} accessibilityLabel={t('Schedule for {{name}}', { name: r.name })}>
                  <CalendarClockIcon size={24} color={c.primary} />
                </Pressable>
              )}
            </View>
          </Card>
        )}
        ListEmptyComponent={list.isPending ? <ActivityIndicator style={{ margin: SPACE.xl }} /> : <EmptyState icon={ShieldOffIcon} title={t('No vehicles')} />}
        ListFooterComponent={
          <View style={{ marginTop: SPACE.lg, gap: SPACE.sm }}>
            <Text weight="600">{t('Alarm on this phone')}</Text>
            <EmergencyAlertsCard />
          </View>
        }
      />
    </>
  );
}

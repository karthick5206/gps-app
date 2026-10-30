import { useQuery } from '@tanstack/react-query';
import type { AttendanceDayDto, AttendanceStatus } from '@veetracer/shared';
import { Stack } from 'expo-router';
import { CalendarCheckIcon } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, FlatList, RefreshControl, View } from 'react-native';
import { Card, EmptyState, ErrorBanner, Pill, Text } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { SPACE } from '@/lib/theme';

const STATUS: Record<AttendanceStatus, { label: string; color: string }> = {
  PRESENT: { label: 'Present', color: '#059669' },
  LATE: { label: 'Late', color: '#d97706' },
  NOT_ARRIVED: { label: 'Not arrived', color: '#ea580c' },
  ABSENT: { label: 'Absent', color: '#e11d48' },
  DAY_OFF: { label: 'Day off', color: '#64748b' },
  UPCOMING: { label: 'Not started', color: '#64748b' },
};
const clock = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const time = (iso: string | null) => (iso ? clock.format(Date.parse(iso)) : '—');

/** Today's staff attendance (settings and timesheets are on the web). */
export default function AttendanceScreen() {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ['attendance', 'today'], queryFn: ({ signal }) => api.get<AttendanceDayDto>('/attendance', undefined, signal), refetchInterval: 60_000 });
  const d = q.data;
  return (
    <>
      <Stack.Screen options={{ title: t('Staff attendance') }} />
      <FlatList
        data={d?.enabled ? d.rows : []}
        keyExtractor={(r) => r.objectId}
        contentContainerStyle={{ padding: SPACE.lg, gap: SPACE.sm, flexGrow: 1 }}
        refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => void q.refetch()} />}
        ListHeaderComponent={
          <View style={{ gap: SPACE.sm, marginBottom: SPACE.xs }}>
            {d?.enabled && (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                {(Object.keys(STATUS) as AttendanceStatus[]).filter((s) => d.counts[s] > 0).map((s) => (
                  <Pill key={s} label={`${t(STATUS[s].label)} ${d.counts[s]}`} color={STATUS[s].color} />
                ))}
              </View>
            )}
            {q.isError && <ErrorBanner message={errorMessage(q.error)} onRetry={() => void q.refetch()} />}
          </View>
        }
        renderItem={({ item: r }) => (
          <Card style={{ gap: 4 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE.sm }}>
              <Text weight="600" style={{ flex: 1 }} numberOfLines={1}>
                {r.name}
              </Text>
              <Pill label={t(STATUS[r.status].label)} color={STATUS[r.status].color} />
            </View>
            <Text size="sm" tone="muted">
              {`${t('In')} ${time(r.firstIn)} · ${t('Out')} ${r.firstIn && !r.lastOut ? t('On site') : time(r.lastOut)}${r.onSiteMin ? ` · ${Math.floor(r.onSiteMin / 60)} h ${r.onSiteMin % 60} min` : ''}${r.lateMin ? ` · ${t('+{{n}} min', { n: r.lateMin })}` : ''}`}
            </Text>
            {r.site && (
              <Text size="xs" tone="muted">
                {r.site}
              </Text>
            )}
          </Card>
        )}
        ListEmptyComponent={
          q.isPending ? (
            <ActivityIndicator style={{ margin: SPACE.xl }} />
          ) : (
            <EmptyState icon={CalendarCheckIcon} title={d?.enabled ? t('No staff to show') : t('Attendance is off')} description={d?.enabled ? undefined : t('Turn it on in the web app: Staff attendance → Settings.')} />
          )
        }
      />
    </>
  );
}

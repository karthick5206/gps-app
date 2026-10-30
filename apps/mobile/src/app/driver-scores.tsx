import { useQuery } from '@tanstack/react-query';
import { SCORE_MIN_KM, type DriverScoresDto, type ScoreBy, type ScoreGrade, type ScorePeriod } from '@veetracer/shared';
import { Stack } from 'expo-router';
import { MedalIcon, TrophyIcon } from 'lucide-react-native';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, FlatList, RefreshControl, View } from 'react-native';
import { Card, Chips, EmptyState, ErrorBanner, Text } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { SPACE, useColors } from '@/lib/theme';

const GRADE_COLOR: Record<ScoreGrade, string> = { A: '#059669', B: '#0284c7', C: '#d97706', D: '#e11d48' };
const MEDAL = ['#f59e0b', '#94a3b8', '#ea580c'];

/** Driver scorecard: safety score per driver (or vehicle) and leaderboard. */
export default function DriverScoresScreen() {
  const c = useColors();
  const { t } = useTranslation();
  const [period, setPeriod] = useState<ScorePeriod>('week');
  const [by, setBy] = useState<ScoreBy>('driver');
  const q = useQuery({ queryKey: ['driver-scores', period, by], queryFn: ({ signal }) => api.get<DriverScoresDto>('/driver-scores', { period, by }, signal) });
  const rows = q.data?.rows ?? [];
  return (
    <>
      <Stack.Screen options={{ title: t('Driver scorecard') }} />
      <FlatList
        data={rows}
        keyExtractor={(r) => `${r.kind}:${r.id}`}
        contentContainerStyle={{ padding: SPACE.lg, gap: SPACE.sm, flexGrow: 1 }}
        refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => void q.refetch()} />}
        ListHeaderComponent={
          <View style={{ gap: SPACE.sm, marginBottom: SPACE.xs }}>
            <Chips
              options={[
                { value: 'week' as ScorePeriod, label: t('This week') },
                { value: 'lastWeek' as ScorePeriod, label: t('Last week') },
                { value: 'month' as ScorePeriod, label: t('This month') },
                { value: 'lastMonth' as ScorePeriod, label: t('Last month') },
              ]}
              value={period}
              onChange={setPeriod}
            />
            <Chips
              options={[
                { value: 'driver' as ScoreBy, label: t('Drivers') },
                { value: 'vehicle' as ScoreBy, label: t('Vehicles') },
              ]}
              value={by}
              onChange={setBy}
            />
            <Card style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE.md }}>
              <TrophyIcon size={22} color="#f59e0b" />
              <Text style={{ flex: 1 }}>{t('Fleet average')}</Text>
              <Text size="lg" weight="700">
                {q.data?.average ?? '—'}
              </Text>
            </Card>
            {q.isError && <ErrorBanner message={errorMessage(q.error)} onRetry={() => void q.refetch()} />}
          </View>
        }
        renderItem={({ item: r, index }) => (
          <Card style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE.md }}>
            {r.score !== null && index < 3 ? (
              <MedalIcon size={22} color={MEDAL[index]} />
            ) : (
              <Text tone="muted" style={{ width: 22, textAlign: 'center' }}>
                {r.score !== null ? index + 1 : '—'}
              </Text>
            )}
            <View style={{ flex: 1, gap: 2 }}>
              <Text weight="600" numberOfLines={1}>
                {r.name}
              </Text>
              <Text size="xs" tone="muted" numberOfLines={1}>
                {`${r.km} km · ${t('Overspeed')} ${r.overspeed} · ${t('Harsh')} ${r.harsh} · ${t('Dashcam')} ${r.dms + r.adas + r.crash} · ${t('Idle %')} ${r.idlePct}%`}
              </Text>
            </View>
            {r.score === null ? (
              <Text size="xs" tone="muted">
                {t('Under {{km}} km', { km: SCORE_MIN_KM })}
              </Text>
            ) : (
              <View style={{ alignItems: 'center', minWidth: 48, paddingVertical: 4, paddingHorizontal: 8, borderRadius: 12, backgroundColor: `${GRADE_COLOR[r.grade!]}22` }}>
                <Text weight="700" style={{ color: GRADE_COLOR[r.grade!] }}>
                  {r.score}
                </Text>
                <Text size="xs" weight="700" style={{ color: GRADE_COLOR[r.grade!] }}>
                  {r.grade}
                </Text>
              </View>
            )}
          </Card>
        )}
        ListEmptyComponent={q.isPending ? <ActivityIndicator style={{ margin: SPACE.xl }} /> : <EmptyState icon={TrophyIcon} title={t('No driving in this period')} />}
        ListFooterComponent={
          <Text size="xs" tone="muted" style={{ marginTop: SPACE.md, color: c.mutedForeground }}>
            {t('A = 90+, B = 75–89, C = 60–74, D = below 60. Each overspeed costs 3 points per 100 km, harsh driving 2, phone use or distraction 4, fatigue 5, a crash 20; idling over 20% of engine time and night driving over 30% of the distance cost a few points more. Trips without a driver assigned count for the vehicle.')}
          </Text>
        }
      />
    </>
  );
}

import { useQuery } from '@tanstack/react-query';
import type { AttendanceDayDto, AttendanceLiveState, AttendanceRowDto, AttendanceStatus } from '@veetracer/shared';
import { router } from 'expo-router';
import { CalendarCheckIcon, ChevronLeftIcon, ChevronRightIcon } from 'lucide-react-native';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, View } from 'react-native';
import { Card, Chips, EmptyState, ErrorBanner, Pill, SearchInput, Text } from '@/components/ui';
import { addDays, hours, HALF_DAY, LIVE, localToday, STATUS, time } from '@/features/attendance/attendance-format';
import { api, errorMessage } from '@/lib/api';
import { SPACE, useColors } from '@/lib/theme';

type Tab = 'day' | 'sheet' | 'person';
type Period = 'week' | 'month' | 'last';
const ALL = 'ALL';
const HALF = 'HALF_DAY';

const rangeOf = (p: Period, today: string): { from: string; to: string } => {
  if (p === 'week') return { from: addDays(today, -6), to: today };
  if (p === 'month') return { from: `${today.slice(0, 8)}01`, to: today };
  const end = addDays(`${today.slice(0, 8)}01`, -1);
  return { from: `${end.slice(0, 8)}01`, to: end };
};

const openPerson = (r: AttendanceRowDto) => router.push({ pathname: '/attendance-person', params: { objectId: r.objectId, name: r.name } });
const open = (r: AttendanceRowDto) => router.push({ pathname: '/attendance-day', params: { objectId: r.objectId, day: r.day } });
const statusOf = (r: AttendanceRowDto) => (r.halfDay ? HALF : r.status);

function PersonCard({ r, withDay }: { r: AttendanceRowDto; withDay?: boolean }) {
  const { t } = useTranslation();
  const c = useColors();
  const s = r.halfDay ? HALF_DAY : STATUS[r.status];
  const flags = [
    r.lateMin > 0 && t('+{{n}} min', { n: r.lateMin }),
    r.earlyMin > 0 && t('Left {{n}} min early', { n: r.earlyMin }),
    r.overtimeMin > 0 && t('OT {{n}} min', { n: r.overtimeMin }),
    r.corrected && t('Corrected'),
  ].filter(Boolean);
  return (
    <Card style={{ gap: 6 }} onPress={() => open(r)}>
      <View style={styles.row}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text weight="600" numberOfLines={1}>
            {withDay ? `${r.day} · ${r.name}` : r.name}
          </Text>
          {r.state && (
            <View style={styles.liveRow}>
              <View style={[styles.liveDot, { backgroundColor: LIVE[r.state].color }]} />
              <Text size="xs" weight="600" style={{ color: LIVE[r.state].color }}>
                {t(LIVE[r.state].label)}
              </Text>
            </View>
          )}
        </View>
        <Pill label={t(s.label)} color={s.color} />
        <ChevronRightIcon size={18} color={c.mutedForeground} />
      </View>
      <View style={styles.row}>
        <View style={styles.figure}>
          <Text size="xs" tone="muted">{t('First in')}</Text>
          <Text size="sm" weight="600">{time(r.firstIn)}</Text>
        </View>
        <View style={styles.figure}>
          <Text size="xs" tone="muted">{t('Last out')}</Text>
          <Text size="sm" weight="600">{r.firstIn && !r.lastOut ? t('On site') : time(r.lastOut)}</Text>
        </View>
        <View style={styles.figure}>
          <Text size="xs" tone="muted">{t('Worked')}</Text>
          <Text size="sm" weight="600">{hours(r.workedMin)}</Text>
        </View>
      </View>
      {r.unexplainedMin > 0 && (
        <Text size="xs" weight="600" style={{ color: '#e11d48' }}>
          {t('Unexplained')}: {hours(r.unexplainedMin)}
        </Text>
      )}
      {flags.length > 0 && (
        <Text size="xs" tone="muted">
          {flags.join(' · ')}
        </Text>
      )}
      <View style={styles.row}>
        <Text size="xs" tone="muted" numberOfLines={1} style={{ flex: 1 }}>
          {[r.site, r.branch].filter(Boolean).join(' · ')}
        </Text>
        {r.selfieAt ? (
          <Text size="xs" tone="muted">{t('Selfie {{time}}', { time: time(r.selfieAt) })}</Text>
        ) : r.selfieMissing ? (
          <Text size="xs" weight="600" style={{ color: '#d97706' }}>{t('No selfie')}</Text>
        ) : null}
        {r.videoAt ? <Text size="xs" tone="muted">{t('Video')}</Text> : r.videoMissing ? <Text size="xs" weight="600" style={{ color: '#d97706' }}>{t('No video')}</Text> : null}
      </View>
    </Card>
  );
}

/** Staff attendance: one day's board, the timesheet and one person's insights (Employee); a person's day opens from any of them. Settings are on the web. */
export default function AttendanceScreen() {
  const { t } = useTranslation();
  const c = useColors();
  const today = localToday();
  const [tab, setTab] = useState<Tab>('day');
  const [day, setDay] = useState(today);
  const [period, setPeriod] = useState<Period>('month');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<string>(ALL);
  const [live, setLive] = useState<AttendanceLiveState | null>(null);

  const board = useQuery({
    queryKey: ['attendance', tab === 'person' ? today : day],
    queryFn: ({ signal }) => api.get<AttendanceDayDto>('/attendance', { day: tab === 'person' ? today : day }, signal),
    // Employee lists today's staff (everyone attendance covers) to choose from.
    enabled: tab === 'day' || tab === 'person',
    refetchInterval: 60_000,
  });
  const range = rangeOf(period, today);
  const sheet = useQuery({
    queryKey: ['attendance-sheet', range.from, range.to],
    queryFn: ({ signal }) => api.get<AttendanceRowDto[]>('/attendance/timesheet', range, signal),
    enabled: tab === 'sheet',
  });
  const active = tab === 'sheet' ? sheet : board;
  const rows = useMemo(() => (tab === 'sheet' ? (sheet.data ?? []) : board.data?.enabled ? board.data.rows : []), [tab, board.data, sheet.data]);
  const counts = useMemo(() => {
    const n: Record<string, number> = {};
    for (const r of rows) n[statusOf(r)] = (n[statusOf(r)] ?? 0) + 1;
    return n;
  }, [rows]);
  // Where people are right now (today only): counts per live state; a tile filters the list.
  const liveCounts = useMemo(() => {
    const n: Partial<Record<AttendanceLiveState, number>> = {};
    if (tab === 'day') for (const r of rows) if (r.state) n[r.state] = (n[r.state] ?? 0) + 1;
    return n;
  }, [rows, tab]);
  const hasLive = Object.keys(liveCounts).length > 0;
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return rows.filter((r) => (tab === 'person' || status === ALL || statusOf(r) === status) && (!live || tab !== 'day' || r.state === live) && (!s || r.name.toLowerCase().includes(s)));
  }, [rows, q, status, live, tab]);
  const off = tab === 'day' && board.data && !board.data.enabled;

  const options = [
    { value: ALL, label: t('All'), count: rows.length },
    ...(Object.keys(STATUS) as AttendanceStatus[]).filter((s) => counts[s]).map((s) => ({ value: s as string, label: t(STATUS[s].label), color: STATUS[s].color, count: counts[s] })),
    ...(counts[HALF] ? [{ value: HALF, label: t(HALF_DAY.label), color: HALF_DAY.color, count: counts[HALF] }] : []),
  ];

  return (
    <FlatList
      data={shown}
      keyExtractor={(r) => `${r.day}:${r.objectId}`}
      contentContainerStyle={{ padding: SPACE.lg, gap: SPACE.sm, flexGrow: 1 }}
      refreshControl={<RefreshControl refreshing={active.isRefetching} onRefresh={() => void active.refetch()} />}
      keyboardShouldPersistTaps="handled"
      ListHeaderComponent={
        <View style={{ gap: SPACE.sm, marginBottom: SPACE.xs }}>
          <Chips
            value={tab}
            onChange={(v) => {
              setTab(v);
              setStatus(ALL);
            }}
            options={[
              { value: 'day', label: t('Day') },
              { value: 'sheet', label: t('Timesheet') },
              { value: 'person', label: t('Employee') },
            ]}
          />
          {tab === 'day' ? (
            <View style={[styles.dateBar, { borderColor: c.border, backgroundColor: c.card }]}>
              <Pressable accessibilityRole="button" accessibilityLabel={t('Previous day')} hitSlop={8} onPress={() => setDay(addDays(day, -1))} style={styles.dateBtn}>
                <ChevronLeftIcon size={22} color={c.foreground} />
              </Pressable>
              <Text weight="600">{day === today ? t('Today') : day}</Text>
              <Pressable accessibilityRole="button" accessibilityLabel={t('Next day')} hitSlop={8} disabled={day >= today} onPress={() => setDay(addDays(day, 1))} style={[styles.dateBtn, { opacity: day >= today ? 0.3 : 1 }]}>
                <ChevronRightIcon size={22} color={c.foreground} />
              </Pressable>
            </View>
          ) : tab === 'person' ? (
            <Text size="sm" tone="muted">
              {t('Choose a staff member to see their attendance %, check-in times, hours and patterns.')}
            </Text>
          ) : (
            <Chips
              value={period}
              onChange={setPeriod}
              options={[
                { value: 'week', label: t('Last 7 days') },
                { value: 'month', label: t('This month') },
                { value: 'last', label: t('Last month') },
              ]}
            />
          )}
          {tab === 'day' && hasLive && (
            <View style={{ gap: 6 }}>
              <Text size="xs" tone="muted" weight="700" style={{ textTransform: 'uppercase', letterSpacing: 0.8 }}>
                {t('Right now')}
              </Text>
              <View style={styles.liveTiles}>
                {(Object.keys(LIVE) as AttendanceLiveState[]).map((k) => {
                  const on = live === k;
                  return (
                    <Pressable
                      key={k}
                      accessibilityRole="button"
                      accessibilityState={{ selected: on }}
                      accessibilityLabel={`${t(LIVE[k].label)}: ${liveCounts[k] ?? 0}`}
                      onPress={() => setLive(on ? null : k)}
                      style={[styles.liveTile, { borderColor: on ? LIVE[k].color : c.border, backgroundColor: on ? `${LIVE[k].color}1f` : c.card }]}
                    >
                      <View style={styles.liveRow}>
                        <View style={[styles.liveDot, { backgroundColor: LIVE[k].color }]} />
                        <Text size="xs" tone="muted" weight="600" numberOfLines={1}>
                          {t(LIVE[k].label)}
                        </Text>
                      </View>
                      <Text size="xl" weight="700">
                        {liveCounts[k] ?? 0}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>
          )}
          {rows.length > 0 && <SearchInput value={q} onChangeText={setQ} placeholder={t('Search staff')} accessibilityLabel={t('Search staff')} />}
          {rows.length > 0 && tab !== 'person' && <Chips value={status} onChange={setStatus} options={options} />}
          {active.isError && <ErrorBanner message={errorMessage(active.error)} onRetry={() => void active.refetch()} />}
          {tab === 'sheet' && rows.length > 0 && (
            <Text size="xs" tone="muted">
              {t('Download Excel or PDF from Reports → Staff attendance.')}
            </Text>
          )}
        </View>
      }
      renderItem={({ item }) =>
        tab === 'person' ? (
          <Card onPress={() => openPerson(item)}>
            <View style={styles.row}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text weight="600" numberOfLines={1}>
                  {item.name}
                </Text>
                <Text size="xs" tone="muted" numberOfLines={1}>
                  {[item.branch, item.shift === 'Default' ? t('Default shift') : item.shift].filter(Boolean).join(' · ')}
                </Text>
              </View>
              <Text size="xs" weight="600" style={{ color: c.primary }}>
                {t('Insights')}
              </Text>
              <ChevronRightIcon size={18} color={c.mutedForeground} />
            </View>
          </Card>
        ) : (
          <PersonCard r={item} withDay={tab === 'sheet'} />
        )
      }
      ListEmptyComponent={
        active.isPending ? (
          <ActivityIndicator style={{ margin: SPACE.xl }} />
        ) : (
          <EmptyState
            icon={CalendarCheckIcon}
            title={off ? t('Attendance is off') : rows.length ? t('No results') : t('No staff to show')}
            description={off ? t('Turn it on in the web app: Staff attendance → Settings.') : rows.length ? undefined : t('People tracked by phone or ID card appear here.')}
          />
        )
      }
    />
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
  figure: { flex: 1 },
  liveRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  liveDot: { width: 8, height: 8, borderRadius: 4 },
  liveTiles: { flexDirection: 'row', gap: SPACE.sm },
  liveTile: { flex: 1, borderWidth: 1, borderRadius: 12, padding: SPACE.md, gap: 4 },
  dateBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderWidth: 1, borderRadius: 12, paddingVertical: 4 },
  dateBtn: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
});

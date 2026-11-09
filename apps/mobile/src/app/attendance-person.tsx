import { useQuery } from '@tanstack/react-query';
import { calendarDays, change, employeeStats, employeeSummary, monthlyTrend, previousRange, teamFigures, trendRange, type AttendanceRowDto, type AttendanceSettingsDto } from '@veetracer/shared';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import Svg, { Circle, G, Line, Path, Rect, Text as SvgText } from 'react-native-svg';
import { Card, Chips, ErrorBanner, Text } from '@/components/ui';
import { useAuth } from '@/features/auth/auth';
import { addDays, HALF_DAY, hours, localToday, STATUS, time } from '@/features/attendance/attendance-format';
import { api, errorMessage } from '@/lib/api';
import { SPACE, useColors, useScheme } from '@/lib/theme';

/*
 * One staff member's attendance insights (same figures as the web Employee view, from @veetracer/shared): tiles, a
 * plain-language summary, a calendar, hours each day; with the Advanced attendance insights add-on also comparisons,
 * the days split, late by weekday, time away and the 12-month trend. Longer periods and downloads are on the web.
 */
type Period = 'this' | 'last' | '30' | '90';
const rangeOf = (p: Period, today: string) => {
  if (p === 'this') return { from: `${today.slice(0, 8)}01`, to: today };
  if (p === '30') return { from: addDays(today, -29), to: today };
  if (p === '90') return { from: addDays(today, -89), to: today };
  const end = addDays(`${today.slice(0, 8)}01`, -1);
  return { from: `${end.slice(0, 8)}01`, to: end };
};
/** Series colours: the validated blue / aqua slots of the web charts. */
const SERIES = { light: { within: '#2a78d6', overtime: '#1baf7a', personal: '#1baf7a', unexplained: '#eb6834' }, dark: { within: '#3987e5', overtime: '#199e70', personal: '#199e70', unexplained: '#d95926' } };
const clock = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const clockOf = (min: number) => clock.format(new Date(2000, 0, 1, Math.floor(min / 60), min % 60));
const DOW_LONG = (i: number) => new Intl.DateTimeFormat(undefined, { weekday: 'long' }).format(new Date(Date.UTC(2026, 10, 1 + i, 12)));
const DOW_SHORT = (i: number) => new Intl.DateTimeFormat(undefined, { weekday: 'narrow' }).format(new Date(Date.UTC(2026, 10, 2 + i, 12))); // Monday first
const DOW_ABBR = (i: number) => new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(new Date(Date.UTC(2026, 10, 1 + i, 12))); // Sunday = 0
const monthLong = (m: string) => new Intl.DateTimeFormat(undefined, { month: 'long', timeZone: 'UTC' }).format(new Date(`${m}-15T12:00:00Z`));
const monthShort = (m: string) => new Intl.DateTimeFormat(undefined, { month: 'narrow', timeZone: 'UTC' }).format(new Date(`${m}-15T12:00:00Z`));
const openDay = (r: AttendanceRowDto) => router.push({ pathname: '/attendance-day', params: { objectId: r.objectId, day: r.day } });

function Tile({ label, value, sub, compare }: { label: string; value: string; sub?: string; compare?: (string | false | null | undefined)[] }) {
  const c = useColors();
  const lines = (compare ?? []).filter(Boolean) as string[];
  return (
    <View style={[styles.tile, { borderColor: c.border, backgroundColor: c.card }]}>
      <Text size="xs" tone="muted" weight="600">
        {label}
      </Text>
      <Text size="xl" weight="700">
        {value}
      </Text>
      {sub ? (
        <Text size="xs" tone="muted">
          {sub}
        </Text>
      ) : null}
      {lines.map((l) => (
        <Text key={l} size="xs" tone="muted">
          {l}
        </Text>
      ))}
    </View>
  );
}

/** A 100 % bar with a legend carrying the numbers. */
function SplitBar({ parts }: { parts: { key: string; value: number; color: string; label: string; text: string }[] }) {
  const c = useColors();
  const total = parts.reduce((n, p) => n + p.value, 0);
  return (
    <View style={{ gap: 8 }}>
      <View style={[styles.split, { backgroundColor: c.muted }]}>
        {total > 0 && parts.filter((p) => p.value > 0).map((p) => <View key={p.key} style={{ flex: p.value, backgroundColor: p.color }} />)}
      </View>
      <View style={styles.legend}>
        {parts.map((p) => (
          <View key={p.key} style={styles.legendItem}>
            <View style={[styles.swatch, { backgroundColor: p.color }]} />
            <Text size="xs" tone="muted">
              {p.label}
            </Text>
            <Text size="xs" weight="700">
              {p.text}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

/** Hours worked each day: within the shift + overtime stacked, a dashed line at the shift length; tap a bar to open the day. */
function HoursBars({ rows, shiftMin, width }: { rows: AttendanceRowDto[]; shiftMin: number | null; width: number }) {
  const c = useColors();
  const s = SERIES[useScheme()];
  const H = 180;
  const m = { top: 10, right: 4, bottom: 22, left: 30 };
  const plotW = Math.max(0, width - m.left - m.right);
  const plotH = H - m.top - m.bottom;
  const yMax = Math.ceil((Math.max(...rows.map((r) => r.workedMin), shiftMin ?? 0, 9 * 60) + 30) / 180) * 180;
  const y = (v: number) => m.top + plotH - (v / yMax) * plotH;
  const slot = rows.length ? plotW / rows.length : 0;
  const barW = Math.max(2, Math.min(18, slot * 0.62));
  const every = Math.max(1, Math.ceil((rows.length * 18) / Math.max(1, plotW)));
  return (
    <Svg width={width} height={H}>
      {Array.from({ length: yMax / 180 + 1 }, (_, i) => i * 180).map((v) => (
        <Line key={v} x1={m.left} x2={width - m.right} y1={y(v)} y2={y(v)} stroke={c.border} strokeWidth={1} />
      ))}
      {Array.from({ length: yMax / 180 + 1 }, (_, i) => i * 180).map((v) => (
        <SvgText key={`t${v}`} x={m.left - 5} y={y(v) + 3.5} fontSize={10} fill={c.mutedForeground} textAnchor="end">
          {`${v / 60} h`}
        </SvgText>
      ))}
      {rows.map((r, i) => {
        const cx = m.left + slot * i + slot / 2;
        const within = Math.max(0, r.workedMin - r.overtimeMin);
        return (
          <G key={r.day}>
            {r.status === 'DAY_OFF' && <Rect x={m.left + slot * i} y={m.top} width={slot} height={plotH} fill={c.muted} />}
            {within > 0 && <Rect x={cx - barW / 2} y={y(within)} width={barW} height={Math.max(0, y(0) - y(within))} fill={s.within} />}
            {r.overtimeMin > 0 && <Rect x={cx - barW / 2} y={y(r.workedMin)} width={barW} height={Math.max(0, y(within) - y(r.workedMin) - (within > 0 ? 1.5 : 0))} fill={s.overtime} />}
            {r.lateMin > 0 && <Circle cx={cx} cy={H - m.bottom + 6} r={2.5} fill={c.warning} />}
            {r.status === 'ABSENT' && (
              <SvgText x={cx} y={H - m.bottom + 9} fontSize={9} fontWeight="700" fill={c.destructive} textAnchor="middle">
                A
              </SvgText>
            )}
            {i % every === 0 && (
              <SvgText x={cx} y={H - 2} fontSize={10} fill={c.mutedForeground} textAnchor="middle">
                {String(Number(r.day.slice(8)))}
              </SvgText>
            )}
            <Rect x={m.left + slot * i} y={m.top} width={slot} height={plotH + 12} fill="transparent" onPress={() => openDay(r)} />
          </G>
        );
      })}
      {shiftMin ? <Line x1={m.left} x2={width - m.right} y1={y(shiftMin)} y2={y(shiftMin)} stroke={c.foreground} strokeOpacity={0.55} strokeWidth={1.5} strokeDasharray="5 4" /> : null}
      <Line x1={m.left} x2={width - m.right} y1={y(0)} y2={y(0)} stroke={c.mutedForeground} strokeOpacity={0.5} />
    </Svg>
  );
}

/** Attendance % each month (line, the latest value written in the title). */
function TrendLine({ points, width }: { points: { month: string; pct: number }[]; width: number }) {
  const c = useColors();
  const s = SERIES[useScheme()];
  const H = 150;
  const m = { top: 10, right: 10, bottom: 20, left: 34 };
  const plotW = Math.max(0, width - m.left - m.right);
  const plotH = H - m.top - m.bottom;
  const lo = Math.min(50, Math.floor(Math.min(100, ...points.map((p) => p.pct)) / 25) * 25);
  const y = (v: number) => m.top + plotH - ((v - lo) / Math.max(1, 100 - lo)) * plotH;
  const slot = points.length ? plotW / points.length : 0;
  const x = (i: number) => m.left + slot * i + slot / 2;
  const ticks: number[] = [];
  for (let v = lo; v <= 100; v += 25) ticks.push(v);
  return (
    <Svg width={width} height={H}>
      {ticks.map((v) => (
        <Line key={v} x1={m.left} x2={width - m.right} y1={y(v)} y2={y(v)} stroke={c.border} />
      ))}
      {ticks.map((v) => (
        <SvgText key={`t${v}`} x={m.left - 5} y={y(v) + 3.5} fontSize={10} fill={c.mutedForeground} textAnchor="end">
          {`${v}%`}
        </SvgText>
      ))}
      <Path d={points.map((p, i) => `${i ? 'L' : 'M'}${x(i)},${y(p.pct)}`).join(' ')} stroke={s.within} strokeWidth={2} fill="none" />
      {points.map((p, i) => (
        <Circle key={p.month} cx={x(i)} cy={y(p.pct)} r={3.5} fill={s.within} stroke={c.card} strokeWidth={1.5} />
      ))}
      {points.map((p, i) => (
        <SvgText key={`m${p.month}`} x={x(i)} y={H - 4} fontSize={10} fill={c.mutedForeground} textAnchor="middle">
          {monthShort(p.month)}
        </SvgText>
      ))}
    </Svg>
  );
}

export default function AttendancePersonScreen() {
  const { t } = useTranslation();
  const c = useColors();
  const s = SERIES[useScheme()];
  const { me } = useAuth();
  const { width } = useWindowDimensions();
  const chartW = width - SPACE.lg * 2 - 32;
  const { objectId, name } = useLocalSearchParams<{ objectId: string; name?: string }>();
  const plus = !!me?.company.features?.includes('attendanceInsightsPlus');
  const today = localToday();
  const [period, setPeriod] = useState<Period>('this');
  const range = rangeOf(period, today);
  const prev = previousRange(range.from, range.to);
  const trend = trendRange(today);
  const sheet = (from: string, to: string, signal: AbortSignal) => api.get<AttendanceRowDto[]>('/attendance/timesheet', { from, to, objectId }, signal);
  const q = useQuery({ queryKey: ['attendance-person', objectId, range.from, range.to], queryFn: ({ signal }) => sheet(range.from, range.to, signal), enabled: !!objectId });
  const before = useQuery({ queryKey: ['attendance-person', objectId, prev.from, prev.to], queryFn: ({ signal }) => sheet(prev.from, prev.to, signal), enabled: plus && !!objectId, staleTime: 5 * 60_000 });
  const year = useQuery({ queryKey: ['attendance-person', objectId, trend.from, trend.to], queryFn: ({ signal }) => sheet(trend.from, trend.to, signal), enabled: plus && !!objectId, staleTime: 10 * 60_000 });
  const team = useQuery({ queryKey: ['attendance-sheet', range.from, range.to], queryFn: ({ signal }) => api.get<AttendanceRowDto[]>('/attendance/timesheet', range, signal), enabled: plus && period !== '90', staleTime: 5 * 60_000 });
  const settings = useQuery({ queryKey: ['attendance-settings'], queryFn: ({ signal }) => api.get<AttendanceSettingsDto>('/attendance/settings', undefined, signal), retry: false });

  const rows = useMemo(() => (q.data ?? []).filter((r) => r.objectId === objectId).sort((a, b) => a.day.localeCompare(b.day)), [q.data, objectId]);
  const st = useMemo(() => employeeStats(rows), [rows]);
  const prevRows = useMemo(() => (before.data ?? []).filter((r) => r.objectId === objectId), [before.data, objectId]);
  const p = plus && before.data ? employeeStats(prevRows) : null;
  const pv = p && p.dueDays > 0 ? p : null;
  const tf = plus && team.data ? teamFigures(team.data) : null;
  const months = useMemo(() => monthlyTrend((year.data ?? []).filter((r) => r.objectId === objectId)), [year.data, objectId]);
  const first = rows[0];
  const shiftMin = useMemo(() => {
    const sd = settings.data;
    if (!sd || !first) return null;
    const named = sd.shifts.find((x) => x.name === first.shift);
    return (named?.endMin ?? sd.endMin) - (named?.startMin ?? sd.startMin);
  }, [settings.data, first]);
  const summary = employeeSummary(st, rows, shiftMin, { duration: hours, weekday: DOW_LONG });
  const byDay = useMemo(() => new Map(rows.map((r) => [r.day, r])), [rows]);
  const lateCount = rows.filter((r) => r.lateMin > 0).length;
  const prevLate = prevRows.filter((r) => r.lateMin > 0).length;
  // "▲ 3% more than the previous period": arrow + words, so the meaning never rests on colour.
  const delta = (v: number | null, text: (n: number) => string, label?: string) =>
    v === null ? null : `${label ? `${label}: ` : ''}${v === 0 ? t('Same as the previous period') : `${v > 0 ? '▲' : '▼'} ${t(v > 0 ? '{{v}} more than the previous period' : '{{v}} less than the previous period', { v: text(Math.abs(v)) })}`}`;
  const dayCount = (n: number) => (n === 1 ? t('1 day') : t('{{n}} days', { n }));

  const lateByDay = [1, 2, 3, 4, 5, 6, 0].map((d) => {
    const due = rows.filter((r) => new Date(`${r.day}T12:00:00Z`).getUTCDay() === d && (r.halfDay || r.status === 'PRESENT' || r.status === 'LATE' || r.status === 'ABSENT'));
    const late = due.filter((r) => r.lateMin > 0);
    return { d, due: due.length, late: late.length, avg: late.length ? Math.round(late.reduce((n, r) => n + r.lateMin, 0) / late.length) : 0 };
  });
  const maxDue = Math.max(1, ...lateByDay.map((x) => x.due));

  return (
    <ScrollView contentContainerStyle={{ padding: SPACE.lg, gap: SPACE.md }} refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => void q.refetch()} />}>
      <Stack.Screen options={{ title: first?.name ?? name ?? t('Staff attendance') }} />
      <Chips
        value={period}
        onChange={setPeriod}
        options={[
          { value: 'this', label: t('This month') },
          { value: 'last', label: t('Last month') },
          { value: '30', label: t('Last 30 days') },
          ...(plus ? [{ value: '90' as Period, label: t('Last 3 months') }] : []),
        ]}
      />
      <Text size="xs" tone="muted">
        {range.from} – {range.to}
      </Text>
      {q.isError && <ErrorBanner message={errorMessage(q.error)} onRetry={() => void q.refetch()} />}
      {q.isPending ? (
        <ActivityIndicator style={{ margin: SPACE.xl }} />
      ) : !rows.length ? (
        <Card>
          <Text weight="600">{t('Nothing in this period')}</Text>
          <Text size="sm" tone="muted">
            {t('This person is not covered by attendance on these days.')}
          </Text>
        </Card>
      ) : (
        <>
          <View style={styles.tiles}>
            <Tile label={t('Attendance')} value={`${st.attendancePct}%`} compare={[delta(pv ? change(st.attendancePct, pv.attendancePct) : null, (n) => `${n}%`), tf && t('Team average {{v}}', { v: `${tf.attendancePct}%` })]} />
            <Tile label={t('Days')} value={`${st.presentDays + st.lateDays} / ${st.dueDays}`} sub={t('{{late}} late · {{half}} half · {{absent}} absent', { late: st.lateDays, half: st.halfDays, absent: st.absentDays })} compare={[delta(pv ? change(st.absentDays, pv.absentDays) : null, dayCount, t('Absent'))]} />
            <Tile
              label={t('Usual check-in')}
              value={st.usualCheckInMin === null ? '—' : clockOf(st.usualCheckInMin)}
              compare={[
                pv && st.usualCheckInMin !== null && pv.usualCheckInMin !== null && st.usualCheckInMin !== pv.usualCheckInMin && `${st.usualCheckInMin < pv.usualCheckInMin ? '▼' : '▲'} ${t(st.usualCheckInMin < pv.usualCheckInMin ? '{{v}} earlier than the previous period' : '{{v}} later than the previous period', { v: hours(Math.abs(st.usualCheckInMin - pv.usualCheckInMin)) })}`,
                tf?.usualCheckInMin != null && t('Team average {{v}}', { v: clockOf(tf.usualCheckInMin) }),
              ]}
            />
            <Tile label={t('Average a day')} value={hours(st.avgWorkedMin)} compare={[pv && pv.avgWorkedMin > 0 && delta(change(st.avgWorkedMin, pv.avgWorkedMin), (n) => hours(Math.round(n))), tf && t('Team average {{v}}', { v: hours(tf.avgWorkedMin) })]} />
            <Tile label={t('Overtime')} value={hours(st.overtimeMin)} compare={[pv && st.overtimeMin !== pv.overtimeMin && t('Previous period {{v}}', { v: hours(pv.overtimeMin) }), tf && t('Team average {{v}}', { v: hours(tf.overtimeMin) })]} />
            <Tile label={t('Late')} value={hours(st.lateMin)} sub={t('{{n}} days', { n: lateCount })} compare={[pv && delta(change(lateCount, prevLate), dayCount, t('Late days')), tf && t('Team average {{v}}', { v: hours(tf.lateMin) })]} />
          </View>
          {pv && (
            <Text size="xs" tone="muted">
              {t('Arrows compare with {{from}} – {{to}}.', { from: prev.from, to: prev.to })}
            </Text>
          )}

          {summary.length > 0 && (
            <Card style={{ gap: 4, borderColor: c.primary }}>
              <Text weight="700">{t('Summary')}</Text>
              <Text size="sm">{summary.map((x) => t(x.key, x.values)).join(' ')}</Text>
            </Card>
          )}

          {rows.length <= 93 && (
            <Card style={{ gap: 8 }}>
              <Text weight="700">{t('Calendar')}</Text>
              <View style={styles.calendar}>
                {Array.from({ length: 7 }, (_, i) => (
                  <Text key={`h${i}`} size="xs" tone="muted" weight="700" style={styles.calHead}>
                    {DOW_SHORT(i)}
                  </Text>
                ))}
                {calendarDays(range.from, range.to).map((d, i) => {
                  const r = d ? byDay.get(d) : undefined;
                  const col = r ? (r.halfDay ? HALF_DAY.color : STATUS[r.status].color) : null;
                  return (
                    <Pressable
                      key={d ?? `e${i}`}
                      disabled={!r}
                      onPress={() => r && openDay(r)}
                      accessibilityLabel={d && r ? `${d}: ${t(r.halfDay ? HALF_DAY.label : STATUS[r.status].label)}` : undefined}
                      style={[styles.calCell, d ? { borderColor: col ? `${col}55` : c.border, backgroundColor: col ? `${col}1f` : 'transparent', borderStyle: r ? 'solid' : 'dashed' } : null]}
                    >
                      {d && (
                        <>
                          <Text size="xs" weight="700">
                            {Number(d.slice(8))}
                            {r?.corrected ? ' ✎' : ''}
                          </Text>
                          {r?.firstIn ? <Text style={styles.calTime}>{time(r.firstIn)}</Text> : null}
                        </>
                      )}
                    </Pressable>
                  );
                })}
              </View>
              <Text size="xs" tone="muted">
                {t('Tap a day to open it. Time = first check-in. ✎ = corrected.')}
              </Text>
            </Card>
          )}

          <Card style={{ gap: 8 }}>
            <Text weight="700">{t('Hours worked each day')}</Text>
            <View style={styles.legend}>
              <View style={styles.legendItem}>
                <View style={[styles.swatch, { backgroundColor: s.within }]} />
                <Text size="xs" tone="muted">{t('Within shift')}</Text>
              </View>
              <View style={styles.legendItem}>
                <View style={[styles.swatch, { backgroundColor: s.overtime }]} />
                <Text size="xs" tone="muted">{t('Overtime')}</Text>
              </View>
              {shiftMin ? <Text size="xs" tone="muted">{`- - ${t('Shift length ({{h}})', { h: hours(shiftMin) })}`}</Text> : null}
            </View>
            <HoursBars rows={rows} shiftMin={shiftMin} width={chartW} />
          </Card>

          {plus ? (
            <>
              <Card style={{ gap: 8 }}>
                <Text weight="700">{t('Days')}</Text>
                <SplitBar
                  parts={[
                    { key: 'p', value: st.presentDays, color: c.success, label: t('Present'), text: String(st.presentDays) },
                    { key: 'l', value: st.lateDays, color: c.warning, label: t('Late'), text: String(st.lateDays) },
                    { key: 'h', value: st.halfDays, color: c.info, label: t('Half day'), text: String(st.halfDays) },
                    { key: 'a', value: st.absentDays, color: c.destructive, label: t('Absent'), text: String(st.absentDays) },
                  ]}
                />
              </Card>
              <Card style={{ gap: 6 }}>
                <Text weight="700">{t('Late by weekday')}</Text>
                {lateByDay.some((x) => x.late) ? (
                  lateByDay.map((x) => (
                    <View key={x.d} style={styles.weekRow}>
                      <Text size="xs" tone="muted" style={{ width: 40 }}>
                        {DOW_ABBR(x.d)}
                      </Text>
                      <View style={{ flex: 1, height: 8 }}>
                        <View style={[styles.weekBar, { width: `${(x.due / maxDue) * 100}%`, backgroundColor: c.muted }]} />
                        {x.late > 0 && <View style={[styles.weekBar, { width: `${(x.late / maxDue) * 100}%`, backgroundColor: c.warning }]} />}
                      </View>
                      <Text size="xs" style={{ minWidth: 110, textAlign: 'right' }}>
                        {x.due ? (x.late ? t('{{n}} of {{due}} · avg {{min}}', { n: x.late, due: x.due, min: hours(x.avg) }) : t('0 of {{due}}', { due: x.due })) : '—'}
                      </Text>
                    </View>
                  ))
                ) : (
                  <Text size="sm" tone="muted">{t('Never late in this period.')}</Text>
                )}
              </Card>
              <Card style={{ gap: 8 }}>
                <Text weight="700">{t('Time away from the work site')}</Text>
                {st.officialMin + st.personalMin + st.unexplainedMin > 0 ? (
                  <SplitBar
                    parts={[
                      { key: 'o', value: st.officialMin, color: s.within, label: t('Official duty'), text: hours(st.officialMin) },
                      { key: 'p', value: st.personalMin, color: s.personal, label: t('Personal'), text: hours(st.personalMin) },
                      { key: 'u', value: st.unexplainedMin, color: s.unexplained, label: t('Not explained'), text: hours(st.unexplainedMin) },
                    ]}
                  />
                ) : (
                  <Text size="sm" tone="muted">{t('No time away from the work site in this period.')}</Text>
                )}
                {st.noSignalMin > 0 && <Text size="xs" tone="muted">{t('Also {{min}} with no phone signal (not counted as away).', { min: hours(st.noSignalMin) })}</Text>}
              </Card>
              <Card style={{ gap: 8 }}>
                <Text weight="700">{t('Last 12 months')}</Text>
                {year.isPending ? (
                  <ActivityIndicator />
                ) : months.length < 2 ? (
                  <Text size="sm" tone="muted">{t('The trend appears once there are two months of attendance.')}</Text>
                ) : (
                  <>
                    <Text size="xs" tone="muted">
                      {t('Attendance %')} · {t('{{v}} in {{month}}', { v: `${months[months.length - 1].stats.attendancePct}%`, month: monthLong(months[months.length - 1].month) })}
                    </Text>
                    <TrendLine points={months.map((x) => ({ month: x.month, pct: x.stats.attendancePct }))} width={chartW} />
                  </>
                )}
              </Card>
            </>
          ) : (
            <Card style={{ gap: 4, borderStyle: 'dashed' }}>
              <Text weight="700">{t('More insights')}</Text>
              <Text size="sm" tone="muted">
                {t('Advanced attendance insights add comparisons with the previous period and the team, late-by-weekday and time-away charts, the daily in / out chart, the 12-month trend, periods up to 6 months and PDF download. Ask VeeTrax support to turn them on for your company.')}
              </Text>
            </Card>
          )}
          <Text size="xs" tone="muted">
            {t('Download Excel or PDF from Reports → Staff attendance.')}
          </Text>
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm },
  tile: { flexBasis: '47%', flexGrow: 1, borderWidth: 1, borderRadius: 12, padding: SPACE.md, gap: 2 },
  split: { flexDirection: 'row', height: 12, borderRadius: 6, overflow: 'hidden', gap: 2 },
  legend: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 12, rowGap: 4, alignItems: 'center' },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  swatch: { width: 10, height: 10, borderRadius: 2 },
  calendar: { flexDirection: 'row', flexWrap: 'wrap' },
  calHead: { width: `${100 / 7}%`, textAlign: 'center', paddingBottom: 4 },
  calCell: { width: `${100 / 7 - 1}%`, margin: '0.5%', minHeight: 44, borderWidth: 1, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  calTime: { fontSize: 9, opacity: 0.8 },
  weekRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  weekBar: { position: 'absolute', left: 0, top: 0, bottom: 0, borderRadius: 4 },
});

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ATTENDANCE_OVERRIDES, type AttendanceDayDto, type AttendanceFix, type AttendanceOverride, type AttendanceRowDto, type OutingKind } from '@veetracer/shared';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useVideoPlayer, VideoView } from 'expo-video';
import { MapPinIcon } from 'lucide-react-native';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Alert, Image, Linking, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Button, Card, Chips, ErrorBanner, Field, Pill, SectionTitle, Text } from '@/components/ui';
import { useAuth } from '@/features/auth/auth';
import { HALF_DAY, hours, OUTING_WORDS, STATUS, time } from '@/features/attendance/attendance-format';
import { useAddress } from '@/features/geocoding/use-address';
import { api, errorMessage } from '@/lib/api';
import { API_URL } from '@/lib/config';
import { session } from '@/lib/session';
import { SPACE, useColors } from '@/lib/theme';

const openMap = (f: AttendanceFix) => void Linking.openURL(`https://www.google.com/maps?q=${f.lat},${f.lng}`);
const coords = (f: AttendanceFix) => `${f.lat.toFixed(5)}, ${f.lng.toFixed(5)}`;
const OVERRIDE_LABEL: Record<AttendanceOverride, string> = { PRESENT: 'Present', HALF_DAY: 'Half day', ABSENT: 'Absent', DAY_OFF: 'Day off' };

/** Street address (looked up from the coordinates), then the coordinates, accuracy and a map link. */
function Place({ fix }: { fix: AttendanceFix | null }) {
  const c = useColors();
  const { t } = useTranslation();
  const { address, loading } = useAddress(fix?.lat, fix?.lng);
  if (!fix) return <Text size="sm" tone="muted">—</Text>;
  return (
    <View style={{ gap: 2 }}>
      <Text size="sm">{address ?? (loading ? t('Finding the address…') : t('Address not available'))}</Text>
      <View style={styles.coordsRow}>
        <Text size="xs" tone="muted">
          {coords(fix)}
          {fix.accuracyM !== null ? ` · ${t('within {{n}} m', { n: Math.round(fix.accuracyM) })}` : ''}
        </Text>
        <Pressable accessibilityRole="link" onPress={() => openMap(fix)} style={styles.place} hitSlop={8}>
          <MapPinIcon size={13} color={c.primary} />
          <Text size="xs" tone="primary" weight="600">
            {t('View on map')}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

/** The check-in selfie with where and when across the bottom. Selfies from before locations were saved use the first-in location. */
function Selfie({ r }: { r: AttendanceRowDto }) {
  const { t } = useTranslation();
  const c = useColors();
  const [failed, setFailed] = useState(false);
  const fix = r.selfieFix ?? r.inFix;
  if (failed) return <Text size="sm" tone="muted">{t('The photo is no longer kept.')}</Text>;
  const token = session.getAccessToken();
  const company = session.getCompanyId();
  const headers: Record<string, string> = { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(company ? { 'X-Company-Id': company } : {}) };
  return (
    <View style={[styles.selfie, { backgroundColor: c.muted }]}>
      <Image
        source={{ uri: `${API_URL}/attendance/selfie?objectId=${r.objectId}&day=${r.day}`, headers }}
        accessibilityLabel={t('Check-in selfie')}
        resizeMode="cover"
        onError={() => setFailed(true)}
        style={StyleSheet.absoluteFill}
      />
      <Pressable accessibilityRole="link" disabled={!fix} onPress={() => fix && openMap(fix)} style={styles.stamp}>
        <Text size="sm" weight="600" style={{ color: '#ffffff' }}>
          {fix ? coords(fix) : t('Location not available')}
        </Text>
        <Text size="xs" style={{ color: '#ffffffd0' }}>
          {r.day} · {time(r.selfieAt)}
        </Text>
      </Pressable>
    </View>
  );
}

/** The check-in video (10 s, no sound), with where and when under it like the photo. */
function CheckInVideo({ r }: { r: AttendanceRowDto }) {
  const { t } = useTranslation();
  const fix = r.selfieFix ?? r.inFix;
  const token = session.getAccessToken();
  const company = session.getCompanyId();
  const headers: Record<string, string> = { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(company ? { 'X-Company-Id': company } : {}) };
  const player = useVideoPlayer({ uri: `${API_URL}/attendance/video?objectId=${r.objectId}&day=${r.day}`, headers }, (p) => {
    p.muted = true;
  });
  return (
    <View style={styles.selfie}>
      <VideoView player={player} style={StyleSheet.absoluteFill} nativeControls contentFit="cover" accessibilityLabel={t('Check-in video')} />
      <View style={styles.stamp} pointerEvents="none">
        <Text size="sm" weight="600" style={{ color: '#ffffff' }}>
          {fix ? coords(fix) : t('Location not available')}
        </Text>
        <Text size="xs" style={{ color: '#ffffffd0' }}>
          {r.day} · {time(r.videoAt)}
        </Text>
      </View>
    </View>
  );
}

/** One person's day: the hours, each crossing's location, the selfie, decisions on time outside and manual correction. */
export default function AttendanceDayScreen() {
  const { objectId, day } = useLocalSearchParams<{ objectId: string; day: string }>();
  const { t } = useTranslation();
  const c = useColors();
  const { can } = useAuth();
  const qc = useQueryClient();
  const canEdit = can('attendance', 'edit');
  const [status, setStatus] = useState<AttendanceOverride | ''>('');
  const [note, setNote] = useState('');

  const q = useQuery({
    queryKey: ['attendance', day],
    queryFn: ({ signal }) => api.get<AttendanceDayDto>('/attendance', { day }, signal),
  });
  const r = q.data?.rows.find((x) => x.objectId === objectId);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['attendance'] });
    void qc.invalidateQueries({ queryKey: ['attendance-sheet'] });
  };
  const failed = (e: unknown) => Alert.alert(t('Could not save'), errorMessage(e));
  const decide = useMutation({
    mutationFn: (v: { leftAt: string; kind: OutingKind }) => api.put<AttendanceRowDto>('/attendance/outing', { objectId, ...v }),
    onSuccess: refresh,
    onError: failed,
  });
  const correct = useMutation({
    mutationFn: (v: { status: string | null; note: string }) => api.put<AttendanceRowDto>('/attendance/correction', { objectId, day, ...v }),
    onSuccess: () => {
      setStatus('');
      setNote('');
      refresh();
    },
    onError: failed,
  });

  const title = r ? r.name : t('Staff attendance');
  if (!r) {
    return (
      <>
        <Stack.Screen options={{ title }} />
        <View style={{ padding: SPACE.lg }}>{q.isPending ? <ActivityIndicator /> : <ErrorBanner message={q.isError ? errorMessage(q.error) : t('No results')} onRetry={() => void q.refetch()} />}</View>
      </>
    );
  }
  const s = r.halfDay ? HALF_DAY : STATUS[r.status];
  const figures: [string, number][] = [
    ['Worked', r.workedMin],
    ['Inside', r.onSiteMin],
    ['Official duty', r.officialMin],
    ['Personal', r.personalMin],
    ['Unexplained', r.unexplainedMin],
    ['No signal', r.noSignalMin],
    ['Late', r.lateMin],
    ['Early leave', r.earlyMin],
    ['Overtime', r.overtimeMin],
  ];

  return (
    <>
      <Stack.Screen options={{ title }} />
      <ScrollView contentContainerStyle={{ padding: SPACE.lg, gap: SPACE.md, paddingBottom: 48 }} keyboardShouldPersistTaps="handled">
        <View style={styles.row}>
          <Pill label={t(s.label)} color={s.color} />
          <Text size="sm" tone="muted" style={{ flex: 1 }}>
            {[r.day, r.shift === 'Default' ? t('Default shift') : r.shift, r.branch].filter(Boolean).join(' · ')}
          </Text>
        </View>
        {r.corrected && (
          <Text size="sm" tone="muted">
            {t('Corrected by hand')}
            {r.correctionNote ? `: ${r.correctionNote}` : ''}
          </Text>
        )}
        {r.carriedOver && (
          <Text size="sm" weight="600" style={{ color: '#b45309' }}>
            {t('This phone was already inside before the shift. It may have stayed at the site overnight, so check this day.')}
          </Text>
        )}

        <View style={styles.grid}>
          {figures.map(([label, min]) => (
            <Card key={label} style={styles.tile}>
              <Text size="xs" tone="muted">{t(label)}</Text>
              <Text size="sm" weight="600">{hours(min)}</Text>
            </Card>
          ))}
        </View>

        <Card style={{ gap: SPACE.md }}>
          <View style={{ gap: 6 }}>
            <View style={styles.between}>
              <Text size="sm" tone="muted" weight="600">{t('First in')}</Text>
              <Text weight="700">{time(r.firstIn)}</Text>
            </View>
            {r.firstIn ? <Place fix={r.inFix} /> : null}
          </View>
          <View style={[styles.divider, { backgroundColor: c.border }]} />
          <View style={{ gap: 6 }}>
            <View style={styles.between}>
              <Text size="sm" tone="muted" weight="600">{t('Last out')}</Text>
              <Text weight="700">{r.firstIn && !r.lastOut ? t('On site') : time(r.lastOut)}</Text>
            </View>
            {r.lastOut ? <Place fix={r.outFix} /> : null}
          </View>
        </Card>

        {(r.selfieAt || r.selfieMissing) && <SectionTitle>{t('Check-in selfie')}</SectionTitle>}
        {r.selfieAt ? <Selfie r={r} /> : r.selfieMissing ? <Text size="sm" style={{ color: '#b45309' }}>{t('No selfie was taken.')}</Text> : null}
        {r.videoAt && (
          <>
            <SectionTitle>{t('Check-in video')}</SectionTitle>
            <CheckInVideo r={r} />
          </>
        )}
        {r.videoMissing && <Text size="sm" style={{ color: '#b45309' }}>{t('No video was recorded.')}</Text>}

        <SectionTitle>{t('Times away from the work site')}</SectionTitle>
        {!r.outings.length && <Text size="sm" tone="muted">{t('None')}</Text>}
        {r.outings.map((o) => (
          <Card key={o.leftAt} style={{ gap: SPACE.sm }}>
            <Pill label={o.kind === 'UNEXPLAINED' ? t('Not explained yet') : t('Counted as: {{kind}}', { kind: t(OUTING_WORDS[o.kind]) })} color={o.kind === 'UNEXPLAINED' ? '#e11d48' : o.kind === 'OFFICIAL' ? '#059669' : '#64748b'} />
            <Text size="sm" weight="600">
              {o.site ? t('Left {{site}} at {{time}}', { site: o.site, time: time(o.leftAt) }) : t('Left at {{time}}', { time: time(o.leftAt) })}
            </Text>
            <Text size="sm" style={!o.returnedAt ? { color: '#b45309' } : undefined}>
              {o.returnedAt ? t('Back at {{time}}', { time: time(o.returnedAt) }) : t('Not back yet')} · {t('Away for {{time}}', { time: hours(o.minutes) })}
            </Text>
            {o.auto === 'TRAVEL' && <Text size="xs" tone="muted">{t('Travel between work sites, counted automatically')}</Text>}
            {o.fix && (
              <View style={{ gap: 2 }}>
                <Text size="xs" tone="muted">{t('Where they left the site:')}</Text>
                <Place fix={o.fix} />
              </View>
            )}
            {o.employeeKind && (
              <Text size="xs" tone="muted">
                {t("Employee's answer: {{answer}}", { answer: t(OUTING_WORDS[o.employeeKind]) })}
                {o.employeeNote ? ` — “${o.employeeNote}”` : ''}
                {o.decidedByAdmin && o.employeeKind !== o.kind ? ` · ${t('The admin changed it to {{kind}}', { kind: t(OUTING_WORDS[o.kind]) })}` : ''}
              </Text>
            )}
            {!o.employeeKind && o.decidedByAdmin && <Text size="xs" tone="muted">{t('Decided by the admin')}</Text>}
            {canEdit && (
              <View style={styles.row}>
                {(['OFFICIAL', 'PERSONAL', 'UNEXPLAINED'] as OutingKind[]).filter((k) => k !== o.kind).map((kind) => (
                  <View key={kind} style={{ flex: 1 }}>
                    <Button title={kind === 'UNEXPLAINED' ? t('Clear the decision') : kind === 'OFFICIAL' ? t('Mark as official duty') : t('Mark as personal work')} variant="outline" disabled={decide.isPending} onPress={() => decide.mutate({ leftAt: o.leftAt, kind })} />
                  </View>
                ))}
              </View>
            )}
          </Card>
        ))}

        {canEdit && (
          <>
            <SectionTitle>{t('Correct this day')}</SectionTitle>
            <Chips<AttendanceOverride | ''> value={status} onChange={setStatus} options={ATTENDANCE_OVERRIDES.map((v) => ({ value: v, label: t(OVERRIDE_LABEL[v]) }))} />
            <Field label={t('Reason')} value={note} onChangeText={setNote} maxLength={300} multiline />
            <Button title={t('Save correction')} disabled={!status || correct.isPending} loading={correct.isPending} onPress={() => correct.mutate({ status: status || null, note })} />
            {r.corrected && <Button title={t('Remove correction')} variant="outline" disabled={correct.isPending} onPress={() => correct.mutate({ status: null, note: '' })} />}
          </>
        )}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
  between: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: SPACE.sm },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm },
  tile: { width: '31%', flexGrow: 1, gap: 2, padding: SPACE.sm },
  place: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  coordsRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: SPACE.md, rowGap: 2 },
  divider: { height: 1 },
  selfie: { height: 340, borderRadius: 12, overflow: 'hidden', justifyContent: 'flex-end' },
  stamp: { backgroundColor: 'rgba(0,0,0,0.62)', paddingHorizontal: SPACE.md, paddingVertical: SPACE.sm },
});

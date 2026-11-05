import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ATTENDANCE_OVERRIDES, type AttendanceDayDto, type AttendanceFix, type AttendanceOverride, type AttendanceRowDto, type OutingKind } from '@veetracer/shared';
import { Stack, useLocalSearchParams } from 'expo-router';
import { MapPinIcon } from 'lucide-react-native';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Alert, Image, Linking, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Button, Card, Chips, ErrorBanner, Field, Pill, SectionTitle, Text } from '@/components/ui';
import { useAuth } from '@/features/auth/auth';
import { HALF_DAY, hours, KINDS, STATUS, time } from '@/features/attendance/attendance-format';
import { api, errorMessage } from '@/lib/api';
import { API_URL } from '@/lib/config';
import { session } from '@/lib/session';
import { SPACE, useColors } from '@/lib/theme';

const openMap = (f: AttendanceFix) => void Linking.openURL(`https://www.google.com/maps?q=${f.lat},${f.lng}`);
const coords = (f: AttendanceFix) => `${f.lat.toFixed(6)}, ${f.lng.toFixed(6)}`;
const OVERRIDE_LABEL: Record<AttendanceOverride, string> = { PRESENT: 'Present', HALF_DAY: 'Half day', ABSENT: 'Absent', DAY_OFF: 'Day off' };

function Place({ fix }: { fix: AttendanceFix | null }) {
  const c = useColors();
  if (!fix) return <Text size="sm" tone="muted">—</Text>;
  return (
    <Pressable accessibilityRole="link" onPress={() => openMap(fix)} style={styles.place} hitSlop={6}>
      <MapPinIcon size={14} color={c.primary} />
      <Text size="sm" tone="primary">{coords(fix)}</Text>
    </Pressable>
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

/** One person's day: the hours, each crossing's location, the selfie, decisions on time outside and manual correction. */
export default function AttendanceDayScreen() {
  const { objectId, day } = useLocalSearchParams<{ objectId: string; day: string }>();
  const { t } = useTranslation();
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

        <Card style={{ gap: SPACE.sm }}>
          <View style={styles.between}>
            <Text size="sm" tone="muted">{t('First in')}</Text>
            <Text size="sm" weight="600">{time(r.firstIn)}</Text>
          </View>
          <Place fix={r.inFix} />
          <View style={styles.between}>
            <Text size="sm" tone="muted">{t('Last out')}</Text>
            <Text size="sm" weight="600">{r.firstIn && !r.lastOut ? t('On site') : time(r.lastOut)}</Text>
          </View>
          <Place fix={r.outFix} />
        </Card>

        {(r.selfieAt || r.selfieMissing) && <SectionTitle>{t('Check-in selfie')}</SectionTitle>}
        {r.selfieAt ? <Selfie r={r} /> : r.selfieMissing ? <Text size="sm" style={{ color: '#b45309' }}>{t('No selfie was taken.')}</Text> : null}

        <SectionTitle>{t('Time outside during the shift')}</SectionTitle>
        {!r.outings.length && <Text size="sm" tone="muted">{t('None')}</Text>}
        {r.outings.map((o) => (
          <Card key={o.leftAt} style={{ gap: SPACE.sm }}>
            <View style={styles.between}>
              <Text size="sm" weight="600" style={{ flex: 1 }}>
                {time(o.leftAt)} – {o.returnedAt ? time(o.returnedAt) : t('not back')} · {hours(o.minutes)}
              </Text>
              <Text size="xs" weight="600" style={{ color: o.kind === 'UNEXPLAINED' ? '#e11d48' : undefined }}>
                {t(KINDS[o.kind])}
              </Text>
            </View>
            <Place fix={o.fix} />
            {o.employeeKind && (
              <Text size="xs" tone="muted">
                {t('Employee says: {{answer}}', { answer: t(KINDS[o.employeeKind]) })}
                {o.employeeNote ? ` · ${o.employeeNote}` : ''}
                {o.decidedByAdmin ? ` · ${t('decided by admin')}` : ''}
              </Text>
            )}
            {canEdit && (
              <View style={styles.row}>
                {(['OFFICIAL', 'PERSONAL', 'UNEXPLAINED'] as OutingKind[]).filter((k) => k !== o.kind).map((kind) => (
                  <View key={kind} style={{ flex: 1 }}>
                    <Button title={kind === 'UNEXPLAINED' ? t('Undo') : t(KINDS[kind])} variant="outline" disabled={decide.isPending} onPress={() => decide.mutate({ leftAt: o.leftAt, kind })} />
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
  selfie: { height: 340, borderRadius: 12, overflow: 'hidden', justifyContent: 'flex-end' },
  stamp: { backgroundColor: 'rgba(0,0,0,0.62)', paddingHorizontal: SPACE.md, paddingVertical: SPACE.sm },
});

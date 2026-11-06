import * as ImagePicker from 'expo-image-picker';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { CalendarCheck, Camera, CheckCircle2, Clock, MapPinOff, Video } from 'lucide-react-native';
import { Alert, AppState, StyleSheet, Text, TextInput, View } from 'react-native';
import { Appear, Body, Button, Card, Chip, Title } from '@/components/ui';
import { api, ApiError, type PhoneAttendance } from '@/lib/api';
import { getToken } from '@/lib/state';
import { S, serverText } from '@/lib/strings';
import { useColors } from '@/lib/theme';

/** While the app is on screen, so a change by the admin (shift, selfie setting) shows within seconds. */
const REFRESH_MS = 15_000;
const time = (iso: string) => new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
const clock = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const message = (e: unknown) => (e instanceof ApiError ? serverText(e.message) : e instanceof Error ? e.message : String(e));

/** Today's attendance: check-in time, the questions about time outside, and the selfie if the employer asks for one. */
export function AttendanceCard() {
  const c = useColors();
  const [a, setA] = useState<PhoneAttendance | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  const refresh = useCallback(async () => {
    const token = await getToken();
    // Older servers: no card. A failed refresh keeps what is shown. The rest of the app doesn't depend on this.
    const next = token ? await api.attendance(token).catch(() => null) : null;
    if (next) setA(next);
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      if (AppState.currentState === 'active') void refresh();
    }, REFRESH_MS);
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') void refresh();
    });
    return () => (clearInterval(timer), sub.remove());
  }, [refresh]);

  // Back from the check-in camera: show the new state at once, not at the next refresh.
  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh]),
  );

  const run = async (action: (token: string) => Promise<PhoneAttendance>) => {
    setBusy(true);
    try {
      const token = await getToken();
      if (token) setA(await action(token));
    } catch (e) {
      Alert.alert(S.attendanceTitle, message(e));
      void refresh();
    } finally {
      setBusy(false);
    }
  };

  // Video check-ins happen on their own screen; the card refreshes when it comes back to the foreground or on its timer.
  const proof = a?.proof ?? 'PHOTO';
  const recordVideo = () => router.push({ pathname: '/checkin-camera', params: proof === 'PHOTO_AND_VIDEO' ? { auto: '1' } : {} });

  const takeSelfie = async () => {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) return Alert.alert(S.selfieTitle, S.cameraDenied);
    const shot = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 0.5, cameraType: ImagePicker.CameraType.front });
    const photo = shot.canceled ? null : shot.assets[0];
    if (photo) await run((token) => api.sendSelfie(token, photo));
  };

  if (!a?.enabled) return null;
  const out = a.outings[0];
  const shift = a.shiftStartMin !== undefined && a.shiftEndMin !== undefined ? [clock(a.shiftStartMin), clock(a.shiftEndMin)] : null;
  const now =
    a.state === 'INSIDE'
      ? { short: S.inside, long: S.stateInside, dot: c.success, fg: c.successText }
      : a.state === 'OUT'
        ? { short: S.outside, long: S.stateOut, dot: c.accent, fg: c.accentText }
        : a.state === 'NO_SIGNAL'
          ? { short: S.noSignalShort, long: S.stateNoSignal, dot: c.idle, fg: c.muted }
          : null;
  return (
    <Card style={styles.card}>
      <View style={styles.head}>
        <View style={[styles.icon, { backgroundColor: a.firstIn ? c.successSoft : c.primarySoft }]}>
          {a.firstIn ? <CalendarCheck color={c.success} size={20} /> : <Clock color={c.primary} size={20} />}
        </View>
        <Title>{S.attendanceTitle}</Title>
        <View style={{ flex: 1 }} />
        {shift ? (
          <View style={[styles.shift, { backgroundColor: c.idleSoft }]} accessibilityLabel={S.shiftToday(shift[0], shift[1])}>
            <Clock color={c.muted} size={14} />
            <Text style={[styles.shiftText, { color: c.muted }]}>
              {shift[0]}–{shift[1]}
            </Text>
          </View>
        ) : null}
      </View>

      {/* Two tiles: when this person checked in, and where they are now. */}
      <View style={styles.tiles}>
        <Appear play={!!a.firstIn} style={[styles.tile, { borderColor: c.border, backgroundColor: a.firstIn ? c.successSoft : c.background }]}>
          <Text style={[styles.tileLabel, { color: c.muted }]}>{S.checkInLabel}</Text>
          <Text style={[styles.tileValue, { color: a.firstIn ? c.successText : c.muted }]}>{a.firstIn ? time(a.firstIn) : S.notYet}</Text>
          {a.firstIn && a.site ? (
            <Text style={[styles.tileSub, { color: c.successText }]} numberOfLines={1}>
              {a.site}
            </Text>
          ) : null}
        </Appear>
        <View style={[styles.tile, { borderColor: c.border, backgroundColor: c.background }]}>
          <Text style={[styles.tileLabel, { color: c.muted }]}>{S.nowLabel}</Text>
          {now ? (
            <View style={styles.nowRow}>
              <View style={[styles.dot, { backgroundColor: now.dot }]} />
              <Text style={[styles.tileValue, { color: now.fg }]} accessibilityLabel={now.long}>
                {now.short}
              </Text>
            </View>
          ) : (
            <Text style={[styles.tileValue, { color: c.muted }]}>—</Text>
          )}
        </View>
      </View>
      {!a.firstIn ? <Body muted style={styles.small}>{S.notCheckedIn}</Body> : null}

      {a.selfieAt || a.videoAt ? (
        <View style={styles.done}>
          {a.selfieAt ? <Chip label={S.selfieDone(time(a.selfieAt))} tone="success" dot={<CheckCircle2 color={c.success} size={14} />} /> : null}
          {a.videoAt ? <Chip label={S.videoDone(time(a.videoAt))} tone="success" dot={<CheckCircle2 color={c.success} size={14} />} /> : null}
        </View>
      ) : null}

      {/* What the employer asks for at check-in: a selfie, or the 10-second video (with or without the auto start). */}
      {(proof === 'PHOTO' && a.selfieNeeded) || (proof !== 'PHOTO' && (a.selfieNeeded || a.videoNeeded)) ? (
        <View style={[styles.box, { backgroundColor: c.primarySoft, borderColor: c.primary }]}>
          <View style={styles.boxHead}>
            {proof === 'PHOTO' ? <Camera color={c.primary} size={22} /> : <Video color={c.primary} size={22} />}
            <Body style={{ flex: 1 }}>{proof === 'PHOTO' ? S.selfieBody : proof === 'PHOTO_AND_VIDEO' ? S.autoVideoBody : S.videoBody}</Body>
          </View>
          {proof === 'PHOTO' ? (
            <Button title={S.selfieButton} busy={busy} icon={<Camera color={c.primaryText} size={18} />} onPress={() => void takeSelfie()} />
          ) : (
            <Button title={proof === 'PHOTO_AND_VIDEO' ? S.openCamera : S.videoButton} icon={<Video color={c.primaryText} size={18} />} onPress={recordVideo} />
          )}
        </View>
      ) : null}

      {/* Time away from the site during the shift: the person says whether it was for work. */}
      {out ? (
        <View style={[styles.box, { backgroundColor: c.accentSoft, borderColor: c.accent }]}>
          <View style={styles.boxHead}>
            <MapPinOff color={c.accentText} size={22} />
            <Body style={{ flex: 1, color: c.accentText, fontWeight: '600' }}>{S.outingQuestion(time(out.leftAt), out.returnedAt ? time(out.returnedAt) : null, out.site)}</Body>
          </View>
          <TextInput
            value={note}
            onChangeText={setNote}
            maxLength={300}
            placeholder={S.outingNote}
            placeholderTextColor={c.muted}
            style={[styles.input, { borderColor: c.border, color: c.text, backgroundColor: c.input }]}
          />
          <View style={styles.pair}>
            <View style={{ flex: 1 }}>
              <Button
                title={S.outingOfficial}
                busy={busy}
                onPress={() => void run((token) => api.answerOuting(token, { leftAt: out.leftAt, kind: 'OFFICIAL', note: note.trim() || undefined })).then(() => setNote(''))}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Button
                title={S.outingPersonal}
                variant="outline"
                disabled={busy}
                onPress={() => void run((token) => api.answerOuting(token, { leftAt: out.leftAt, kind: 'PERSONAL', note: note.trim() || undefined })).then(() => setNote(''))}
              />
            </View>
          </View>
        </View>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { gap: 12 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  icon: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  shift: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 9, paddingVertical: 4, borderRadius: 999 },
  shiftText: { fontSize: 13, fontWeight: '700', fontVariant: ['tabular-nums'] },
  tiles: { flexDirection: 'row', gap: 10 },
  tile: { flex: 1, borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, gap: 2, minHeight: 78 },
  tileLabel: { fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.6 },
  tileValue: { fontSize: 20, fontWeight: '800', fontVariant: ['tabular-nums'] },
  tileSub: { fontSize: 13, fontWeight: '600' },
  nowRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  small: { fontSize: 13, lineHeight: 19 },
  done: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  box: { borderWidth: 1, borderRadius: 10, padding: 12, gap: 10 },
  boxHead: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  input: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, minHeight: 46, fontSize: 15 },
  pair: { flexDirection: 'row', gap: 10 },
});

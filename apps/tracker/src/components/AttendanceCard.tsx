import * as ImagePicker from 'expo-image-picker';
import { router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Alert, AppState, TextInput, View } from 'react-native';
import { Body, Button, Card } from '@/components/ui';
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
  return (
    <Card>
      <Body style={{ fontWeight: '700' }}>{S.attendanceTitle}</Body>
      {a.shiftStartMin !== undefined && a.shiftEndMin !== undefined ? <Body muted>{S.shiftToday(clock(a.shiftStartMin), clock(a.shiftEndMin))}</Body> : null}
      {a.firstIn ? <Body muted>{S.checkedInAt(time(a.firstIn), a.site)}</Body> : <Body>{S.notCheckedIn}</Body>}
      {a.state === 'INSIDE' ? <Body muted>{S.stateInside}</Body> : a.state === 'OUT' ? <Body muted>{S.stateOut}</Body> : a.state === 'NO_SIGNAL' ? <Body muted>{S.stateNoSignal}</Body> : null}
      {a.selfieAt ? <Body muted>{S.selfieDone(time(a.selfieAt))}</Body> : null}
      {a.videoAt ? <Body muted>{S.videoDone(time(a.videoAt))}</Body> : null}
      {proof === 'PHOTO' && a.selfieNeeded ? (
        <View style={{ gap: 8, marginTop: 8 }}>
          <Body>{S.selfieBody}</Body>
          <Button title={S.selfieButton} busy={busy} onPress={() => void takeSelfie()} />
        </View>
      ) : null}
      {proof !== 'PHOTO' && (a.selfieNeeded || a.videoNeeded) ? (
        <View style={{ gap: 8, marginTop: 8 }}>
          <Body>{proof === 'PHOTO_AND_VIDEO' ? S.autoVideoBody : S.videoBody}</Body>
          <Button title={proof === 'PHOTO_AND_VIDEO' ? S.openCamera : S.videoButton} onPress={recordVideo} />
        </View>
      ) : null}
      {out ? (
        <View style={{ gap: 8, marginTop: 8 }}>
          <Body>{S.outingQuestion(time(out.leftAt), out.returnedAt ? time(out.returnedAt) : null, out.site)}</Body>
          <TextInput
            value={note}
            onChangeText={setNote}
            maxLength={300}
            placeholder={S.outingNote}
            placeholderTextColor={c.muted}
            style={{ borderWidth: 1, borderColor: c.border, borderRadius: 8, padding: 10, color: c.text }}
          />
          <Button
            title={S.outingOfficial}
            busy={busy}
            onPress={() => void run((token) => api.answerOuting(token, { leftAt: out.leftAt, kind: 'OFFICIAL', note: note.trim() || undefined })).then(() => setNote(''))}
          />
          <Button
            title={S.outingPersonal}
            variant="outline"
            disabled={busy}
            onPress={() => void run((token) => api.answerOuting(token, { leftAt: out.leftAt, kind: 'PERSONAL', note: note.trim() || undefined })).then(() => setNote(''))}
          />
        </View>
      ) : null}
    </Card>
  );
}

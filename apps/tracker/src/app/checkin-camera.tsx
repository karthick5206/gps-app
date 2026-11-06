import { CameraView, useCameraPermissions } from 'expo-camera';
import { router, useLocalSearchParams } from 'expo-router';
import * as VideoThumbnails from 'expo-video-thumbnails';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { getToken, useStoreVersion } from '@/lib/state';
import { S, serverText } from '@/lib/strings';

const SECONDS = 10;
/** A camera that hasn't started by then is taken as missing (some phones and emulators have no front camera). */
const READY_MS = 4000;
/** The photo is taken from the middle of the video, when the person is most likely looking at the camera. */
const PHOTO_AT_MS = 4000;
const message = (e: unknown) => (e instanceof ApiError ? serverText(e.message) : e instanceof Error ? e.message : String(e));

/**
 * The check-in video: the front camera records 10 seconds (no sound), with a red dot and a countdown so the person
 * always knows. `auto` starts recording as soon as the camera is ready; otherwise the person taps Start. A photo is
 * taken from the video, then both are sent; the server burns name, time, address and coordinates into the photo.
 */
export default function CheckInCameraScreen() {
  useStoreVersion();
  const { auto } = useLocalSearchParams<{ auto?: string }>();
  const camera = useRef<CameraView>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const [ready, setReady] = useState(false);
  const [facing, setFacing] = useState<'front' | 'back'>('front');
  const [failed, setFailed] = useState(false);
  const [left, setLeft] = useState<number | null>(null);
  const [sending, setSending] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    if (permission && !permission.granted && permission.canAskAgain) void requestPermission();
  }, [permission]);

  const send = async (uri: string) => {
    setSending(true);
    try {
      const token = await getToken();
      if (!token) return;
      const photo = await VideoThumbnails.getThumbnailAsync(uri, { time: PHOTO_AT_MS, quality: 0.8 });
      await api.sendSelfie(token, { uri: photo.uri, mimeType: 'image/jpeg' });
      await api.sendVideo(token, { uri });
      router.back();
    } catch (e) {
      Alert.alert(S.videoTitle, message(e));
      started.current = false;
      setSending(false);
    }
  };

  const record = async () => {
    if (!camera.current || started.current) return;
    started.current = true;
    setLeft(SECONDS);
    const tick = setInterval(() => setLeft((n) => (n && n > 1 ? n - 1 : n)), 1000);
    try {
      const video = await camera.current.recordAsync({ maxDuration: SECONDS });
      clearInterval(tick);
      setLeft(null);
      if (video?.uri) await send(video.uri);
      else started.current = false;
    } catch (e) {
      clearInterval(tick);
      setLeft(null);
      started.current = false;
      Alert.alert(S.videoTitle, message(e));
    }
  };

  useEffect(() => {
    if (auto === '1' && ready && !started.current) void record();
  }, [auto, ready]);

  // Front camera first; if it doesn't start, the back one; if that doesn't either, say so instead of a black screen.
  useEffect(() => {
    if (ready || !permission?.granted) return;
    const timer = setTimeout(() => (facing === 'front' ? setFacing('back') : setFailed(true)), READY_MS);
    return () => clearTimeout(timer);
  }, [ready, facing, permission?.granted]);

  if (!permission) return <View style={styles.dark} />;
  if (!permission.granted || failed) {
    return (
      <SafeAreaView style={[styles.dark, styles.center]}>
        <Text style={styles.white}>{failed ? S.cameraFailed : S.cameraDenied}</Text>
        <Button title={S.cancel} variant="outline" onPress={() => router.back()} />
      </SafeAreaView>
    );
  }
  return (
    <View style={styles.dark}>
      <CameraView key={facing} ref={camera} style={StyleSheet.absoluteFill} facing={facing} mode="video" mute videoQuality="480p" onCameraReady={() => setReady(true)} onMountError={() => (facing === 'front' ? setFacing('back') : setFailed(true))} />
      <SafeAreaView style={styles.overlay} pointerEvents="box-none">
        <View style={styles.top}>
          {left !== null ? (
            <View style={styles.rec} accessibilityLiveRegion="polite">
              <View style={styles.dot} />
              <Text style={styles.recText}>{S.recording(left)}</Text>
            </View>
          ) : (
            <Text style={styles.hint}>{S.lookAtCamera}</Text>
          )}
        </View>
        <View style={styles.bottom}>
          {sending ? (
            <View style={styles.row}>
              <ActivityIndicator color="#ffffff" />
              <Text style={styles.white}>{S.sending}</Text>
            </View>
          ) : left === null ? (
            <>
              {auto !== '1' && <Button title={S.startRecording} onPress={() => void record()} disabled={!ready} />}
              <Pressable accessibilityRole="button" onPress={() => router.back()} style={styles.cancel}>
                <Text style={styles.white}>{S.cancel}</Text>
              </Pressable>
            </>
          ) : (
            <Button title={S.stopRecording} variant="danger" onPress={() => camera.current?.stopRecording()} />
          )}
        </View>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  dark: { flex: 1, backgroundColor: '#000000' },
  center: { alignItems: 'center', justifyContent: 'center', gap: 16, padding: 24 },
  overlay: { flex: 1, justifyContent: 'space-between' },
  top: { alignItems: 'center', paddingTop: 16 },
  bottom: { gap: 12, padding: 24 },
  rec: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: 'rgba(0,0,0,0.6)', paddingHorizontal: 16, paddingVertical: 8, borderRadius: 999 },
  dot: { width: 12, height: 12, borderRadius: 6, backgroundColor: '#ef4444' },
  recText: { color: '#ffffff', fontSize: 17, fontWeight: '700' },
  hint: { color: '#ffffff', fontSize: 16, fontWeight: '600', backgroundColor: 'rgba(0,0,0,0.5)', paddingHorizontal: 14, paddingVertical: 6, borderRadius: 999 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10 },
  white: { color: '#ffffff', fontSize: 15, textAlign: 'center' },
  cancel: { alignItems: 'center', minHeight: 44, justifyContent: 'center' },
});

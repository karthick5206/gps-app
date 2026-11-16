import * as ImagePicker from 'expo-image-picker';
import { useFocusEffect } from 'expo-router';
import { Camera, ImageIcon, Trash2 } from 'lucide-react-native';
import { useCallback, useState } from 'react';
import { Alert, Image, StyleSheet, Text, View } from 'react-native';
import { Button } from '@/components/ui';
import { api, ApiError, type PhotoState } from '@/lib/api';
import { getToken } from '@/lib/state';
import { S, serverText } from '@/lib/strings';
import { useColors } from '@/lib/theme';

/**
 * "Profile photo" of the person this phone tracks: take one with the camera or pick one, upload it (the server crops it
 * square and removes EXIF incl. GPS), or remove it. Hidden when the phone is not linked to a person (404) or offline.
 * Falls back to the initial when there is no photo.
 */
export function ProfilePhoto({ initial, enabled = true }: { initial: string; enabled?: boolean }) {
  const c = useColors();
  const [state, setState] = useState<PhotoState | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useFocusEffect(
    useCallback(() => {
      let live = true;
      void (async () => {
        const t = await getToken();
        if (!t || !live) return;
        setToken(t);
        const s = await api.photoState(t).catch(() => null);
        if (live) setState(s);
      })();
      return () => {
        live = false;
      };
    }, []),
  );

  const run = async (job: (token: string) => Promise<PhotoState>) => {
    if (!token) return;
    setBusy(true);
    try {
      setState(await job(token));
    } catch (e) {
      Alert.alert(S.profilePhoto, e instanceof ApiError ? serverText(e.message) : e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // Small, square-ish upload: the server makes 256 px anyway.
  const options: ImagePicker.ImagePickerOptions = { mediaTypes: ['images'], quality: 0.7, allowsEditing: true, aspect: [1, 1], exif: false };

  const take = async () => {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) return Alert.alert(S.profilePhoto, S.photoCameraDenied);
    const shot = await ImagePicker.launchCameraAsync({ ...options, cameraType: ImagePicker.CameraType.front });
    const photo = shot.canceled ? null : shot.assets[0];
    if (photo) await run((t) => api.sendPhoto(t, photo));
  };

  const pick = async () => {
    // The system photo picker needs no photos permission (none is declared: app.json photosPermission false).
    const res = await ImagePicker.launchImageLibraryAsync(options);
    const photo = res.canceled ? null : res.assets[0];
    if (photo) await run((t) => api.sendPhoto(t, photo));
  };

  const remove = () =>
    Alert.alert(S.profilePhoto, S.removePhotoConfirm, [
      { text: S.cancel, style: 'cancel' },
      { text: S.removePhoto, style: 'destructive', onPress: () => void run((t) => api.removePhoto(t)) },
    ]);

  const avatar =
    token && state?.photoVersion ? (
      <Image source={api.photoSource(token, state.photoVersion)} style={styles.photo} accessibilityLabel={S.profilePhoto} />
    ) : (
      <View style={[styles.photo, { backgroundColor: c.header, alignItems: 'center', justifyContent: 'center' }]}>
        <Text style={[styles.initial, { color: c.headerText }]}>{initial}</Text>
      </View>
    );

  if (!enabled) {
    return (
      <View style={[styles.photo, { backgroundColor: c.header, alignItems: 'center', justifyContent: 'center' }]}>
        <Text style={[styles.initial, { color: c.headerText }]}>{initial}</Text>
      </View>
    );
  }
  if (!state) return avatar;
  return (
    <View style={styles.wrap}>
      {avatar}
      <View style={styles.buttons}>
        <Button title={S.takePhoto} variant="outline" icon={<Camera size={16} color={c.text} />} busy={busy} onPress={() => void take()} />
        <Button title={S.choosePhoto} variant="outline" icon={<ImageIcon size={16} color={c.text} />} disabled={busy} onPress={() => void pick()} />
        {state.photoVersion ? <Button title={S.removePhoto} variant="ghost" icon={<Trash2 size={16} color={c.danger} />} disabled={busy} onPress={remove} /> : null}
      </View>
      <Text style={[styles.hint, { color: c.muted }]}>{S.profilePhotoHint}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', gap: 10 },
  photo: { width: 96, height: 96, borderRadius: 48 },
  initial: { fontSize: 36, fontWeight: '800' },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 8 },
  hint: { fontSize: 12, textAlign: 'center', paddingHorizontal: 12 },
});

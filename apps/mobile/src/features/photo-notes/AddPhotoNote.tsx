import { PHOTO_NOTE_CATEGORIES, PHOTO_NOTE_CATEGORY_LABELS, PHOTO_NOTE_MAX_PHOTOS, PHOTO_NOTE_MONEY_CATEGORIES, PHOTO_NOTE_NOTE_MAX, type PhotoNoteCategory } from '@veetracer/shared';
import * as ImagePicker from 'expo-image-picker';
import { CameraIcon, ImageIcon, LocateFixedIcon, XIcon } from 'lucide-react-native';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Alert, Image, Pressable, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button, Chips, Field, Text } from '@/components/ui';
import { SPACE, useColors } from '@/lib/theme';
import { randomUuid } from './photo-note-queue';
import { currentFix, discardPhotos, isUnsupportedPhoto, normaliseMime, PICKER_JPEG, persistPhotos, queuePhotoNote, type FixResult } from './photo-note-store';

type Picked = { uri: string; mimeType: string };

/**
 * "Add photo here": 1–5 photos (camera or gallery), a category, a note and, for bills / receipts, an amount, saved
 * with the phone's position. The note is queued on the phone first (photo-note-store.ts) and uploaded at once or as
 * soon as there is a connection, so it works offline.
 */
export function AddPhotoNote({ onClose, onQueued }: { onClose: () => void; onQueued: () => void }) {
  const c = useColors();
  const { t } = useTranslation();
  const [photos, setPhotos] = useState<Picked[]>([]);
  const [takenAt, setTakenAt] = useState<string | null>(null);
  const [category, setCategory] = useState<PhotoNoteCategory>('BILL');
  const [note, setNote] = useState('');
  const [amount, setAmount] = useState('');
  const [fix, setFix] = useState<FixResult | null>(null);
  const [saving, setSaving] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const locate = useCallback(async (): Promise<FixResult> => {
    setFix(null);
    const r = await currentFix();
    if (mounted.current) setFix(r);
    return r;
  }, []);
  useEffect(() => {
    void locate();
  }, [locate]);

  const money = PHOTO_NOTE_MONEY_CATEGORIES.includes(category);
  const amountValue = amount.trim() ? Number(amount.replace(',', '.')) : null;
  const amountError = money && amountValue !== null && !(Number.isFinite(amountValue) && amountValue > 0 && amountValue < 1e9) ? t('Enter a valid amount') : undefined;
  const room = PHOTO_NOTE_MAX_PHOTOS - photos.length;

  const pick = async (camera: boolean) => {
    if (room <= 0) return Alert.alert(t('Photos'), t('Up to {{count}} photos per note.', { count: PHOTO_NOTE_MAX_PHOTOS }));
    if (camera) {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) return Alert.alert(t('Camera'), t('Allow the camera to take the photo.'));
    }
    const opts: ImagePicker.ImagePickerOptions = camera
      ? { mediaTypes: ['images'], ...PICKER_JPEG }
      : { mediaTypes: ['images'], ...PICKER_JPEG, allowsMultipleSelection: true, selectionLimit: room };
    const r = camera ? await ImagePicker.launchCameraAsync(opts) : await ImagePicker.launchImageLibraryAsync(opts);
    if (r.canceled || !r.assets.length) return;
    const usable = r.assets.filter((a) => !isUnsupportedPhoto(a));
    if (usable.length < r.assets.length) Alert.alert(t('Photos'), t('This photo format is not supported. Take the photo again or choose a JPEG photo.'));
    const added = usable.slice(0, room).map((a) => ({ uri: a.uri, mimeType: normaliseMime(a.mimeType) }));
    if (!takenAt) setTakenAt(new Date().toISOString());
    setPhotos((p) => [...p, ...added].slice(0, PHOTO_NOTE_MAX_PHOTOS));
  };

  const save = async () => {
    if (!photos.length) return Alert.alert(t('Photos'), t('Add at least one photo.'));
    if (amountError) return;
    setSaving(true);
    try {
      const where = fix?.ok ? fix : await locate();
      if (!where.ok) {
        Alert.alert(t('Location'), where.reason === 'denied' ? t('Allow location to save where the photo was taken.') : t('Could not find your location. Move to an open area and try again.'));
        return;
      }
      const clientId = randomUuid();
      let stored = false;
      try {
        const files = await persistPhotos(clientId, photos);
        await queuePhotoNote({
          clientId,
          takenAt: takenAt ?? new Date().toISOString(),
          lat: where.lat,
          lng: where.lng,
          accuracyM: where.accuracyM,
          category,
          note: note.trim() || null,
          amountMinor: money && amountValue !== null ? Math.round(amountValue * 100) : null,
          currency: money && amountValue !== null ? 'INR' : null,
          photos: files,
        });
        stored = true;
      } finally {
        if (!stored) discardPhotos(clientId);
      }
      onQueued();
    } catch {
      Alert.alert(t('Could not save'), t('The photo note could not be stored on this phone. Check the free space and try again.'));
    } finally {
      if (mounted.current) setSaving(false);
    }
  };

  const fixLine =
    !fix
      ? t('Getting your location…')
      : fix.ok
        ? fix.accuracyM
          ? t('Location found (±{{m}} m)', { m: Math.round(fix.accuracyM) })
          : t('Location found')
        : fix.reason === 'denied'
          ? t('Allow location to save where the photo was taken.')
          : t('Could not find your location. Move to an open area and try again.');

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: c.background }}>
      <ScrollView contentContainerStyle={{ padding: SPACE.lg, gap: SPACE.md }} keyboardShouldPersistTaps="handled">
        <Text size="lg" weight="700">
          {t('Add photo here')}
        </Text>
        <View style={{ flexDirection: 'row', gap: SPACE.sm }}>
          <Button title={t('Take photo')} icon={CameraIcon} style={{ flex: 1 }} onPress={() => void pick(true)} disabled={room <= 0} />
          <Button title={t('Gallery')} icon={ImageIcon} variant="outline" style={{ flex: 1 }} onPress={() => void pick(false)} disabled={room <= 0} />
        </View>
        <Text size="xs" tone="muted">
          {t('Up to {{count}} photos per note.', { count: PHOTO_NOTE_MAX_PHOTOS })}
        </Text>
        {photos.length > 0 && (
          <ScrollView horizontal contentContainerStyle={{ gap: SPACE.sm }} showsHorizontalScrollIndicator={false}>
            {photos.map((p, i) => (
              <View key={`${p.uri}-${i}`}>
                <Image source={{ uri: p.uri }} style={{ width: 96, height: 96, borderRadius: 10, backgroundColor: c.muted }} resizeMode="cover" />
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t('Remove photo')}
                  hitSlop={8}
                  onPress={() => setPhotos((list) => list.filter((_, j) => j !== i))}
                  style={{ position: 'absolute', top: 4, right: 4, width: 26, height: 26, borderRadius: 13, backgroundColor: 'rgba(0,0,0,0.6)', alignItems: 'center', justifyContent: 'center' }}
                >
                  <XIcon size={16} color="#ffffff" />
                </Pressable>
              </View>
            ))}
          </ScrollView>
        )}

        <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, padding: SPACE.sm, borderRadius: 10, borderWidth: 1, borderColor: c.border, backgroundColor: c.card }}>
          {!fix ? <ActivityIndicator /> : <LocateFixedIcon size={18} color={fix.ok ? c.primary : c.destructive} />}
          <Text size="sm" style={{ flex: 1 }} tone={fix && !fix.ok ? 'destructive' : 'default'} accessibilityLiveRegion="polite">
            {fixLine}
          </Text>
          {fix && (
            <Pressable accessibilityRole="button" onPress={() => void locate()} hitSlop={8}>
              <Text size="sm" weight="600" tone="primary">
                {t('Refresh')}
              </Text>
            </Pressable>
          )}
        </View>

        <Text size="sm" weight="500">
          {t('Category')}
        </Text>
        <Chips options={PHOTO_NOTE_CATEGORIES.map((k) => ({ value: k, label: t(PHOTO_NOTE_CATEGORY_LABELS[k]) }))} value={category} onChange={setCategory} />
        {money && <Field label={t('Amount (₹, optional)')} value={amount} onChangeText={setAmount} keyboardType="decimal-pad" error={amountError} maxLength={12} />}
        <Field label={t('Note (optional)')} value={note} onChangeText={setNote} maxLength={PHOTO_NOTE_NOTE_MAX} multiline style={{ minHeight: 80, textAlignVertical: 'top' }} />
        <Text size="xs" tone="muted">
          {t('The note is kept on this phone and uploaded as soon as there is a connection.')}
        </Text>
        <Button title={t('Save')} onPress={() => void save()} loading={saving} disabled={!photos.length || !!amountError || saving} />
        <Button title={t('Cancel')} variant="ghost" onPress={onClose} disabled={saving} />
      </ScrollView>
    </SafeAreaView>
  );
}

import * as ImagePicker from 'expo-image-picker';
import { useFocusEffect } from 'expo-router';
import { Camera, CloudOff, LocateFixed, RotateCw, Trash2, X } from 'lucide-react-native';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Image, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Body, Button, Card, SectionLabel } from '@/components/ui';
import { api, ApiError, PHOTO_NOTE_CATEGORIES, PHOTO_NOTE_MAX_PHOTOS, PHOTO_NOTE_MONEY_CATEGORIES, PHOTO_NOTE_NOTE_MAX, photoNotePhotoUrl, type PhotoNote, type PhotoNoteCategory } from '@/lib/api';
import { handleAuthError } from '@/lib/control';
import { rupees, shortDateTime } from '@/lib/format';
import { randomUuid, type QueuedNote } from '@/lib/photo-note-queue';
import { currentFix, discardPhotos, normaliseMime, onPhotoNoteDelivered, persistPhotos, photoNoteQueue, queuedPhotoUri, queuePhotoNote, retryPhotoNote, startPhotoNotes, usePhotoNoteQueue, type FixResult } from '@/lib/photo-notes';
import { getToken } from '@/lib/state';
import { S, serverText } from '@/lib/strings';
import { useColors } from '@/lib/theme';

type Picked = { uri: string; mimeType: string };

/**
 * "Add photo here": photos (camera) with a category, a note and, for bills / receipts, an amount, saved with the
 * phone's position. Queued on the phone first (lib/photo-notes.ts), so it works offline; below, this person's recent
 * notes (waiting ones first).
 */
export default function PhotoNoteScreen() {
  const c = useColors();
  const queue = usePhotoNoteQueue();
  const [photos, setPhotos] = useState<Picked[]>([]);
  const [takenAt, setTakenAt] = useState<string | null>(null);
  const [category, setCategory] = useState<PhotoNoteCategory>('BILL');
  const [note, setNote] = useState('');
  const [amount, setAmount] = useState('');
  const [fix, setFix] = useState<FixResult | null>(null);
  const [saving, setSaving] = useState(false);
  const [recent, setRecent] = useState<PhotoNote[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [token, setTokenState] = useState<string | null>(null);
  const mounted = useRef(true);

  const locate = useCallback(async (): Promise<FixResult> => {
    setFix(null);
    const r = await currentFix();
    if (mounted.current) setFix(r);
    return r;
  }, []);

  const loadRecent = useCallback(async () => {
    const t = await getToken();
    if (!mounted.current) return;
    setTokenState(t);
    if (!t) return;
    try {
      const r = await api.photoNotes(t, 30);
      if (mounted.current) {
        setRecent(r.items);
        setLoadError(false);
      }
    } catch (e) {
      if (await handleAuthError(e)) return;
      if (mounted.current) setLoadError(true);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void locate();
    onPhotoNoteDelivered(() => void loadRecent());
    return () => {
      mounted.current = false;
      onPhotoNoteDelivered(null);
    };
  }, [locate, loadRecent]);

  // Focus: load the queue (if not yet), send what is due, refresh the list.
  useFocusEffect(
    useCallback(() => {
      startPhotoNotes().catch(() => undefined);
      void loadRecent();
    }, [loadRecent]),
  );

  const money = PHOTO_NOTE_MONEY_CATEGORIES.includes(category);
  const amountValue = amount.trim() ? Number(amount.replace(',', '.')) : null;
  const amountInvalid = money && amountValue !== null && !(Number.isFinite(amountValue) && amountValue > 0 && amountValue < 1e9);
  const room = PHOTO_NOTE_MAX_PHOTOS - photos.length;

  const takePhoto = async () => {
    if (room <= 0) return Alert.alert(S.photoNotesTitle, S.photoNoteMaxPhotos(PHOTO_NOTE_MAX_PHOTOS));
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) return Alert.alert(S.photoNotesTitle, S.photoNoteCameraDenied);
    const shot = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 0.7 });
    const a = shot.canceled ? null : shot.assets[0];
    if (!a) return;
    if (!takenAt) setTakenAt(new Date().toISOString());
    setPhotos((p) => [...p, { uri: a.uri, mimeType: normaliseMime(a.mimeType) }].slice(0, PHOTO_NOTE_MAX_PHOTOS));
  };

  const save = async () => {
    if (!photos.length) return Alert.alert(S.photoNotesTitle, S.photoNoteNeedPhoto);
    if (amountInvalid) return Alert.alert(S.photoNotesTitle, S.photoNoteAmountInvalid);
    setSaving(true);
    try {
      const where = fix?.ok ? fix : await locate();
      if (!where.ok) {
        Alert.alert(S.photoNotesTitle, where.reason === 'denied' ? S.photoNoteLocationDenied : S.photoNoteLocationUnavailable);
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
      if (!mounted.current) return;
      setPhotos([]);
      setTakenAt(null);
      setNote('');
      setAmount('');
      Alert.alert(S.photoNotesTitle, S.photoNoteSaved);
    } catch {
      Alert.alert(S.photoNotesTitle, S.photoNoteStoreFailed);
    } finally {
      if (mounted.current) setSaving(false);
    }
  };

  const deleteNote = (n: PhotoNote) =>
    Alert.alert(S.photoNoteDeleteTitle, S.photoNoteDeleteBody, [
      { text: S.cancel, style: 'cancel' },
      {
        text: S.photoNoteDelete,
        style: 'destructive',
        onPress: async () => {
          const t = await getToken();
          if (!t) return;
          try {
            await api.deletePhotoNote(t, n.id);
            setRecent((list) => (list ?? []).filter((x) => x.id !== n.id));
          } catch (e) {
            if (await handleAuthError(e)) return;
            Alert.alert(S.photoNotesTitle, e instanceof ApiError ? serverText(e.message) : S.photoNoteDeleteFailed);
          }
        },
      },
    ]);

  const discard = (q: QueuedNote) =>
    Alert.alert(S.photoNoteDiscardTitle, S.photoNoteDiscardBody, [
      { text: S.cancel, style: 'cancel' },
      { text: S.photoNoteDelete, style: 'destructive', onPress: () => void photoNoteQueue.remove(q.clientId) },
    ]);

  const input = [styles.input, { color: c.text, borderColor: amountInvalid ? c.danger : c.border, backgroundColor: c.input }];
  const fixLine = !fix ? S.photoNoteLocating : fix.ok ? S.photoNoteLocated(fix.accuracyM ? Math.round(fix.accuracyM) : null) : fix.reason === 'denied' ? S.photoNoteLocationDenied : S.photoNoteLocationUnavailable;
  // A note the server already has (sent, answer lost) is shown once.
  const queuedIds = new Set(queue.items.map((q) => q.clientId));
  const serverItems = (recent ?? []).filter((n) => !n.clientId || !queuedIds.has(n.clientId));

  return (
    <SafeAreaView edges={['bottom', 'left', 'right']} style={{ flex: 1, backgroundColor: c.background }}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <Card>
            <Body muted>{S.photoNoteHomeBody}</Body>
            {photos.length > 0 ? (
              <ScrollView horizontal contentContainerStyle={{ gap: 8 }} showsHorizontalScrollIndicator={false}>
                {photos.map((p, i) => (
                  <View key={`${p.uri}-${i}`}>
                    <Image source={{ uri: p.uri }} style={[styles.thumb, { backgroundColor: c.idleSoft }]} resizeMode="cover" />
                    <Pressable accessibilityRole="button" accessibilityLabel={S.photoNoteRemovePhoto} hitSlop={8} onPress={() => setPhotos((list) => list.filter((_, j) => j !== i))} style={styles.remove}>
                      <X size={16} color="#ffffff" />
                    </Pressable>
                  </View>
                ))}
              </ScrollView>
            ) : null}
            <Button title={photos.length ? S.photoNoteAddAnother : S.photoNoteTakePhoto} variant={photos.length ? 'outline' : 'primary'} icon={<Camera color={photos.length ? c.primary : c.primaryText} size={18} />} onPress={() => void takePhoto()} disabled={room <= 0} />
            <Body muted style={styles.small}>
              {S.photoNoteMaxPhotos(PHOTO_NOTE_MAX_PHOTOS)}
            </Body>

            <View style={[styles.fix, { borderColor: c.border }]}>
              {!fix ? <ActivityIndicator color={c.primary} /> : <LocateFixed size={18} color={fix.ok ? c.primary : c.danger} />}
              <Text style={[styles.fixText, { color: fix && !fix.ok ? c.dangerText : c.text }]} accessibilityLiveRegion="polite">
                {fixLine}
              </Text>
              {fix ? (
                <Pressable accessibilityRole="button" onPress={() => void locate()} hitSlop={8}>
                  <Text style={[styles.link, { color: c.primary }]}>{S.photoNoteRefreshLocation}</Text>
                </Pressable>
              ) : null}
            </View>

            <SectionLabel>{S.photoNoteCategory}</SectionLabel>
            <View style={styles.chips}>
              {PHOTO_NOTE_CATEGORIES.map((k) => {
                const on = k === category;
                return (
                  <Pressable
                    key={k}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: on }}
                    onPress={() => setCategory(k)}
                    style={[styles.chip, { borderColor: on ? c.primary : c.border, backgroundColor: on ? c.primarySoft : c.card }]}
                  >
                    <Text style={[styles.chipText, { color: on ? c.primary : c.text }]}>{S.photoNoteCategories[k]}</Text>
                  </Pressable>
                );
              })}
            </View>
            {money ? (
              <>
                <SectionLabel>{S.photoNoteAmount}</SectionLabel>
                <TextInput style={input} value={amount} onChangeText={setAmount} keyboardType="decimal-pad" maxLength={12} placeholder="0.00" placeholderTextColor={c.muted} />
                {amountInvalid ? <Text style={{ color: c.dangerText }}>{S.photoNoteAmountInvalid}</Text> : null}
              </>
            ) : null}
            <SectionLabel>{S.photoNoteNote}</SectionLabel>
            <TextInput
              style={[styles.input, styles.multiline, { color: c.text, borderColor: c.border, backgroundColor: c.input }]}
              value={note}
              onChangeText={setNote}
              maxLength={PHOTO_NOTE_NOTE_MAX}
              multiline
            />
            <Button title={S.photoNoteSave} onPress={() => void save()} busy={saving} disabled={!photos.length || amountInvalid} />
            <Body muted style={styles.small}>
              {S.photoNoteOfflineHint}
            </Body>
          </Card>

          <SectionLabel>{S.photoNoteRecent}</SectionLabel>
          {queue.items.map((q) => (
            <QueuedRow key={q.clientId} item={q} sending={queue.sendingId === q.clientId} onRetry={() => void retryPhotoNote(q.clientId)} onDelete={() => discard(q)} />
          ))}
          {serverItems.map((n) => (
            <NoteRow key={n.id} note={n} token={token} onDelete={n.canDelete === false ? undefined : () => deleteNote(n)} />
          ))}
          {recent === null && !loadError ? <ActivityIndicator color={c.primary} /> : null}
          {loadError ? (
            <Card tone="warn">
              <Body>{S.photoNoteLoadFailed}</Body>
              <Button title={S.photoNoteRetry} variant="outline" onPress={() => void loadRecent()} />
            </Card>
          ) : null}
          {recent !== null && !serverItems.length && !queue.items.length ? <Body muted>{S.photoNoteNone}</Body> : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function Meta({ category, amountMinor, at, note, address }: { category: string; amountMinor: number | null; at: string; note: string | null; address?: string | null }) {
  const c = useColors();
  const label = S.photoNoteCategories[category as PhotoNoteCategory] ?? category;
  return (
    <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Text style={[styles.metaTitle, { color: c.text }]} numberOfLines={1}>
          {label}
        </Text>
        {amountMinor !== null ? <Text style={[styles.metaAmount, { color: c.text }]}>{rupees(amountMinor)}</Text> : null}
      </View>
      <Text style={{ color: c.muted, fontSize: 13 }}>{shortDateTime(at)}</Text>
      {address ? (
        <Text style={{ color: c.muted, fontSize: 13 }} numberOfLines={2}>
          {address}
        </Text>
      ) : null}
      {note ? (
        <Text style={{ color: c.text, fontSize: 14 }} numberOfLines={3}>
          {note}
        </Text>
      ) : null}
    </View>
  );
}

function NoteRow({ note, token, onDelete }: { note: PhotoNote; token: string | null; onDelete?: () => void }) {
  const c = useColors();
  const [failed, setFailed] = useState(false);
  const first = note.photos[0];
  return (
    <Card style={styles.row}>
      <View style={[styles.rowThumb, { backgroundColor: c.idleSoft }]}>
        {first && token && !failed ? (
          <Image source={{ uri: photoNotePhotoUrl(note.id, first.id, 'thumb'), headers: { Authorization: `Bearer ${token}` } }} style={styles.rowThumb} resizeMode="cover" onError={() => setFailed(true)} />
        ) : null}
        {note.photos.length > 1 ? (
          <View style={styles.count}>
            <Text style={{ color: '#ffffff', fontSize: 11, fontWeight: '700' }}>{note.photos.length}</Text>
          </View>
        ) : null}
      </View>
      <Meta category={note.category} amountMinor={note.amountMinor} at={note.takenAt} note={note.note} address={note.address} />
      {onDelete ? (
        <Pressable accessibilityRole="button" accessibilityLabel={S.photoNoteDelete} hitSlop={8} onPress={onDelete}>
          <Trash2 size={18} color={c.muted} />
        </Pressable>
      ) : null}
    </Card>
  );
}

function QueuedRow({ item, sending, onRetry, onDelete }: { item: QueuedNote; sending: boolean; onRetry: () => void; onDelete: () => void }) {
  const c = useColors();
  const first = item.photos[0];
  const failed = item.state === 'FAILED';
  const status = failed ? S.photoNoteFailed(item.lastError ?? '') : sending ? S.photoNoteUploading : item.attempts > 0 ? S.photoNoteWaitingConnection : S.photoNoteWaiting;
  return (
    <Card tone={failed ? 'danger' : undefined}>
      <View style={styles.row}>
        <View style={[styles.rowThumb, { backgroundColor: c.idleSoft }]}>{first ? <Image source={{ uri: queuedPhotoUri(item.clientId, first) }} style={styles.rowThumb} resizeMode="cover" /> : null}</View>
        <Meta category={item.category} amountMinor={item.amountMinor} at={item.takenAt} note={item.note} />
      </View>
      <View style={styles.statusLine}>
        {sending && !failed ? <ActivityIndicator size="small" color={c.primary} /> : <CloudOff size={16} color={failed ? c.danger : c.muted} />}
        <Text style={{ flex: 1, color: failed ? c.dangerText : c.muted, fontSize: 14 }}>{status}</Text>
      </View>
      <View style={styles.actions}>
        <View style={{ flex: 1 }}>
          <Button title={S.photoNoteRetry} variant="outline" icon={<RotateCw size={16} color={c.primary} />} onPress={onRetry} disabled={sending && !failed} />
        </View>
        <View style={{ flex: 1 }}>
          <Button title={S.photoNoteDelete} variant="ghost" icon={<Trash2 size={16} color={c.muted} />} onPress={onDelete} />
        </View>
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  scroll: { padding: 16, gap: 12, paddingBottom: 40 },
  small: { fontSize: 13, lineHeight: 18 },
  thumb: { width: 92, height: 92, borderRadius: 10 },
  remove: { position: 'absolute', top: 4, right: 4, width: 26, height: 26, borderRadius: 13, backgroundColor: 'rgba(0,0,0,0.6)', alignItems: 'center', justifyContent: 'center' },
  fix: { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderRadius: 10, padding: 10 },
  fixText: { flex: 1, fontSize: 14 },
  link: { fontSize: 14, fontWeight: '700' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderWidth: 1.5, borderRadius: 999, paddingHorizontal: 14, minHeight: 40, justifyContent: 'center' },
  chipText: { fontSize: 15, fontWeight: '600' },
  input: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, minHeight: 52, fontSize: 17 },
  multiline: { minHeight: 90, paddingTop: 12, textAlignVertical: 'top' },
  row: { flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
  rowThumb: { width: 64, height: 64, borderRadius: 8, overflow: 'hidden' },
  count: { position: 'absolute', right: 4, bottom: 4, paddingHorizontal: 5, borderRadius: 6, backgroundColor: 'rgba(0,0,0,0.6)' },
  metaTitle: { flex: 1, fontSize: 16, fontWeight: '700' },
  metaAmount: { fontSize: 16, fontWeight: '700' },
  statusLine: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  actions: { flexDirection: 'row', gap: 8 },
});

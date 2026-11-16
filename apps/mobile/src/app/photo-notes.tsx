import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatInr, PHOTO_NOTE_CATEGORY_LABELS, photoNotePhotoPath, type Paginated, type PhotoNoteCategory, type PhotoNoteDto } from '@veetracer/shared';
import { Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { CameraIcon, CloudOffIcon, ImagesIcon, RotateCwIcon, Trash2Icon } from 'lucide-react-native';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Alert, Dimensions, FlatList, Image, Modal, Pressable, RefreshControl, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button, Card, EmptyState, ErrorBanner, Text } from '@/components/ui';
import { useAuth } from '@/features/auth/auth';
import { AddPhotoNote } from '@/features/photo-notes/AddPhotoNote';
import type { QueuedNote } from '@/features/photo-notes/photo-note-queue';
import { drainPhotoNotes, PHOTO_NOTES_KEY, photoNoteQueue, queuedPhotoUri, retryPhotoNote, usePhotoNoteQueue } from '@/features/photo-notes/photo-note-store';
import { api, errorMessage } from '@/lib/api';
import { apiUrl } from '@/lib/config';
import { formatDateTime } from '@/lib/format';
import { session } from '@/lib/session';
import { SPACE, useColors } from '@/lib/theme';

/** Authorization headers for the photo images (the same the api client sends). */
function imageHeaders(): Record<string, string> {
  const token = session.getAccessToken();
  const company = session.getCompanyId();
  return { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(company ? { 'X-Company-Id': company } : {}) };
}

function categoryLabel(c: string): string {
  return PHOTO_NOTE_CATEGORY_LABELS[c as PhotoNoteCategory] ?? c;
}

/** My photo notes: notes waiting on the phone (offline queue) first, then the ones on the server. */
export default function PhotoNotesScreen() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const qc = useQueryClient();
  const params = useLocalSearchParams<{ add?: string }>();
  const canCreate = can('photo_notes', 'create');
  const [adding, setAdding] = useState(params.add === '1' && canCreate);
  const [viewing, setViewing] = useState<PhotoNoteDto | null>(null);
  const queue = usePhotoNoteQueue();
  const list = useQuery({
    queryKey: [...PHOTO_NOTES_KEY, 'mine'],
    queryFn: ({ signal }) => api.get<Paginated<PhotoNoteDto>>('/photo-notes', { mine: 1, pageSize: 50 }, signal),
    enabled: can('photo_notes'),
  });

  // Screen focus: send what is waiting.
  useFocusEffect(
    useCallback(() => {
      drainPhotoNotes();
    }, []),
  );

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/photo-notes/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: PHOTO_NOTES_KEY }),
    onError: (e) => Alert.alert(t('Could not delete'), errorMessage(e)),
  });
  const confirmDelete = (n: PhotoNoteDto) =>
    Alert.alert(t('Delete this photo note?'), t('The note and its photos are removed for everyone.'), [
      { text: t('Cancel'), style: 'cancel' },
      { text: t('Delete'), style: 'destructive', onPress: () => remove.mutate(n.id) },
    ]);
  const confirmDiscard = (q: QueuedNote) =>
    Alert.alert(t('Delete from this phone?'), t('This note was not uploaded. It and its photos are removed from this phone.'), [
      { text: t('Cancel'), style: 'cancel' },
      { text: t('Delete'), style: 'destructive', onPress: () => void photoNoteQueue.remove(q.clientId) },
    ]);

  const header = (
    <View style={{ gap: SPACE.sm, marginBottom: SPACE.xs }}>
      {canCreate && <Button title={t('Add photo here')} icon={CameraIcon} onPress={() => setAdding(true)} />}
      {list.isError && <ErrorBanner message={errorMessage(list.error)} onRetry={() => void list.refetch()} />}
      {queue.items.map((q) => (
        <QueuedCard key={q.clientId} item={q} sending={queue.sendingId === q.clientId} onRetry={() => void retryPhotoNote(q.clientId)} onDelete={() => confirmDiscard(q)} />
      ))}
    </View>
  );

  return (
    <>
      <Stack.Screen options={{ title: t('Photo notes') }} />
      <FlatList
        data={list.data?.items ?? []}
        keyExtractor={(n) => n.id}
        contentContainerStyle={{ padding: SPACE.lg, gap: SPACE.sm, flexGrow: 1 }}
        refreshControl={
          <RefreshControl
            refreshing={list.isRefetching}
            onRefresh={() => {
              drainPhotoNotes();
              void list.refetch();
            }}
          />
        }
        ListHeaderComponent={header}
        renderItem={({ item }) => <NoteCard note={item} onOpen={() => setViewing(item)} onDelete={item.canDelete ? () => confirmDelete(item) : undefined} />}
        ListEmptyComponent={
          list.isPending ? (
            <ActivityIndicator style={{ margin: SPACE.xl }} />
          ) : queue.items.length ? undefined : (
            <EmptyState icon={ImagesIcon} title={t('No photo notes')} description={t('Save photos of a place with a note, for example a bill, a receipt or a customer visit.')} />
          )
        }
      />
      <Modal visible={adding} animationType="slide" onRequestClose={() => setAdding(false)}>
        <AddPhotoNote
          onClose={() => setAdding(false)}
          onQueued={() => {
            setAdding(false);
            Alert.alert(t('Photo note saved'), t('It is uploaded now, or as soon as there is a connection.'));
          }}
        />
      </Modal>
      <Modal visible={!!viewing} animationType="fade" onRequestClose={() => setViewing(null)}>
        {viewing && <PhotoViewer note={viewing} onClose={() => setViewing(null)} />}
      </Modal>
    </>
  );
}

function NoteMeta({ category, amountMinor, at, note, address }: { category: string; amountMinor: number | null; at: string; note: string | null; address?: string | null }) {
  const { t } = useTranslation();
  return (
    <View style={{ flex: 1, gap: 2 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE.sm }}>
        <Text weight="600" style={{ flex: 1 }} numberOfLines={1}>
          {t(categoryLabel(category))}
        </Text>
        {amountMinor !== null ? <Text weight="700">{formatInr(amountMinor)}</Text> : null}
      </View>
      <Text size="sm" tone="muted" numberOfLines={1}>
        {formatDateTime(at)}
      </Text>
      {address ? (
        <Text size="sm" tone="muted" numberOfLines={2}>
          {address}
        </Text>
      ) : null}
      {note ? (
        <Text size="sm" numberOfLines={3}>
          {note}
        </Text>
      ) : null}
    </View>
  );
}

function NoteCard({ note, onOpen, onDelete }: { note: PhotoNoteDto; onOpen: () => void; onDelete?: () => void }) {
  const c = useColors();
  const { t } = useTranslation();
  const [failed, setFailed] = useState(false);
  const first = note.photos[0];
  return (
    <Card style={{ flexDirection: 'row', gap: SPACE.md }}>
      <Pressable accessibilityRole="imagebutton" accessibilityLabel={t('Open photos')} onPress={onOpen} disabled={!first}>
        <View style={{ width: 72, height: 72, borderRadius: 8, overflow: 'hidden', backgroundColor: c.muted, alignItems: 'center', justifyContent: 'center' }}>
          {first && !failed ? (
            <Image source={{ uri: `${apiUrl()}${photoNotePhotoPath(note.id, first.id, 'thumb')}`, headers: imageHeaders() }} style={{ width: 72, height: 72 }} resizeMode="cover" onError={() => setFailed(true)} />
          ) : (
            <ImagesIcon size={22} color={c.mutedForeground} />
          )}
          {note.photos.length > 1 ? (
            <View style={{ position: 'absolute', right: 4, bottom: 4, paddingHorizontal: 5, borderRadius: 6, backgroundColor: 'rgba(0,0,0,0.6)' }}>
              <Text size="xs" style={{ color: '#ffffff' }}>
                {note.photos.length}
              </Text>
            </View>
          ) : null}
        </View>
      </Pressable>
      <NoteMeta category={note.category} amountMinor={note.amountMinor} at={note.takenAt} note={note.note} address={note.address} />
      {onDelete ? (
        <Pressable accessibilityRole="button" accessibilityLabel={t('Delete')} hitSlop={8} onPress={onDelete} style={{ paddingTop: 2 }}>
          <Trash2Icon size={18} color={c.mutedForeground} />
        </Pressable>
      ) : null}
    </Card>
  );
}

function QueuedCard({ item, sending, onRetry, onDelete }: { item: QueuedNote; sending: boolean; onRetry: () => void; onDelete: () => void }) {
  const c = useColors();
  const { t } = useTranslation();
  const first = item.photos[0];
  const failed = item.state === 'FAILED';
  const status = failed
    ? t('Not uploaded: {{error}}', { error: item.lastError ?? '' })
    : sending
      ? t('Uploading…')
      : item.attempts > 0
        ? t('Waiting for a connection to upload')
        : t('Waiting to upload');
  return (
    <Card style={{ gap: SPACE.sm, borderColor: failed ? c.destructive : c.border }}>
      <View style={{ flexDirection: 'row', gap: SPACE.md }}>
        <View style={{ width: 72, height: 72, borderRadius: 8, overflow: 'hidden', backgroundColor: c.muted }}>
          {first ? <Image source={{ uri: queuedPhotoUri(item.clientId, first) }} style={{ width: 72, height: 72 }} resizeMode="cover" /> : null}
        </View>
        <NoteMeta category={item.category} amountMinor={item.amountMinor} at={item.takenAt} note={item.note} />
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE.sm }}>
        {sending && !failed ? <ActivityIndicator size="small" /> : <CloudOffIcon size={16} color={failed ? c.destructive : c.mutedForeground} />}
        <Text size="sm" tone={failed ? 'destructive' : 'muted'} style={{ flex: 1 }}>
          {status}
        </Text>
      </View>
      <View style={{ flexDirection: 'row', gap: SPACE.sm }}>
        <Button title={t('Try again')} icon={RotateCwIcon} variant="outline" style={{ flex: 1 }} onPress={onRetry} disabled={sending && !failed} />
        <Button title={t('Delete')} icon={Trash2Icon} variant="ghost" style={{ flex: 1 }} onPress={onDelete} />
      </View>
    </Card>
  );
}

function PhotoViewer({ note, onClose }: { note: PhotoNoteDto; onClose: () => void }) {
  const { t } = useTranslation();
  const width = Dimensions.get('window').width;
  const headers = imageHeaders();
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: '#000000' }}>
      <ScrollView horizontal pagingEnabled showsHorizontalScrollIndicator={false} style={{ flex: 1 }}>
        {note.photos.map((p, i) => (
          <View key={p.id} style={{ width, flex: 1, justifyContent: 'center' }}>
            <Image source={{ uri: `${apiUrl()}${photoNotePhotoPath(note.id, p.id, 'full')}`, headers }} style={{ width, height: '100%' }} resizeMode="contain" accessibilityLabel={t('Photo {{n}}', { n: i + 1 })} />
          </View>
        ))}
      </ScrollView>
      <View style={{ padding: SPACE.lg, gap: SPACE.sm }}>
        <Text style={{ color: '#ffffff' }} weight="600">
          {[t(categoryLabel(note.category)), note.amountMinor !== null ? formatInr(note.amountMinor) : null, formatDateTime(note.takenAt)].filter(Boolean).join(' · ')}
        </Text>
        {note.note ? <Text style={{ color: '#ffffffd0' }}>{note.note}</Text> : null}
        <Button title={t('Close')} variant="outline" onPress={onClose} />
      </View>
    </SafeAreaView>
  );
}

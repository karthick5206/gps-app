import { useInfiniteQuery } from '@tanstack/react-query';
import { MANUAL_CAPTURE_TYPE, type DriverEventDto, type DriverEventMediaDto, type Paginated } from '@veetracer/shared';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useVideoPlayer, VideoView } from 'expo-video';
import { FilmIcon, ImageIcon, PlayIcon, Share2Icon, XIcon } from 'lucide-react-native';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Alert, FlatList, Image, Modal, Pressable, StyleSheet, View } from 'react-native';
import { Card, Chips, EmptyState, ErrorBanner, Text } from '@/components/ui';
import { useAuth } from '@/features/auth/auth';
import { AlertTypeIcon } from '@/features/alerts/alert-icons';
import { eventLabel, eventSeverity, mediaUri } from '@/features/driver-events/driver-events';
import { IconButton } from '@/features/video/LivePlayer';
import { channelName, phonePlayable } from '@/features/video/video';
import { api, errorMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { downloadAndShare } from '@/lib/share-file';
import { SPACE, useColors } from '@/lib/theme';

const PAGE_SIZE = 20;
type Period = 'today' | '7d' | '30d';

const periodFrom = (p: Period): string => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  if (p === '7d') d.setDate(d.getDate() - 6);
  if (p === '30d') d.setDate(d.getDate() - 29);
  return d.toISOString();
};

/**
 * Video evidence (VeeTrax 0.8.0): dashcam photos and clips of ADAS / DMS / harsh / SOS events, manual captures and
 * SD-card downloads, newest first. Clips play here (MP4 and the .ts minutes of Jimi cameras); every file can be saved
 * or sent through the share sheet. `objectId` / `name` params limit it to one vehicle.
 */
export default function VideoEvidenceScreen() {
  const { t } = useTranslation();
  const c = useColors();
  const { can } = useAuth();
  const params = useLocalSearchParams<{ objectId?: string; name?: string }>();
  const [period, setPeriod] = useState<Period>('7d');
  const [kind, setKind] = useState<'any' | 'video'>('any');
  const [playing, setPlaying] = useState<{ media: DriverEventMediaDto; title: string } | null>(null);
  const [photo, setPhoto] = useState<string | null>(null);

  const query = useInfiniteQuery({
    queryKey: ['driver-events', 'evidence', 'mobile', params.objectId ?? null, period, kind],
    queryFn: ({ pageParam }) =>
      api.get<Paginated<DriverEventDto>>('/driver-events/evidence', {
        from: periodFrom(period),
        objectIds: params.objectId,
        hasMedia: kind,
        page: pageParam,
        pageSize: PAGE_SIZE,
      }),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.page * last.pageSize < last.total ? last.page + 1 : undefined),
  });
  const items = useMemo(() => query.data?.pages.flatMap((p) => p.items) ?? [], [query.data]);

  const share = async (m: DriverEventMediaDto, e: DriverEventDto) => {
    const ext = m.mime === 'video/mp2t' ? 'ts' : m.mime === 'video/mp4' ? 'mp4' : m.mime === 'image/png' ? 'png' : m.kind === 'PHOTO' ? 'jpg' : 'bin';
    const stamp = (m.capturedAt ?? e.occurredAt).slice(0, 19).replace(/[-:T]/g, '');
    try {
      await downloadAndShare(m.url.replace(/^\/api/, ''), { fallbackName: `${(e.plateNumber ?? e.objectName).replace(/[^\w-]+/g, '_')}_${stamp}.${ext}` });
    } catch (err) {
      Alert.alert(t('Could not save the file'), errorMessage(err));
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <Stack.Screen options={{ title: params.name ? `${t('Video evidence')} · ${params.name}` : t('Video evidence') }} />
      <FlatList
        data={items}
        keyExtractor={(e) => e.id}
        contentContainerStyle={{ padding: SPACE.lg, gap: SPACE.md, paddingBottom: SPACE.xl * 2 }}
        onEndReached={() => query.hasNextPage && !query.isFetchingNextPage && void query.fetchNextPage()}
        onEndReachedThreshold={0.4}
        refreshing={query.isRefetching}
        onRefresh={() => void query.refetch()}
        ListHeaderComponent={
          <View style={{ gap: SPACE.sm, marginBottom: SPACE.sm }}>
            <Chips
              options={[
                { value: 'today', label: t('Today') },
                { value: '7d', label: t('7 days') },
                { value: '30d', label: t('30 days') },
              ]}
              value={period}
              onChange={(v) => setPeriod(v as Period)}
            />
            <Chips
              options={[
                { value: 'any', label: t('Photos & clips') },
                { value: 'video', label: t('Clips only') },
              ]}
              value={kind}
              onChange={(v) => setKind(v as 'any' | 'video')}
            />
            {query.isError && <ErrorBanner message={errorMessage(query.error)} onRetry={() => void query.refetch()} />}
          </View>
        }
        ListEmptyComponent={
          query.isPending ? (
            <ActivityIndicator style={{ marginTop: SPACE.xl }} color={c.primary} />
          ) : (
            <EmptyState icon={FilmIcon} title={t('No dashcam photos or clips')} description={t('Photos and clips of dashcam alerts, captures and downloads appear here.')} />
          )
        }
        ListFooterComponent={query.isFetchingNextPage ? <ActivityIndicator color={c.primary} /> : undefined}
        renderItem={({ item: e }) => {
          const clips = e.media.filter((m) => m.kind === 'VIDEO');
          const photos = e.media.filter((m) => m.kind === 'PHOTO');
          const thumb = e.thumbnailUrl ?? photos[0]?.url ?? null;
          const title = (e.type as string) === MANUAL_CAPTURE_TYPE ? t('Manual capture') : t(eventLabel(e.type));
          return (
            <Card style={{ gap: SPACE.sm }} onPress={can('driver_events') ? () => router.push(`/driver-events/${e.id}`) : undefined}>
              <View style={{ flexDirection: 'row', gap: SPACE.md, alignItems: 'center' }}>
                <AlertTypeIcon type={e.type} severity={eventSeverity(e.type)} size={30} />
                <View style={{ flex: 1 }}>
                  <Text weight="600" numberOfLines={1}>
                    {title}
                  </Text>
                  <Text size="xs" tone="muted" numberOfLines={1}>
                    {e.plateNumber && e.plateNumber !== e.objectName ? `${e.objectName} · ${e.plateNumber}` : e.objectName} · {formatDateTime(e.occurredAt)}
                  </Text>
                </View>
              </View>
              {thumb && (
                <Pressable onPress={() => setPhoto(mediaUri(thumb))} accessibilityRole="imagebutton" accessibilityLabel={t('Photo')}>
                  <Image source={{ uri: mediaUri(thumb) }} style={styles.thumb} resizeMode="cover" />
                </Pressable>
              )}
              {e.address && (
                <Text size="xs" tone="muted" numberOfLines={2}>
                  {e.address}
                </Text>
              )}
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm }}>
                {clips.map((m) => (
                  <View key={m.id} style={[styles.chip, { borderColor: c.border }]}>
                    <FilmIcon size={16} color={c.mutedForeground} />
                    <Text size="xs">{m.channel ? channelName(t, m.channel) : t('Clip')}</Text>
                    {phonePlayable(m.mime) && (
                      <IconButton label={t('Play clip')} onPress={() => setPlaying({ media: m, title })}>
                        <PlayIcon size={18} color={c.primary} />
                      </IconButton>
                    )}
                    <IconButton label={t('Save or share')} onPress={() => void share(m, e)}>
                      <Share2Icon size={18} color={c.foreground} />
                    </IconButton>
                  </View>
                ))}
                {photos.map((m) => (
                  <View key={m.id} style={[styles.chip, { borderColor: c.border }]}>
                    <ImageIcon size={16} color={c.mutedForeground} />
                    <Text size="xs">{m.channel ? channelName(t, m.channel) : t('Photo')}</Text>
                    <IconButton label={t('Save or share')} onPress={() => void share(m, e)}>
                      <Share2Icon size={18} color={c.foreground} />
                    </IconButton>
                  </View>
                ))}
              </View>
            </Card>
          );
        }}
      />
      <Modal visible={!!playing} animationType="fade" onRequestClose={() => setPlaying(null)} supportedOrientations={['portrait', 'landscape']}>
        {playing && <ClipPlayer media={playing.media} title={playing.title} onClose={() => setPlaying(null)} />}
      </Modal>
      <Modal visible={!!photo} transparent animationType="fade" onRequestClose={() => setPhoto(null)}>
        <Pressable style={styles.photoBack} onPress={() => setPhoto(null)} accessibilityLabel={t('Close')}>
          {photo && <Image source={{ uri: photo }} style={{ width: '100%', height: '80%' }} resizeMode="contain" />}
        </Pressable>
      </Modal>
    </View>
  );
}

function ClipPlayer({ media, title, onClose }: { media: DriverEventMediaDto; title: string; onClose: () => void }) {
  const { t } = useTranslation();
  const player = useVideoPlayer({ uri: mediaUri(media.url), contentType: 'progressive' }, (p) => {
    p.play();
  });
  return (
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      <View style={styles.modalTop}>
        <Text weight="600" style={{ color: '#fff', flex: 1 }} numberOfLines={1}>
          {title}
        </Text>
        <Pressable onPress={onClose} hitSlop={10} accessibilityRole="button" accessibilityLabel={t('Close')}>
          <XIcon size={22} color="#fff" />
        </Pressable>
      </View>
      <VideoView player={player} style={{ flex: 1 }} contentFit="contain" nativeControls fullscreenOptions={{ enable: true }} />
    </View>
  );
}

const styles = StyleSheet.create({
  thumb: { width: '100%', aspectRatio: 16 / 9, borderRadius: 10, backgroundColor: '#000' },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 4, borderWidth: 1, borderRadius: 10, paddingLeft: 8 },
  photoBack: { flex: 1, backgroundColor: 'rgba(0,0,0,0.92)', alignItems: 'center', justifyContent: 'center' },
  modalTop: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingTop: 48, paddingBottom: 12 },
});

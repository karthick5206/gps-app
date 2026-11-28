import { useQuery } from '@tanstack/react-query';
import type { VideoChannelsDto } from '@veetracer/shared';
import { router, Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { FilmIcon } from 'lucide-react-native';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, KeyboardAvoidingView, ScrollView, View } from 'react-native';
import { Button, Chips, ErrorBanner, Text } from '@/components/ui';
import { useAuth } from '@/features/auth/auth';
import { LivePlayer } from '@/features/video/LivePlayer';
import { RecordingsPanel } from '@/features/video/RecordingsPanel';
import { videoErrorText } from '@/features/video/video';
import { api } from '@/lib/api';
import { SPACE, useColors } from '@/lib/theme';

/**
 * Native dashcam video for one vehicle (VeeTrax 0.8.0): Live (every camera stacked, one below the other) and
 * Recordings (SD card: timeline, controls, downloads). Params: `name` (title), `at` (alert / event time → Recordings
 * around it), `tab`. Players stop when the screen loses focus, so a stream never keeps running in the background.
 */
export default function VideoScreen() {
  const { t } = useTranslation();
  const c = useColors();
  const { can } = useAuth();
  const params = useLocalSearchParams<{ id: string; name?: string; at?: string; tab?: string }>();
  const id = params.id;
  const [tab, setTab] = useState<'live' | 'recordings'>(params.at || params.tab === 'recordings' ? 'recordings' : 'live');
  const [focused, setFocused] = useState(true);
  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      return () => setFocused(false);
    }, []),
  );
  const channels = useQuery({
    queryKey: ['video-channels', id],
    queryFn: () => api.get<VideoChannelsDto>(`/video/${id}/channels`),
    retry: false,
    staleTime: 5 * 60_000,
  });
  const list = channels.data?.channels ?? [];
  const vehicle = params.name ?? '';

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: c.background }}>
      <Stack.Screen options={{ title: vehicle ? `${t('Video')} · ${vehicle}` : t('Video') }} />
      <ScrollView contentContainerStyle={{ padding: SPACE.lg, gap: SPACE.md, paddingBottom: SPACE.xl * 2 }} keyboardShouldPersistTaps="handled">
        <Chips
          options={[
            { value: 'live', label: t('Live') },
            { value: 'recordings', label: t('Recordings') },
          ]}
          value={tab}
          onChange={(v) => setTab(v as 'live' | 'recordings')}
        />
        {channels.isPending && <ActivityIndicator style={{ marginTop: SPACE.xl }} color={c.primary} />}
        {channels.isError && <ErrorBanner message={videoErrorText(t, channels.error)} onRetry={() => void channels.refetch()} />}
        {channels.isSuccess && focused && tab === 'live' && (
          <View style={{ gap: SPACE.lg }}>
            {list.map((ch) => (
              <LivePlayer key={ch} objectId={id} channel={ch} />
            ))}
            <Text size="xs" tone="muted">
              {t('Video uses mobile data: about 1–2 MB per minute for each camera.')}
            </Text>
          </View>
        )}
        {channels.isSuccess && focused && tab === 'recordings' && <RecordingsPanel objectId={id} vehicle={vehicle} channels={list} initialAt={params.at} />}
        {can('video_evidence') && (
          <Button title={t('Video evidence')} icon={FilmIcon} variant="outline" onPress={() => router.push({ pathname: '/video-evidence', params: { objectId: id, name: vehicle } })} />
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

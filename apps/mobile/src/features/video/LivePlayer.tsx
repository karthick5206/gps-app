import type { VideoCaptureDto, VideoExtendDto, VideoSessionDto } from '@veetracer/shared';
import { useEvent } from 'expo';
import { useVideoPlayer, VideoView } from 'expo-video';
import { CameraIcon, CircleDotIcon, MaximizeIcon, RotateCcwIcon, TimerResetIcon, Volume2Icon, VolumeXIcon } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Alert, Pressable, StyleSheet, View } from 'react-native';
import { Text } from '@/components/ui';
import { api } from '@/lib/api';
import { RADIUS, SPACE, useColors } from '@/lib/theme';
import { channelName, sessionSource, videoErrorText } from './video';

/**
 * One live camera: asks the API to start (or join) the stream, plays it (HLS for Jimi RTMP cameras, HTTP-FLV for
 * JT/T 1078 dashcams) and tells the API the viewer left when it unmounts. Under the picture: sound, full screen,
 * snapshot, 10-second clip and, for RTMP cameras, the time left with Extend.
 */
export function LivePlayer({ objectId, channel }: { objectId: string; channel: number }) {
  const { t } = useTranslation();
  const c = useColors();
  const [session, setSession] = useState<VideoSessionDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [muted, setMuted] = useState(true);
  const [endsAt, setEndsAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState<'photo' | 'video' | 'extend' | null>(null);
  const view = useRef<VideoView>(null);
  const player = useVideoPlayer(null, (p) => {
    p.muted = true;
  });
  const { status } = useEvent(player, 'statusChange', { status: player.status });

  useEffect(() => {
    let cancelled = false;
    let id: string | null = null;
    setError(null);
    setSession(null);
    api
      .post<VideoSessionDto>(`/video/${objectId}/live`, { channel, stream: 'sub' })
      .then(async (s) => {
        if (cancelled) return;
        id = s.sessionId;
        setSession(s);
        setEndsAt(s.streamEndsAt ? Date.parse(s.streamEndsAt) : null);
        await player.replaceAsync(sessionSource(s));
        player.play();
      })
      .catch((err) => !cancelled && setError(videoErrorText(t, err)));
    return () => {
      cancelled = true;
      if (id) {
        const leaving = id;
        setTimeout(() => void api.delete(`/video/sessions/${leaving}`).catch(() => undefined), 300);
      }
    };
  }, [objectId, channel, attempt, player, t]);

  // RTMP cameras stream for a fixed time: show what is left.
  useEffect(() => {
    if (!endsAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [endsAt]);

  const capture = async (kind: 'photo' | 'video') => {
    setBusy(kind);
    try {
      await api.post<VideoCaptureDto>(`/video/${objectId}/capture`, { channel, kind, seconds: 10 });
      Alert.alert(kind === 'photo' ? t('Photo requested') : t('Clip requested'), t('It appears in Video evidence in about a minute.'));
    } catch (err) {
      Alert.alert(t('Could not ask the dashcam'), videoErrorText(t, err));
    } finally {
      setBusy(null);
    }
  };
  const extend = async () => {
    setBusy('extend');
    try {
      const r = await api.post<VideoExtendDto>(`/video/${objectId}/extend`, { channel });
      setEndsAt(Date.parse(r.streamEndsAt));
    } catch (err) {
      Alert.alert(t('Could not extend'), videoErrorText(t, err));
    } finally {
      setBusy(null);
    }
  };

  const left = endsAt ? Math.max(0, Math.round((endsAt - now) / 1000)) : null;
  const rtmp = session?.transport === 'rtmp';
  const loading = !error && (!session || status === 'loading' || status === 'idle');

  return (
    <View style={{ gap: SPACE.sm }}>
      <View style={[styles.frame, { borderRadius: RADIUS.md }]}>
        <VideoView ref={view} player={player} style={StyleSheet.absoluteFill} contentFit="contain" nativeControls={false} fullscreenOptions={{ enable: true }} />
        <View style={styles.top} pointerEvents="none">
          <Text size="xs" weight="600" style={{ color: '#fff' }}>
            {channelName(t, channel)}
          </Text>
          {status === 'readyToPlay' && (
            <View style={[styles.badge, { backgroundColor: '#dc2626' }]}>
              <Text size="xs" weight="700" style={{ color: '#fff' }}>
                LIVE
              </Text>
            </View>
          )}
        </View>
        {loading && (
          <View style={styles.overlay}>
            <ActivityIndicator color="#fff" />
            <Text size="sm" style={{ color: '#fff' }}>
              {session ? t('Connecting…') : t('Asking the dashcam to start video…')}
            </Text>
          </View>
        )}
        {(error || status === 'error') && (
          <View style={[styles.overlay, { backgroundColor: 'rgba(0,0,0,0.8)' }]}>
            <Text size="sm" style={{ color: '#fff', textAlign: 'center' }}>
              {error ?? t('The video connection was lost.')}
            </Text>
            <Pressable onPress={() => setAttempt((a) => a + 1)} style={styles.retry} accessibilityRole="button">
              <RotateCcwIcon size={16} color="#111" />
              <Text size="sm" weight="600" style={{ color: '#111' }}>
                {t('Try again')}
              </Text>
            </Pressable>
          </View>
        )}
      </View>
      <View style={[styles.bar, { borderColor: c.border, backgroundColor: c.card }]}>
        <IconButton
          label={muted ? t('Sound on') : t('Sound off')}
          onPress={() => {
            player.muted = !muted;
            setMuted(!muted);
          }}
        >
          {muted ? <VolumeXIcon size={20} color={c.foreground} /> : <Volume2Icon size={20} color={c.foreground} />}
        </IconButton>
        <IconButton label={t('Full screen')} onPress={() => void view.current?.enterFullscreen().catch(() => undefined)}>
          <MaximizeIcon size={20} color={c.foreground} />
        </IconButton>
        <IconButton label={t('Snapshot')} onPress={() => void capture('photo')} busy={busy === 'photo'}>
          <CameraIcon size={20} color={c.foreground} />
        </IconButton>
        {rtmp && (
          <IconButton label={t('Record 10 seconds')} onPress={() => void capture('video')} busy={busy === 'video'}>
            <CircleDotIcon size={20} color="#dc2626" />
          </IconButton>
        )}
        <View style={{ flex: 1 }} />
        {rtmp && left !== null && (
          <>
            <Text size="xs" tone="muted" style={{ fontVariant: ['tabular-nums'] }}>
              {t('Ends in {{time}}', { time: `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` })}
            </Text>
            <IconButton label={t('Extend')} onPress={() => void extend()} busy={busy === 'extend'}>
              <TimerResetIcon size={20} color={c.primary} />
            </IconButton>
          </>
        )}
      </View>
    </View>
  );
}

export function IconButton({ label, onPress, busy, disabled, children }: { label: string; onPress: () => void; busy?: boolean; disabled?: boolean; children: React.ReactNode }) {
  const c = useColors();
  return (
    <Pressable
      onPress={onPress}
      disabled={busy || disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={6}
      style={({ pressed }) => [styles.icon, pressed && { backgroundColor: c.muted }, (busy || disabled) && { opacity: 0.4 }]}
    >
      {busy ? <ActivityIndicator size="small" color={c.foreground} /> : children}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  frame: { width: '100%', aspectRatio: 16 / 9, backgroundColor: '#000', overflow: 'hidden' },
  top: { position: 'absolute', top: 0, left: 0, right: 0, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 8, backgroundColor: 'rgba(0,0,0,0.35)' },
  badge: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 },
  overlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', gap: 10, padding: 16 },
  retry: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: '#fff', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8 },
  bar: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 2, borderWidth: 1, borderRadius: 10, paddingHorizontal: 4, paddingVertical: 2 },
  icon: { width: 40, height: 40, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
});

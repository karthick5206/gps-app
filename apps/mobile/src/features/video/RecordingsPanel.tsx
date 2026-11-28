import { useMutation } from '@tanstack/react-query';
import { VIDEO_DOWNLOAD_MAX_FILES, type VideoDownloadDto, type VideoRecordingDto, type VideoSessionDto } from '@veetracer/shared';
import { useEvent } from 'expo';
import { router } from 'expo-router';
import { useVideoPlayer, VideoView } from 'expo-video';
import {
  ChevronDownIcon,
  DownloadIcon,
  MaximizeIcon,
  PauseIcon,
  PlayIcon,
  RotateCcwIcon,
  SearchIcon,
  SkipBackIcon,
  SkipForwardIcon,
  Volume2Icon,
  VolumeXIcon,
  XIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from 'lucide-react-native';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Button, Card, Chips, ErrorBanner, Text } from '@/components/ui';
import { DateField, fromYmd, TimeField, toYmd } from '@/components/pickers';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { RADIUS, SPACE, useColors } from '@/lib/theme';
import { IconButton } from './LivePlayer';
import { channelName, hhmm, hhmmss, recordingAt, sessionSource, timelineSpans, videoErrorText } from './video';

type Search = { channel: number; from: number; to: number; recs: VideoRecordingDto[] };
type Playing = { channel: number; start: string; end: string; fileName?: string };

const minutesOf = (d: Date) => d.getHours() * 60 + d.getMinutes();
const atDay = (ymd: string, minutes: number) => {
  const d = fromYmd(ymd);
  d.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
  return d.getTime();
};

/**
 * Recorded (SD-card) video of one vehicle: day + time range search, a scrolling timeline (double-tap plays from that
 * time), the player with its controls, "download a time range" and the list. Jimi cameras play in real time, so
 * "forward" is the next minute (a new playback) and only 0.5× / 1× speeds exist.
 */
export function RecordingsPanel({ objectId, vehicle, channels, initialAt }: { objectId: string; vehicle: string; channels: number[]; initialAt?: string }) {
  const { t } = useTranslation();
  const c = useColors();
  const start0 = initialAt ? new Date(Date.parse(initialAt) - 2 * 60_000) : new Date(Date.now() - 3 * 3600_000);
  const end0 = initialAt ? new Date(Date.parse(initialAt) + 2 * 60_000) : new Date();
  const [day, setDay] = useState(toYmd(start0));
  const [fromMin, setFromMin] = useState(minutesOf(start0));
  const [toMin, setToMin] = useState(start0.getDate() === end0.getDate() ? minutesOf(end0) : 23 * 60 + 59);
  const [camera, setCamera] = useState('0');
  const [playing, setPlaying] = useState<Playing | null>(null);
  const [clock, setClock] = useState<number | null>(null);
  const [showList, setShowList] = useState(false);
  const invalid = toMin <= fromMin;

  const search = useMutation({
    mutationFn: async (v: { channel: number; from: number; to: number }): Promise<Search> => {
      const recs = await api.get<VideoRecordingDto[]>(`/video/${objectId}/recordings`, { channel: v.channel, from: new Date(v.from).toISOString(), to: new Date(v.to).toISOString() });
      return { ...v, recs };
    },
  });
  const run = () => !invalid && search.mutate({ channel: Number(camera), from: atDay(day, fromMin), to: atDay(day, toMin) + 59_000 });
  const { mutate } = search;
  useEffect(() => {
    if (initialAt) mutate({ channel: 0, from: Date.parse(initialAt) - 2 * 60_000, to: Date.parse(initialAt) + 2 * 60_000 });
  }, [initialAt, mutate]);

  const download = useMutation({
    mutationFn: (fileNames: string[]) => api.post<VideoDownloadDto>(`/video/${objectId}/recordings/download`, { fileNames }),
    onSuccess: (r) =>
      Alert.alert(
        t('Download requested'),
        r.stoppedBecause
          ? t('{{n}} minute(s) requested; the camera stopped the rest: {{why}}', { n: r.eventIds.length, why: r.stoppedBecause })
          : t('{{n}} minute(s) requested. The camera is uploading; each appears in Video evidence in about a minute.', { n: r.eventIds.length }),
        [{ text: t('OK') }, { text: t('Open Video evidence'), onPress: () => router.push({ pathname: '/video-evidence', params: { objectId } }) }],
      ),
    onError: (e) => Alert.alert(t('Download failed'), videoErrorText(t, e)),
  });

  const recs = search.data?.recs;
  const lanes = search.data && search.data.channel !== 0 ? [search.data.channel] : channels.slice(0, 4);
  const play = (r: VideoRecordingDto) => {
    if (!r.start) return;
    setClock(null);
    const s = Date.parse(r.start);
    setPlaying(r.fileName ? { channel: r.channel, start: r.start, end: new Date(s + 5 * 60_000).toISOString(), fileName: r.fileName } : { channel: r.channel, start: r.start, end: r.end ?? new Date(s + 60_000).toISOString() });
  };
  const move = (minutes: number) => {
    if (!playing || !recs) return;
    const rec = recordingAt(recs, playing.channel, (clock ?? Date.parse(playing.start)) + minutes * 60_000);
    if (rec) play(rec);
    else Alert.alert(t('No more recordings in this direction.'));
  };

  return (
    <View style={{ gap: SPACE.md }}>
      <Card style={{ gap: SPACE.md }}>
        {/* DateField uses flex: 1, so it sits in a row (in this column it would collapse to 0 height). */}
        <View style={{ flexDirection: 'row' }}>
          <DateField label={t('Day')} value={day} onChange={setDay} maximumDate={new Date()} />
        </View>
        <View style={{ flexDirection: 'row', gap: SPACE.md }}>
          <TimeField label={t('From')} value={fromMin} onChange={setFromMin} />
          <TimeField label={t('To')} value={toMin} onChange={setToMin} />
        </View>
        <Chips options={[{ value: '0', label: t('All cameras') }, ...channels.map((ch) => ({ value: String(ch), label: channelName(t, ch) }))]} value={camera} onChange={setCamera} />
        {invalid && (
          <Text size="xs" style={{ color: c.destructive }}>
            {t('End must be after start')}
          </Text>
        )}
        <Button title={t('Search')} icon={SearchIcon} onPress={run} loading={search.isPending} disabled={invalid} />
        {search.isPending && (
          <Text size="sm" tone="muted">
            {t('Asking the dashcam for its recordings…')}
          </Text>
        )}
      </Card>
      {search.isError && <ErrorBanner message={videoErrorText(t, search.error)} onRetry={run} />}

      {playing && (
        <RecordingPlayer
          key={`${playing.channel}-${playing.start}`}
          objectId={objectId}
          vehicle={vehicle}
          playing={playing}
          onClock={setClock}
          onClose={() => {
            setPlaying(null);
            setClock(null);
          }}
          onPrev={() => move(-1)}
          onNext={() => move(1)}
          onDownload={
            playing.fileName && recs
              ? () => download.mutate([recordingAt(recs, playing.channel, clock ?? Date.parse(playing.start))?.fileName ?? playing.fileName!])
              : undefined
          }
          downloading={download.isPending}
        />
      )}

      {search.data && recs && recs.length === 0 && (
        <Text tone="muted" style={{ textAlign: 'center', paddingVertical: SPACE.lg }}>
          {t('No recordings on the dashcam for this time.')}
        </Text>
      )}
      {search.data && recs && recs.length > 0 && (
        <>
          <Timeline
            from={search.data.from}
            to={search.data.to}
            recs={recs}
            lanes={lanes}
            playhead={playing ? (clock ?? Date.parse(playing.start)) : null}
            onPlay={(at, ch) => {
              const rec = recordingAt(recs, ch, at);
              if (rec) play(rec);
              else Alert.alert(t('No recording of this camera after that time.'));
            }}
          />
          {recs.some((r) => r.fileName) && (
            <RangeDownload recs={recs} lanes={lanes} day={day} fromMin={fromMin} toMin={toMin} busy={download.isPending} onDownload={(names) => download.mutate(names)} onPlay={play} />
          )}
          <Card style={{ padding: 0 }}>
            <Pressable onPress={() => setShowList((v) => !v)} style={styles.listHead} accessibilityRole="button" accessibilityState={{ expanded: showList }}>
              <Text weight="600" style={{ flex: 1 }}>
                {t('List of recordings ({{n}})', { n: recs.length })}
              </Text>
              <ChevronDownIcon size={18} color={c.mutedForeground} style={{ transform: [{ rotate: showList ? '0deg' : '-90deg' }] }} />
            </Pressable>
            {showList &&
              recs.slice(0, 300).map((r, i) => (
                <View key={`${r.channel}-${r.start}-${i}`} style={[styles.row, { borderTopColor: c.border }]}>
                  <View style={{ flex: 1 }}>
                    <Text size="xs" tone="muted">
                      {channelName(t, r.channel)}
                    </Text>
                    <Text size="sm">{formatDateTime(r.start)}</Text>
                  </View>
                  {r.fileName && (
                    <IconButton label={t('Download')} onPress={() => download.mutate([r.fileName!])} disabled={download.isPending}>
                      <DownloadIcon size={20} color={c.foreground} />
                    </IconButton>
                  )}
                  <IconButton label={t('Play recording')} onPress={() => play(r)}>
                    <PlayIcon size={20} color={c.primary} />
                  </IconButton>
                </View>
              ))}
          </Card>
        </>
      )}
    </View>
  );
}

function RecordingPlayer({
  objectId,
  vehicle,
  playing,
  onClock,
  onClose,
  onPrev,
  onNext,
  onDownload,
  downloading,
}: {
  objectId: string;
  vehicle: string;
  playing: Playing;
  onClock: (ms: number) => void;
  onClose: () => void;
  onPrev: () => void;
  onNext: () => void;
  onDownload?: () => void;
  downloading: boolean;
}) {
  const { t } = useTranslation();
  const c = useColors();
  const view = useRef<VideoView>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [startsAt, setStartsAt] = useState<number | null>(null);
  const [muted, setMuted] = useState(true);
  const [rate, setRate] = useState(1);
  const [clock, setClockState] = useState<number | null>(null);
  const base = useRef<number | null>(null);
  const player = useVideoPlayer(null, (p) => {
    p.muted = true;
    p.timeUpdateEventInterval = 1;
  });
  const { status } = useEvent(player, 'statusChange', { status: player.status });
  const { isPlaying } = useEvent(player, 'playingChange', { isPlaying: player.playing });
  const time = useEvent(player, 'timeUpdate', { currentTime: 0, currentLiveTimestamp: null, currentOffsetFromLive: null, bufferedPosition: 0 });

  useEffect(() => {
    let cancelled = false;
    let id: string | null = null;
    setError(null);
    base.current = null;
    api
      .post<VideoSessionDto>(`/video/${objectId}/playback`, { channel: playing.channel, start: playing.start, end: playing.end })
      .then(async (s) => {
        if (cancelled) return;
        id = s.sessionId;
        setStartsAt(Date.parse(s.startsAt ?? playing.start));
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
  }, [objectId, playing, attempt, player, t]);

  // Wall clock = first frame's time + seconds played (HLS live streams do not start at 0).
  useEffect(() => {
    if (startsAt === null || status !== 'readyToPlay') return;
    if (base.current === null) base.current = time.currentTime;
    const ms = startsAt + Math.max(0, time.currentTime - base.current) * 1000;
    setClockState(ms);
    onClock(ms);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- follow the player clock only
  }, [time.currentTime, startsAt, status]);

  const loading = !error && (status === 'idle' || status === 'loading');
  return (
    <View style={{ gap: SPACE.sm }}>
      <View style={[styles.frame, { borderRadius: RADIUS.md }]}>
        <VideoView ref={view} player={player} style={StyleSheet.absoluteFill} contentFit="contain" nativeControls={false} fullscreenOptions={{ enable: true }} />
        <View style={styles.top} pointerEvents="box-none">
          <Text size="xs" weight="600" style={{ color: '#fff', flex: 1 }} numberOfLines={1}>
            {vehicle} · {channelName(t, playing.channel)}
          </Text>
          {status === 'readyToPlay' && (
            <View style={[styles.badge, { backgroundColor: '#0284c7' }]}>
              <Text size="xs" weight="700" style={{ color: '#fff' }}>
                REC
              </Text>
            </View>
          )}
          <Pressable onPress={onClose} hitSlop={8} accessibilityRole="button" accessibilityLabel={t('Close video')}>
            <XIcon size={18} color="#fff" />
          </Pressable>
        </View>
        {loading && (
          <View style={styles.overlay}>
            <ActivityIndicator color="#fff" />
            <Text size="sm" style={{ color: '#fff' }}>
              {t('Asking the dashcam to play the recording…')}
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
        <IconButton label={t('Previous minute')} onPress={onPrev}>
          <SkipBackIcon size={20} color={c.foreground} />
        </IconButton>
        <IconButton label={t('Back 10 seconds')} onPress={() => player.seekBy(-10)}>
          <RotateCcwIcon size={20} color={c.foreground} />
        </IconButton>
        <IconButton label={isPlaying ? t('Pause') : t('Play')} onPress={() => (isPlaying ? player.pause() : player.play())}>
          {isPlaying ? <PauseIcon size={20} color={c.foreground} /> : <PlayIcon size={20} color={c.foreground} />}
        </IconButton>
        <IconButton label={t('Next minute')} onPress={onNext}>
          <SkipForwardIcon size={20} color={c.foreground} />
        </IconButton>
        <IconButton
          label={muted ? t('Sound on') : t('Sound off')}
          onPress={() => {
            player.muted = !muted;
            setMuted(!muted);
          }}
        >
          {muted ? <VolumeXIcon size={20} color={c.foreground} /> : <Volume2Icon size={20} color={c.foreground} />}
        </IconButton>
        <Pressable
          onPress={() => {
            const next = rate === 1 ? 0.5 : 1;
            player.playbackRate = next;
            setRate(next);
          }}
          accessibilityRole="button"
          accessibilityLabel={t('Playback speed: {{n}}×', { n: rate })}
          style={styles.rate}
        >
          <Text size="sm" weight="600">
            {rate}×
          </Text>
        </Pressable>
        <IconButton label={t('Full screen')} onPress={() => void view.current?.enterFullscreen().catch(() => undefined)}>
          <MaximizeIcon size={20} color={c.foreground} />
        </IconButton>
        {onDownload && (
          <IconButton label={t('Download this minute')} onPress={onDownload} busy={downloading}>
            <DownloadIcon size={20} color={c.foreground} />
          </IconButton>
        )}
        <View style={{ flex: 1 }} />
        {clock !== null && (
          <Text size="xs" tone="muted" style={{ fontVariant: ['tabular-nums'], paddingHorizontal: 4 }}>
            {hhmmss(clock)}
          </Text>
        )}
      </View>
    </View>
  );
}

const ZOOMS = [1, 2, 4, 8, 16, 32];
const LANE = 34;

/** Horizontal timeline: one lane per camera; single tap shows a time, double tap plays from it. */
function Timeline({ from, to, recs, lanes, playhead, onPlay }: { from: number; to: number; recs: VideoRecordingDto[]; lanes: number[]; playhead: number | null; onPlay: (at: number, ch: number) => void }) {
  const { t } = useTranslation();
  const c = useColors();
  const [viewW, setViewW] = useState(300);
  const [zoom, setZoom] = useState(0);
  const [cursor, setCursor] = useState<number | null>(null);
  const lastTap = useRef(0);
  const scroller = useRef<React.ComponentRef<typeof ScrollView>>(null);
  const width = Math.max(200, viewW * ZOOMS[zoom]);
  const total = Math.max(1, to - from);
  const spans = useMemo(() => timelineSpans(recs, from, to), [recs, from, to]);
  const pxPerHour = (width / total) * 3600_000;
  const stepMin = [1, 2, 5, 10, 15, 30, 60, 120, 180, 360].find((m) => (m / 60) * pxPerHour >= 64) ?? 720;
  const ticks = useMemo(() => {
    const out: number[] = [];
    const step = stepMin * 60_000;
    const offset = -new Date(from).getTimezoneOffset() * 60_000;
    for (let x = Math.ceil((from + offset) / step) * step - offset; x <= to; x += step) out.push(x);
    return out;
  }, [from, to, stepMin]);
  const x = (ms: number) => ((ms - from) / total) * width;

  // Keep the playing position in view.
  const playKey = playhead ? Math.floor(playhead / 15_000) : null;
  useEffect(() => {
    if (playhead === null) return;
    scroller.current?.scrollTo({ x: Math.max(0, x(playhead) - viewW / 3), animated: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- follow the playhead in 15 s steps and zoom
  }, [playKey, zoom]);

  return (
    <Card style={{ gap: SPACE.sm, padding: SPACE.md }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE.sm }}>
        <Text size="xs" tone="muted" style={{ flex: 1 }}>
          {cursor !== null ? `${hhmm(cursor)} · ` : ''}
          {t('Double-tap the timeline to play from that time.')}
        </Text>
        <IconButton label={t('Zoom out')} onPress={() => setZoom((z) => Math.max(0, z - 1))} disabled={zoom === 0}>
          <ZoomOutIcon size={18} color={c.foreground} />
        </IconButton>
        <IconButton label={t('Zoom in')} onPress={() => setZoom((z) => Math.min(ZOOMS.length - 1, z + 1))} disabled={zoom === ZOOMS.length - 1}>
          <ZoomInIcon size={18} color={c.foreground} />
        </IconButton>
      </View>
      <View style={{ flexDirection: 'row' }}>
        <View style={{ width: 52, paddingTop: 20 }}>
          {lanes.map((ch) => (
            <View key={ch} style={{ height: LANE, justifyContent: 'center' }}>
              <Text size="xs" tone="muted">
                {ch === 1 ? t('Road') : ch === 2 ? t('Driver') : `CH${ch}`}
              </Text>
            </View>
          ))}
        </View>
        <ScrollView ref={scroller} horizontal showsHorizontalScrollIndicator style={{ flex: 1 }} onLayout={(e) => setViewW(e.nativeEvent.layout.width)}>
          <View style={{ width }}>
            <View style={{ height: 20 }}>
              {ticks.map((tk) => (
                <Text key={tk} size="xs" tone="muted" style={{ position: 'absolute', left: x(tk) + 3, top: 2, fontSize: 10 }}>
                  {hhmm(tk)}
                </Text>
              ))}
            </View>
            <Pressable
              accessibilityRole="adjustable"
              accessibilityLabel={t('Recording timeline')}
              style={{ height: lanes.length * LANE, backgroundColor: c.muted, borderRadius: 6 }}
              onPress={(e) => {
                const at = from + Math.min(1, Math.max(0, e.nativeEvent.locationX / width)) * total;
                const lane = lanes[Math.min(lanes.length - 1, Math.max(0, Math.floor(e.nativeEvent.locationY / LANE)))];
                const now = Date.now();
                setCursor(at);
                if (now - lastTap.current < 350) {
                  lastTap.current = 0;
                  onPlay(at, lane);
                } else lastTap.current = now;
              }}
            >
              {ticks.map((tk) => (
                <View key={tk} pointerEvents="none" style={{ position: 'absolute', left: x(tk), top: 0, bottom: 0, width: StyleSheet.hairlineWidth, backgroundColor: c.border }} />
              ))}
              {spans.map((s, i) => (
                <View
                  key={i}
                  pointerEvents="none"
                  style={{
                    position: 'absolute',
                    left: s.left * width,
                    width: Math.max(s.event ? 4 : 2, s.width * width),
                    top: Math.max(0, lanes.indexOf(s.channel)) * LANE + 7,
                    height: LANE - 14,
                    borderRadius: 3,
                    backgroundColor: s.event ? '#f59e0b' : s.channel === 2 ? '#8b5cf6' : '#0284c7',
                    zIndex: s.event ? 1 : 0,
                  }}
                />
              ))}
              {cursor !== null && <View pointerEvents="none" style={{ position: 'absolute', left: x(cursor), top: 0, bottom: 0, width: 1, backgroundColor: c.foreground }} />}
              {playhead !== null && <View pointerEvents="none" style={{ position: 'absolute', left: x(playhead), top: 0, bottom: 0, width: 2, backgroundColor: '#dc2626' }} />}
            </Pressable>
          </View>
        </ScrollView>
      </View>
    </Card>
  );
}

/** Pick camera + start / end time on the searched day; downloads up to VIDEO_DOWNLOAD_MAX_FILES minutes. */
function RangeDownload({
  recs,
  lanes,
  day,
  fromMin,
  toMin,
  busy,
  onDownload,
  onPlay,
}: {
  recs: VideoRecordingDto[];
  lanes: number[];
  day: string;
  fromMin: number;
  toMin: number;
  busy: boolean;
  onDownload: (names: string[]) => void;
  onPlay: (r: VideoRecordingDto) => void;
}) {
  const { t } = useTranslation();
  const c = useColors();
  const [cam, setCam] = useState(String(lanes[0] ?? 1));
  const [startMin, setStartMin] = useState(Math.max(fromMin, toMin - 5));
  const [endMin, setEndMin] = useState(toMin);
  const s = atDay(day, startMin);
  const e = atDay(day, endMin) + 59_000;
  const files = useMemo(
    () => (e > s ? recs.filter((r) => r.fileName && r.channel === Number(cam) && r.start && r.end && Date.parse(r.end) > s && Date.parse(r.start) < e) : []),
    [recs, cam, s, e],
  );
  const tooMany = files.length > VIDEO_DOWNLOAD_MAX_FILES;
  return (
    <Card style={{ gap: SPACE.md }}>
      <View style={{ gap: 2 }}>
        <Text weight="600">{t('Download a time range')}</Text>
        <Text size="xs" tone="muted">
          {t('Each minute is about 10–15 MB; the camera uploads it over its SIM.')}
        </Text>
      </View>
      <Chips options={lanes.map((ch) => ({ value: String(ch), label: channelName(t, ch) }))} value={cam} onChange={setCam} />
      <View style={{ flexDirection: 'row', gap: SPACE.md }}>
        <TimeField label={t('Start time')} value={startMin} onChange={setStartMin} />
        <TimeField label={t('End time')} value={endMin} onChange={setEndMin} />
      </View>
      <Text size="xs" style={{ color: tooMany ? c.destructive : c.mutedForeground }}>
        {tooMany
          ? t('{{n}} minutes selected: at most {{max}} per download. Shorten the range.', { n: files.length, max: VIDEO_DOWNLOAD_MAX_FILES })
          : t('{{n}} minute(s) recorded in this range', { n: files.length })}
      </Text>
      <View style={{ flexDirection: 'row', gap: SPACE.md }}>
        <Button title={t('Play')} icon={PlayIcon} variant="outline" style={{ flex: 1 }} disabled={!files.length} onPress={() => files[0] && onPlay(files[0])} />
        <Button title={t('Download')} icon={DownloadIcon} style={{ flex: 1 }} disabled={!files.length || tooMany} loading={busy} onPress={() => onDownload(files.map((f) => f.fileName!))} />
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  frame: { width: '100%', aspectRatio: 16 / 9, backgroundColor: '#000', overflow: 'hidden' },
  top: { position: 'absolute', top: 0, left: 0, right: 0, flexDirection: 'row', alignItems: 'center', gap: 8, padding: 8, backgroundColor: 'rgba(0,0,0,0.35)' },
  badge: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 },
  overlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', gap: 10, padding: 16 },
  retry: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: '#fff', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8 },
  bar: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 2, borderWidth: 1, borderRadius: 10, paddingHorizontal: 4, paddingVertical: 2 },
  rate: { minWidth: 44, height: 40, alignItems: 'center', justifyContent: 'center', borderRadius: 8 },
  listHead: { flexDirection: 'row', alignItems: 'center', padding: SPACE.md },
  row: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, paddingHorizontal: SPACE.md, paddingVertical: SPACE.sm, borderTopWidth: StyleSheet.hairlineWidth },
});

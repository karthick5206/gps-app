import { useMutation, useQuery } from '@tanstack/react-query';
import {
  VIDEO_DOWNLOAD_MAX_FILES,
  type VideoChannelsDto,
  type VideoDownloadDto,
  type VideoRecordingDto,
  type VideoSessionDto,
  type VideoStreamType,
} from '@veetracer/shared';
import type { TFunction } from 'i18next';
import { ChevronDownIcon, DownloadIcon, PictureInPicture2Icon, PlayIcon, SearchIcon, SquareIcon, VideoIcon } from 'lucide-react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { fromLocalInput, toLocalInput } from '@/features/history/time-range';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { alertWindow, formatBytes, gridColumns, isAlarmRecording, playbackRange, recordingAt, shiftWindow } from './video-utils';
import { RecordingTimeline } from './RecordingTimeline';
import { RecordingControls } from './RecordingControls';
import { floatingVideo } from './floating-video-store';
import { LiveControls } from './LiveControls';
import { VideoPlayer, videoErrorText } from './VideoPlayer';

export function useVideoChannels(objectId: string | null, enabled = true) {
  return useQuery({
    queryKey: ['video-channels', objectId],
    queryFn: ({ signal }) => api.get<VideoChannelsDto>(`/video/${objectId}/channels`, undefined, signal),
    enabled: enabled && !!objectId,
    retry: false,
    staleTime: 5 * 60_000,
  });
}

/** Channel picker + players: every channel stacked one below another by default, each with its own controls. */
export function LiveChannels({
  objectId,
  vehicle,
  channels,
  selected,
  onSelect,
  playing,
  large,
  compact,
}: {
  objectId: string;
  vehicle: string;
  channels: number[];
  selected: number[];
  onSelect: (channels: number[]) => void;
  /** null = not playing yet. */
  playing: { channels: number[]; stream: VideoStreamType } | null;
  large?: boolean;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const [sessions, setSessions] = useState<Record<number, VideoSessionDto>>({});
  const toggle = (ch: number) =>
    onSelect(selected.includes(ch) ? (selected.length > 1 ? selected.filter((c) => c !== ch) : selected) : [...selected, ch].sort((a, b) => a - b));
  const cols = large ? gridColumns(playing?.channels.length ?? 1) : 1;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t('Camera channel')}>
        {channels.map((ch) => (
          <Button
            key={ch}
            size="sm"
            variant={selected.includes(ch) ? 'default' : 'outline'}
            aria-pressed={selected.includes(ch)}
            onClick={() => toggle(ch)}
            className={compact ? 'h-7 px-2' : undefined}
          >
            {channelLabel(t, ch, channels.length)}
          </Button>
        ))}
      </div>
      {playing && (
        <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
          {playing.channels.map((ch) => (
            <div key={`${ch}-${playing.stream}`} className="space-y-1.5">
              <VideoPlayer
                label={`${vehicle} · ${channelLabel(t, ch, channels.length)}`}
                start={() => api.post<VideoSessionDto>(`/video/${objectId}/live`, { channel: ch, stream: playing.stream })}
                onSession={(s) => setSessions((cur) => ({ ...cur, [ch]: s }))}
                onClose={() => onSelect(selected.length > 1 ? selected.filter((c) => c !== ch) : selected)}
              />
              <LiveControls objectId={objectId} channel={ch} session={sessions[ch] ?? null} compact={compact} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** "Road camera" / "Driver camera" for 2-channel dashcams, else CH<n>. */
export function channelLabel(t: (k: string, o?: Record<string, unknown>) => string, ch: number, count: number): string {
  if (count === 2) return ch === 1 ? t('Road camera') : t('Driver camera');
  return t('CH{{n}}', { n: ch });
}

function LiveView({
  objectId,
  vehicle,
  channels,
  initialChannel,
  large,
}: {
  objectId: string;
  vehicle: string;
  channels: number[];
  initialChannel?: number;
  large?: boolean;
}) {
  const { t } = useTranslation();
  // All channels by default (one below another); an alert opens just its own channel.
  const [selected, setSelected] = useState<number[]>(initialChannel && channels.includes(initialChannel) ? [initialChannel] : channels);
  const [stream, setStream] = useState<VideoStreamType>('sub');
  const [playing, setPlaying] = useState<{ channels: number[]; stream: VideoStreamType } | null>(null);
  // Channel changes while playing apply at once.
  useEffect(() => setPlaying((p) => (p ? { ...p, channels: selected } : p)), [selected]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={stream} onValueChange={(v) => setStream(v as VideoStreamType)}>
          <SelectTrigger className="h-8 w-44" aria-label={t('Quality')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="sub">{t('Data saver (sub-stream)')}</SelectItem>
            <SelectItem value="main">{t('High quality (main stream)')}</SelectItem>
          </SelectContent>
        </Select>
        {playing ? (
          <Button size="sm" variant="outline" onClick={() => setPlaying(null)}>
            <SquareIcon /> {t('Stop')}
          </Button>
        ) : (
          <Button size="sm" onClick={() => setPlaying({ channels: selected, stream })}>
            <VideoIcon /> {t('Live')}
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            floatingVideo.open(objectId, vehicle, channels, selected);
            setPlaying(null);
          }}
          title={t('Keep watching in a small window while you use the map and other pages')}
        >
          <PictureInPicture2Icon /> {t('Pop out')}
        </Button>
      </div>
      <LiveChannels objectId={objectId} vehicle={vehicle} channels={channels} selected={selected} onSelect={setSelected} playing={playing} large={large} />
      {!playing && (
        <p className="text-xs text-muted-foreground">
          {t('Live video uses mobile data on the dashcam SIM (about 256–512 kbps per channel on the sub-stream). It stops automatically when you close it.')}
        </p>
      )}
    </div>
  );
}

function RecordingsView({
  objectId,
  vehicle,
  channels,
  initialChannel,
  initialAt,
}: {
  objectId: string;
  vehicle: string;
  channels: number[];
  initialChannel?: number;
  initialAt?: string;
}) {
  const { t } = useTranslation();
  const window0 = useMemo(() => (initialAt ? alertWindow(initialAt) : { from: new Date(Date.now() - 3 * 3600_000), to: new Date() }), [initialAt]);
  const [from, setFrom] = useState(toLocalInput(window0.from));
  const [to, setTo] = useState(toLocalInput(window0.to));
  const [channel, setChannel] = useState(String(initialChannel ?? 0));
  const [playing, setPlaying] = useState<{ channel: number; start: string; end: string; fileName?: string } | null>(null);
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);
  const [startsAt, setStartsAt] = useState<string | null>(null);
  const [clock, setClock] = useState<string | null>(null);
  const [showList, setShowList] = useState(false);
  const navigate = useNavigate();
  const range = { from: fromLocalInput(from), to: fromLocalInput(to) };
  const invalid = !range.from || !range.to || range.to <= range.from;
  const search = useMutation({
    mutationFn: (v: { channel: number; from: Date; to: Date }) =>
      api
        .get<VideoRecordingDto[]>(`/video/${objectId}/recordings`, { channel: v.channel, from: v.from.toISOString(), to: v.to.toISOString() })
        .then((recs) => ({ ...v, recs })),
  });
  const runSearch = () => {
    if (!invalid) search.mutate({ channel: Number(channel), from: range.from!, to: range.to! });
  };
  // Opened from an alert: search straight away.
  const { mutate } = search;
  useEffect(() => {
    if (initialAt) mutate({ channel: initialChannel ?? 0, from: window0.from, to: window0.to });
  }, [initialAt, initialChannel, mutate, window0]);
  const clampWindow = initialAt ? window0 : null;
  const recs = search.data?.recs;
  const sdCard = !!recs?.some((r) => r.fileName);
  const lanes = search.data && search.data.channel !== 0 ? [search.data.channel] : channels.slice(0, 4);

  // SD-card download (Jimi): the camera uploads each minute; they land in Video evidence as manual captures.
  const download = useMutation({
    mutationFn: (fileNames: string[]) => api.post<VideoDownloadDto>(`/video/${objectId}/recordings/download`, { fileNames }),
    onSuccess: (r) =>
      toast.success(
        r.stoppedBecause
          ? t('{{n}} minute(s) requested; the camera stopped the rest: {{why}}', { n: r.eventIds.length, why: r.stoppedBecause })
          : t('{{n}} minute(s) requested. The camera is uploading; each appears in Video evidence in about a minute.', { n: r.eventIds.length }),
        { action: { label: t('Open Video evidence'), onClick: () => void navigate('/video-evidence') }, duration: 12_000 },
      ),
    onError: (e) => toast.error(videoErrorText(t, e)),
  });

  const play = (r: VideoRecordingDto) => {
    const pb = playbackRange(r, clampWindow);
    if (!pb) return;
    setStartsAt(null);
    setClock(null);
    // SD-card cameras: play on for 5 minutes from this file (several files per request).
    setPlaying(r.fileName ? { channel: r.channel, ...shiftWindow(pb.start, 0, 5), fileName: r.fileName } : { channel: r.channel, ...pb });
  };
  // Next / previous minute (SD-card cameras play in real time, so "forward" is a new playback from a later file).
  const move = (minutes: number) => {
    if (!playing || !recs) return;
    const base = Date.parse(clock ?? startsAt ?? playing.start) + minutes * 60_000;
    const rec = recordingAt(recs, playing.channel, base);
    if (rec) play(rec);
    else toast.info(t('No more recordings in this direction.'));
  };

  return (
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto_auto] sm:items-end">
        <div className="space-y-1">
          <Label htmlFor="rec-from">{t('From')}</Label>
          <Input id="rec-from" type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="rec-to">{t('To')}</Label>
          <Input id="rec-to" type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <Select value={channel} onValueChange={setChannel}>
          <SelectTrigger className="h-9 w-full sm:w-36" aria-label={t('Camera channel')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="0">{t('All cameras')}</SelectItem>
            {channels.map((ch) => (
              <SelectItem key={ch} value={String(ch)}>
                {channelName(t, ch)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button onClick={runSearch} disabled={invalid || search.isPending}>
          {search.isPending ? <Spinner /> : <SearchIcon />} {t('Search')}
        </Button>
      </div>
      {invalid && <p className="text-xs text-destructive">{t('End must be after start')}</p>}
      {search.isPending && <p className="text-sm text-muted-foreground">{t('Asking the dashcam for its recordings…')}</p>}
      {search.isError && (
        <p className="text-sm text-destructive" role="alert">
          {videoErrorText(t, search.error)}
        </p>
      )}

      {playing && (
        <div className="mx-auto w-full max-w-4xl space-y-2">
          <VideoPlayer
            key={`${playing.channel}-${playing.start}`}
            kind="playback"
            label={`${vehicle} · ${channelName(t, playing.channel)} · ${formatDateTime(playing.start)}`}
            start={() => api.post<VideoSessionDto>(`/video/${objectId}/playback`, { channel: playing.channel, start: playing.start, end: playing.end })}
            onSession={(s) => setStartsAt(s.startsAt ?? playing.start)}
            onVideo={setVideoEl}
            onClose={() => {
              setPlaying(null);
              setClock(null);
            }}
          />
          <RecordingControls
            video={videoEl}
            startsAt={startsAt}
            vehicle={vehicle}
            onClock={setClock}
            onPrev={() => move(-1)}
            onNext={() => move(1)}
            onDownload={
              playing.fileName && recs
                ? () => {
                    const rec = recordingAt(recs, playing.channel, Date.parse(clock ?? startsAt ?? playing.start));
                    download.mutate([rec?.fileName ?? playing.fileName!]);
                  }
                : undefined
            }
            downloading={download.isPending}
          />
        </div>
      )}

      {search.data && recs && recs.length === 0 && (
        <p className="py-4 text-center text-sm text-muted-foreground">{t('No recordings on the dashcam for this time.')}</p>
      )}
      {search.data && recs && recs.length > 0 && (
        <>
          <RecordingTimeline
            from={search.data.from}
            to={search.data.to}
            recordings={recs}
            channels={lanes}
            playhead={playing ? (clock ?? startsAt) : null}
            onPlay={(at, ch) => {
              const rec = recordingAt(recs, ch, at);
              if (rec) play(rec);
              else toast.info(t('No recording of this camera after that time.'));
            }}
          />
          {sdCard && (
            <RangeDownload
              recs={recs}
              channels={lanes}
              from={search.data.from}
              to={search.data.to}
              busy={download.isPending}
              onDownload={(names) => download.mutate(names)}
              onPlay={play}
            />
          )}
          <div className="rounded-lg border">
            <button
              type="button"
              className="flex w-full items-center justify-between px-3 py-2 text-sm font-medium hover:bg-muted/60"
              onClick={() => setShowList((v) => !v)}
              aria-expanded={showList}
            >
              {t('List of recordings ({{n}})', { n: recs.length })}
              <ChevronDownIcon className={cn('size-4 transition-transform', !showList && '-rotate-90')} />
            </button>
            {showList && (
              <ul className="max-h-96 divide-y overflow-y-auto border-t">
                {recs.map((r, i) => (
                  <li key={`${r.channel}-${r.start}-${i}`} className="flex items-center gap-3 px-3 py-2 text-sm">
                    <Badge variant="outline" className="hidden sm:inline-flex">
                      {channelName(t, r.channel)}
                    </Badge>
                    <div className="min-w-0 flex-1">
                      <div className="text-xs text-muted-foreground sm:hidden">{channelName(t, r.channel)}</div>
                      <div className="truncate tabular-nums">
                        {r.fileName
                          ? `${formatDateTime(r.start)} · ${t('{{n}} min', { n: Math.max(1, Math.round((Date.parse(r.end ?? r.start!) - Date.parse(r.start!)) / 60_000)) })}`
                          : `${formatDateTime(r.start)} – ${formatDateTime(r.end)}`}
                      </div>
                      {!r.fileName && (
                        <div className="text-xs text-muted-foreground">
                          {formatBytes(r.sizeBytes)}
                          {r.storageType === 2 ? ` · ${t('Backup storage')}` : ''}
                        </div>
                      )}
                    </div>
                    {isAlarmRecording(r.alarmFlags) && <Badge variant="warning">{t('Event')}</Badge>}
                    {r.fileName && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={download.isPending}
                        onClick={() => download.mutate([r.fileName!])}
                        aria-label={t('Download recording')}
                        title={t('Download')}
                      >
                        <DownloadIcon />
                      </Button>
                    )}
                    <Button size="sm" variant="outline" disabled={!playbackRange(r, clampWindow)} onClick={() => play(r)} aria-label={t('Play recording')}>
                      <PlayIcon />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** Camera name: 1 = road, 2 = driver (Jimi / most dashcams), else CHn. */
function channelName(t: TFunction, ch: number): string {
  return ch === 1 ? t('Road camera') : ch === 2 ? t('Driver camera') : t('CH{{n}}', { n: ch });
}

/**
 * Download a time range from the SD card (like the "Download history" box of other platforms): pick the camera and the
 * start / end time; up to VIDEO_DOWNLOAD_MAX_FILES minutes per request (each ~10–15 MB over the camera's 4G).
 */
function RangeDownload({
  recs,
  channels,
  from,
  to,
  busy,
  onDownload,
  onPlay,
}: {
  recs: VideoRecordingDto[];
  channels: number[];
  from: Date;
  to: Date;
  busy: boolean;
  onDownload: (fileNames: string[]) => void;
  onPlay: (r: VideoRecordingDto) => void;
}) {
  const { t } = useTranslation();
  const [cam, setCam] = useState(String(channels[0] ?? 1));
  const [start, setStart] = useState(toLocalInput(new Date(Math.max(from.getTime(), to.getTime() - 5 * 60_000))));
  const [end, setEnd] = useState(toLocalInput(to));
  const s = fromLocalInput(start)?.getTime() ?? null;
  const e = fromLocalInput(end)?.getTime() ?? null;
  const files = useMemo(
    () =>
      s !== null && e !== null && e > s
        ? recs.filter((r) => r.fileName && r.channel === Number(cam) && r.start && r.end && Date.parse(r.end) > s && Date.parse(r.start) < e)
        : [],
    [recs, cam, s, e],
  );
  const tooMany = files.length > VIDEO_DOWNLOAD_MAX_FILES;
  return (
    <div className="space-y-2 rounded-lg border p-3">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <h3 className="text-sm font-semibold">{t('Download a time range')}</h3>
        <span className="text-xs text-muted-foreground">{t('Each minute is about 10–15 MB; the camera uploads it over its SIM.')}</span>
      </div>
      <div className="grid gap-2 sm:grid-cols-[auto_1fr_1fr] sm:items-end">
        <Select value={cam} onValueChange={setCam}>
          <SelectTrigger className="h-9 w-full sm:w-40" aria-label={t('Camera')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {channels.map((ch) => (
              <SelectItem key={ch} value={String(ch)}>
                {channelName(t, ch)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="space-y-1">
          <Label htmlFor="dl-from">{t('Start time')}</Label>
          <Input
            id="dl-from"
            type="datetime-local"
            value={start}
            min={toLocalInput(from)}
            max={toLocalInput(to)}
            onChange={(ev) => setStart(ev.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="dl-to">{t('End time')}</Label>
          <Input id="dl-to" type="datetime-local" value={end} min={toLocalInput(from)} max={toLocalInput(to)} onChange={(ev) => setEnd(ev.target.value)} />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className={cn('flex-1 text-xs', tooMany ? 'text-destructive' : 'text-muted-foreground')}>
          {tooMany
            ? t('{{n}} minutes selected: at most {{max}} per download. Shorten the range.', { n: files.length, max: VIDEO_DOWNLOAD_MAX_FILES })
            : t('{{n}} minute(s) recorded in this range', { n: files.length })}
        </span>
        <Button variant="outline" size="sm" disabled={!files.length} onClick={() => files[0] && onPlay(files[0])}>
          <PlayIcon /> {t('Play')}
        </Button>
        <Button size="sm" disabled={!files.length || tooMany || busy} onClick={() => onDownload(files.map((f) => f.fileName!))}>
          {busy ? <Spinner /> : <DownloadIcon />} {t('Download')}
        </Button>
      </div>
    </div>
  );
}

/** Live + recorded dashcam video for one vehicle (drawer tab and the Video page). */
export function VideoPanel({
  objectId,
  vehicle,
  initialChannel,
  initialAt,
  large,
  className,
}: {
  objectId: string;
  vehicle: string;
  initialChannel?: number;
  /** Alert time: opens Recordings ± 2 minutes around it. */
  initialAt?: string;
  large?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const channels = useVideoChannels(objectId);
  if (channels.isPending) return <Skeleton className="h-40 w-full" />;
  if (channels.isError) return <p className="py-6 text-center text-sm text-muted-foreground">{videoErrorText(t, channels.error)}</p>;
  const list = channels.data.channels;
  return (
    <Tabs defaultValue={initialAt ? 'recordings' : 'live'} className={cn('space-y-3', className)}>
      <TabsList>
        <TabsTrigger value="live">{t('Live')}</TabsTrigger>
        <TabsTrigger value="recordings">{t('Recordings')}</TabsTrigger>
      </TabsList>
      <TabsContent value="live">
        <LiveView objectId={objectId} vehicle={vehicle} channels={list} initialChannel={initialChannel} large={large} />
      </TabsContent>
      <TabsContent value="recordings">
        <RecordingsView objectId={objectId} vehicle={vehicle} channels={list} initialChannel={initialChannel} initialAt={initialAt} />
      </TabsContent>
    </Tabs>
  );
}

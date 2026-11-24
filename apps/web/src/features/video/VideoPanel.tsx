import { useMutation, useQuery } from '@tanstack/react-query';
import type { VideoChannelsDto, VideoRecordingDto, VideoSessionDto, VideoStreamType } from '@veetracer/shared';
import { PictureInPicture2Icon, PlayIcon, SearchIcon, SquareIcon, VideoIcon } from 'lucide-react';
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
import { alertWindow, formatBytes, gridColumns, isAlarmRecording, playbackRange } from './video-utils';
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
  const toggle = (ch: number) => onSelect(selected.includes(ch) ? (selected.length > 1 ? selected.filter((c) => c !== ch) : selected) : [...selected, ch].sort((a, b) => a - b));
  const cols = large ? gridColumns(playing?.channels.length ?? 1) : 1;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t('Camera channel')}>
        {channels.map((ch) => (
          <Button key={ch} size="sm" variant={selected.includes(ch) ? 'default' : 'outline'} aria-pressed={selected.includes(ch)} onClick={() => toggle(ch)} className={compact ? 'h-7 px-2' : undefined}>
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

function LiveView({ objectId, vehicle, channels, initialChannel, large }: { objectId: string; vehicle: string; channels: number[]; initialChannel?: number; large?: boolean }) {
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
        <p className="text-xs text-muted-foreground">{t('Live video uses mobile data on the dashcam SIM (about 256–512 kbps per channel on the sub-stream). It stops automatically when you close it.')}</p>
      )}
    </div>
  );
}

function RecordingsView({ objectId, vehicle, channels, initialChannel, initialAt }: { objectId: string; vehicle: string; channels: number[]; initialChannel?: number; initialAt?: string }) {
  const { t } = useTranslation();
  const window0 = useMemo(() => (initialAt ? alertWindow(initialAt) : { from: new Date(Date.now() - 3600_000), to: new Date() }), [initialAt]);
  const [from, setFrom] = useState(toLocalInput(window0.from));
  const [to, setTo] = useState(toLocalInput(window0.to));
  const [channel, setChannel] = useState(String(initialChannel ?? 0));
  const [playing, setPlaying] = useState<{ channel: number; start: string; end: string } | null>(null);
  const range = { from: fromLocalInput(from), to: fromLocalInput(to) };
  const invalid = !range.from || !range.to || range.to <= range.from;
  const search = useMutation({
    mutationFn: () => api.get<VideoRecordingDto[]>(`/video/${objectId}/recordings`, { channel: Number(channel), from: range.from!.toISOString(), to: range.to!.toISOString() }),
  });
  // Opened from an alert: search straight away.
  const { mutate } = search;
  useEffect(() => {
    if (initialAt) mutate();
  }, [initialAt, mutate]);
  const clampWindow = initialAt ? window0 : null;

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
          <SelectTrigger className="h-9 w-32" aria-label={t('Camera channel')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="0">{t('All channels')}</SelectItem>
            {channels.map((ch) => (
              <SelectItem key={ch} value={String(ch)}>
                {t('CH{{n}}', { n: ch })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button onClick={() => search.mutate()} disabled={invalid || search.isPending}>
          {search.isPending ? <Spinner /> : <SearchIcon />} {t('Search')}
        </Button>
      </div>
      {invalid && <p className="text-xs text-destructive">{t('End must be after start')}</p>}
      {playing && (
        <VideoPlayer
          key={`${playing.channel}-${playing.start}`}
          label={`${vehicle} · ${t('CH{{n}}', { n: playing.channel })} · ${formatDateTime(playing.start)}`}
          start={() => api.post<VideoSessionDto>(`/video/${objectId}/playback`, playing)}
          onClose={() => setPlaying(null)}
        />
      )}
      {search.isPending && <p className="text-sm text-muted-foreground">{t('Asking the dashcam for its recordings…')}</p>}
      {search.isError && <p className="text-sm text-destructive" role="alert">{videoErrorText(t, search.error)}</p>}
      {search.data && search.data.length === 0 && <p className="py-4 text-center text-sm text-muted-foreground">{t('No recordings on the dashcam for this time.')}</p>}
      {search.data && search.data.length > 0 && (
        <ul className="divide-y rounded-lg border">
          {search.data.map((r, i) => {
            const pb = playbackRange(r, clampWindow);
            return (
              <li key={`${r.channel}-${r.start}-${i}`} className="flex items-center gap-3 px-3 py-2 text-sm">
                <Badge variant="outline">{t('CH{{n}}', { n: r.channel })}</Badge>
                <div className="min-w-0 flex-1">
                  <div className="truncate tabular-nums">
                    {formatDateTime(r.start)} – {formatDateTime(r.end)}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {formatBytes(r.sizeBytes)}
                    {r.storageType === 2 ? ` · ${t('Backup storage')}` : ''}
                  </div>
                </div>
                {isAlarmRecording(r.alarmFlags) && <Badge variant="warning">{t('Event')}</Badge>}
                <Button size="sm" variant="outline" disabled={!pb} onClick={() => pb && setPlaying({ channel: r.channel, ...pb })} aria-label={t('Play recording')}>
                  <PlayIcon />
                </Button>
              </li>
            );
          })}
        </ul>
      )}
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

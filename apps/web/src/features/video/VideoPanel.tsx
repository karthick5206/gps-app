import { useMutation, useQuery } from '@tanstack/react-query';
import type { VideoChannelsDto, VideoRecordingDto, VideoSessionDto, VideoStreamType } from '@veetracer/shared';
import { LayoutGridIcon, PlayIcon, SearchIcon, SquareIcon, VideoIcon } from 'lucide-react';
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

function LiveView({ objectId, vehicle, channels, initialChannel, large }: { objectId: string; vehicle: string; channels: number[]; initialChannel?: number; large?: boolean }) {
  const { t } = useTranslation();
  const [grid, setGrid] = useState(false);
  const [selected, setSelected] = useState<number[]>([initialChannel && channels.includes(initialChannel) ? initialChannel : channels[0]]);
  const [stream, setStream] = useState<VideoStreamType>('sub');
  const [playing, setPlaying] = useState<{ channels: number[]; stream: VideoStreamType } | null>(null);

  const toggle = (ch: number) => {
    if (!grid) return setSelected([ch]);
    setSelected((cur) => (cur.includes(ch) ? (cur.length > 1 ? cur.filter((c) => c !== ch) : cur) : [...cur, ch].sort((a, b) => a - b)));
  };
  const cols = gridColumns(playing?.channels.length ?? 1);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t('Camera channel')}>
        {channels.map((ch) => (
          <Button key={ch} size="sm" variant={selected.includes(ch) ? 'default' : 'outline'} aria-pressed={selected.includes(ch)} onClick={() => toggle(ch)}>
            {t('CH{{n}}', { n: ch })}
          </Button>
        ))}
        <Button
          size="sm"
          variant={grid ? 'secondary' : 'ghost'}
          aria-pressed={grid}
          onClick={() => {
            setGrid((g) => !g);
            if (grid) setSelected((cur) => cur.slice(0, 1));
          }}
          title={t('Watch several channels at once')}
        >
          <LayoutGridIcon /> {t('Grid')}
        </Button>
      </div>
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
      </div>
      {playing ? (
        <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${large ? cols : Math.min(cols, 2)}, minmax(0, 1fr))` }}>
          {playing.channels.map((ch) => (
            <VideoPlayer
              key={`${ch}-${playing.stream}`}
              label={`${vehicle} · ${t('CH{{n}}', { n: ch })}`}
              start={() => api.post<VideoSessionDto>(`/video/${objectId}/live`, { channel: ch, stream: playing.stream })}
              onClose={() => setPlaying((p) => (p && p.channels.length > 1 ? { ...p, channels: p.channels.filter((c) => c !== ch) } : null))}
            />
          ))}
        </div>
      ) : (
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

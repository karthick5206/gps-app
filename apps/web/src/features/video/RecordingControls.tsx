import {
  CameraIcon,
  DownloadIcon,
  MaximizeIcon,
  PauseIcon,
  PlayIcon,
  RotateCcwIcon,
  SkipBackIcon,
  SkipForwardIcon,
  Volume2Icon,
  VolumeXIcon,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Tooltip } from '@/components/ui/tooltip';
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { frameFileName } from './video-utils';

/**
 * Controls under a recorded (SD-card) video: play / pause, back 10 s, previous / next minute, speed, sound, full screen,
 * save frame and download. The camera sends a recording in real time, so "forward" jumps to the next minute's file
 * (a new playback) rather than skipping inside the stream, and speeds above 1× are not offered.
 */
export function RecordingControls({
  video,
  startsAt,
  vehicle,
  onClock,
  onPrev,
  onNext,
  onDownload,
  downloading,
  className,
}: {
  /** Wall-clock time being shown (timeline playhead), about every second. */
  onClock?: (iso: string) => void;
  video: HTMLVideoElement | null;
  /** Wall-clock time of the first frame (VideoSessionDto.startsAt). */
  startsAt: string | null;
  vehicle: string;
  onPrev: () => void;
  onNext: () => void;
  onDownload?: () => void;
  downloading?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const [paused, setPaused] = useState(true);
  const [muted, setMuted] = useState(true);
  const [rate, setRate] = useState(1);
  const [clock, setClock] = useState<string | null>(null);
  // currentTime of the first frame: HLS live streams do not start at 0.
  const base = useRef<number | null>(null);
  const onClockRef = useRef(onClock);
  onClockRef.current = onClock;

  useEffect(() => {
    if (!video) return;
    base.current = null;
    const sync = () => {
      setPaused(video.paused);
      setMuted(video.muted);
      setRate(video.playbackRate);
    };
    const tick = () => {
      if (!startsAt || video.readyState < 2) return;
      if (base.current === null) base.current = video.currentTime;
      const iso = new Date(Date.parse(startsAt) + Math.max(0, video.currentTime - base.current) * 1000).toISOString();
      setClock(iso);
      onClockRef.current?.(iso);
    };
    const events = ['play', 'pause', 'volumechange', 'ratechange', 'playing'] as const;
    for (const e of events) video.addEventListener(e, sync);
    video.addEventListener('timeupdate', tick);
    sync();
    return () => {
      for (const e of events) video.removeEventListener(e, sync);
      video.removeEventListener('timeupdate', tick);
    };
  }, [video, startsAt]);

  const ready = !!video;
  const back10 = () => {
    if (!video) return;
    const min = video.seekable.length ? video.seekable.start(0) : 0;
    video.currentTime = Math.max(min, video.currentTime - 10);
  };
  const fullScreen = () => {
    const el = video?.parentElement ?? video;
    void el?.requestFullscreen?.().catch(() => undefined);
  };
  const saveFrame = () => {
    if (!video || !video.videoWidth) return;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d')?.drawImage(video, 0, 0);
    canvas.toBlob((blob) => {
      if (!blob) return;
      const a = Object.assign(document.createElement('a'), {
        href: URL.createObjectURL(blob),
        download: frameFileName(vehicle, clock ?? new Date().toISOString()),
      });
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5_000);
    }, 'image/png');
  };

  const btn = (label: string, icon: React.ReactNode, onClick: () => void, disabled = !ready) => (
    <Tooltip content={label}>
      <Button size="icon-sm" variant="ghost" onClick={onClick} disabled={disabled} aria-label={label}>
        {icon}
      </Button>
    </Tooltip>
  );

  return (
    <div
      className={cn('flex flex-wrap items-center gap-1 rounded-lg border bg-card px-2 py-1.5', className)}
      role="toolbar"
      aria-label={t('Recording controls')}
    >
      {btn(t('Previous minute'), <SkipBackIcon />, onPrev, false)}
      {btn(t('Back 10 seconds'), <RotateCcwIcon />, back10)}
      {btn(paused ? t('Play') : t('Pause'), paused ? <PlayIcon /> : <PauseIcon />, () =>
        video?.paused ? void video.play().catch(() => undefined) : video?.pause(),
      )}
      {btn(t('Next minute'), <SkipForwardIcon />, onNext, false)}
      <div className="mx-1 h-5 w-px bg-border" aria-hidden />
      {btn(muted ? t('Sound on') : t('Sound off'), muted ? <VolumeXIcon /> : <Volume2Icon />, () => video && (video.muted = !video.muted))}
      <Tooltip content={t('Playback speed')}>
        <Button
          size="sm"
          variant="ghost"
          className="w-14 tabular-nums"
          disabled={!ready}
          onClick={() => video && (video.playbackRate = rate === 1 ? 0.5 : 1)}
          aria-label={t('Playback speed: {{n}}×', { n: rate })}
        >
          {rate}×
        </Button>
      </Tooltip>
      {btn(t('Save frame as picture'), <CameraIcon />, saveFrame)}
      {btn(t('Full screen'), <MaximizeIcon />, fullScreen)}
      {onDownload && btn(t('Download this minute'), downloading ? <Spinner /> : <DownloadIcon />, onDownload, !!downloading)}
      <span className="ms-auto px-1 text-xs text-muted-foreground tabular-nums" aria-live="off">
        {clock ? formatDateTime(clock) : ''}
      </span>
    </div>
  );
}

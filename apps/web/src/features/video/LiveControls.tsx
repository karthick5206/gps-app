import { useMutation } from '@tanstack/react-query';
import type { VideoCaptureDto, VideoExtendDto, VideoSessionDto } from '@veetracer/shared';
import { CameraIcon, ClockIcon, FilmIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { useAuth } from '@/features/auth/auth-context';
import { api } from '@/lib/api';
import { videoErrorText } from './VideoPlayer';

/** mm:ss until `iso` (0 when past). */
function remaining(iso: string, now: number): string {
  const s = Math.max(0, Math.round((Date.parse(iso) - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * Controls under one live channel: Snapshot (photo), Record 10 s (RTMP / Jimi cameras) and, for cameras that stream
 * for a fixed time, a countdown with Extend. Photos and clips arrive in Video evidence as "Manual capture".
 */
export function LiveControls({ objectId, channel, session, compact }: { objectId: string; channel: number; session: VideoSessionDto | null; compact?: boolean }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const [endsAt, setEndsAt] = useState<string | null>(session?.streamEndsAt ?? null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => setEndsAt(session?.streamEndsAt ?? null), [session?.streamEndsAt]);
  useEffect(() => {
    if (!endsAt) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [endsAt]);

  const evidenceLink = (id: string) => (can('video_evidence') ? `/video-evidence?event=${id}` : can('driver_events') ? `/driver-events?event=${id}` : null);
  const capture = useMutation({
    mutationFn: (kind: 'photo' | 'video') => api.post<VideoCaptureDto>(`/video/${objectId}/capture`, { channel, kind, seconds: 10 }),
    onSuccess: (r, kind) => {
      const to = evidenceLink(r.eventId);
      toast.success(kind === 'photo' ? t('Photo requested from the dashcam') : t('10-second clip requested from the dashcam'), {
        description: t('It appears in Video evidence when the camera uploads it (usually within a minute).'),
        action: to ? { label: t('Open'), onClick: () => window.open(to, '_blank', 'noopener') } : undefined,
      });
    },
    onError: (e) => toast.error(videoErrorText(t, e)),
  });
  const extend = useMutation({
    mutationFn: () => api.post<VideoExtendDto>(`/video/${objectId}/extend`, { channel }),
    onSuccess: (r) => {
      setEndsAt(r.streamEndsAt);
      toast.success(t('Live video extended'));
    },
    onError: (e) => toast.error(videoErrorText(t, e)),
  });

  if (!session) return null;
  const rtmp = session.transport === 'rtmp';
  const left = endsAt ? Date.parse(endsAt) - now : null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Button size="sm" variant="outline" disabled={capture.isPending} onClick={() => capture.mutate('photo')} title={t('Take a photo with this camera')}>
        {capture.isPending && capture.variables === 'photo' ? <Spinner /> : <CameraIcon />} {!compact && t('Snapshot')}
      </Button>
      {rtmp && (
        <Button size="sm" variant="outline" disabled={capture.isPending} onClick={() => capture.mutate('video')} title={t('Record a 10-second clip')}>
          {capture.isPending && capture.variables === 'video' ? <Spinner /> : <FilmIcon />} {!compact && t('Record 10 s')}
        </Button>
      )}
      {rtmp && endsAt && (
        <span className={`ml-auto flex items-center gap-1 text-xs tabular-nums ${left !== null && left < 120_000 ? 'text-destructive' : 'text-muted-foreground'}`}>
          <ClockIcon className="size-3.5" aria-hidden />
          {left !== null && left > 0 ? t('Stops in {{time}}', { time: remaining(endsAt, now) }) : t('Stream time over')}
          <Button size="sm" variant="ghost" className="h-7 px-2" disabled={extend.isPending} onClick={() => extend.mutate()}>
            {extend.isPending ? <Spinner /> : null} {t('Extend')}
          </Button>
        </span>
      )}
    </div>
  );
}

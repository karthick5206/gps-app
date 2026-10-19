import type { VideoSessionDto, VideoSessionStatusDto } from '@veetracer/shared';
import type { TFunction } from 'i18next';
import { AlertTriangleIcon, RotateCcwIcon, XIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { api, ApiError, errorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';

type Phase = 'starting' | 'connecting' | 'playing' | 'buffering' | 'error' | 'ended';

/** Translated text for the API's video error codes (the server message is the fallback). */
export function videoErrorText(t: TFunction, err: unknown): string {
  const code = err instanceof ApiError ? err.code : null;
  switch (code) {
    case 'DEVICE_OFFLINE':
      return t('The dashcam is offline. Video needs the device to be connected.');
    case 'NOT_DASHCAM':
      return t('This vehicle has no dashcam with video.');
    case 'STREAM_LIMIT':
      return t('Too many videos are playing right now. Close another video and try again.');
    case 'CODEC_UNSUPPORTED':
      return t('This camera sends H.265 video, which the browser cannot play. Set the dashcam to H.264.');
    case 'DEVICE_TIMEOUT':
      return t('The dashcam did not answer. Check that it is online and try again.');
    case 'DEVICE_REFUSED':
      return t('The dashcam refused the request.');
    case 'VIDEO_DISABLED':
      return t('Video is not enabled on the server.');
    default:
      return errorMessage(err);
  }
}

/**
 * One HTTP-FLV player (mpegts.js over MSE). `start` opens (or joins) a session; leaving the page or pressing stop
 * destroys the player and tells the API the viewer left.
 */
export function VideoPlayer({ start, label, onClose, className }: { start: () => Promise<VideoSessionDto>; label: string; onClose?: () => void; className?: string }) {
  const { t } = useTranslation();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [phase, setPhase] = useState<Phase>('starting');
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const startRef = useRef(start);
  startRef.current = start;

  useEffect(() => {
    let cancelled = false;
    let player: { destroy(): void; unload(): void; detachMediaElement(): void } | null = null;
    let sessionId: string | null = null;
    const video = videoRef.current;
    const fail = (message: string) => {
      if (cancelled) return;
      setError(message);
      setPhase('error');
    };
    setPhase('starting');
    setError(null);

    void (async () => {
      const { default: mpegts } = await import('mpegts.js');
      if (cancelled) return;
      if (!mpegts.isSupported() || !mpegts.getFeatureList().mseLivePlayback) {
        fail(t('This browser cannot play live video. Use Chrome, Edge or Firefox on a computer or Android.'));
        return;
      }
      let session: VideoSessionDto;
      try {
        session = await startRef.current();
      } catch (err) {
        fail(videoErrorText(t, err));
        return;
      }
      // Unmounted meanwhile: no viewer ever connected, so the server's idle timeout (30 s) closes it — an immediate
      // leave could close a stream another tile just joined.
      if (cancelled || !video) return;
      sessionId = session.sessionId;
      setPhase('connecting');
      const p = mpegts.createPlayer(
        { type: 'flv', isLive: true, url: new URL(session.url, window.location.origin).toString(), hasAudio: false, hasVideo: true },
        { enableStashBuffer: false, liveBufferLatencyChasing: true, liveBufferLatencyMaxLatency: 3, liveBufferLatencyMinRemain: 0.5, lazyLoad: false },
      );
      player = p;
      p.on(mpegts.Events.ERROR, () => {
        // Ask why (H.265 or the stream ended) for a precise message.
        api
          .get<VideoSessionStatusDto>(`/video/sessions/${session.sessionId}`)
          .then((s) => fail(s.codec === 'h265' ? videoErrorText(t, new ApiError(415, [], 'CODEC_UNSUPPORTED')) : s.state === 'closed' ? t('The video stream ended.') : t('The video connection was lost.')))
          .catch(() => fail(t('The video connection was lost.')));
      });
      p.on(mpegts.Events.LOADING_COMPLETE, () => !cancelled && setPhase('ended'));
      p.attachMediaElement(video);
      p.load();
      void Promise.resolve(p.play()).catch(() => undefined);
    })();

    const onPlaying = () => setPhase('playing');
    const onWaiting = () => setPhase((ph) => (ph === 'playing' ? 'buffering' : ph));
    video?.addEventListener('playing', onPlaying);
    video?.addEventListener('waiting', onWaiting);
    return () => {
      cancelled = true;
      video?.removeEventListener('playing', onPlaying);
      video?.removeEventListener('waiting', onWaiting);
      if (player) {
        try {
          player.unload();
          player.detachMediaElement();
          player.destroy();
        } catch {
          // already torn down
        }
      }
      // Leave after the player closed its connection, so the gateway sees no viewers left.
      if (sessionId && player) {
        const id = sessionId;
        setTimeout(() => void api.delete(`/video/sessions/${id}`).catch(() => undefined), 300);
      }
    };
  }, [attempt, t]);

  const overlay =
    phase === 'starting' ? t('Asking the dashcam to start video…') : phase === 'connecting' ? t('Connecting…') : phase === 'buffering' ? t('Buffering…') : null;

  return (
    <div className={cn('relative overflow-hidden rounded-lg bg-black', className)}>
      <video ref={videoRef} className="aspect-video w-full bg-black object-contain" muted playsInline controls={phase === 'playing'} aria-label={label} />
      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center justify-between gap-2 bg-gradient-to-b from-black/70 to-transparent px-2 py-1.5 text-xs text-white">
        <span className="truncate font-medium">{label}</span>
        {phase === 'playing' && <span className="rounded bg-red-600 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide">LIVE</span>}
      </div>
      {onClose && (
        <Button size="icon-sm" variant="ghost" className="absolute right-1 bottom-1 text-white hover:bg-white/20 hover:text-white" onClick={onClose} aria-label={t('Stop video')}>
          <XIcon />
        </Button>
      )}
      {overlay && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm text-white/90" role="status">
          <Spinner />
          {overlay}
        </div>
      )}
      {phase === 'error' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/80 p-4 text-center text-sm text-white" role="alert">
          <AlertTriangleIcon className="size-6 text-amber-400" />
          <p className="max-w-xs">{error}</p>
          <Button size="sm" variant="secondary" onClick={() => setAttempt((a) => a + 1)}>
            <RotateCcwIcon /> {t('Try again')}
          </Button>
        </div>
      )}
      {phase === 'ended' && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/70 text-sm text-white" role="status">
          {t('The video stream ended.')}
        </div>
      )}
    </div>
  );
}

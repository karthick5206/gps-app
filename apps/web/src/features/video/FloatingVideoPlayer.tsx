import { ChevronDownIcon, ChevronUpIcon, Maximize2Icon, XIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { floatingVideo, useFloatingVideo } from './floating-video-store';
import { LiveChannels } from './VideoPanel';

/**
 * Picture-in-picture live player (bottom right), mounted once in the app shell. It keeps streaming while the user
 * moves around the map and other pages; minimise hides the pictures (and stops the streams), close ends it.
 */
export function FloatingVideoPlayer() {
  const { t } = useTranslation();
  const v = useFloatingVideo();
  const [minimised, setMinimised] = useState(false);
  if (!v) return null;
  return (
    <aside
      className={cn('fixed right-3 bottom-3 z-50 flex w-[min(26rem,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-xl border bg-background shadow-2xl', !minimised && 'max-h-[85vh]')}
      aria-label={t('Live video: {{vehicle}}', { vehicle: v.vehicle })}
    >
      <header className="flex items-center gap-1 border-b bg-muted/60 px-3 py-1.5">
        <span className="size-2 shrink-0 animate-pulse rounded-full bg-destructive" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{v.vehicle}</span>
        <Button size="icon-sm" variant="ghost" asChild title={t('Open on the Video page')}>
          <Link to={`/video?objectId=${encodeURIComponent(v.objectId)}`} aria-label={t('Open on the Video page')}>
            <Maximize2Icon />
          </Link>
        </Button>
        <Button size="icon-sm" variant="ghost" onClick={() => setMinimised((m) => !m)} aria-label={minimised ? t('Show video') : t('Minimise')}>
          {minimised ? <ChevronUpIcon /> : <ChevronDownIcon />}
        </Button>
        <Button size="icon-sm" variant="ghost" onClick={() => floatingVideo.close()} aria-label={t('Close video')}>
          <XIcon />
        </Button>
      </header>
      {!minimised && (
        <div className="min-h-0 overflow-y-auto p-2">
          <LiveChannels
            key={v.objectId}
            objectId={v.objectId}
            vehicle={v.vehicle}
            channels={v.channels}
            selected={v.selected}
            onSelect={(s) => floatingVideo.select(s)}
            playing={{ channels: v.selected, stream: 'sub' }}
            compact
          />
        </div>
      )}
    </aside>
  );
}

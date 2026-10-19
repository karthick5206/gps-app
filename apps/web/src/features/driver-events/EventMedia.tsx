import type { DriverEventDto, DriverEventMediaDto } from '@veetracer/shared';
import { CameraOffIcon, ChevronLeftIcon, ChevronRightIcon, DownloadIcon, FilmIcon, ImageIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';

/** Cabin / road snapshot thumbnail of an event (placeholder when there is no photo yet). */
export function EventThumbnail({ event, className }: { event: Pick<DriverEventDto, 'thumbnailUrl' | 'media'>; className?: string }) {
  const { t } = useTranslation();
  const [failed, setFailed] = useState(false);
  const photos = event.media.filter((m) => m.kind === 'PHOTO').length;
  return (
    <div className={cn('relative flex items-center justify-center overflow-hidden bg-muted text-muted-foreground', className)}>
      {event.thumbnailUrl && !failed ? (
        <img src={event.thumbnailUrl} alt={t('Snapshot')} loading="lazy" className="size-full object-cover" onError={() => setFailed(true)} />
      ) : (
        <span className="flex flex-col items-center gap-1 text-xs">
          <CameraOffIcon className="size-5" aria-hidden />
          {t('No snapshot')}
        </span>
      )}
      {photos > 1 && (
        <span className="absolute right-1.5 bottom-1.5 flex items-center gap-1 rounded bg-black/60 px-1.5 py-0.5 text-[11px] text-white">
          <ImageIcon className="size-3" aria-hidden /> {photos}
        </span>
      )}
    </div>
  );
}

/** Photos (click → lightbox) and clips of an event. */
export function EventGallery({ media }: { media: DriverEventMediaDto[] }) {
  const { t } = useTranslation();
  const photos = media.filter((m) => m.kind === 'PHOTO');
  const clips = media.filter((m) => m.kind === 'VIDEO');
  const [open, setOpen] = useState<number | null>(null);
  if (!media.length) {
    return (
      <div className="flex h-40 flex-col items-center justify-center gap-2 rounded-lg border border-dashed text-sm text-muted-foreground">
        <CameraOffIcon className="size-6" aria-hidden />
        {t('No snapshot was received from the dashcam for this event.')}
      </div>
    );
  }
  const current = open === null ? null : photos[open];
  return (
    <div className="space-y-2">
      {photos.length > 0 && (
        <div className={cn('grid gap-2', photos.length > 1 && 'grid-cols-2')}>
          {photos.map((p, i) => (
            <button key={p.id} type="button" onClick={() => setOpen(i)} className={cn('group relative overflow-hidden rounded-lg border bg-black', i === 0 && photos.length > 2 && 'col-span-2')}>
              <img src={p.url} alt={t('Snapshot {{n}}', { n: i + 1 })} className="aspect-video w-full object-contain transition-transform group-hover:scale-[1.02]" />
              <span className="absolute bottom-1.5 left-1.5 rounded bg-black/60 px-1.5 py-0.5 text-[11px] text-white">
                {p.channel ? t('Camera {{n}}', { n: p.channel }) : p.source === 'SNAPSHOT' ? t('Snapshot') : t('Alarm photo')}
              </span>
            </button>
          ))}
        </div>
      )}
      {clips.map((c) =>
        c.playable ? (
          <video key={c.id} src={c.url} controls preload="metadata" className="aspect-video w-full rounded-lg border bg-black" />
        ) : (
          <a key={c.id} href={c.url} download className="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm hover:bg-accent">
            <FilmIcon className="size-4 text-muted-foreground" aria-hidden />
            <span className="flex-1">{t('Alarm clip (download, raw H.264)')}</span>
            <DownloadIcon className="size-4" aria-hidden />
          </a>
        ),
      )}
      <Dialog open={!!current} onOpenChange={(o) => !o && setOpen(null)}>
        <DialogContent className="max-w-5xl gap-2 bg-black p-2 sm:p-3">
          <DialogTitle className="sr-only">{t('Snapshot')}</DialogTitle>
          <DialogDescription className="px-1 text-xs text-white/70">
            {current ? `${current.channel ? t('Camera {{n}}', { n: current.channel }) : ''}${current.capturedAt ? ` · ${formatDateTime(current.capturedAt)}` : ''}` : ''}
          </DialogDescription>
          {current && <img src={current.url} alt={t('Snapshot')} className="max-h-[78vh] w-full object-contain" />}
          {photos.length > 1 && open !== null && (
            <div className="flex justify-between">
              <Button size="sm" variant="secondary" disabled={open === 0} onClick={() => setOpen(open - 1)}>
                <ChevronLeftIcon /> {t('Previous')}
              </Button>
              <Button size="sm" variant="secondary" disabled={open === photos.length - 1} onClick={() => setOpen(open + 1)}>
                {t('Next')} <ChevronRightIcon />
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

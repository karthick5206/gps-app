import { CameraIcon, MaximizeIcon, MinimizeIcon, TagIcon } from 'lucide-react';
import { useEffect, useState, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { savedAt, saveBlob, withHeader, type PictureCaption } from '@/lib/picture-header';
import { cn } from '@/lib/utils';

export type MapCaption = PictureCaption;
export { vehicleCaption } from '@/lib/picture-header';

/**
 * Map buttons shared by the Live map and History pages: save the map as a PNG, and full screen for the whole page
 * area (`fullscreen`), so the side panels come along. Styled like MapLibre's own control group.
 */
export function MapTools({
  snapshot,
  fileName,
  fullscreen,
  caption,
  labels,
  className,
}: {
  /** Marker label switch (Live map): registration numbers and person names on every marker. */
  labels?: { on: boolean; onToggle: () => void };
  snapshot: (() => Promise<Blob | null>) | null;
  fileName: () => string;
  fullscreen: RefObject<HTMLElement | null>;
  /** Details for the header band on the saved picture; none = the bare map. */
  caption?: () => MapCaption;
  className?: string;
}) {
  const { t } = useTranslation();
  const [full, setFull] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const on = () => setFull(!!document.fullscreenElement && document.fullscreenElement === fullscreen.current);
    document.addEventListener('fullscreenchange', on);
    return () => document.removeEventListener('fullscreenchange', on);
  }, [fullscreen]);
  const canFull = typeof document !== 'undefined' && !!document.documentElement.requestFullscreen;

  const shoot = async () => {
    if (!snapshot || busy) return;
    setBusy(true);
    try {
      const raw = await snapshot();
      if (!raw) throw new Error('empty');
      const blob = caption ? await withHeader(raw, caption(), t('Saved {{time}}', { time: savedAt() })).catch(() => raw) : raw;
      saveBlob(blob, fileName());
      toast.success(t('Map picture saved to your downloads'));
    } catch {
      toast.error(t('Could not take a picture of the map'));
    } finally {
      setBusy(false);
    }
  };
  const toggleFull = () => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    else void fullscreen.current?.requestFullscreen().catch(() => toast.error(t('Full screen is not available in this browser')));
  };

  const btn = 'flex size-[29px] items-center justify-center bg-white text-[#333] hover:bg-[#f2f2f2] disabled:opacity-50 dark:bg-card dark:text-foreground dark:hover:bg-muted';
  return (
    <div className={cn('pointer-events-auto flex flex-col overflow-hidden rounded-[4px] shadow-[0_0_0_2px_rgba(0,0,0,0.1)]', className)}>
      <button type="button" className={btn} onClick={() => void shoot()} disabled={!snapshot || busy} title={t('Save map picture')} aria-label={t('Save map picture')}>
        <CameraIcon className="size-4" />
      </button>
      {labels && (
        <button
          type="button"
          className={cn(btn, 'border-t border-black/10', labels.on && 'text-primary dark:text-primary')}
          onClick={labels.onToggle}
          aria-pressed={labels.on}
          title={labels.on ? t('Hide marker labels') : t('Show marker labels')}
          aria-label={labels.on ? t('Hide marker labels') : t('Show marker labels')}
        >
          <TagIcon className="size-4" />
        </button>
      )}
      {canFull && (
        <button type="button" className={cn(btn, 'border-t border-black/10')} onClick={toggleFull} aria-pressed={full} title={full ? t('Exit full screen') : t('Full screen')} aria-label={full ? t('Exit full screen') : t('Full screen')}>
          {full ? <MinimizeIcon className="size-4" /> : <MaximizeIcon className="size-4" />}
        </button>
      )}
    </div>
  );
}

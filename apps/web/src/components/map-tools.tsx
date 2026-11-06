import { CameraIcon, MaximizeIcon, MinimizeIcon } from 'lucide-react';
import { useEffect, useState, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

/** Saves a blob as a file in the browser's downloads. */
function save(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Map buttons shared by the Live map and History pages: save the map as a PNG, and full screen for the whole page
 * area (`fullscreen`), so the side panels come along. Styled like MapLibre's own control group.
 */
export function MapTools({ snapshot, fileName, fullscreen, className }: { snapshot: (() => Promise<Blob | null>) | null; fileName: () => string; fullscreen: RefObject<HTMLElement | null>; className?: string }) {
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
      const blob = await snapshot();
      if (!blob) throw new Error('empty');
      save(blob, fileName());
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
      {canFull && (
        <button type="button" className={cn(btn, 'border-t border-black/10')} onClick={toggleFull} aria-pressed={full} title={full ? t('Exit full screen') : t('Full screen')} aria-label={full ? t('Exit full screen') : t('Full screen')}>
          {full ? <MinimizeIcon className="size-4" /> : <MaximizeIcon className="size-4" />}
        </button>
      )}
    </div>
  );
}

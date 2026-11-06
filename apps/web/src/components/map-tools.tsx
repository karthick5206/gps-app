import { BRAND_COLORS } from '@veetracer/shared';
import { CameraIcon, MaximizeIcon, MinimizeIcon, TagIcon } from 'lucide-react';
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

/** Details printed in a band above the saved map picture. */
export interface MapCaption {
  /** Bold, after the brand: usually the company. */
  title: string;
  /** One line each: vehicle, period, distance… (empty lines are skipped). */
  lines: (string | null | undefined | false)[];
}

/** "Name · plate · driver" for the picture header. */
export function vehicleCaption(t: (k: string, o?: Record<string, unknown>) => string, o: { name: string; plateNumber: string | null; driverName?: string | null } | undefined, fallback: string): string {
  if (!o) return fallback;
  return [o.name, o.plateNumber && o.plateNumber !== o.name ? o.plateNumber : null, o.driverName ? t('Driver: {{name}}', { name: o.driverName }) : null].filter(Boolean).join('  ·  ');
}

/** Cuts `text` with an ellipsis so it fits `max` px in the current font. */
function fit(ctx: CanvasRenderingContext2D, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > max) t = t.slice(0, -1);
  return `${t}…`;
}

/**
 * Adds a header band over the map picture: VeeTrax and the company on the first line, then the caption lines; on the
 * right when it was saved and the site it came from. Drawn at the screen's pixel ratio so text stays sharp.
 */
async function withHeader(blob: Blob, cap: MapCaption, saved: string): Promise<Blob> {
  const img = await createImageBitmap(blob);
  const s = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
  const lines = cap.lines.filter((l): l is string => !!l);
  const pad = 14 * s;
  const head = pad + 22 * s + lines.length * 19 * s + 10 * s;
  const accent = 3 * s;
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height + head + accent;
  const ctx = canvas.getContext('2d');
  if (!ctx) return blob;
  const brand = BRAND_COLORS.light.tile;
  const font = (px: number, weight = 400) => `${weight} ${px * s}px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif`;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, head);
  ctx.fillStyle = brand;
  ctx.fillRect(0, head, canvas.width, accent);
  ctx.textBaseline = 'alphabetic';

  // Right column: when and where from.
  ctx.font = font(12);
  ctx.textAlign = 'right';
  ctx.fillStyle = '#64748b';
  const right = canvas.width - pad;
  ctx.fillText(saved, right, pad + 15 * s);
  ctx.fillText(window.location.host, right, pad + 34 * s);
  const rightW = Math.max(ctx.measureText(saved).width, ctx.measureText(window.location.host).width) + 24 * s;
  const maxW = Math.max(80 * s, canvas.width - pad * 2 - rightW);

  // Left: brand · company, then the details.
  ctx.textAlign = 'left';
  let y = pad + 16 * s;
  ctx.font = font(16, 800);
  ctx.fillStyle = brand;
  ctx.fillText('VeeTrax', pad, y);
  const bw = ctx.measureText('VeeTrax').width;
  if (cap.title) {
    ctx.font = font(16, 700);
    ctx.fillStyle = '#0f172a';
    ctx.fillText(fit(ctx, `  |  ${cap.title}`, maxW - bw), pad + bw, y);
  }
  y += 6 * s;
  ctx.font = font(13);
  lines.forEach((line, i) => {
    y += 19 * s;
    ctx.fillStyle = i === 0 ? '#0f172a' : '#334155';
    ctx.font = font(13, i === 0 ? 600 : 400);
    ctx.fillText(fit(ctx, line, maxW), pad, y);
  });
  ctx.drawImage(img, 0, head + accent);
  img.close();
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b ?? blob), 'image/png'));
}

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
      const when = new Date().toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
      const blob = caption ? await withHeader(raw, caption(), t('Saved {{time}}', { time: when })).catch(() => raw) : raw;
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

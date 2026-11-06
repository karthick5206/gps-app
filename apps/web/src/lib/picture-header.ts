import { BRAND_COLORS } from '@veetracer/shared';

/*
 * Saved pictures (map and dashboard): a header band with VeeTrax, the company and the details of what was saved, and
 * when and where from. Shared by the map buttons and the dashboard download.
 */

/** Saves a blob as a file in the browser's downloads. */
export function saveBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Details printed in a band above a saved picture. */
export interface PictureCaption {
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
export async function withHeader(blob: Blob, cap: PictureCaption, saved: string): Promise<Blob> {
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

/** "7 Nov 2026, 10:42" in the viewer's locale, for "Saved …". */
export const savedAt = () => new Date().toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

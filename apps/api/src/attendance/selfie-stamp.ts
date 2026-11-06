import sharp from 'sharp';

export interface StampDetails {
  name: string;
  /** Company-local date and time, already formatted ("06 Nov 2026, 09:25"). */
  when: string;
  address: string | null;
  lat: number | null;
  lng: number | null;
}

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The lines of the stamp: who and when, where (address), and the coordinates. */
export function stampLines(d: StampDetails): string[] {
  const coords = d.lat !== null && d.lng !== null ? `${d.lat.toFixed(6)}, ${d.lng.toFixed(6)}` : 'Location not available';
  return [`${d.name} · ${d.when}`, ...(d.address ? [d.address] : []), coords];
}

/**
 * Burns the check-in details across the bottom of the photo, so they stay with it wherever it is shared. The photo is
 * turned upright first (phones store the camera's rotation separately) and saved as JPEG.
 */
export async function stampSelfie(photo: Buffer, d: StampDetails): Promise<Buffer> {
  const upright = await sharp(photo).rotate().jpeg({ quality: 90 }).toBuffer({ resolveWithObject: true });
  const width = upright.info.width;
  const pad = Math.round(width * 0.03);
  const size = Math.max(14, Math.round(width * 0.032));
  // Pango markup: text wraps at the width, so a long address takes two lines instead of running off the photo.
  const text = await sharp({
    text: {
      text: `<span foreground="white">${stampLines(d).map(escape).join('\n')}</span>`,
      // At 72 dpi a Pango point is a pixel.
      font: `Arial, sans bold ${size}`,
      width: width - pad * 2,
      dpi: 72,
      rgba: true,
      wrap: 'word',
    },
  })
    .png()
    .toBuffer({ resolveWithObject: true });
  const bandHeight = text.info.height + pad * 2;
  const band = await sharp({ create: { width, height: bandHeight, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0.62 } } })
    .composite([{ input: text.data, left: pad, top: pad }])
    .png()
    .toBuffer();
  return sharp(upright.data)
    .composite([{ input: band, left: 0, top: Math.max(0, upright.info.height - bandHeight) }])
    .jpeg({ quality: 88 })
    .toBuffer();
}

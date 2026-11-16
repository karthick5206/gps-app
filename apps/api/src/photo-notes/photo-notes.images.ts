import { PHOTO_NOTE_FULL_PX, PHOTO_NOTE_THUMB_PX } from '@veetracer/shared';
import sharp from 'sharp';
import { readExif, type ExifInfo } from './photo-notes.logic';

export interface EncodedPhoto {
  full: Buffer;
  thumb: Buffer;
  width: number;
  height: number;
  /** GPS / time read from the original's EXIF before it is stripped. */
  exif: ExifInfo;
}

/**
 * Re-encodes an upload: turned upright, at most 1920 px on the long side (never enlarged), JPEG on a white background,
 * plus a 320 px thumbnail. sharp writes no metadata unless asked, so EXIF (GPS, camera, owner) is stripped from both;
 * the GPS position and time are read from the original first. Also limits decoding to 50 megapixels (decompression bombs).
 */
export async function encodePhoto(input: Buffer, tzOffsetMin?: number): Promise<EncodedPhoto> {
  const src = sharp(input, { failOn: 'error', limitInputPixels: 50_000_000 });
  const meta = await src.metadata();
  const exif = readExif(meta.exif, tzOffsetMin);
  const upright = src.rotate().flatten({ background: '#ffffff' });
  const full = await upright
    .clone()
    .resize({ width: PHOTO_NOTE_FULL_PX, height: PHOTO_NOTE_FULL_PX, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });
  const thumb = await sharp(full.data).resize({ width: PHOTO_NOTE_THUMB_PX, height: PHOTO_NOTE_THUMB_PX, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 72 }).toBuffer();
  return { full: full.data, thumb, width: full.info.width, height: full.info.height, exif };
}

import { BadRequestException } from '@nestjs/common';
import { OBJECT_PHOTO_MAX_BYTES, OBJECT_PHOTO_MIME_TYPES, OBJECT_PHOTO_SIZE, OBJECT_PHOTO_THUMB_SIZE } from '@veetracer/shared';
import sharp from 'sharp';

export interface UploadedPhoto {
  buffer: Buffer;
  mimetype?: string;
}

type PhotoMime = (typeof OBJECT_PHOTO_MIME_TYPES)[number];

/** Magic bytes per accepted type: the declared type must match the content. */
const SIGNATURES: Record<PhotoMime, (b: Buffer) => boolean> = {
  'image/jpeg': (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/webp': (b) => b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP',
};

/** Phones send image/jpg now and then. */
const ALIASES: Record<string, PhotoMime> = { 'image/jpg': 'image/jpeg', 'image/pjpeg': 'image/jpeg' };

/** A decompression bomb (tiny file, huge canvas) is refused before it is decoded (40 megapixels is any phone camera). */
const MAX_INPUT_PIXELS = 40_000_000;

/** Checks size, declared type and magic bytes. Throws 400 with a user-facing message; returns the normalised type. */
export function validatePhoto(file: UploadedPhoto | undefined): PhotoMime {
  if (!file?.buffer?.length) throw new BadRequestException('Choose a photo to upload');
  if (file.buffer.length > OBJECT_PHOTO_MAX_BYTES) throw new BadRequestException('The photo is larger than 5 MB');
  const declared = (file.mimetype ?? '').toLowerCase().trim();
  const type = (ALIASES[declared] ?? declared) as PhotoMime;
  if (!OBJECT_PHOTO_MIME_TYPES.includes(type)) throw new BadRequestException('Upload a JPEG, PNG or WebP photo');
  if (!SIGNATURES[type](file.buffer)) throw new BadRequestException('The file content does not match its type');
  return type;
}

/** Round map-marker version of the 64 px thumbnail: the photo inside a circle of radius 25.5, transparent around it. */
export async function markerPng(thumb: Buffer): Promise<Buffer> {
  const size = OBJECT_PHOTO_THUMB_SIZE;
  const mask = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${size * 0.4}" fill="#fff"/></svg>`);
  return sharp(thumb).resize(size, size).ensureAlpha().composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();
}

export interface EncodedPhoto {
  /** 256 × 256 JPEG. */
  full: Buffer;
  /** 64 × 64 JPEG (map markers, lists). */
  thumb: Buffer;
}

/**
 * Re-encodes the photo: turned upright (the camera's EXIF orientation), centre-cropped to a square, saved as JPEG at
 * 256 px and 64 px. Sharp writes no metadata unless asked, so EXIF (GPS position, camera, time), ICC comments and XMP
 * are all dropped; only the pixels survive. An undecodable file is a 400.
 */
export async function encodePhoto(input: Buffer): Promise<EncodedPhoto> {
  try {
    const upright = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' })
      .rotate()
      .resize(OBJECT_PHOTO_SIZE, OBJECT_PHOTO_SIZE, { fit: 'cover', position: 'attention' })
      .flatten({ background: '#ffffff' })
      .toColourspace('srgb')
      .raw()
      .toBuffer({ resolveWithObject: true });
    const raw = { raw: { width: upright.info.width, height: upright.info.height, channels: upright.info.channels } };
    const [full, thumb] = await Promise.all([
      sharp(upright.data, raw).jpeg({ quality: 86, mozjpeg: true }).toBuffer(),
      sharp(upright.data, raw).resize(OBJECT_PHOTO_THUMB_SIZE, OBJECT_PHOTO_THUMB_SIZE).jpeg({ quality: 82, mozjpeg: true }).toBuffer(),
    ]);
    return { full, thumb };
  } catch {
    throw new BadRequestException('This photo could not be read. Try another one.');
  }
}

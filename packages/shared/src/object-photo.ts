import type { ObjectType } from './tracking';

/**
 * Person photos (avatars) of tracked objects: uploaded as JPEG / PNG / WebP up to 5 MB, re-encoded by the server to
 * square JPEGs (256 px, and a 64 px thumbnail for map markers) without any metadata (EXIF, GPS). Served only through the
 * authenticated GET /api/objects/:id/photo (web / mobile) and GET /api/tracker/v1/photo (the phone's own person).
 */
export const OBJECT_PHOTO_MAX_BYTES = 5 * 1024 * 1024;
export const OBJECT_PHOTO_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
/** Object types that may have a photo (vehicles keep their type icon). */
export const OBJECT_PHOTO_TYPES: readonly ObjectType[] = ['PERSON', 'PET', 'ASSET'];
/** Edge of the full photo and of the thumbnail (px). */
export const OBJECT_PHOTO_SIZE = 256;
export const OBJECT_PHOTO_THUMB_SIZE = 64;

/** full = 256 px JPEG, thumb = 64 px JPEG, marker = 64 px round PNG (transparent corners) for native map markers. */
export type ObjectPhotoSize = 'full' | 'thumb' | 'marker';

export const hasPhotoType = (type: ObjectType): boolean => OBJECT_PHOTO_TYPES.includes(type);

/** API path (below /api) of an object's photo; `version` makes each change a new URL, so caches never go stale. */
export function objectPhotoPath(objectId: string, version: number, size: ObjectPhotoSize = 'full'): string {
  return `/objects/${objectId}/photo?size=${size}&v=${version}`;
}

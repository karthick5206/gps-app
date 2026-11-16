import { randomUUID } from 'node:crypto';
import { mkdir, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { APP_ROOT } from '../config/env';
import type { EncodedPhoto } from './object-photo-image';

/** var/object-photos/<companyId>/<random>-256.jpg and -64.jpg: names carry no object id or person name. */
export const OBJECT_PHOTOS_DIR = join(APP_ROOT, 'var', 'object-photos');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PhotoPaths {
  photoPath: string;
  photoThumbPath: string;
}

export async function writePhotoFiles(companyId: string, photo: EncodedPhoto): Promise<PhotoPaths> {
  if (!UUID_RE.test(companyId)) throw new Error('Invalid company id');
  const dir = join(OBJECT_PHOTOS_DIR, companyId);
  await mkdir(dir, { recursive: true });
  const key = randomUUID();
  const paths = { photoPath: join(dir, `${key}-256.jpg`), photoThumbPath: join(dir, `${key}-64.jpg`) };
  await writeFile(paths.photoPath, photo.full);
  await writeFile(paths.photoThumbPath, photo.thumb);
  return paths;
}

/** Deletes photo files; a file already gone is fine. Paths are never logged (they belong to a person). */
export async function deletePhotoFiles(rows: { photoPath: string | null; photoThumbPath: string | null }[]): Promise<void> {
  const paths = rows.flatMap((r) => [r.photoPath, r.photoThumbPath]).filter((p): p is string => !!p);
  await Promise.all(paths.map((p) => unlink(p).catch(() => undefined)));
}

/** A purged company's whole photo folder (also catches files a crash left without a row). */
export async function deleteCompanyPhotoDir(companyId: string): Promise<void> {
  if (!UUID_RE.test(companyId)) return;
  await rm(join(OBJECT_PHOTOS_DIR, companyId.toLowerCase()), { recursive: true, force: true }).catch(() => undefined);
}

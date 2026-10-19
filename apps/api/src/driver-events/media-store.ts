import { randomUUID } from 'node:crypto';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, sep } from 'node:path';
import { APP_ROOT } from '../config/env';

/**
 * Driver event photos / clips live under var/driver-media/ (gateway and API share the app directory):
 *   incoming/<yyyy-mm-dd>/<uuid>.<ext>        written by the gateway, not yet linked
 *   <companyId>/<yyyy-mm>/<eventId>-<uuid>.<ext>   linked to a DriverEventMedia row (path stored relative)
 */
export const DRIVER_MEDIA_DIR = join(APP_ROOT, 'var', 'driver-media');
export const INCOMING = 'incoming';

/** Stream message (vt:driver-media) describing a file the gateway stored under incoming/. */
export interface DriverMediaMessage {
  path: string;
  uniqueId: string;
  source: 'SNAPSHOT' | 'ATTACHMENT';
  kind: 'PHOTO' | 'VIDEO';
  mime: string;
  size: number;
  channel: number | null;
  capturedAt: string | null;
  lat: number | null;
  lng: number | null;
  eventId: string | null;
  ref: string | null;
}

/** Pub/sub message (vt:snap:gw:<id>) asking a gateway to take a snapshot for a driver event. */
export interface SnapshotRequest {
  uniqueId: string;
  eventId: string;
  channel: number;
}

const EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'video/mp4': 'mp4',
  'video/h264': 'h264',
  'video/x-msvideo': 'avi',
};
export const mediaExt = (mime: string) => EXT[mime] ?? 'bin';

/** Absolute path of a stored relative path; throws for anything escaping the media directory. */
export function mediaPath(relative: string): string {
  const abs = normalize(join(DRIVER_MEDIA_DIR, relative));
  if (!abs.startsWith(DRIVER_MEDIA_DIR + sep)) throw new Error(`Invalid media path ${relative}`);
  return abs;
}

/** Writes a new file under incoming/; returns its relative path. */
export async function writeIncoming(data: Buffer, mime: string, now = new Date()): Promise<string> {
  const rel = [INCOMING, now.toISOString().slice(0, 10), `${randomUUID()}.${mediaExt(mime)}`].join('/');
  const abs = mediaPath(rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, data);
  return rel;
}

/** Moves an incoming file next to its event; returns the new relative path. */
export async function linkIncoming(rel: string, companyId: string, eventId: string, mime: string, at = new Date()): Promise<string> {
  const target = [companyId, at.toISOString().slice(0, 7), `${eventId}-${randomUUID().slice(0, 8)}.${mediaExt(mime)}`].join('/');
  const abs = mediaPath(target);
  await mkdir(dirname(abs), { recursive: true });
  await rename(mediaPath(rel), abs);
  return target;
}

export async function removeMedia(rel: string): Promise<void> {
  await unlink(mediaPath(rel)).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
}

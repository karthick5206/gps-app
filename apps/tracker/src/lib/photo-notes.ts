import * as ImagePicker from 'expo-image-picker';
import { Directory, File, Paths } from 'expo-file-system';
import * as Location from 'expo-location';
import { useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import { api, ApiError, NetworkError } from './api';
import { kvGet, kvSet } from './db';
import { PhotoNoteQueue, PhotoNoteSendError, type NewQueuedNote, type PhotoNoteQueueStorage, type QueuedNote, type QueuedPhoto } from './photo-note-queue';
import { getToken, store } from './state';
import { S, serverText } from './strings';

/**
 * This phone's photo-note queue (photo-note-queue.ts): the rows are one JSON value in the SQLite kv table (db.ts), the
 * photos are copied into <documents>/photo-notes-queue/<clientId>/. Drain triggers: right after a note is added, when
 * the app comes to the foreground, when the home screen is focused, and a timer at the next back-off step. Deleted on
 * sign-out / deactivation (control.ts). Never logs coordinates or file paths.
 */

const KV_KEY = 'photoNoteQueue';
const ROOT_NAME = 'photo-notes-queue';

function rootDir(): Directory {
  return new Directory(Paths.document, ROOT_NAME);
}

function noteDir(clientId: string): Directory {
  return new Directory(rootDir(), clientId);
}

const storage: PhotoNoteQueueStorage = {
  async read() {
    return kvGet<string | null>(KV_KEY, null);
  },
  async write(json) {
    kvSet(KV_KEY, json);
  },
  async removeFiles(clientId) {
    const d = noteDir(clientId);
    if (d.exists) d.delete();
  },
  async removeAll() {
    kvSet(KV_KEY, null);
    const d = rootDir();
    if (d.exists) d.delete();
  },
};

let deliveredListener: (() => void) | null = null;

export const photoNoteQueue = new PhotoNoteQueue({ storage, onDelivered: () => deliveredListener?.() });

/** Called after a queued note reached the server (the screen refreshes its list). */
export function onPhotoNoteDelivered(fn: (() => void) | null): void {
  deliveredListener = fn;
}

function extFor(mime: string): string {
  return mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
}

/**
 * iPhones shoot HEIC, which the server can't read: the picker is asked for JPEG (quality 0.8 re-encodes camera shots,
 * "compatible" representation converts library photos). Anything still HEIC / HEIF is refused here.
 */
export const PICKER_JPEG = { quality: 0.8, preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible } as const;

export function isUnsupportedPhoto(a: { uri: string; mimeType?: string | null; fileName?: string | null }): boolean {
  const name = `${a.mimeType ?? ''} ${a.fileName ?? ''} ${a.uri}`.toLowerCase();
  return /heic|heif/.test(name);
}

export function normaliseMime(mime: string | null | undefined): string {
  return mime === 'image/png' || mime === 'image/webp' ? mime : 'image/jpeg';
}

/** Copies the photos into the note's own folder (they must outlive the camera's cache). */
export async function persistPhotos(clientId: string, photos: { uri: string; mimeType: string }[]): Promise<QueuedPhoto[]> {
  const root = rootDir();
  if (!root.exists) root.create({ intermediates: true, idempotent: true });
  const dir = noteDir(clientId);
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  try {
    return await Promise.all(
      photos.map(async (p, i) => {
        const mimeType = normaliseMime(p.mimeType);
        const file = `${i}.${extFor(mimeType)}`;
        await new File(p.uri).copy(new File(dir, file), { overwrite: true });
        return { file, mimeType };
      }),
    );
  } catch (e) {
    if (dir.exists) dir.delete();
    throw e;
  }
}

export function discardPhotos(clientId: string): void {
  try {
    const d = noteDir(clientId);
    if (d.exists) d.delete();
  } catch {
    /* nothing to clean */
  }
}

export function queuedPhotoUri(clientId: string, photo: QueuedPhoto): string {
  return new File(noteDir(clientId), photo.file).uri;
}

const transport = {
  async send(item: QueuedNote) {
    const token = await getToken();
    if (!token) throw new PhotoNoteSendError(401, S.notSignedIn);
    const photos = item.photos.map((p) => {
      const f = new File(noteDir(item.clientId), p.file);
      if (!f.exists) throw new PhotoNoteSendError(400, S.photoNotePhotoMissing);
      return { uri: f.uri, mimeType: p.mimeType, name: p.file };
    });
    try {
      await api.sendPhotoNote(token, { ...item, photos });
    } catch (e) {
      if (e instanceof ApiError) throw new PhotoNoteSendError(e.status, serverText(e.message));
      if (e instanceof NetworkError) throw new PhotoNoteSendError(undefined, S.networkError);
      throw new PhotoNoteSendError(undefined, e instanceof Error ? e.message : String(e));
    }
  },
};

let loadedOwner: string | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let started = false;

function schedule() {
  if (timer) clearTimeout(timer);
  timer = null;
  const wait = photoNoteQueue.nextDueIn();
  if (wait === null || !loadedOwner) return;
  timer = setTimeout(() => {
    if (AppState.currentState === 'active') drainPhotoNotes();
  }, Math.max(1_000, wait));
}

/** Loads the queue of the signed-in phone (once) and sends what is due. Safe to call often (home screen focus). */
export async function startPhotoNotes(): Promise<void> {
  const owner = store.session()?.uniqueId ?? null;
  if (!owner || !(await getToken())) return;
  if (!started) {
    started = true;
    photoNoteQueue.subscribe(() => {
      if (!photoNoteQueue.snapshot().sending) schedule();
    });
    AppState.addEventListener('change', (s) => {
      if (s === 'active') drainPhotoNotes();
    });
  }
  if (loadedOwner !== owner) {
    await photoNoteQueue.load(owner);
    loadedOwner = owner;
  }
  drainPhotoNotes();
}

export function drainPhotoNotes(force = false): void {
  if (loadedOwner) void photoNoteQueue.drain(transport, force).catch(() => undefined);
}

/** Stores the note durably, then tries to send it at once. Throws when it could not be stored. */
export async function queuePhotoNote(input: NewQueuedNote): Promise<void> {
  await startPhotoNotes();
  if (!loadedOwner) throw new Error('not signed in');
  await photoNoteQueue.add(input);
  drainPhotoNotes();
}

export async function retryPhotoNote(clientId: string): Promise<void> {
  await photoNoteQueue.retry(clientId);
  drainPhotoNotes(true);
}

/** Sign-out / deactivation: queued notes and their photos leave the phone (privacy). */
export async function clearPhotoNotes(): Promise<void> {
  loadedOwner = null;
  if (timer) clearTimeout(timer);
  timer = null;
  await photoNoteQueue.clear().catch(() => undefined);
  // Also when nothing was loaded in this run (e.g. a sign-out right after the start).
  await storage.removeAll().catch(() => undefined);
}

export function usePhotoNoteQueue() {
  return useSyncExternalStore(
    (l) => photoNoteQueue.subscribe(l),
    () => photoNoteQueue.snapshot(),
  );
}

export type FixResult = { ok: true; lat: number; lng: number; accuracyM: number | null } | { ok: false; reason: 'denied' | 'unavailable' };

const FIX_TIMEOUT_MS = 20_000;
const LAST_KNOWN_MAX_AGE_MS = 2 * 60_000;

/** The phone's current position (a last-known one up to 2 minutes old when no fresh fix comes in time). Never logged. */
export async function currentFix(): Promise<FixResult> {
  let perm = await Location.getForegroundPermissionsAsync().catch(() => null);
  if (!perm?.granted) perm = await Location.requestForegroundPermissionsAsync().catch(() => null);
  if (!perm?.granted) return { ok: false, reason: 'denied' };
  const fresh = await Promise.race([
    Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }).catch(() => null),
    new Promise<null>((done) => setTimeout(() => done(null), FIX_TIMEOUT_MS)),
  ]);
  const pos = fresh ?? (await Location.getLastKnownPositionAsync({ maxAge: LAST_KNOWN_MAX_AGE_MS }).catch(() => null));
  if (!pos || !Number.isFinite(pos.coords.latitude) || !Number.isFinite(pos.coords.longitude)) return { ok: false, reason: 'unavailable' };
  const acc = pos.coords.accuracy;
  return { ok: true, lat: pos.coords.latitude, lng: pos.coords.longitude, accuracyM: acc !== null && Number.isFinite(acc) && acc > 0 ? acc : null };
}

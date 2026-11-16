import * as ImagePicker from 'expo-image-picker';
import { LocationManager } from '@maplibre/maplibre-react-native';
import { useQueryClient } from '@tanstack/react-query';
import { PHOTO_NOTE_FILE_FIELD, type PhotoNoteDto } from '@veetracer/shared';
import { Directory, File, Paths } from 'expo-file-system';
import { useEffect, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import { api, ApiError } from '@/lib/api';
import { i18n } from '@/lib/i18n';
import { PhotoNoteQueue, PhotoNoteSendError, type PhotoNoteQueueStorage, type PhotoNoteTransport, type QueuedNote, type QueuedPhoto } from './photo-note-queue';

/**
 * The app's photo-note queue (photo-note-queue.ts) on expo-file-system: the photos are copied into
 * <documents>/photo-notes-queue/<clientId>/ and the queue rows are one JSON file next to them (SecureStore is too small
 * for this). Drain triggers: right after a note is added, when the app comes to the foreground, when the screen is
 * focused, and a timer at the next back-off step. Cleared on sign-out (auth.tsx).
 */

export const PHOTO_NOTES_KEY = ['photo-notes'] as const;

const ROOT_NAME = 'photo-notes-queue';
const QUEUE_FILE = 'queue.json';

function rootDir(): Directory {
  return new Directory(Paths.document, ROOT_NAME);
}

function noteDir(clientId: string): Directory {
  return new Directory(rootDir(), clientId);
}

function ensureRoot(): Directory {
  const dir = rootDir();
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  return dir;
}

const fileStorage: PhotoNoteQueueStorage = {
  async read() {
    const f = new File(rootDir(), QUEUE_FILE);
    return f.exists ? f.text() : null;
  },
  async write(json) {
    const dir = ensureRoot();
    // Write a temporary file, then move it over the queue: a crash mid-write never leaves a half queue.
    const tmp = new File(dir, `${QUEUE_FILE}.tmp`);
    await tmp.write(json);
    await tmp.move(new File(dir, QUEUE_FILE), { overwrite: true });
  },
  async removeFiles(clientId) {
    const d = noteDir(clientId);
    if (d.exists) d.delete();
  },
  async removeAll() {
    const d = rootDir();
    if (d.exists) d.delete();
  },
};

let onDelivered: (note: string) => void = () => {};

export const photoNoteQueue = new PhotoNoteQueue({ storage: fileStorage, onDelivered: (id) => onDelivered(id) });

function extFor(mime: string): string {
  return mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
}

/** The picker gives JPEG for camera shots / compressed picks; anything else the server does not take is sent as JPEG. */
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

/** Copies the picked photos into the note's own folder (they must outlive the picker's cache). */
export async function persistPhotos(clientId: string, photos: { uri: string; mimeType?: string | null }[]): Promise<QueuedPhoto[]> {
  ensureRoot();
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

/** Local uri of a queued photo (for the pending list). */
export function queuedPhotoUri(clientId: string, photo: QueuedPhoto): string {
  return new File(noteDir(clientId), photo.file).uri;
}

/** Deletes the folder of a note that was never queued (save failed after the copy). */
export function discardPhotos(clientId: string): void {
  try {
    const d = noteDir(clientId);
    if (d.exists) d.delete();
  } catch {
    /* nothing to clean */
  }
}

export const photoNoteTransport: PhotoNoteTransport = {
  async send(item: QueuedNote) {
    const form = new FormData();
    for (const p of item.photos) {
      const f = new File(noteDir(item.clientId), p.file);
      if (!f.exists) throw new PhotoNoteSendError(400, i18n.t('A photo of this note is no longer on the phone.'));
      form.append(PHOTO_NOTE_FILE_FIELD, { uri: f.uri, name: p.file, type: p.mimeType } as unknown as Blob);
    }
    form.append('clientId', item.clientId);
    form.append('takenAt', item.takenAt);
    form.append('lat', String(item.lat));
    form.append('lng', String(item.lng));
    if (item.accuracyM !== null) form.append('accuracyM', String(Math.round(item.accuracyM)));
    form.append('category', item.category);
    if (item.note) form.append('note', item.note);
    if (item.amountMinor !== null) form.append('amountMinor', String(item.amountMinor));
    if (item.currency) form.append('currency', item.currency);
    form.append('source', 'MOBILE');
    try {
      await api.upload<PhotoNoteDto>('/photo-notes', form);
    } catch (e) {
      if (e instanceof ApiError) throw new PhotoNoteSendError(e.status, e.message);
      throw new PhotoNoteSendError(undefined, e instanceof Error ? e.message : String(e));
    }
  },
};

let loaded: string | null = null;

function drain(force = false) {
  if (loaded) void photoNoteQueue.drain(photoNoteTransport, force).catch(() => undefined);
}

/** Stores the note durably, then tries to send it at once. */
export async function queuePhotoNote(input: Parameters<PhotoNoteQueue['add']>[0]): Promise<void> {
  await photoNoteQueue.add(input);
  drain();
}

/** "Try again" on one note (also a FAILED one). */
export async function retryPhotoNote(clientId: string): Promise<void> {
  await photoNoteQueue.retry(clientId);
  drain(true);
}

/** Screen focus: send what is due. */
export function drainPhotoNotes(): void {
  drain();
}

/** Sign-out: queued notes and their photos are deleted from the phone (privacy). */
export function clearPhotoNoteQueue(): void {
  loaded = null;
  void photoNoteQueue.clear().catch(() => undefined);
}

export function usePhotoNoteQueue() {
  return useSyncExternalStore(
    (l) => photoNoteQueue.subscribe(l),
    () => photoNoteQueue.snapshot(),
  );
}

/**
 * Loads the queue of the signed-in user (null = signed out / no photo-note rights: unload; the rows stay for that
 * user's next sign-in unless sign-out cleared them) and runs the drain triggers.
 */
export function usePhotoNoteQueueLifecycle(userId: string | null) {
  const qc = useQueryClient();
  useEffect(() => {
    onDelivered = () => void qc.invalidateQueries({ queryKey: PHOTO_NOTES_KEY });
  }, [qc]);
  useEffect(() => {
    if (!userId) {
      loaded = null;
      photoNoteQueue.unload();
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // A timer at the next back-off step (re-armed on every queue change).
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      const wait = photoNoteQueue.nextDueIn();
      if (wait === null || cancelled) return;
      timer = setTimeout(() => {
        if (AppState.currentState === 'active') drain();
      }, Math.max(1_000, wait));
    };
    const unsubscribe = photoNoteQueue.subscribe(() => {
      if (!photoNoteQueue.snapshot().sending) schedule();
    });
    photoNoteQueue
      .load(userId)
      .then(() => {
        if (cancelled) return;
        loaded = userId;
        drain();
      })
      .catch(() => undefined);
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') drain();
    });
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      unsubscribe();
      sub.remove();
    };
  }, [userId]);
}

export type FixResult = { ok: true; lat: number; lng: number; accuracyM: number | null } | { ok: false; reason: 'denied' | 'unavailable' };

const FIX_TIMEOUT_MS = 20_000;
/** A position older than this is not where the photo is being taken. */
const FIX_MAX_AGE_MS = 2 * 60_000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([p, new Promise<undefined>((done) => setTimeout(() => done(undefined), ms))]);
}

type Position = NonNullable<Awaited<ReturnType<typeof LocationManager.getCurrentPosition>>>;

function fresh(p: Position | undefined): p is Position {
  return !!p && Number.isFinite(p.coords.latitude) && Number.isFinite(p.coords.longitude) && (!p.timestamp || Date.now() - p.timestamp <= FIX_MAX_AGE_MS);
}

/**
 * The phone's current position (MapLibre's location manager: the app has no expo-location). A stale last-known
 * position is not used: then it waits for the next update. Never logged.
 */
export async function currentFix(): Promise<FixResult> {
  let granted = false;
  try {
    granted = await LocationManager.requestPermissions();
  } catch {
    granted = false;
  }
  if (!granted) return { ok: false, reason: 'denied' };
  let pos = await withTimeout(LocationManager.getCurrentPosition().catch(() => undefined), FIX_TIMEOUT_MS);
  if (!fresh(pos)) {
    pos = await new Promise<Position | undefined>((resolve) => {
      const listener = (p: Position) => {
        if (!fresh(p)) return;
        clearTimeout(timer);
        LocationManager.removeListener(listener);
        resolve(p);
      };
      const timer = setTimeout(() => {
        LocationManager.removeListener(listener);
        resolve(undefined);
      }, FIX_TIMEOUT_MS);
      LocationManager.addListener(listener);
    });
  }
  if (!fresh(pos)) return { ok: false, reason: 'unavailable' };
  const acc = pos.coords.accuracy;
  return { ok: true, lat: pos.coords.latitude, lng: pos.coords.longitude, accuracyM: Number.isFinite(acc) && acc > 0 ? acc : null };
}

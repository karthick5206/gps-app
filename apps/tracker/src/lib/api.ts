/**
 * Typed client for the tracker API (docs/mobile-tracker/API.md): activation and /me. Plain fetch.
 * Position uploads are done by the native engine (modules/veetrax-tracker), not from JS.
 */

import * as Tracker from '../../modules/veetrax-tracker';

/** The build's address: only seeds a phone that has none stored yet (installs keep theirs; servers can move it). */
export const BUILD_SERVER_URL = (process.env.EXPO_PUBLIC_SERVER_URL || 'https://app.veetrax.com').replace(/\/+$/, '');

/**
 * The address in use. The native engine owns it (it can move to a new server address the server names, app 1.5.0+);
 * JS follows: once at start (syncServerUrl) and with every status read (noteServerUrl).
 */
let serverUrl = BUILD_SERVER_URL;
let serverReady: Promise<void> | null = null;

export function currentServerUrl(): string {
  return serverUrl;
}

export function noteServerUrl(url: string | null | undefined): void {
  if (url && /^https?:\/\//.test(url)) serverUrl = url.replace(/\/+$/, '');
}

/** Reads (and on a fresh install seeds) the native address; every request waits for it. */
export function syncServerUrl(): Promise<void> {
  serverReady ??= Tracker.initServerUrl(BUILD_SERVER_URL).then(noteServerUrl, () => undefined);
  return serverReady;
}

/** Demo server ("Demo account" on the activation screen); live is BUILD_SERVER_URL. */
export const DEMO_SERVER_URL = (process.env.EXPO_PUBLIC_DEMO_SERVER_URL || 'https://gps.mintplus.co.in').replace(/\/+$/, '');

/** Switches between the live and demo server. Only offered before activation (the token belongs to one server). */
export async function setDemoServer(demo: boolean): Promise<void> {
  await syncServerUrl();
  noteServerUrl(await Tracker.setServerUrl(demo ? DEMO_SERVER_URL : BUILD_SERVER_URL));
}

const apiBase = () => `${serverUrl}/api/tracker/v1`;

/** Image URL of a photo-note photo (send the Bearer token as a header). */
export function photoNotePhotoUrl(noteId: string, photoId: string, size: 'thumb' | 'full' = 'thumb'): string {
  return `${apiBase()}/photo-notes/${encodeURIComponent(noteId)}/photos/${encodeURIComponent(photoId)}?size=${size}`;
}

export interface TrackerConfig {
  intervalSec: number;
  stoppedIntervalSec: number;
  distanceM: number;
  maxAccuracyM: number;
  batchMax: number;
}

export const DEFAULT_CONFIG: TrackerConfig = { intervalSec: 10, stoppedIntervalSec: 60, distanceM: 10, maxAccuracyM: 100, batchMax: 100 };

/** sentTo: masked e-mail addresses the code went to (device admins + the device's activation e-mail). */
export interface ActivateRequestResponse { ok: true; mobile: string; smsSent: boolean; emailSent?: boolean; sentTo?: string[]; expiresInSec: number }
export interface MeResponse {
  uniqueId: string;
  objectName: string;
  companyName: string;
  config: TrackerConfig;
  /** "+91 98765 43210" */
  mobile?: string;
  email?: string | null;
  accountType?: 'BUSINESS' | 'INDIVIDUAL' | 'FAMILY' | null;
  trialEndsAt?: string | null;
  licenceEndsAt?: string | null;
}
export interface VerifyResponse extends MeResponse { token: string }
/** Registered number: its e-mail / name (only when this phone activated it before), else a masked e-mail hint. */
export interface LookupResponse { registered: boolean; samePhone: boolean; email: string | null; name: string | null; emailHint: string | null }
/** Attendance of the person this phone tracks. */
export interface PhoneAttendance {
  enabled: boolean;
  firstIn: string | null;
  state: 'INSIDE' | 'OUT' | 'NO_SIGNAL' | null;
  site: string | null;
  outings: { leftAt: string; returnedAt: string | null; minutes: number; site: string | null }[];
  selfieNeeded: boolean;
  selfieAt: string | null;
  /** What to record; older servers send nothing (a photo). */
  proof?: 'PHOTO' | 'VIDEO' | 'PHOTO_AND_VIDEO';
  videoNeeded?: boolean;
  videoAt?: string | null;
  shiftStartMin?: number;
  shiftEndMin?: number;
  /** Left the site for the day; older servers send nothing. */
  lastOut?: string | null;
  /** Minutes worked so far today; older servers send nothing. */
  workedMin?: number;
}

/** Location photo note (packages/shared/src/photo-notes.ts PhotoNoteDto; the fields this app shows). */
export type PhotoNoteCategory = 'BILL' | 'RECEIPT' | 'VISIT' | 'OTHER';
export const PHOTO_NOTE_CATEGORIES: readonly PhotoNoteCategory[] = ['BILL', 'RECEIPT', 'VISIT', 'OTHER'];
/** Categories that may carry an amount. */
export const PHOTO_NOTE_MONEY_CATEGORIES: readonly PhotoNoteCategory[] = ['BILL', 'RECEIPT'];
export const PHOTO_NOTE_MAX_PHOTOS = 5;
export const PHOTO_NOTE_NOTE_MAX = 1000;
export interface PhotoNote {
  id: string;
  takenAt: string;
  lat: number;
  lng: number;
  accuracyM: number | null;
  address: string | null;
  category: PhotoNoteCategory;
  note: string | null;
  amountMinor: number | null;
  currency: string | null;
  clientId: string | null;
  photos: { id: string; width: number; height: number }[];
  createdAt: string;
  canDelete?: boolean;
}
/** Text fields of the multipart create (photos go as `photos` file parts). */
export interface PhotoNoteUpload {
  clientId: string;
  takenAt: string;
  lat: number;
  lng: number;
  accuracyM: number | null;
  category: string;
  note: string | null;
  amountMinor: number | null;
  currency: string | null;
  photos: { uri: string; mimeType: string; name: string }[];
}

/** HTTP error from the server: status + message (+ code such as REVOKED / INVALID / INACTIVE). */
export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
    this.name = 'ApiError';
  }
}

/** The request never got an HTTP response (offline, DNS, timeout). */
export interface PhotoState {
  objectId: string;
  /** ms of the last change; null = no photo. */
  photoVersion: number | null;
}

export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkError';
  }
}

const TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 90_000;

async function request<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown, token?: string): Promise<T> {
  // Lets the server keep this phone's app version current (shown in Devices → Tracker app).
  const headers: Record<string, string> = { Accept: 'application/json', 'X-App-Version': APP_VERSION };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  await syncServerUrl();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${apiBase()}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: ctrl.signal });
  } catch (e) {
    throw new NetworkError(e instanceof Error ? e.message : String(e));
  } finally {
    clearTimeout(timer);
  }
  return parseResponse<T>(res.ok, res.status, await res.text().catch(() => ''));
}

function parseResponse<T>(ok: boolean, status: number, text: string): T {
  let json: unknown = undefined;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    // non-JSON body (e.g. a proxy error page)
  }
  if (!ok) {
    const obj = (json ?? {}) as { message?: unknown; code?: unknown };
    const msg = typeof obj.message === 'string' ? obj.message : Array.isArray(obj.message) ? obj.message.join(', ') : `HTTP ${status}`;
    throw new ApiError(status, msg, typeof obj.code === 'string' ? obj.code : undefined);
  }
  return json as T;
}

/** Sends a photo by file uri. Expo's fetch refuses that in FormData ("Unsupported FormDataPart implementation"); XMLHttpRequest takes it. */
async function uploadForm<T>(path: string, form: FormData, token: string): Promise<T> {
  await syncServerUrl();
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${apiBase()}${path}`);
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.timeout = UPLOAD_TIMEOUT_MS;
    xhr.onload = () => {
      try {
        resolve(parseResponse<T>(xhr.status >= 200 && xhr.status < 300, xhr.status, xhr.responseText));
      } catch (e) {
        reject(e);
      }
    };
    xhr.onerror = () => reject(new NetworkError('Could not send the photo. Check your internet connection.'));
    xhr.ontimeout = () => reject(new NetworkError('Sending the photo took too long. Try again.'));
    xhr.send(form);
  });
}

export const api = {
  requestCode: (mobile: string, email?: string, name?: string) => request<ActivateRequestResponse>('POST', '/activate/request', { mobile, email, name }),
  verify: (body: { mobile: string; code: string; deviceName: string; appVersion: string; platform: string; installId: string }) =>
    request<VerifyResponse>('POST', '/activate/verify', body),
  lookup: (mobile: string, installId: string) => request<LookupResponse>('POST', '/activate/lookup', { mobile, installId }),
  restore: (body: { installId: string; deviceName: string; appVersion: string; platform: string }) => request<VerifyResponse>('POST', '/activate/restore', body),
  me: (token: string) => request<MeResponse>('GET', '/me', undefined, token),
  attendance: (token: string) => request<PhoneAttendance>('GET', '/attendance', undefined, token),
  answerOuting: (token: string, body: { leftAt: string; kind: 'OFFICIAL' | 'PERSONAL'; note?: string }) => request<PhoneAttendance>('PUT', '/attendance/outing', body, token),
  sendSelfie: (token: string, photo: { uri: string; mimeType?: string | null }) => {
    const type = photo.mimeType || 'image/jpeg';
    const form = new FormData();
    form.append('file', { uri: photo.uri, type, name: `selfie.${type.split('/')[1] ?? 'jpg'}` } as unknown as Blob);
    return uploadForm<PhoneAttendance>('/attendance/selfie', form, token);
  },
  sendVideo: (token: string, video: { uri: string }) => {
    const form = new FormData();
    form.append('file', { uri: video.uri, type: 'video/mp4', name: 'checkin.mp4' } as unknown as Blob);
    return uploadForm<PhoneAttendance>('/attendance/video', form, token);
  },
  /** Profile photo of the person this phone tracks (404 when the phone is not linked to a person). */
  photoState: (token: string) => request<PhotoState>('GET', '/photo/state', undefined, token),
  sendPhoto: (token: string, photo: { uri: string; mimeType?: string | null }) => {
    const type = photo.mimeType || 'image/jpeg';
    const form = new FormData();
    form.append('file', { uri: photo.uri, type, name: `photo.${type.split('/')[1] ?? 'jpg'}` } as unknown as Blob);
    return uploadForm<PhotoState>('/photo', form, token);
  },
  removePhoto: (token: string) => request<PhotoState>('DELETE', '/photo', undefined, token),
  /** Image source for <Image>: the photo with the phone's token (no public URL exists). */
  photoSource: (token: string, version: number) => ({ uri: `${apiBase()}/photo?size=full&v=${version}`, headers: { Authorization: `Bearer ${token}` } }),
  /** Location photo note (multipart; idempotent by clientId: a resend returns the note already saved). */
  sendPhotoNote: (token: string, n: PhotoNoteUpload) => {
    const form = new FormData();
    for (const p of n.photos) form.append('photos', { uri: p.uri, type: p.mimeType, name: p.name } as unknown as Blob);
    form.append('clientId', n.clientId);
    form.append('takenAt', n.takenAt);
    form.append('lat', String(n.lat));
    form.append('lng', String(n.lng));
    if (n.accuracyM !== null) form.append('accuracyM', String(Math.round(n.accuracyM)));
    form.append('category', n.category);
    if (n.note) form.append('note', n.note);
    if (n.amountMinor !== null) form.append('amountMinor', String(n.amountMinor));
    if (n.currency) form.append('currency', n.currency);
    return uploadForm<PhotoNote>('/photo-notes', form, token);
  },
  /** This phone's person's recent photo notes (taken in this app). */
  photoNotes: (token: string, limit = 30) => request<{ items: PhotoNote[] }>('GET', `/photo-notes?limit=${limit}`, undefined, token),
  deletePhotoNote: (token: string, id: string) => request<{ ok: true }>('DELETE', `/photo-notes/${encodeURIComponent(id)}`, undefined, token),
  signOut: (token: string) => request<{ ok: true }>('POST', '/signout', undefined, token),
  diagnostics: (body: { appVersion: string; platform: string; device: string; nativeCrash: string | null; jsCrash: string | null }) =>
    request<{ ok: true }>('POST', '/diagnostics', body),
};import { APP_VERSION } from './device';


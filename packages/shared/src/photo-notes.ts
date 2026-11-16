/**
 * Location photo notes ("memory pins"): a photo (1–5) taken at a place with a note, a category and, for bills and
 * receipts, an amount. Uploaded from the Tracker app (the phone's own person), the VeeTrax mobile app and the web.
 * Visible to the person who took it and to users holding `photo_notes: view` within their data scope.
 *
 * Contract (all under /api):
 * - POST   /photo-notes                       multipart: `photos` (1–5 files) + the PhotoNoteCreateFields below
 * - GET    /photo-notes                       PhotoNoteListQuery → Paginated<PhotoNoteDto>  (`format=csv` = CSV export)
 * - GET    /photo-notes/:id                   PhotoNoteDto
 * - GET    /photo-notes/:id/photos/:photoId   ?size=thumb|full (default full) → image/jpeg (authenticated)
 * - PATCH  /photo-notes/:id                   PhotoNoteUpdateInput → PhotoNoteDto
 * - DELETE /photo-notes/:id                   soft delete → { ok: true }
 * - POST   /photo-notes/:id/expense           PhotoNoteToExpenseInput → PhotoNoteDto (BILL / RECEIPT only)
 * Tracker app (Bearer = tracker session token, the phone's own person):
 * - POST   /tracker/v1/photo-notes            multipart, same fields (lat / lng required; objectId ignored)
 * - GET    /tracker/v1/photo-notes            ?limit= → { items: PhotoNoteDto[] } (this person's Tracker-app notes)
 * - GET    /tracker/v1/photo-notes/:id/photos/:photoId?size=thumb|full
 * - DELETE /tracker/v1/photo-notes/:id
 */

export const PHOTO_NOTE_CATEGORIES = ['BILL', 'RECEIPT', 'VISIT', 'OTHER'] as const;
export type PhotoNoteCategory = (typeof PHOTO_NOTE_CATEGORIES)[number];

export const PHOTO_NOTE_CATEGORY_LABELS: Record<PhotoNoteCategory, string> = {
  BILL: 'Bill',
  RECEIPT: 'Receipt',
  VISIT: 'Visit',
  OTHER: 'Other',
};

/** Categories that may carry an amount (and can be sent to Fuel & expenses). */
export const PHOTO_NOTE_MONEY_CATEGORIES: readonly PhotoNoteCategory[] = ['BILL', 'RECEIPT'];

export const PHOTO_NOTE_SOURCES = ['TRACKER_APP', 'MOBILE', 'WEB'] as const;
export type PhotoNoteSource = (typeof PHOTO_NOTE_SOURCES)[number];

export const PHOTO_NOTE_SOURCE_LABELS: Record<PhotoNoteSource, string> = {
  TRACKER_APP: 'Tracker app',
  MOBILE: 'Mobile app',
  WEB: 'Web',
};

export const PHOTO_NOTE_MAX_PHOTOS = 5;
export const PHOTO_NOTE_MAX_BYTES = 10 * 1024 * 1024;
export const PHOTO_NOTE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const PHOTO_NOTE_NOTE_MAX = 1000;
/** Largest stored side of a photo and of its thumbnail (px). */
export const PHOTO_NOTE_FULL_PX = 1920;
export const PHOTO_NOTE_THUMB_PX = 320;
/** Multipart field name of the photo files. */
export const PHOTO_NOTE_FILE_FIELD = 'photos';

export interface PhotoNotePhotoDto {
  id: string;
  width: number;
  height: number;
}

export interface PhotoNoteDto {
  id: string;
  /** The person / tracked object the note belongs to (Tracker app: the phone's person). */
  objectId: string | null;
  objectName: string | null;
  /** Uploader login (null for Tracker-app notes). */
  userId: string | null;
  userName: string | null;
  takenAt: string;
  lat: number;
  lng: number;
  accuracyM: number | null;
  /** Reverse-geocoded when saved (null when the geocoder was not available). */
  address: string | null;
  category: PhotoNoteCategory;
  note: string | null;
  /** Minor units (paise for INR); BILL / RECEIPT only. */
  amountMinor: number | null;
  currency: string | null;
  source: PhotoNoteSource;
  clientId: string | null;
  photos: PhotoNotePhotoDto[];
  /** Expense created from this note ("Send to Fuel & expenses"). */
  expenseId: string | null;
  createdAt: string;
  updatedAt: string;
  /** The caller uploaded it. */
  mine: boolean;
  canEdit: boolean;
  canDelete: boolean;
}

/**
 * Text fields of the multipart create (all strings on the wire). `takenAt` defaults to the photo's EXIF time (web) or
 * now; web uploads without lat / lng use the photo's EXIF GPS, otherwise the request is refused.
 */
export interface PhotoNoteCreateFields {
  /** Idempotency key from the device (UUID): a repeat returns the note already saved. */
  clientId?: string;
  objectId?: string;
  takenAt?: string;
  lat?: number;
  lng?: number;
  accuracyM?: number;
  category: PhotoNoteCategory;
  note?: string;
  amountMinor?: number;
  currency?: string;
  /** MOBILE or WEB on /photo-notes (default WEB); the tracker route always stores TRACKER_APP. */
  source?: PhotoNoteSource;
}

export interface PhotoNoteListQuery {
  from?: string;
  to?: string;
  objectId?: string;
  category?: PhotoNoteCategory;
  /** minLng,minLat,maxLng,maxLat */
  bbox?: string;
  /** Search in the note and the address. */
  q?: string;
  /** '1' = only notes the caller uploaded. */
  mine?: string;
  page?: number;
  /** Up to 500 (the map view asks for many). */
  pageSize?: number;
}

export interface PhotoNoteUpdateInput {
  note?: string | null;
  category?: PhotoNoteCategory;
  amountMinor?: number | null;
  currency?: string | null;
}

export interface PhotoNoteToExpenseInput {
  /** Required when the note has no object (an expense always belongs to a vehicle / object). */
  objectId?: string;
  /** EXPENSE_KINDS; default OTHER. */
  kind?: string;
  vendor?: string;
}

/** Photo URL path (relative to the API base, without /api) for an authenticated fetch. */
export function photoNotePhotoPath(noteId: string, photoId: string, size: 'thumb' | 'full' = 'full'): string {
  return `/photo-notes/${noteId}/photos/${photoId}?size=${size}`;
}

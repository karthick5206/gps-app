import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatInr, type Paginated, type PhotoNoteCategory, type PhotoNoteDto, type PhotoNoteListQuery, type PhotoNoteToExpenseInput, type PhotoNoteUpdateInput } from '@veetracer/shared';
import { api, ApiError, type QueryParams } from '@/lib/api';

/** Every photo-note query starts with this key, so one invalidation refreshes the page, the map pins and the lightbox. */
export const PHOTO_NOTES_KEY = 'photo-notes';
/** Live map: notes of the last 24 hours. */
const RECENT_WINDOW_MS = 24 * 3600_000;
/** Largest page the API serves (map views ask for many). */
export const PHOTO_NOTE_MAP_PAGE = 500;

export function usePhotoNotes(query: PhotoNoteListQuery, enabled = true) {
  return useQuery({
    queryKey: [PHOTO_NOTES_KEY, 'list', query],
    queryFn: ({ signal }) => api.get<Paginated<PhotoNoteDto>>('/photo-notes', query as QueryParams, signal),
    enabled,
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  });
}

/** Live map layer: the last 24 hours (the window is worked out when fetching, so the key stays stable). */
export function useRecentPhotoNotes(enabled: boolean) {
  return useQuery({
    queryKey: [PHOTO_NOTES_KEY, 'recent'],
    queryFn: ({ signal }) =>
      api.get<Paginated<PhotoNoteDto>>('/photo-notes', { from: new Date(Date.now() - RECENT_WINDOW_MS).toISOString(), page: 1, pageSize: PHOTO_NOTE_MAP_PAGE }, signal),
    enabled,
    staleTime: 60_000,
    refetchInterval: enabled ? 120_000 : false,
  });
}

/** History map: one object's notes in the replayed period. */
export function useObjectPhotoNotes(objectId: string | null, from: Date, to: Date, enabled = true) {
  const fromIso = from.toISOString();
  const toIso = to.toISOString();
  return useQuery({
    queryKey: [PHOTO_NOTES_KEY, 'object', objectId, fromIso, toIso],
    queryFn: ({ signal }) => api.get<Paginated<PhotoNoteDto>>('/photo-notes', { objectId, from: fromIso, to: toIso, page: 1, pageSize: PHOTO_NOTE_MAP_PAGE }, signal),
    enabled: enabled && !!objectId,
    staleTime: 60_000,
  });
}

export interface PhotoNoteCreate {
  photos: File[];
  clientId: string;
  category: PhotoNoteCategory;
  objectId?: string | null;
  note?: string;
  amountMinor?: number | null;
  currency?: string;
  /** Omitted: the server reads the photo's EXIF GPS. */
  location?: { lat: number; lng: number; accuracyM?: number } | null;
  takenAt?: string;
}

export function useCreatePhotoNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: PhotoNoteCreate) => {
      const form = new FormData();
      form.append('clientId', input.clientId);
      form.append('category', input.category);
      form.append('source', 'WEB');
      if (input.objectId) form.append('objectId', input.objectId);
      if (input.note?.trim()) form.append('note', input.note.trim());
      if (input.amountMinor != null) {
        form.append('amountMinor', String(input.amountMinor));
        form.append('currency', input.currency ?? 'INR');
      }
      if (input.takenAt) form.append('takenAt', input.takenAt);
      if (input.location) {
        form.append('lat', String(input.location.lat));
        form.append('lng', String(input.location.lng));
        if (input.location.accuracyM != null) form.append('accuracyM', String(input.location.accuracyM));
      }
      for (const f of input.photos) form.append('photos', f, f.name);
      return api.upload<PhotoNoteDto>('/photo-notes', form);
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: [PHOTO_NOTES_KEY] }),
  });
}

export function useUpdatePhotoNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: PhotoNoteUpdateInput }) => api.patch<PhotoNoteDto>(`/photo-notes/${id}`, patch),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [PHOTO_NOTES_KEY] }),
  });
}

export function useDeletePhotoNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<{ ok: true }>(`/photo-notes/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [PHOTO_NOTES_KEY] }),
  });
}

export function usePhotoNoteToExpense() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: PhotoNoteToExpenseInput }) => api.post<PhotoNoteDto>(`/photo-notes/${id}/expense`, input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: [PHOTO_NOTES_KEY] });
      void qc.invalidateQueries({ queryKey: ['expenses'] });
    },
  });
}

/** A web upload without a location the server could use (no lat / lng sent and no GPS in the photo). */
export function isMissingLocationError(err: unknown): boolean {
  if (!(err instanceof ApiError) || err.status !== 400) return false;
  if (err.code && /LOCATION|GPS|EXIF/i.test(err.code)) return true;
  return err.messages.some((m) => /location|gps|exif|lat|lng|latitude|longitude/i.test(m));
}

/** "₹ 1,250.00" (INR) or "USD 12.00". */
export function formatAmount(amountMinor: number | null, currency: string | null): string | null {
  if (amountMinor == null) return null;
  const cur = (currency ?? 'INR').toUpperCase();
  const value = cur === 'INR' ? formatInr(amountMinor) : (amountMinor / 100).toFixed(2);
  return cur === 'INR' ? `₹ ${value}` : `${cur} ${value}`;
}

/** Rupees typed in a form → paise (null when blank / invalid). */
export function rupeesToMinor(text: string): number | null {
  const n = Number(text.replace(/,/g, '').trim());
  if (!text.trim() || !Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

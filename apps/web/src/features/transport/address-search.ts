/**
 * Address type-ahead (pure, `node --test`): the state rules behind AddressSearchCombobox. The search itself goes to the
 * API, which asks the self-hosted Photon geocoder; no external geocoder or map host is ever called from the browser.
 */

export interface AddressHit {
  label: string;
  lat: number;
  lng: number;
}

/** Desk / dispatcher search (etms_bookings), used by the booking, edit / set-location and group ride dialogs. */
export const BOOKING_GEOCODE_ENDPOINT = '/transport/bookings/geocode';
/** Passenger self-service search (etms_self), used by "My transport profile" and the passenger's own requests. */
export const ME_GEOCODE_ENDPOINT = '/me/transport/geocode';

export const ADDRESS_SEARCH_DEFAULTS = { minChars: 3, debounceMs: 350, maxResults: 6, staleMs: 5 * 60_000 } as const;

/** The query to send for what is typed: trimmed, whitespace collapsed, or null below the minimum length. */
export function searchTerm(text: string, minChars: number = ADDRESS_SEARCH_DEFAULTS.minChars): string | null {
  const q = text.trim().replace(/\s+/g, ' ');
  return q.length >= minChars ? q : null;
}

/** Next highlighted suggestion for ArrowDown (+1) / ArrowUp (-1); wraps; -1 means none (nothing to highlight). */
export function moveActive(current: number, count: number, step: 1 | -1): number {
  if (count <= 0) return -1;
  if (current < 0 || current >= count) return step === 1 ? 0 : count - 1;
  return (current + step + count) % count;
}

/** HTTP 429 from the API's per-user geocode limit (or Photon's, passed through). */
export function isRateLimited(err: unknown): boolean {
  return !!err && typeof err === 'object' && 'status' in err && (err as { status: unknown }).status === 429;
}

export type AddressSearchView = 'idle' | 'loading' | 'results' | 'empty' | 'rate-limited' | 'error';

/**
 * What the suggestion list shows. `typed` is the current term, `settled` the debounced one the data belongs to: while
 * they differ the user is still typing, so the list says "Searching…" instead of flashing an old "no match".
 */
export function addressSearchView(s: { typed: string | null; settled: string | null; fetching: boolean; error: unknown; hits: number }): AddressSearchView {
  if (!s.typed) return 'idle';
  if (s.error && s.typed === s.settled && !s.fetching) return isRateLimited(s.error) ? 'rate-limited' : 'error';
  if (s.typed !== s.settled || s.fetching) return s.hits > 0 && s.typed === s.settled ? 'results' : 'loading';
  return s.hits > 0 ? 'results' : 'empty';
}

/** Hits rounded to 6 decimals (about 0.1 m), the precision the booking and home inputs store. */
export function roundHit(h: AddressHit): AddressHit {
  return { label: h.label, lat: Number(h.lat.toFixed(6)), lng: Number(h.lng.toFixed(6)) };
}

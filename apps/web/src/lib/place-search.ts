/**
 * Map place search (pure, `node --test`): typed coordinates become a hit at once, before (and without) the API answer.
 * The search itself goes to the API (`/geocode/search` and the ETMS geocode routes), which asks the self-hosted Photon
 * instances only; no external geocoder or map host is ever called from the browser.
 */
import { formatCoordinates, parseCoordinates } from '@veetracer/shared';

export interface PlaceHit {
  label: string;
  lat: number;
  lng: number;
  /** The typed coordinates themselves (shown with a "Coordinates" tag). */
  coordinates?: boolean;
}

/** The point typed as coordinates ("12.97, 77.59", "12.97N 77.59E", DMS…), labelled with its formatted coordinates. */
export function coordinateHit(text: string): PlaceHit | null {
  const p = parseCoordinates(text.trim());
  return p ? { label: formatCoordinates(p.lat, p.lng), lat: p.lat, lng: p.lng, coordinates: true } : null;
}

const samePoint = (a: { lat: number; lng: number }, b: { lat: number; lng: number }): boolean => Math.abs(a.lat - b.lat) < 1e-6 && Math.abs(a.lng - b.lng) < 1e-6;

/**
 * The list to show for `text`: when it is coordinates, the coordinate hit comes first (labelled with the address the API
 * found for that point, once its answer is in) and the API's own copy of that point is not repeated.
 */
export function withCoordinateHit<T extends { label: string; lat: number; lng: number }>(text: string, hits: readonly T[] | undefined, max = 6): PlaceHit[] {
  const list = (hits ?? []).map((h) => ({ label: h.label, lat: h.lat, lng: h.lng }));
  const point = coordinateHit(text);
  if (!point) return list.slice(0, max);
  const same = list.find((h) => samePoint(h, point));
  return [{ ...point, label: same?.label ?? point.label }, ...list.filter((h) => !samePoint(h, point))].slice(0, max);
}

/** Whether `text` is worth a search: 3+ characters, or coordinates of any length. */
export function placeSearchReady(text: string, minChars = 3): boolean {
  const q = text.trim();
  return q.length >= minChars || coordinateHit(q) !== null;
}

/**
 * The bias point sent with a search (the map centre): longitude wrapped into [-180, 180) (MapLibre's centre goes past
 * ±180 after panning across the date line), both rounded to 4 decimals so small pans reuse the cached answer.
 */
export function biasPoint(center: { lat: number; lng: number } | null | undefined): { lat: number; lng: number } | null {
  if (!center || !Number.isFinite(center.lat) || !Number.isFinite(center.lng)) return null;
  const lng = ((((center.lng + 180) % 360) + 360) % 360) - 180;
  const r = (v: number) => Math.round(v * 1e4) / 1e4 + 0;
  return { lat: r(Math.max(-90, Math.min(90, center.lat))), lng: r(lng) };
}

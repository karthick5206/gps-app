/**
 * Corridor band geometry for the route map (pure, runs under node --test).
 * The corridor is drawn as a wide, translucent line under the road path whose width in pixels tracks a width in
 * metres at every zoom (MapLibre `line-width` interpolated exponentially with base 2, which is exact for Web Mercator).
 */

/** Earth circumference at the equator (m), Web Mercator. */
const EQUATOR_M = 40_075_016.686;
/** MapLibre tiles are 512 px. */
const TILE_PX = 512;
const MAX_ZOOM = 24;

/** Ground metres per screen pixel at `zoom` and latitude `lat` (degrees). */
export function metresPerPixel(zoom: number, lat: number): number {
  return (EQUATOR_M * Math.cos((lat * Math.PI) / 180)) / (TILE_PX * 2 ** zoom);
}

/**
 * `line-width` expression for a band `halfWidthM` metres either side of the line (the corridor value is a
 * half-width: a vehicle up to `corridorM` from the path is inside). Uses the latitude of the route's centre.
 */
export function corridorLineWidth(halfWidthM: number, lat: number): ['interpolate', ['exponential', number], ['zoom'], number, number, number, number] {
  const full = Math.max(0, halfWidthM) * 2;
  return ['interpolate', ['exponential', 2], ['zoom'], 0, full / metresPerPixel(0, lat), MAX_ZOOM, full / metresPerPixel(MAX_ZOOM, lat)];
}

/** Mean latitude of the points ([lng, lat]); 0 when empty. Good enough for a city / regional route. */
export function midLatitude(coords: [number, number][]): number {
  if (!coords.length) return 0;
  let min = Infinity;
  let max = -Infinity;
  for (const [, lat] of coords) {
    if (lat < min) min = lat;
    if (lat > max) max = lat;
  }
  return (min + max) / 2;
}

/** Bounds [[minLng, minLat], [maxLng, maxLat]] of the points, or null when empty. */
export function coordsBounds(coords: [number, number][]): [[number, number], [number, number]] | null {
  if (!coords.length) return null;
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;
  for (const [lng, lat] of coords) {
    minLng = Math.min(minLng, lng);
    maxLng = Math.max(maxLng, lng);
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
  }
  return [
    [minLng, minLat],
    [maxLng, maxLat],
  ];
}

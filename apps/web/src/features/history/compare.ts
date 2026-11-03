/**
 * History → compare: other vehicles' paths drawn over the selected one, each in its own colour. Pure (no DOM / React /
 * MapLibre) so it can be unit-tested with `node --test`.
 */
import { GAP_MS, type TrackIndex } from './playback-core.ts';

/** Vehicles that can be added to the selected one (one colour each, below). */
export const MAX_COMPARE = 4;

type Theme = 'light' | 'dark';

/** Index 0 is the selected vehicle. Picked to stay apart from each other on both basemaps. */
const COMPARE_COLORS: Record<Theme, readonly string[]> = {
  light: ['#2563eb', '#dc2626', '#059669', '#9333ea', '#d97706'],
  dark: ['#60a5fa', '#f87171', '#34d399', '#c084fc', '#fbbf24'],
};

/**
 * Line width at street zoom per added vehicle. Vehicles driving together share a road, so each line is narrower than
 * the one under it and all of them stay visible.
 */
const COMPARE_WIDTHS = [3.5, 2.5, 2, 1.5];

export function compareColor(theme: Theme, index: number): string {
  const colors = COMPARE_COLORS[theme];
  return colors[index % colors.length];
}

/** The `compare` URL parameter: comma-separated ids, without repeats or the selected vehicle, at most MAX_COMPARE. */
export function parseCompareIds(raw: string | null, primary: string | null): string[] {
  if (!raw) return [];
  const ids = raw.split(',').map((s) => s.trim()).filter((s) => s && s !== primary);
  return [...new Set(ids)].slice(0, MAX_COMPARE);
}

export interface CompareFeature {
  type: 'Feature';
  geometry: { type: 'LineString'; coordinates: [number, number][] };
  properties: { color: string; gap: boolean; w: number };
}

/** One added vehicle's path: a solid line per recorded stretch, a dashed one (`gap`) across each data gap. */
export function compareFeatures(idx: TrackIndex, color: string, order: number): CompareFeature[] {
  const out: CompareFeature[] = [];
  const properties = (gap: boolean) => ({ color, gap, w: COMPARE_WIDTHS[order] ?? COMPARE_WIDTHS[COMPARE_WIDTHS.length - 1] });
  const line = (coordinates: [number, number][], gap: boolean): CompareFeature => ({
    type: 'Feature',
    geometry: { type: 'LineString', coordinates },
    properties: properties(gap),
  });
  let stretch: [number, number][] = [];
  for (let i = 0; i < idx.n; i++) {
    const here: [number, number] = [idx.lng[i], idx.lat[i]];
    if (i > 0 && idx.t[i] - idx.t[i - 1] > GAP_MS) {
      if (stretch.length > 1) out.push(line(stretch, false));
      out.push(line([[idx.lng[i - 1], idx.lat[i - 1]], here], true));
      stretch = [];
    }
    stretch.push(here);
  }
  if (stretch.length > 1) out.push(line(stretch, false));
  return out;
}

/** Seconds inside the track with no data (the gaps drawn dashed). */
export function noDataSeconds(idx: TrackIndex): number {
  let ms = 0;
  for (let i = 1; i < idx.n; i++) {
    const d = idx.t[i] - idx.t[i - 1];
    if (d > GAP_MS) ms += d;
  }
  return ms / 1000;
}

/** The area holding all the tracks, null when none has a point. */
export function unionBounds(tracks: readonly (TrackIndex | null | undefined)[]): [[number, number], [number, number]] | null {
  let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
  for (const idx of tracks) {
    if (!idx) continue;
    for (let i = 0; i < idx.n; i++) {
      minLng = Math.min(minLng, idx.lng[i]);
      maxLng = Math.max(maxLng, idx.lng[i]);
      minLat = Math.min(minLat, idx.lat[i]);
      maxLat = Math.max(maxLat, idx.lat[i]);
    }
  }
  return Number.isFinite(minLng) ? [[minLng, minLat], [maxLng, maxLat]] : null;
}

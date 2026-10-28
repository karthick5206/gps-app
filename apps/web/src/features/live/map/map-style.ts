import { basemapStyle, MOVEMENT_STATUSES, OPENFREEMAP, STATUS_META } from '@veetracer/shared';
import type { ExpressionSpecification, StyleSpecification } from 'maplibre-gl';
import type { ResolvedTheme } from '@/features/theme/theme-store';
import { basemapStore } from './basemap-store';

export const SOURCE_ID = 'objects';
export const ARROW_IMAGE = 'vt-arrow';
/** Must exist on the basemap style's glyph server (OpenFreeMap / self-hosted OpenMapTiles fonts). */
export const LABEL_FONT = [import.meta.env.VITE_MAP_FONT || 'Noto Sans Bold'];

export const LAYERS = {
  clusters: 'objects-clusters',
  clusterCount: 'objects-cluster-count',
  selected: 'objects-selected',
  circle: 'objects-circle',
  arrow: 'objects-arrow',
  label: 'objects-label',
} as const;

/** Clustering switches on above this many visible points. */
export const CLUSTER_THRESHOLD = 500;
export const CLUSTER_MAX_ZOOM = 14;
export const LABEL_MIN_ZOOM = 13;

/**
 * Vector basemap styles. Defaults to OpenFreeMap (free, no API key, OpenMapTiles schema); point these at the
 * self-hosted Martin tile server once it is deployed.
 */
const STYLE_URLS = {
  standard: import.meta.env.VITE_MAP_STYLE_STANDARD || OPENFREEMAP.standard,
  light: import.meta.env.VITE_MAP_STYLE_LIGHT || OPENFREEMAP.light,
  dark: import.meta.env.VITE_MAP_STYLE_DARK || OPENFREEMAP.dark,
};

/** Basemap for the theme and the map type chosen in the switcher (see basemap-store). */
export function styleUrl(theme: ResolvedTheme): string | StyleSpecification {
  basemapStore.ensureConfig();
  return basemapStyle(basemapStore.type, theme, basemapStore.satellite, STYLE_URLS) as string | StyleSpecification;
}

/** Comparable key of a style, so maps re-style only when the basemap really changes. */
export function styleKey(style: string | StyleSpecification): string {
  return typeof style === 'string' ? style : JSON.stringify(style);
}

const OWN_LAYER_IDS = new Set<string>(Object.values(LAYERS));

/** Carries our object source and layers over when the basemap style changes with the theme. */
export function keepOwnLayers(previous: StyleSpecification | undefined, next: StyleSpecification): StyleSpecification {
  const ownSource = previous?.sources[SOURCE_ID];
  if (!previous || !ownSource) return next;
  return {
    ...next,
    sources: { ...next.sources, [SOURCE_ID]: ownSource },
    layers: [...next.layers, ...previous.layers.filter((l) => OWN_LAYER_IDS.has(l.id))],
  };
}

/** `match` expression mapping the feature's status to its STATUS_META colour for the theme. */
export function statusColorExpression(theme: ResolvedTheme): ExpressionSpecification {
  const pairs = MOVEMENT_STATUSES.flatMap((s) => [s, STATUS_META[s][theme]]);
  // The tuple type of `match` can't express a variadic label/output list; the shape is correct at runtime.
  return ['match', ['get', 'status'], ...pairs, STATUS_META.NO_DATA[theme]] as unknown as ExpressionSpecification;
}

/** Reads a design token (CSS variable) so map paint follows the same palette as the UI. */
export function cssToken(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** White chevron drawn once on a canvas and registered as an SDF icon so it can be tinted per status. */
export function createArrowImage(): { width: number; height: number; data: Uint8ClampedArray } {
  const size = 48;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D unavailable');
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.moveTo(size / 2, 6);
  ctx.lineTo(size - 10, size - 8);
  ctx.lineTo(size / 2, size - 18);
  ctx.lineTo(10, size - 8);
  ctx.closePath();
  ctx.fill();
  return { width: size, height: size, data: ctx.getImageData(0, 0, size, size).data };
}

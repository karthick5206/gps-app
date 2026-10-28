import type { BasemapType, MapsConfigDto } from './store-links';

/** OpenFreeMap (free, no key, OpenMapTiles schema): the styles behind the map type switcher. */
export const OPENFREEMAP = {
  standard: 'https://tiles.openfreemap.org/styles/liberty',
  light: 'https://tiles.openfreemap.org/styles/positron',
  dark: 'https://tiles.openfreemap.org/styles/dark',
  vector: 'https://tiles.openfreemap.org/planet',
  glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
} as const;

export interface BasemapUrls {
  standard: string;
  light: string;
  dark: string;
}

/**
 * Style for a map: a style URL, or (satellite) a style object of raster imagery with OSM road lines and names on
 * top, like a "hybrid" view. A dark UI theme uses the dark style except for satellite; satellite falls back to
 * standard when the server has no imagery configured.
 */
export function basemapStyle(
  type: BasemapType,
  theme: 'light' | 'dark',
  satellite: MapsConfigDto['satellite'],
  urls: BasemapUrls = OPENFREEMAP,
): string | Record<string, unknown> {
  if (type === 'satellite' && satellite) return satelliteStyle(satellite);
  if (theme === 'dark') return urls.dark;
  return type === 'light' ? urls.light : urls.standard;
}

const NAME = ['coalesce', ['get', 'name:en'], ['get', 'name:latin'], ['get', 'name']];
const LABEL_PAINT = { 'text-color': '#ffffff', 'text-halo-color': 'rgba(0,0,0,0.8)', 'text-halo-width': 1.6 };

function satelliteStyle(s: NonNullable<MapsConfigDto['satellite']>): Record<string, unknown> {
  return {
    version: 8,
    glyphs: OPENFREEMAP.glyphs,
    sources: {
      imagery: { type: 'raster', tiles: s.tiles, tileSize: 256, maxzoom: s.maxZoom, attribution: s.attribution },
      omt: { type: 'vector', url: OPENFREEMAP.vector, attribution: '© OpenStreetMap contributors' },
    },
    layers: [
      { id: 'sat-imagery', type: 'raster', source: 'imagery' },
      {
        id: 'sat-roads',
        type: 'line',
        source: 'omt',
        'source-layer': 'transportation',
        minzoom: 9,
        filter: ['in', ['get', 'class'], ['literal', ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor']]],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': ['match', ['get', 'class'], ['motorway', 'trunk'], '#ffd966', '#ffffff'],
          'line-opacity': ['interpolate', ['linear'], ['zoom'], 9, 0.25, 15, 0.45],
          'line-width': ['interpolate', ['linear'], ['zoom'], 9, 0.6, 16, 3],
        },
      },
      {
        id: 'sat-road-names',
        type: 'symbol',
        source: 'omt',
        'source-layer': 'transportation_name',
        minzoom: 13,
        layout: { 'text-field': NAME, 'text-font': ['Noto Sans Regular'], 'text-size': 11, 'symbol-placement': 'line' },
        paint: LABEL_PAINT,
      },
      {
        id: 'sat-places',
        type: 'symbol',
        source: 'omt',
        'source-layer': 'place',
        layout: {
          'text-field': NAME,
          'text-font': ['Noto Sans Bold'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 5, 11, 14, 15],
          'text-max-width': 8,
        },
        paint: LABEL_PAINT,
      },
    ],
  };
}

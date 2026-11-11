import type { BasemapType, MapsConfigDto } from './store-links';

/**
 * Road lines and names drawn over satellite imagery ("hybrid"): a glyph URL template and an OpenMapTiles-schema
 * vector tile URL template, both from our own tile server.
 */
export interface BasemapOverlay {
  glyphs: string;
  tiles: string;
}

/**
 * The style URLs behind the map type switcher. There is deliberately no built-in default: every app passes its own
 * configured (self-hosted) URLs, so a build without settings never falls back to an outside map host (G8).
 */
export interface BasemapUrls {
  standard: string;
  light: string;
  dark: string;
  /** Satellite overlay; derived from `standard` when it is a self-hosted style (see selfHostedSite). */
  overlay?: BasemapOverlay;
}

/**
 * The self-hosted map files under `<base>/tiles` (ops/deploy/linux/maps: Caddy serves styles, fonts and sprites,
 * Martin the India vector tiles). `base` is a site origin such as `https://app.veetrax.com`, or '' for same-origin.
 */
export function selfHostedStyles(base: string): Required<BasemapUrls> {
  const b = base.replace(/\/+$/, '');
  return {
    standard: `${b}/tiles/styles/liberty.json`,
    light: `${b}/tiles/styles/positron.json`,
    dark: `${b}/tiles/styles/dark.json`,
    overlay: { glyphs: `${b}/tiles/fonts/{fontstack}/{range}.pbf`, tiles: `${b}/tiles/india/{z}/{x}/{y}` },
  };
}

/** Site of a self-hosted style URL (`<site>/tiles/styles/<name>.json`), or null for any other URL. */
export function selfHostedSite(styleUrl: string): string | null {
  const m = /^(.*)\/tiles\/styles\/[^/?#]+$/.exec(styleUrl);
  return m ? m[1] : null;
}

/**
 * Style for a map: a style URL, or (satellite) a style object of raster imagery with OSM road lines and names on
 * top, like a "hybrid" view. A dark UI theme uses the dark style except for satellite; satellite falls back to
 * standard when the server has no imagery configured. The satellite overlay comes from `urls.overlay`, else from
 * the self-hosted server behind `urls.standard`; with neither, satellite shows the imagery alone.
 */
export function basemapStyle(
  type: BasemapType,
  theme: 'light' | 'dark',
  satellite: MapsConfigDto['satellite'],
  urls: BasemapUrls,
): string | Record<string, unknown> {
  if (type === 'satellite' && satellite) {
    const site = selfHostedSite(urls.standard);
    return satelliteStyle(satellite, urls.overlay ?? (site === null ? undefined : selfHostedStyles(site).overlay));
  }
  if (theme === 'dark') return urls.dark;
  return type === 'light' ? urls.light : urls.standard;
}

const NAME = ['coalesce', ['get', 'name:en'], ['get', 'name:latin'], ['get', 'name']];
const LABEL_PAINT = { 'text-color': '#ffffff', 'text-halo-color': 'rgba(0,0,0,0.8)', 'text-halo-width': 1.6 };

/** Satellite imagery (tiles from the server's MapsConfigDto), with our own road overlay when one is known. */
export function satelliteStyle(s: NonNullable<MapsConfigDto['satellite']>, overlay?: BasemapOverlay): Record<string, unknown> {
  const imagery = { type: 'raster', tiles: s.tiles, tileSize: 256, maxzoom: s.maxZoom, attribution: s.attribution };
  if (!overlay) return { version: 8, sources: { imagery }, layers: [{ id: 'sat-imagery', type: 'raster', source: 'imagery' }] };
  return {
    version: 8,
    glyphs: overlay.glyphs,
    sources: {
      imagery,
      omt: { type: 'vector', tiles: [overlay.tiles], minzoom: 0, maxzoom: 14, attribution: '© OpenStreetMap contributors' },
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

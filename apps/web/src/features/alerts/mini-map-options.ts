import type { MapOptions } from 'maplibre-gl';

/**
 * Map options of the alert MiniMap: a static snippet centred on the alert point ([lng, lat], GeoJSON order).
 * The attribution control stays on, compact (RR-08, OSM ODbL): the basemap is self-hosted, but its data is
 * OpenStreetMap, and the credit comes from the self-hosted style's own `attribution` (no outside link is added here).
 */
export function miniMapOptions(lng: number, lat: number, zoom: number): Partial<MapOptions> {
  return { center: [lng, lat], zoom, interactive: false, attributionControl: { compact: true } };
}

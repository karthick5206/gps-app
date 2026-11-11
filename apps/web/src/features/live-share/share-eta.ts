import type { FeatureCollection } from 'geojson';

/**
 * The delivery-ETA road line for the share page map. `route` comes from the API already in GeoJSON [lng, lat] order
 * (RoutingService.route → decodePolyline), so it is used as is. RR-14: the page used to swap the pair, which would
 * have drawn the road mirrored across the diagonal as soon as a routing engine was configured.
 */
export function etaRouteFeatures(route: readonly [number, number][] | null | undefined): FeatureCollection {
  if (!route || route.length < 2) return { type: 'FeatureCollection', features: [] };
  return { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: route.map(([lng, lat]) => [lng, lat]) } }] };
}

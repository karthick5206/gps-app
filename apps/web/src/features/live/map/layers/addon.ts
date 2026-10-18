import type { Map as MlMap } from 'maplibre-gl';
import { LAYERS } from '../map-style';

/** First vehicle-marker layer: add-on layers are inserted below it so markers stay on top. */
export function beneathMarkers(map: MlMap): string | undefined {
  return map.getLayer(LAYERS.clusters) ? LAYERS.clusters : undefined;
}

/**
 * Calls `ensure` whenever the style is (re)loaded. The live map swaps basemaps with a transformed style that only
 * carries the vehicle layers, so add-on layers must re-add themselves; `ensure` must be idempotent.
 */
export function keepAlive(map: MlMap, ensure: () => void): () => void {
  const run = () => {
    if (map.isStyleLoaded()) ensure();
  };
  map.on('styledata', run);
  map.on('load', run);
  run();
  return () => {
    map.off('styledata', run);
    map.off('load', run);
  };
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

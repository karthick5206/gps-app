import 'maplibre-gl/dist/maplibre-gl.css';
import maplibregl, { type Map as MlMap, type MapOptions } from 'maplibre-gl';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { basemapStore } from '@/features/live/map/basemap-store';
import { styleKey, styleUrl } from '@/features/live/map/map-style';
import { themeStore } from '@/features/theme/theme-store';

export const DEFAULT_CENTER: [number, number] = [80.24, 13.07];

/**
 * Creates a MapLibre map with the themed basemap (same OpenFreeMap styles as the live map) once per mount,
 * swaps the style when the theme changes (callers re-add their layers on `style.load`), and keeps it sized.
 * Returns null until created; `unsupported` when WebGL is unavailable.
 */
export function useBasemap(containerRef: RefObject<HTMLDivElement | null>, options: Partial<MapOptions> = {}) {
  const [map, setMap] = useState<MlMap | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const optionsRef = useRef(options);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let m: MlMap;
    try {
      m = new maplibregl.Map({
        container: el,
        style: styleUrl(themeStore.getResolved()),
        center: DEFAULT_CENTER,
        zoom: 11,
        attributionControl: { compact: true },
        fadeDuration: 0,
        ...optionsRef.current,
      });
    } catch {
      setUnsupported(true);
      return;
    }
    // Theme or map type changed: swap the basemap only when the resulting style differs.
    let key = styleKey(styleUrl(themeStore.getResolved()));
    const restyle = () => {
      const style = styleUrl(themeStore.getResolved());
      if (styleKey(style) === key) return;
      key = styleKey(style);
      m.setStyle(style, { diff: false });
    };
    const offTheme = themeStore.subscribe(restyle);
    const offBasemap = basemapStore.subscribe(restyle);
    const unsubscribe = () => {
      offTheme();
      offBasemap();
    };
    const ro = new ResizeObserver(() => m.resize());
    ro.observe(el);
    setMap(m);
    return () => {
      ro.disconnect();
      unsubscribe();
      m.remove();
      setMap(null);
    };
  }, [containerRef]);

  return { map, unsupported };
}

/** Runs `fn` now if the style is ready (else on load) and again after every basemap swap. Returns a disposer. */
export function onStyleReady(map: MlMap, fn: () => void): () => void {
  const handler = () => fn();
  map.on('style.load', handler);
  if (map.isStyleLoaded()) fn();
  else map.once('load', handler);
  return () => {
    map.off('style.load', handler);
    map.off('load', handler);
  };
}

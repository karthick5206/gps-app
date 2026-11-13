import maplibregl, { type GeoJSONSource } from 'maplibre-gl';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { circleRing } from '@/features/geofences/geometry';
import { onStyleReady, useBasemap } from '@/features/geofences/map/use-basemap';
import { cssToken } from '@/features/live/map/map-style';
import { cn } from '@/lib/utils';
import { prefersReducedMotion } from './passenger-ui';

const SRC = 'etms-home-approx';
/** A point rounded to 4 decimals is within about 11 m of the stored one (doc 02 §4.2). */
const APPROX_RADIUS_M = 11;

/**
 * Home / pickup pin on the self-hosted basemap (same `useBasemap` hook and style config as the route and POI editors;
 * no external map host). Click the map or drag the pin to move it. When the point is approximate (rounded by the server
 * for the caller's role), it is drawn read-only with an ~11 m circle instead of pretending to be exact.
 */
export function HomePinMap({
  position,
  onChange,
  readOnly = false,
  approximate = false,
  stop,
  className,
  texts,
}: {
  /** WP 3.9: other wording for reuse as a booking point picker (already translated). */
  texts?: { marker: string; empty: string; set: string; region: string };
  position: { lat: number; lng: number } | null;
  onChange: (p: { lat: number; lng: number }) => void;
  readOnly?: boolean;
  approximate?: boolean;
  /** The passenger's default pickup stop, shown as a second marker for context. */
  stop?: { lat: number; lng: number; name: string } | null;
  className?: string;
}) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const initial = useRef(position ?? stop ?? null);
  const { map, unsupported } = useBasemap(containerRef, initial.current ? { center: [initial.current.lng, initial.current.lat], zoom: 15 } : {});
  const markerRef = useRef<maplibregl.Marker | null>(null);
  const stopMarkerRef = useRef<maplibregl.Marker | null>(null);
  const cb = useRef({ onChange, readOnly });
  cb.current = { onChange, readOnly };

  useEffect(() => {
    if (!map) return;
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), 'bottom-right');
    map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
    const onClick = (e: maplibregl.MapMouseEvent) => {
      if (cb.current.readOnly) return;
      cb.current.onChange({ lat: Number(e.lngLat.lat.toFixed(6)), lng: Number(e.lngLat.lng.toFixed(6)) });
    };
    map.on('click', onClick);
    map.getCanvas().style.cursor = cb.current.readOnly ? '' : 'crosshair';
    return () => {
      map.off('click', onClick);
      markerRef.current?.remove();
      markerRef.current = null;
      stopMarkerRef.current?.remove();
      stopMarkerRef.current = null;
    };
  }, [map]);

  useEffect(() => {
    if (map) map.getCanvas().style.cursor = readOnly ? '' : 'crosshair';
  }, [map, readOnly]);

  // Home pin (recreated when draggability changes; MapLibre markers cannot toggle it in place reliably).
  useEffect(() => {
    if (!map) return;
    markerRef.current?.remove();
    markerRef.current = null;
    if (!position) return;
    const color = cssToken('--primary') || '#0e5e57';
    const m = new maplibregl.Marker({ color, draggable: !readOnly }).setLngLat([position.lng, position.lat]).addTo(map);
    m.getElement().setAttribute('aria-label', texts ? texts.marker : approximate ? t('Home location (approximate)') : t('Home location'));
    m.on('dragend', () => {
      const ll = m.getLngLat();
      cb.current.onChange({ lat: Number(ll.lat.toFixed(6)), lng: Number(ll.lng.toFixed(6)) });
    });
    markerRef.current = m;
  }, [map, position?.lat, position?.lng, readOnly, approximate, t, texts?.marker]); // eslint-disable-line react-hooks/exhaustive-deps

  // Pickup stop marker (context only).
  useEffect(() => {
    if (!map) return;
    stopMarkerRef.current?.remove();
    stopMarkerRef.current = null;
    if (!stop) return;
    const el = document.createElement('div');
    el.className = 'flex size-6 items-center justify-center rounded-full border-2 border-[var(--map-marker-stroke)] bg-info text-[10px] font-bold text-primary-foreground shadow-md';
    el.textContent = 'S';
    el.title = stop.name;
    el.setAttribute('aria-label', t('Pickup stop: {{name}}', { name: stop.name }));
    stopMarkerRef.current = new maplibregl.Marker({ element: el }).setLngLat([stop.lng, stop.lat]).addTo(map);
  }, [map, stop?.lat, stop?.lng, stop?.name, t]); // eslint-disable-line react-hooks/exhaustive-deps

  // Follow a typed / geocoded position when it leaves the viewport.
  useEffect(() => {
    if (!map || !position) return;
    if (!map.getBounds().contains([position.lng, position.lat])) {
      map.easeTo({ center: [position.lng, position.lat], zoom: Math.max(map.getZoom(), 15), duration: prefersReducedMotion() ? 0 : 400 });
    }
  }, [map, position?.lat, position?.lng]); // eslint-disable-line react-hooks/exhaustive-deps

  // Approximate circle.
  useEffect(() => {
    if (!map) return;
    const data: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features:
        position && approximate
          ? (() => {
              const ring = circleRing(position, APPROX_RADIUS_M);
              return [{ type: 'Feature' as const, geometry: { type: 'Polygon' as const, coordinates: [[...ring, ring[0]]] }, properties: {} }];
            })()
          : [],
    };
    return onStyleReady(map, () => {
      const src = map.getSource<GeoJSONSource>(SRC);
      if (src) {
        src.setData(data);
        return;
      }
      const primary = cssToken('--primary') || '#0e5e57';
      map.addSource(SRC, { type: 'geojson', data });
      map.addLayer({ id: `${SRC}-fill`, type: 'fill', source: SRC, paint: { 'fill-color': primary, 'fill-opacity': 0.15 } });
      map.addLayer({ id: `${SRC}-line`, type: 'line', source: SRC, paint: { 'line-color': primary, 'line-width': 1.5, 'line-dasharray': [2, 2] } });
    });
  }, [map, position?.lat, position?.lng, approximate]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className={cn('relative min-h-[260px] overflow-hidden rounded-lg border', className)}>
      <div ref={containerRef} className="h-full w-full" role="application" aria-label={texts ? texts.region : t('Home location map. Use the latitude and longitude fields to set the point with the keyboard.')} />
      {unsupported && (
        <div className="absolute inset-0 flex items-center justify-center bg-muted p-6 text-center text-sm text-muted-foreground">
          {t('The map needs WebGL. You can still type the latitude and longitude.')}
        </div>
      )}
      {!unsupported && (
        <div className="pointer-events-none absolute inset-x-2 top-2 z-10 flex justify-center">
          <span className="rounded-md border bg-card/95 px-2 py-1 text-xs text-muted-foreground shadow-sm backdrop-blur">
            {readOnly
              ? approximate
                ? t('Approximate location (within about 11 m).')
                : t('Read only')
              : position
                ? (texts?.set ?? t('Click the map or drag the pin to move it.'))
                : (texts?.empty ?? t('Click the map to place the home pin.'))}
          </span>
        </div>
      )}
    </div>
  );
}

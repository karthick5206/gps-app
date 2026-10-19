import maplibregl, { type GeoJSONSource } from 'maplibre-gl';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { circleRing } from '@/features/geofences/geometry';
import { onStyleReady, useBasemap } from '@/features/geofences/map/use-basemap';
import { cn } from '@/lib/utils';

const SRC = 'poi-edit-radius';

/** Small editor map: click (or drag the pin) to set the POI position; the radius is drawn as a circle. */
export function PoiMap({
  position,
  radiusM,
  color,
  onChange,
  readOnly = false,
  className,
}: {
  position: { lat: number; lng: number } | null;
  radiusM: number;
  color: string;
  onChange: (p: { lat: number; lng: number }) => void;
  readOnly?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const initial = useRef(position);
  const { map, unsupported } = useBasemap(containerRef, initial.current ? { center: [initial.current.lng, initial.current.lat], zoom: 15 } : {});
  const markerRef = useRef<maplibregl.Marker | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;

  // Controls + click-to-place.
  useEffect(() => {
    if (!map) return;
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), 'bottom-right');
    map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
    const onClick = (e: maplibregl.MapMouseEvent) => {
      if (readOnlyRef.current) return;
      onChangeRef.current({ lat: Number(e.lngLat.lat.toFixed(6)), lng: Number(e.lngLat.lng.toFixed(6)) });
    };
    map.on('click', onClick);
    map.getCanvas().style.cursor = readOnlyRef.current ? '' : 'crosshair';
    return () => {
      map.off('click', onClick);
      markerRef.current?.remove();
      markerRef.current = null;
    };
  }, [map]);

  // Pin marker (draggable).
  useEffect(() => {
    if (!map) return;
    if (!position) {
      markerRef.current?.remove();
      markerRef.current = null;
      return;
    }
    let m = markerRef.current;
    if (!m) {
      m = new maplibregl.Marker({ color, draggable: !readOnly }).setLngLat([position.lng, position.lat]).addTo(map);
      m.on('dragend', () => {
        const ll = m!.getLngLat();
        onChangeRef.current({ lat: Number(ll.lat.toFixed(6)), lng: Number(ll.lng.toFixed(6)) });
      });
      markerRef.current = m;
    } else {
      m.setLngLat([position.lng, position.lat]);
    }
  }, [map, position?.lat, position?.lng]); // eslint-disable-line react-hooks/exhaustive-deps

  // Recreate the marker when the colour changes (MapLibre markers can't be recoloured in place).
  useEffect(() => {
    if (!map || !markerRef.current) return;
    const ll = markerRef.current.getLngLat();
    markerRef.current.remove();
    const m = new maplibregl.Marker({ color, draggable: !readOnly }).setLngLat(ll).addTo(map);
    m.on('dragend', () => {
      const p = m.getLngLat();
      onChangeRef.current({ lat: Number(p.lat.toFixed(6)), lng: Number(p.lng.toFixed(6)) });
    });
    markerRef.current = m;
  }, [color, readOnly]); // eslint-disable-line react-hooks/exhaustive-deps

  // Pan to a typed-in position when it leaves the viewport.
  useEffect(() => {
    if (!map || !position) return;
    if (!map.getBounds().contains([position.lng, position.lat])) map.easeTo({ center: [position.lng, position.lat], zoom: Math.max(map.getZoom(), 14), duration: 400 });
  }, [map, position?.lat, position?.lng]); // eslint-disable-line react-hooks/exhaustive-deps

  // Radius circle.
  useEffect(() => {
    if (!map) return;
    const data: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features: position && radiusM > 0 ? [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [circleRing(position, radiusM)] }, properties: {} }] : [],
    };
    return onStyleReady(map, () => {
      const src = map.getSource<GeoJSONSource>(SRC);
      if (src) src.setData(data);
      else {
        map.addSource(SRC, { type: 'geojson', data });
        map.addLayer({ id: `${SRC}-fill`, type: 'fill', source: SRC, paint: { 'fill-color': color, 'fill-opacity': 0.12 } });
        map.addLayer({ id: `${SRC}-line`, type: 'line', source: SRC, paint: { 'line-color': color, 'line-width': 1.5 } });
      }
      if (map.getLayer(`${SRC}-fill`)) map.setPaintProperty(`${SRC}-fill`, 'fill-color', color);
      if (map.getLayer(`${SRC}-line`)) map.setPaintProperty(`${SRC}-line`, 'line-color', color);
    });
  }, [map, position?.lat, position?.lng, radiusM, color]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className={cn('relative min-h-[240px] overflow-hidden rounded-lg border', className)}>
      <div ref={containerRef} className="h-full w-full" role="application" aria-label={t('POI location map')} />
      {unsupported && (
        <div className="absolute inset-0 flex items-center justify-center bg-muted p-6 text-center text-sm text-muted-foreground">
          {t('The map needs WebGL. You can still type the latitude and longitude.')}
        </div>
      )}
      {!unsupported && !readOnly && (
        <div className="pointer-events-none absolute inset-x-2 top-2 z-10 flex justify-center">
          <span className="rounded-md border bg-card/95 px-2 py-1 text-xs text-muted-foreground shadow-sm backdrop-blur">
            {position ? t('Click the map or drag the pin to move it.') : t('Click the map to place the POI.')}
          </span>
        </div>
      )}
    </div>
  );
}

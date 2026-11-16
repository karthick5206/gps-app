import maplibregl from 'maplibre-gl';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { PlaceSearch } from '@/components/map-place-search';
import { useBasemap } from '@/features/geofences/map/use-basemap';
import { cn } from '@/lib/utils';

type LatLng = { lat: number; lng: number };
const round = (v: number) => Number(v.toFixed(6));

/** Small map to pick where a photo was taken: click the map, drag the pin or search a place. */
export function LocationPickerMap({ position, onChange, className }: { position: LatLng | null; onChange: (p: LatLng) => void; className?: string }) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const initial = useRef(position);
  const { map, unsupported } = useBasemap(containerRef, initial.current ? { center: [initial.current.lng, initial.current.lat], zoom: 15 } : {});
  const markerRef = useRef<maplibregl.Marker | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!map) return;
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: false, showCompass: false }), 'bottom-right');
    const onClick = (e: maplibregl.MapMouseEvent) => onChangeRef.current({ lat: round(e.lngLat.lat), lng: round(e.lngLat.lng) });
    map.on('click', onClick);
    map.getCanvas().style.cursor = 'crosshair';
    return () => {
      map.off('click', onClick);
      markerRef.current?.remove();
      markerRef.current = null;
    };
  }, [map]);

  useEffect(() => {
    if (!map) return;
    if (!position) {
      markerRef.current?.remove();
      markerRef.current = null;
      return;
    }
    if (!markerRef.current) {
      const m = new maplibregl.Marker({ color: '#2563eb', draggable: true }).setLngLat([position.lng, position.lat]).addTo(map);
      m.on('dragend', () => {
        const ll = m.getLngLat();
        onChangeRef.current({ lat: round(ll.lat), lng: round(ll.lng) });
      });
      markerRef.current = m;
    } else markerRef.current.setLngLat([position.lng, position.lat]);
    if (!map.getBounds().contains([position.lng, position.lat])) map.easeTo({ center: [position.lng, position.lat], zoom: Math.max(map.getZoom(), 14), duration: 400 });
  }, [map, position?.lat, position?.lng]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className={cn('relative h-64 overflow-hidden rounded-lg border', className)}>
      <div ref={containerRef} className="h-full w-full" role="application" aria-label={t('Photo location map')} />
      {unsupported ? (
        <div className="absolute inset-0 flex items-center justify-center bg-muted p-6 text-center text-sm text-muted-foreground">{t('The map needs WebGL. Use the location in the photo instead.')}</div>
      ) : (
        <>
          <PlaceSearch
            near={() => map?.getCenter() ?? null}
            className="absolute top-2 right-2 left-2 z-10 max-w-sm"
            onPick={(p) => {
              if (!p) return;
              onChangeRef.current({ lat: round(p.lat), lng: round(p.lng) });
              map?.flyTo({ center: [p.lng, p.lat], zoom: Math.max(map.getZoom(), 16), duration: 600 });
            }}
          />
          <div className="pointer-events-none absolute inset-x-2 bottom-2 z-10 flex justify-center">
            <span className="rounded-md border bg-card/95 px-2 py-1 text-xs text-muted-foreground shadow-sm backdrop-blur">
              {position ? t('Click the map or drag the pin to move it.') : t('Click the map where the photo was taken.')}
            </span>
          </div>
        </>
      )}
    </div>
  );
}

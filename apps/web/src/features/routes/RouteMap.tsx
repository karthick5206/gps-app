import type { RoutePath } from '@veetracer/shared';
import maplibregl, { type GeoJSONSource } from 'maplibre-gl';
import { MaximizeIcon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';
import { circleRing } from '@/features/geofences/geometry';
import { onStyleReady, useBasemap } from '@/features/geofences/map/use-basemap';
import { PlaceSearch, type Place } from '@/features/geofences/PlaceSearch';
import { cssToken } from '@/features/live/map/map-style';
import { cn } from '@/lib/utils';
import { coordsBounds, corridorLineWidth, midLatitude } from './corridor';
import { stopNameFromPlace, type StopDraft } from './route-stops';

const LINE_SRC = 'rte-line';
const STOP_SRC = 'rte-stops';

/** Marker colour role: start and end are distinct from the stops in between (theme tokens, see index.css). */
export function stopRole(index: number, count: number): 'start' | 'end' | 'via' {
  if (index === 0) return 'start';
  if (index === count - 1 && count > 1) return 'end';
  return 'via';
}

export const ROLE_CLASS: Record<ReturnType<typeof stopRole>, string> = {
  start: 'bg-success text-primary-foreground',
  end: 'bg-destructive text-destructive-foreground',
  via: 'bg-primary text-primary-foreground',
};

const round6 = (n: number) => Number(n.toFixed(6));

/**
 * Route editor map: numbered stop markers (click the map to add, drag to move), stop radius circles, the road path
 * (or straight dashed legs when there is none) and the corridor drawn as a band whose width follows the zoom.
 */
export function RouteMap({
  stops,
  path,
  corridorM,
  selected,
  onSelect,
  onAdd,
  onMove,
  readOnly = false,
  className,
}: {
  stops: StopDraft[];
  /** Road path ([lng, lat]); null = straight legs between the stops. */
  path: RoutePath | null;
  corridorM: number;
  selected: number | null;
  onSelect: (index: number) => void;
  onAdd: (stop: { lat: number; lng: number; name?: string }) => void;
  onMove: (index: number, lat: number, lng: number) => void;
  readOnly?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const { map, unsupported } = useBasemap(containerRef);
  const markersRef = useRef<maplibregl.Marker[]>([]);
  const cb = useRef({ onSelect, onAdd, onMove, readOnly });
  cb.current = { onSelect, onAdd, onMove, readOnly };
  const [searchKey, setSearchKey] = useState(0);
  const fittedRef = useRef(false);

  const coords = useMemo<[number, number][]>(() => stops.filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lng)).map((s) => [s.lng, s.lat]), [stops]);
  const lineCoords = path && path.length >= 2 ? path : coords;
  const straight = !(path && path.length >= 2);

  const fit = () => {
    const b = coordsBounds(lineCoords.length ? lineCoords : coords);
    if (!map || !b) return;
    if (b[0][0] === b[1][0] && b[0][1] === b[1][1]) map.flyTo({ center: b[0], zoom: Math.max(map.getZoom(), 14), duration: 400 });
    else map.fitBounds(b, { padding: 48, maxZoom: 16, duration: 400 });
  };

  // Controls + click-to-add.
  useEffect(() => {
    if (!map) return;
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), 'bottom-right');
    map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
    const onClick = (e: maplibregl.MapMouseEvent) => {
      if (cb.current.readOnly) return;
      // Markers sit in the canvas container; their clicks select, they don't add.
      if ((e.originalEvent.target as HTMLElement | null)?.closest?.('.maplibregl-marker')) return;
      cb.current.onAdd({ lat: round6(e.lngLat.lat), lng: round6(e.lngLat.lng) });
    };
    map.on('click', onClick);
    map.getCanvas().style.cursor = cb.current.readOnly ? '' : 'crosshair';
    return () => {
      map.off('click', onClick);
    };
  }, [map]);

  // First fit once there is something to show (the route's stops when editing).
  useEffect(() => {
    if (!map || fittedRef.current || !coords.length) return;
    fittedRef.current = true;
    const b = coordsBounds(lineCoords);
    if (!b) return;
    const run = () => {
      if (b[0][0] === b[1][0] && b[0][1] === b[1][1]) map.jumpTo({ center: b[0], zoom: 14 });
      else map.fitBounds(b, { padding: 48, maxZoom: 16, duration: 0 });
    };
    if (map.loaded()) run();
    else map.once('load', run);
  }, [map, coords.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // Numbered markers, rebuilt when positions, order, names or the selection change.
  const markerKey = stops.map((s) => `${s.key}@${s.lat},${s.lng}:${s.name}`).join('|');
  useEffect(() => {
    if (!map) return;
    for (const m of markersRef.current) m.remove();
    markersRef.current = stops.map((s, i) => {
      const el = document.createElement('button');
      el.type = 'button';
      el.textContent = String(i + 1);
      el.title = s.name || t('Stop {{n}}', { n: i + 1 });
      el.setAttribute('aria-label', t('Stop {{n}}: {{name}}', { n: i + 1, name: s.name || '—' }));
      el.className = cn(
        'flex size-7 items-center justify-center rounded-full border-2 border-[var(--map-marker-stroke)] text-xs font-bold shadow-md',
        ROLE_CLASS[stopRole(i, stops.length)],
        readOnly ? 'cursor-pointer' : 'cursor-grab',
        selected === i && 'ring-2 ring-ring ring-offset-1 ring-offset-background',
      );
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        cb.current.onSelect(i);
      });
      const marker = new maplibregl.Marker({ element: el, draggable: !readOnly }).setLngLat([s.lng, s.lat]).addTo(map);
      marker.on('dragend', () => {
        const ll = marker.getLngLat();
        cb.current.onMove(i, round6(ll.lat), round6(ll.lng));
      });
      return marker;
    });
  }, [map, markerKey, selected, readOnly, t]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(
    () => () => {
      for (const m of markersRef.current) m.remove();
      markersRef.current = [];
    },
    [],
  );

  // Path / straight legs + corridor band + stop radius circles.
  const lineData = useMemo<GeoJSON.FeatureCollection>(
    () => ({
      type: 'FeatureCollection',
      features: lineCoords.length >= 2 ? [{ type: 'Feature', geometry: { type: 'LineString', coordinates: lineCoords }, properties: { straight } }] : [],
    }),
    [lineCoords, straight],
  );
  const stopData = useMemo<GeoJSON.FeatureCollection>(
    () => ({
      type: 'FeatureCollection',
      features: stops
        .filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lng) && Number.isFinite(s.radiusM) && s.radiusM > 0)
        .map((s) => {
          const ring = circleRing({ lat: s.lat, lng: s.lng }, s.radiusM);
          return { type: 'Feature' as const, geometry: { type: 'Polygon' as const, coordinates: [[...ring, ring[0]]] }, properties: {} };
        }),
    }),
    [stops],
  );
  const lat = midLatitude(lineCoords);

  useEffect(() => {
    if (!map) return;
    const width = corridorLineWidth(corridorM, lat);
    return onStyleReady(map, () => {
      const lineSrc = map.getSource<GeoJSONSource>(LINE_SRC);
      if (lineSrc) {
        lineSrc.setData(lineData);
        map.getSource<GeoJSONSource>(STOP_SRC)?.setData(stopData);
        map.setPaintProperty('rte-corridor', 'line-width', width);
        return;
      }
      // Theme tokens are read again after every basemap swap (style.load), so dark / light both follow the theme.
      const primary = cssToken('--primary') || '#0e5e57';
      const muted = cssToken('--muted-foreground') || '#64748b';
      map.addSource(LINE_SRC, { type: 'geojson', data: lineData });
      map.addSource(STOP_SRC, { type: 'geojson', data: stopData });
      map.addLayer({ id: 'rte-corridor', type: 'line', source: LINE_SRC, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': primary, 'line-opacity': 0.16, 'line-width': width } });
      map.addLayer({ id: 'rte-stop-fill', type: 'fill', source: STOP_SRC, paint: { 'fill-color': primary, 'fill-opacity': 0.12 } });
      map.addLayer({ id: 'rte-stop-line', type: 'line', source: STOP_SRC, paint: { 'line-color': primary, 'line-width': 1, 'line-opacity': 0.6 } });
      map.addLayer({
        id: 'rte-path',
        type: 'line',
        source: LINE_SRC,
        filter: ['!', ['get', 'straight']],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': primary, 'line-width': 4, 'line-opacity': 0.9 },
      });
      map.addLayer({
        id: 'rte-straight',
        type: 'line',
        source: LINE_SRC,
        filter: ['get', 'straight'],
        paint: { 'line-color': muted, 'line-width': 2.5, 'line-dasharray': [2, 2] },
      });
    });
  }, [map, lineData, stopData, corridorM, lat]);

  const pickPlace = (place: Place | null) => {
    if (!place || !map) return;
    map.flyTo({ center: [place.lng, place.lat], zoom: Math.max(map.getZoom(), 14), duration: 600 });
    if (!readOnly) {
      cb.current.onAdd({ lat: round6(place.lat), lng: round6(place.lng), name: stopNameFromPlace(place.label) });
      setSearchKey((k) => k + 1);
    }
  };

  return (
    <div className={cn('relative min-h-[260px] overflow-hidden', className)}>
      <div ref={containerRef} className="h-full w-full" role="application" aria-label={t('Route map editor')} />
      {unsupported && (
        <div className="absolute inset-0 flex items-center justify-center bg-muted p-6 text-center text-sm text-muted-foreground">
          {t('The map needs WebGL. You can still edit the stop list.')}
        </div>
      )}
      {!unsupported && (
        <>
          <PlaceSearch key={searchKey} near={() => map?.getCenter() ?? null} onPick={pickPlace} className="absolute top-3 right-14 left-3 z-10 max-w-sm" />
          <div className="absolute top-3 right-3 z-10">
            <Tooltip content={t('Zoom to route')}>
              <Button variant="outline" size="icon-sm" aria-label={t('Zoom to route')} onClick={fit} disabled={!coords.length} className="bg-card shadow-sm">
                <MaximizeIcon />
              </Button>
            </Tooltip>
          </div>
          {!readOnly && (
            <div className="pointer-events-none absolute inset-x-3 bottom-10 z-10 flex justify-center sm:bottom-3 sm:left-14 sm:justify-start">
              <p className="rounded-lg border bg-card/95 px-3 py-1.5 text-xs text-muted-foreground shadow-md backdrop-blur">
                {stops.length ? t('Click the map to add a stop. Drag a marker to move it.') : t('Click the map or search a place to add the start stop.')}
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}

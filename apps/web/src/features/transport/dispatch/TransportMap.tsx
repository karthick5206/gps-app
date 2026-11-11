import maplibregl, { type GeoJSONSource } from 'maplibre-gl';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { onStyleReady, useBasemap } from '@/features/geofences/map/use-basemap';
import { cssToken } from '@/features/live/map/map-style';
import { prefersReducedMotion } from '@/hooks/use-reduced-motion';
import { cn } from '@/lib/utils';

const SRC = 'etms-trip-line';

export interface MapStop {
  seq: number;
  lat: number;
  lng: number;
  label: string;
  /** Visited (arrived / departed). */
  done?: boolean;
  /** Highlight (the passenger's own pickup). */
  mine?: boolean;
}

/**
 * Stops, planned line and (optionally) the vehicle on the self-hosted basemap (same `useBasemap` styles as every other
 * map; no outside map host). The stop list next to it is the accessible equivalent; the map is never the only way.
 */
export function TransportMap({ line, stops, vehicle, className, label }: { line: [number, number][]; stops: MapStop[]; vehicle?: { lat: number; lng: number; heading: number | null } | null; className?: string; label: string }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const first = stops[0] ?? vehicle ?? null;
  const { map, unsupported } = useBasemap(ref, first ? { center: [first.lng, first.lat], zoom: 13 } : {});
  const markers = useRef<maplibregl.Marker[]>([]);
  const vehicleMarker = useRef<maplibregl.Marker | null>(null);
  const fitted = useRef(false);

  useEffect(() => {
    if (!map) return;
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), 'bottom-right');
  }, [map]);

  // Planned line.
  const lineKey = JSON.stringify(line);
  useEffect(() => {
    if (!map) return;
    const data: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: line.length > 1 ? [{ type: 'Feature', geometry: { type: 'LineString', coordinates: line }, properties: {} }] : [] };
    return onStyleReady(map, () => {
      const src = map.getSource<GeoJSONSource>(SRC);
      if (src) {
        src.setData(data);
        return;
      }
      map.addSource(SRC, { type: 'geojson', data });
      map.addLayer({ id: SRC, type: 'line', source: SRC, paint: { 'line-color': cssToken('--primary') || '#0e5e57', 'line-width': 3, 'line-dasharray': [2, 1.5] } });
    });
  }, [map, lineKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Stop markers (numbered, the list order).
  const stopsKey = JSON.stringify(stops);
  useEffect(() => {
    if (!map) return;
    markers.current.forEach((m) => m.remove());
    markers.current = stops.map((s) => {
      const el = document.createElement('div');
      el.className = cn(
        'flex size-6 items-center justify-center rounded-full border-2 border-[var(--map-marker-stroke)] text-[10px] font-bold shadow-md',
        s.mine ? 'bg-warning text-white' : s.done ? 'bg-success text-white' : 'bg-primary text-primary-foreground',
      );
      el.textContent = String(s.seq + 1);
      el.title = s.label;
      el.setAttribute('aria-label', t('Stop {{n}}: {{name}}', { n: s.seq + 1, name: s.label }));
      return new maplibregl.Marker({ element: el }).setLngLat([s.lng, s.lat]).addTo(map);
    });
    if (!fitted.current && (stops.length > 0 || line.length > 1)) {
      const pts: [number, number][] = [...line, ...stops.map((s) => [s.lng, s.lat] as [number, number])];
      if (vehicle) pts.push([vehicle.lng, vehicle.lat]);
      const b = pts.reduce((acc, p) => acc.extend(p), new maplibregl.LngLatBounds(pts[0], pts[0]));
      map.fitBounds(b, { padding: 40, maxZoom: 15, duration: 0 });
      fitted.current = true;
    }
    return () => {
      markers.current.forEach((m) => m.remove());
      markers.current = [];
    };
  }, [map, stopsKey, t]); // eslint-disable-line react-hooks/exhaustive-deps

  // Vehicle (polled position).
  useEffect(() => {
    if (!map) return;
    if (!vehicle) {
      vehicleMarker.current?.remove();
      vehicleMarker.current = null;
      return;
    }
    if (!vehicleMarker.current) {
      const el = document.createElement('div');
      el.className = 'flex size-8 items-center justify-center rounded-full border-2 border-white bg-info text-white shadow-lg';
      el.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M12 2 19 21 12 17 5 21Z"/></svg>';
      el.setAttribute('aria-label', t('Vehicle position'));
      vehicleMarker.current = new maplibregl.Marker({ element: el, rotationAlignment: 'map' }).setLngLat([vehicle.lng, vehicle.lat]).addTo(map);
    } else vehicleMarker.current.setLngLat([vehicle.lng, vehicle.lat]);
    vehicleMarker.current.setRotation(vehicle.heading ?? 0);
    if (!map.getBounds().contains([vehicle.lng, vehicle.lat])) map.easeTo({ center: [vehicle.lng, vehicle.lat], duration: prefersReducedMotion() ? 0 : 500 });
  }, [map, vehicle?.lat, vehicle?.lng, vehicle?.heading, t]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(
    () => () => {
      vehicleMarker.current?.remove();
      vehicleMarker.current = null;
    },
    [],
  );

  return (
    <div className={cn('relative min-h-[240px] overflow-hidden rounded-lg border', className)}>
      <div ref={ref} className="h-full w-full" role="img" aria-label={label} />
      {unsupported && <div className="absolute inset-0 flex items-center justify-center bg-muted p-6 text-center text-sm text-muted-foreground">{t('The map needs WebGL. The list shows the same stops.')}</div>}
    </div>
  );
}

/** Planned line: the road path when present, else straight legs between the stops ([lng, lat]). */
export function tripLine(path: [number, number][] | null | undefined, stops: { lat: number; lng: number; seq: number }[]): [number, number][] {
  if (path && path.length > 1) return path.map(([lng, lat]) => [lng, lat]);
  return [...stops].sort((a, b) => a.seq - b.seq).map((s) => [s.lng, s.lat]);
}

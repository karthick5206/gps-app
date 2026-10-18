import type { AlertSeverity, GeofenceGeometry } from '@veetracer/shared';
import type { GeoJSONSource } from 'maplibre-gl';
import { useEffect, useRef } from 'react';
import { geometryRing } from '@/features/geofences/geometry';
import { onStyleReady, useBasemap } from '@/features/geofences/map/use-basemap';
import { cn } from '@/lib/utils';
import { SEVERITY_COLOR } from './severity';

const SRC = 'mini';

/** Small static map snippet centred on a point, optionally with a geofence outline. */
export function MiniMap({
  lat,
  lng,
  severity = 'WARNING',
  geofence,
  className,
  zoom = 15,
}: {
  lat: number;
  lng: number;
  severity?: AlertSeverity;
  geofence?: { geometry: GeofenceGeometry; color: string } | null;
  className?: string;
  zoom?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { map, unsupported } = useBasemap(ref, { center: [lng, lat], zoom, interactive: false, attributionControl: false });

  useEffect(() => {
    if (!map) return;
    map.jumpTo({ center: [lng, lat] });
    const features: GeoJSON.Feature[] = [{ type: 'Feature', geometry: { type: 'Point', coordinates: [lng, lat] }, properties: { kind: 'point' } }];
    if (geofence) features.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [geometryRing(geofence.geometry)] }, properties: { kind: 'zone', color: geofence.color } });
    const data: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features };
    return onStyleReady(map, () => {
      const src = map.getSource<GeoJSONSource>(SRC);
      if (src) return src.setData(data);
      map.addSource(SRC, { type: 'geojson', data });
      map.addLayer({ id: 'mini-zone-fill', type: 'fill', source: SRC, filter: ['==', ['get', 'kind'], 'zone'], paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.12 } });
      map.addLayer({ id: 'mini-zone-line', type: 'line', source: SRC, filter: ['==', ['get', 'kind'], 'zone'], paint: { 'line-color': ['get', 'color'], 'line-width': 2 } });
      map.addLayer({
        id: 'mini-halo',
        type: 'circle',
        source: SRC,
        filter: ['==', ['get', 'kind'], 'point'],
        paint: { 'circle-radius': 16, 'circle-color': SEVERITY_COLOR[severity], 'circle-opacity': 0.2 },
      });
      map.addLayer({
        id: 'mini-point',
        type: 'circle',
        source: SRC,
        filter: ['==', ['get', 'kind'], 'point'],
        paint: { 'circle-radius': 7, 'circle-color': SEVERITY_COLOR[severity], 'circle-stroke-width': 2.5, 'circle-stroke-color': '#ffffff' },
      });
    });
  }, [map, lat, lng, severity, geofence]);

  return (
    <div className={cn('relative h-40 overflow-hidden rounded-lg border bg-muted', className)}>
      <div ref={ref} className="h-full w-full" aria-label="Alert location map" role="img" />
      {unsupported && <p className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">Map unavailable</p>}
    </div>
  );
}

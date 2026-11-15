import type { LatLng } from '@veetracer/shared';
import maplibregl, { type GeoJSONSource } from 'maplibre-gl';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { onStyleReady, useBasemap } from '@/features/geofences/map/use-basemap';
import { cn } from '@/lib/utils';
import { mapControlLocale, vehicleColor, type MapPoint, type RouteLine } from './planner-format';

const SRC = 'etms-plan-routes';

/**
 * Routes of a plan on the self-hosted basemap (`useBasemap`: same styles as every other map; no outside map host).
 * Only the points the API sent (consent-gated, 4 decimals for branch scope; see `mapPoints`) and engine road geometry;
 * never a straight line drawn in the browser. The route lists beside it are the accessible equivalent.
 */
export function PlanMap({ lines, points, depot, focus, className, label, selected, onSelect }: { lines: RouteLine[]; points: MapPoint[]; depot: LatLng | null; focus?: number | null; className?: string; label: string; selected?: string | null; onSelect?: (stopId: string) => void }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const first = points[0] ?? depot;
  // T2-L5: MapLibre control labels (zoom, compass, attribution, map) in the user's language.
  const { map, unsupported } = useBasemap(ref, { ...(first ? { center: [first.lng, first.lat] as [number, number], zoom: 12 } : {}), locale: mapControlLocale(t) });
  const markers = useRef<maplibregl.Marker[]>([]);
  // E4 WP-W: a click (or Enter / Space) on a stop marker selects that passenger in the route cards.
  const select = useRef(onSelect);
  select.current = onSelect;
  const fitted = useRef(false);

  useEffect(() => {
    if (!map) return;
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), 'bottom-right');
  }, [map]);

  const linesKey = JSON.stringify(lines) + String(focus ?? '');
  useEffect(() => {
    if (!map) return;
    const data: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features: lines.map((l) => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: l.coordinates }, properties: { color: l.color, dim: focus !== null && focus !== undefined && focus !== l.route ? 1 : 0 } })),
    };
    return onStyleReady(map, () => {
      const src = map.getSource<GeoJSONSource>(SRC);
      if (src) {
        src.setData(data);
        return;
      }
      map.addSource(SRC, { type: 'geojson', data });
      map.addLayer({ id: SRC, type: 'line', source: SRC, layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': ['get', 'color'], 'line-width': 4, 'line-opacity': ['case', ['==', ['get', 'dim'], 1], 0.25, 0.9] } });
    });
  }, [map, linesKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const pointsKey = JSON.stringify(points) + JSON.stringify(depot) + String(focus ?? '') + String(selected ?? '') + String(!!onSelect);
  useEffect(() => {
    if (!map) return;
    markers.current.forEach((m) => m.remove());
    const made: maplibregl.Marker[] = [];
    if (depot) {
      const el = document.createElement('div');
      el.className = 'flex size-7 items-center justify-center rounded-md border-2 border-[var(--map-marker-stroke)] bg-foreground text-[10px] font-bold text-background shadow-md';
      el.textContent = 'S';
      el.setAttribute('aria-label', t('Site'));
      el.title = t('Site');
      made.push(new maplibregl.Marker({ element: el }).setLngLat([depot.lng, depot.lat]).addTo(map));
    }
    for (const p of points) {
      const el = document.createElement('div');
      const dim = focus !== null && focus !== undefined && focus !== p.route;
      const isSel = selected === p.id;
      // Pooling: pickups are round, drops square, so the two ends of a ride are told apart at a glance.
      el.className = cn('flex size-6 items-center justify-center border-2 border-[var(--map-marker-stroke)] text-[10px] font-bold text-white shadow-md', p.kind === 'DROP' ? 'rounded-[3px]' : 'rounded-full', dim && !isSel && 'opacity-40', isSel && 'size-8 ring-4 ring-primary', onSelect && 'cursor-pointer');
      el.style.background = p.route >= 0 ? vehicleColor(p.route) : '#6b7280';
      el.textContent = p.position ? String(p.position) : '–';
      const base = p.route >= 0 ? t('Route {{r}}, stop {{n}}: {{name}}', { r: p.route + 1, n: p.position ?? 0, name: t(p.label) }) : t('Unassigned: {{name}}', { name: t(p.label) });
      const text = p.kind && !p.personal ? `${base} (${p.kind === 'DROP' ? t('Drop') : t('Pickup')})` : base;
      el.title = text;
      el.setAttribute('aria-label', text);
      if (onSelect) {
        el.tabIndex = 0;
        el.setAttribute('role', 'button');
        el.setAttribute('aria-pressed', String(isSel));
        const pick = (e: Event) => {
          e.stopPropagation();
          select.current?.(p.id);
        };
        el.addEventListener('click', pick);
        el.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            pick(e);
          }
        });
      }
      made.push(new maplibregl.Marker({ element: el }).setLngLat([p.lng, p.lat]).addTo(map));
    }
    markers.current = made;
    if (!fitted.current) {
      const pts: [number, number][] = [...lines.flatMap((l) => l.coordinates), ...points.map((p) => [p.lng, p.lat] as [number, number])];
      if (depot) pts.push([depot.lng, depot.lat]);
      if (pts.length) {
        const b = pts.reduce((acc, p) => acc.extend(p), new maplibregl.LngLatBounds(pts[0], pts[0]));
        map.fitBounds(b, { padding: 40, maxZoom: 15, duration: 0 });
        fitted.current = true;
      }
    }
    return () => {
      markers.current.forEach((m) => m.remove());
      markers.current = [];
    };
  }, [map, pointsKey, t]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className={cn('relative min-h-[260px] overflow-hidden rounded-lg border', className)}>
      <div ref={ref} className="h-full w-full" role="img" aria-label={label} />
      {unsupported && <div className="absolute inset-0 flex items-center justify-center bg-muted p-6 text-center text-sm text-muted-foreground">{t('The map needs WebGL. The route lists show the same stops.')}</div>}
    </div>
  );
}

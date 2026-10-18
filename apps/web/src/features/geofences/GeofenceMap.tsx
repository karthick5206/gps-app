import type { GeofenceDto } from '@veetracer/shared';
import maplibregl, { type GeoJSONSource } from 'maplibre-gl';
import { CheckIcon, CircleIcon, EraserIcon, HexagonIcon, MaximizeIcon, SquareIcon, Undo2Icon, XIcon } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';
import { cssToken } from '@/features/live/map/map-style';
import { cn } from '@/lib/utils';
import { GeofenceDraw, type DrawMode } from './draw/geofence-draw';
import { geometryRing, labelPoint, type Geometry } from './geometry';
import { onStyleReady, useBasemap } from './map/use-basemap';

const OTHERS_SRC = 'gfe-others';

const HINTS: Record<DrawMode, string> = {
  none: 'Drag the shape to move it, drag handles to reshape. Right-click a polygon point to delete it.',
  circle: 'Press at the centre and drag out the radius (a click makes a 200 m circle).',
  polygon: 'Click to add points. Double-click, press Enter or click the first point to finish. Backspace undoes a point.',
  rectangle: 'Press and drag from one corner to the opposite corner.',
};

function ToolButton({ label, active, onClick, children, disabled }: { label: string; active?: boolean; onClick: () => void; children: ReactNode; disabled?: boolean }) {
  return (
    <Tooltip content={label}>
      <Button
        variant={active ? 'default' : 'outline'}
        size="icon-sm"
        aria-label={label}
        aria-pressed={active}
        onClick={onClick}
        disabled={disabled}
        className={cn('shadow-sm', !active && 'bg-card')}
      >
        {children}
      </Button>
    </Tooltip>
  );
}

/**
 * Editor map: draws/edits one geofence and shows the company's other geofences faintly for context.
 * `focus` recentres the map (vehicle location picker) without changing the geometry.
 */
export function GeofenceMap({
  geometry,
  onChange,
  color,
  others = [],
  focus,
  readOnly = false,
  className,
}: {
  geometry: Geometry | null;
  onChange: (g: Geometry | null) => void;
  color: string;
  others?: GeofenceDto[];
  focus?: { lat: number; lng: number; zoom?: number; key: number } | null;
  readOnly?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const { map, unsupported } = useBasemap(containerRef);
  const drawRef = useRef<GeofenceDraw | null>(null);
  const [mode, setMode] = useState<DrawMode>('none');
  const [draftPoints, setDraftPoints] = useState(0);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const initialGeometry = useRef(geometry);

  useEffect(() => {
    if (!map) return;
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), 'bottom-right');
    map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
    const draw = new GeofenceDraw({
      map,
      color,
      onChange: (g) => onChangeRef.current(g),
      onModeChange: setMode,
      onDraftChange: setDraftPoints,
    });
    drawRef.current = draw;
    const fit = () => {
      if (initialGeometry.current) {
        draw.setGeometry(initialGeometry.current);
        draw.fitToGeometry();
      }
    };
    if (map.loaded()) fit();
    else map.once('load', fit);
    return () => {
      draw.destroy();
      drawRef.current = null;
    };
    // Colour is pushed via setColor below; the controller is created once per map.
  }, [map]);

  // External geometry edits (numeric radius, vehicle location) → controller.
  useEffect(() => {
    const draw = drawRef.current;
    if (!draw || draw.getGeometry() === geometry) return;
    draw.setGeometry(geometry);
  }, [geometry]);

  useEffect(() => drawRef.current?.setColor(color), [color]);

  useEffect(() => {
    if (!map || !focus) return;
    map.flyTo({ center: [focus.lng, focus.lat], zoom: focus.zoom ?? Math.max(map.getZoom(), 15), duration: 600 });
  }, [map, focus]);

  // Context layer: other geofences, faint and non-interactive, below the editable shape.
  useEffect(() => {
    if (!map) return;
    const data: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features: others.flatMap((g) => [
        { type: 'Feature' as const, geometry: { type: 'Polygon' as const, coordinates: [geometryRing(g.geometry)] }, properties: { color: g.color } },
        {
          type: 'Feature' as const,
          geometry: { type: 'Point' as const, coordinates: [labelPoint(g.geometry).lng, labelPoint(g.geometry).lat] },
          properties: { name: g.name, label: true },
        },
      ]),
    };
    return onStyleReady(map, () => {
      const src = map.getSource<GeoJSONSource>(OTHERS_SRC);
      if (src) {
        src.setData(data);
        return;
      }
      map.addSource(OTHERS_SRC, { type: 'geojson', data });
      const before = map.getLayer('gfd-fill') ? 'gfd-fill' : undefined;
      map.addLayer({ id: 'gfe-others-fill', type: 'fill', source: OTHERS_SRC, filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.06 } }, before);
      map.addLayer(
        { id: 'gfe-others-line', type: 'line', source: OTHERS_SRC, filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'line-color': ['get', 'color'], 'line-width': 1, 'line-opacity': 0.5, 'line-dasharray': [3, 2] } },
        before,
      );
      map.addLayer(
        {
          id: 'gfe-others-label',
          type: 'symbol',
          source: OTHERS_SRC,
          filter: ['==', ['geometry-type'], 'Point'],
          minzoom: 12,
          layout: { 'text-field': ['get', 'name'], 'text-font': [import.meta.env.VITE_MAP_FONT || 'Noto Sans Bold'], 'text-size': 11 },
          paint: { 'text-color': cssToken('--muted-foreground') || '#64748b', 'text-halo-color': cssToken('--map-label-halo') || '#ffffff', 'text-halo-width': 1 },
        },
        before,
      );
    });
  }, [map, others]);

  const start = (m: DrawMode) => drawRef.current?.setMode(mode === m ? 'none' : m);

  return (
    <div className={cn('relative min-h-[280px] overflow-hidden', className)}>
      <div ref={containerRef} className="h-full w-full" role="application" aria-label={t('Geofence map editor')} />
      {unsupported && (
        <div className="absolute inset-0 flex items-center justify-center bg-muted p-6 text-center text-sm text-muted-foreground">
          {t('The map needs WebGL. You can still enter a circle centre and radius in the form.')}
        </div>
      )}
      {!readOnly && !unsupported && (
        <>
          <div className="absolute top-3 left-3 z-10 flex flex-col gap-1.5" role="toolbar" aria-label="Drawing tools">
            <ToolButton label={t('Draw circle')} active={mode === 'circle'} onClick={() => start('circle')}>
              <CircleIcon />
            </ToolButton>
            <ToolButton label={t('Draw polygon')} active={mode === 'polygon'} onClick={() => start('polygon')}>
              <HexagonIcon />
            </ToolButton>
            <ToolButton label={t('Draw rectangle')} active={mode === 'rectangle'} onClick={() => start('rectangle')}>
              <SquareIcon />
            </ToolButton>
            <div className="my-0.5 h-px bg-border" />
            <ToolButton label={t('Zoom to shape')} onClick={() => drawRef.current?.fitToGeometry()} disabled={!geometry}>
              <MaximizeIcon />
            </ToolButton>
            <ToolButton
              label={t('Clear shape')}
              onClick={() => {
                drawRef.current?.setGeometry(null);
                onChange(null);
              }}
              disabled={!geometry}
            >
              <EraserIcon />
            </ToolButton>
          </div>
          <div className="pointer-events-none absolute inset-x-3 bottom-10 z-10 flex justify-center sm:bottom-3 sm:left-14 sm:justify-start">
            <div className="pointer-events-auto flex max-w-xl flex-wrap items-center gap-2 rounded-lg border bg-card/95 px-3 py-2 text-xs shadow-md backdrop-blur">
              <span className="text-muted-foreground">{!geometry && mode === 'none' ? t('Pick a tool on the left to draw the geofence.') : t(HINTS[mode])}</span>
              {mode === 'polygon' && (
                <>
                  <span className="font-medium tabular-nums">{t('{{count}} pts', { count: draftPoints })}</span>
                  <Button size="sm" className="h-7" onClick={() => drawRef.current?.finishPolygon()} disabled={draftPoints < 3}>
                    <CheckIcon /> {t('Finish')}
                  </Button>
                  <Button size="sm" variant="outline" className="h-7" onClick={() => drawRef.current?.undoPoint()} disabled={!draftPoints}>
                    <Undo2Icon /> {t('Undo')}
                  </Button>
                </>
              )}
              {mode !== 'none' && (
                <Button size="sm" variant="ghost" className="h-7" onClick={() => drawRef.current?.setMode('none')}>
                  <XIcon /> {t('Cancel')}
                </Button>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

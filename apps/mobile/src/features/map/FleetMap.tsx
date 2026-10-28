import { Camera, GeoJSONSource, Images, Layer, Map, type CameraRef, type LngLatBounds } from '@maplibre/maplibre-react-native';
import { displayStatus, type LiveObject } from '@veetracer/shared';
import { forwardRef, useImperativeHandle, useMemo, useRef, type ReactNode } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import { useDisplay } from '@/features/display/display';
import { useMapStyle } from '@/features/map/basemap';
import { useColors } from '@/lib/theme';
import { iconKind, iconName, rotates } from './vehicle-icons';
import { VEHICLE_ICON_IMAGES } from './vehicle-icon-images';

const LABEL_FONT = ['Noto Sans Bold'];
const LABEL_MIN_ZOOM = 13;
/** Centre of India: first view before any vehicle has a position. */
const DEFAULT_CENTER: [number, number] = [78.9, 21.5];

/** Camera position after the user (or an animation) moved the map. */
export interface MapView {
  center: [lng: number, lat: number];
  zoom: number;
  bounds: LngLatBounds;
}

export interface FleetMapHandle {
  /** Shows every vehicle with a position. */
  fitAll(objects: LiveObject[], animate?: boolean): void;
  focus(o: LiveObject, zoom?: number): void;
}

export function boundsOf(objects: LiveObject[]): LngLatBounds | null {
  let w = 180, s = 90, e = -180, n = -90, any = false;
  for (const o of objects) {
    if (o.lat === null || o.lng === null) continue;
    any = true;
    w = Math.min(w, o.lng);
    e = Math.max(e, o.lng);
    s = Math.min(s, o.lat);
    n = Math.max(n, o.lat);
  }
  return any ? [w, s, e, n] : null;
}

function toFeatures(objects: LiveObject[], selectedId: string | null): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  for (const o of objects) {
    if (o.lat === null || o.lng === null) continue;
    const kind = iconKind(o);
    features.push({
      type: 'Feature',
      id: o.objectId,
      geometry: { type: 'Point', coordinates: [o.lng, o.lat] },
      properties: {
        id: o.objectId,
        icon: iconName(kind, displayStatus(o)),
        rot: rotates(kind) ? o.course : 0,
        label: o.plateNumber || o.name,
        selected: o.objectId === selectedId,
      },
    });
  }
  return { type: 'FeatureCollection', features };
}

/** MapLibre map with the fleet as rotated vehicle icons (same style and icons as the web live map). */
export const FleetMap = forwardRef<
  FleetMapHandle,
  {
    objects: LiveObject[];
    selectedId?: string | null;
    onSelect?: (id: string | null) => void;
    style?: StyleProp<ViewStyle>;
    children?: ReactNode;
    interactive?: boolean;
    initialZoom?: number;
    /** Called when the map stops moving (current centre, zoom and visible bounds). */
    onViewChange?: (view: MapView) => void;
  }
>(function FleetMap({ objects, selectedId = null, onSelect, style, children, interactive = true, initialZoom, onViewChange }, ref) {
  const mapStyle = useMapStyle();
  const c = useColors();
  const camera = useRef<CameraRef>(null);
  const { iconScale } = useDisplay();
  const data = useMemo(() => toFeatures(objects, selectedId), [objects, selectedId]);

  useImperativeHandle(ref, () => ({
    fitAll(list, animate = true) {
      const b = boundsOf(list);
      if (!b) return;
      if (b[0] === b[2] && b[1] === b[3]) camera.current?.easeTo({ center: [b[0], b[1]], zoom: 14, duration: animate ? 600 : 0 });
      else camera.current?.fitBounds(b, { padding: { top: 90, bottom: 380, left: 50, right: 50 }, duration: animate ? 600 : 0 });
    },
    focus(o, zoom = 15) {
      if (o.lat === null || o.lng === null) return;
      camera.current?.easeTo({ center: [o.lng, o.lat], zoom, duration: 600 });
    },
  }));

  const initial = objects.find((o) => o.lat !== null && o.lng !== null);
  return (
    <Map
      style={[{ flex: 1 }, style]}
      mapStyle={mapStyle}
      logo={false}
      attribution
      attributionPosition={{ bottom: 4, left: 8 }}
      compass={interactive}
      dragPan={interactive}
      touchZoom={interactive}
      touchRotate={interactive}
      touchPitch={false}
      doubleTapZoom={interactive}
      onPress={() => onSelect?.(null)}
      onRegionDidChange={onViewChange ? (e) => onViewChange({ center: e.nativeEvent.center, zoom: e.nativeEvent.zoom, bounds: e.nativeEvent.bounds }) : undefined}
    >
      <Camera ref={camera} initialViewState={initial ? { center: [initial.lng!, initial.lat!], zoom: initialZoom ?? 11 } : { center: DEFAULT_CENTER, zoom: 4 }} />
      <Images images={VEHICLE_ICON_IMAGES} />
      <GeoJSONSource
        id="vehicles"
        data={data}
        hitbox={{ top: 12, bottom: 12, left: 12, right: 12 }}
        onPress={(e) => {
          e.stopPropagation();
          const id = e.nativeEvent.features[0]?.properties?.id;
          if (typeof id === 'string') onSelect?.(id);
        }}
      >
        <Layer
          id="vehicles-selected"
          type="circle"
          filter={['==', ['get', 'selected'], true]}
          paint={{ 'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, 12, 12, 18, 16, 24], 'circle-color': c.primary, 'circle-opacity': 0.18, 'circle-stroke-width': 2, 'circle-stroke-color': c.primary }}
        />
        <Layer
          id="vehicles-icons"
          type="symbol"
          layout={{
            'icon-image': ['get', 'icon'],
            // About 30 % larger than before, times the user's map icon size.
            'icon-size': ['interpolate', ['linear'], ['zoom'], 5, 0.6 * iconScale, 10, 0.85 * iconScale, 14, 1.1 * iconScale, 17, 1.4 * iconScale],
            'icon-rotate': ['get', 'rot'],
            'icon-rotation-alignment': 'map',
            'icon-allow-overlap': true,
            'icon-ignore-placement': true,
          }}
        />
        <Layer
          id="vehicles-labels"
          type="symbol"
          minzoom={LABEL_MIN_ZOOM}
          layout={{ 'text-field': ['get', 'label'], 'text-font': LABEL_FONT, 'text-size': 11, 'text-offset': [0, 1.5], 'text-anchor': 'top', 'text-optional': true }}
          paint={{ 'text-color': c.foreground, 'text-halo-color': c.card, 'text-halo-width': 1.5 }}
        />
      </GeoJSONSource>
      {children}
    </Map>
  );
});

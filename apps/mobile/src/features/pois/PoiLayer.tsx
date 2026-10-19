import { GeoJSONSource, Layer } from '@maplibre/maplibre-react-native';
import type { PoiDto } from '@veetracer/shared';
import { useMemo } from 'react';
import { useColors } from '@/lib/theme';

const LABEL_FONT = ['Noto Sans Bold'];
/** Names appear from this zoom (same as the vehicle labels). */
const LABEL_MIN_ZOOM = 13;

/** POIs as coloured pins (circles) with their names at street zoom; drawn under the vehicles. Child of FleetMap. */
export function PoiLayer({ pois, selectedId, onSelect }: { pois: PoiDto[]; selectedId?: string | null; onSelect?: (poi: PoiDto) => void }) {
  const c = useColors();
  const byId = useMemo(() => new Map(pois.map((p) => [p.id, p])), [pois]);
  const data = useMemo<GeoJSON.FeatureCollection>(
    () => ({
      type: 'FeatureCollection',
      features: pois.map((p) => ({
        type: 'Feature',
        id: p.id,
        geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
        properties: { id: p.id, name: p.name, color: p.color, selected: p.id === selectedId },
      })),
    }),
    [pois, selectedId],
  );
  return (
    <GeoJSONSource
      id="pois"
      data={data}
      hitbox={{ top: 10, bottom: 10, left: 10, right: 10 }}
      onPress={(e) => {
        e.stopPropagation();
        const id = e.nativeEvent.features[0]?.properties?.id;
        const poi = typeof id === 'string' ? byId.get(id) : undefined;
        if (poi) onSelect?.(poi);
      }}
    >
      <Layer
        id="pois-dot"
        type="circle"
        beforeId="vehicles-selected"
        paint={{
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, 3, 12, 6, 16, 8],
          'circle-color': ['get', 'color'],
          'circle-stroke-color': ['case', ['==', ['get', 'selected'], true], c.foreground, '#ffffff'],
          'circle-stroke-width': ['case', ['==', ['get', 'selected'], true], 3, 2],
        }}
      />
      <Layer
        id="pois-label"
        type="symbol"
        beforeId="vehicles-selected"
        minzoom={LABEL_MIN_ZOOM}
        layout={{ 'text-field': ['get', 'name'], 'text-font': LABEL_FONT, 'text-size': 11, 'text-offset': [0, 0.9], 'text-anchor': 'top', 'text-optional': true }}
        paint={{ 'text-color': ['get', 'color'], 'text-halo-color': c.card, 'text-halo-width': 1.5 }}
      />
    </GeoJSONSource>
  );
}

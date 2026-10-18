import type { GeofenceDto } from '@veetracer/shared';
import maplibregl, { type GeoJSONSource, type Map as MlMap, type MapLayerMouseEvent } from 'maplibre-gl';
import { geometryRing, labelPoint } from '@/features/geofences/geometry';
import { MODE_LABEL } from '@/features/geofences/api';
import { i18n } from '@/lib/i18n';
import { cssToken, LABEL_FONT, LAYERS } from '../map-style';
import { beneathMarkers, escapeHtml, keepAlive } from './addon';

const SRC = 'geofences';
const IDS = { fill: 'geofences-fill', line: 'geofences-line', lineNoGo: 'geofences-line-nogo', label: 'geofences-label' } as const;

/** Live-map geofence overlay: fill + outline + name label in each geofence's colour; click shows a popup. */
export class GeofenceLayer {
  private readonly map: MlMap;
  private data: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };
  private visible = false;
  private byId = new Map<string, GeofenceDto>();
  private popup: maplibregl.Popup | null = null;
  private readonly dispose: () => void;

  constructor(map: MlMap) {
    this.map = map;
    const stopKeepAlive = keepAlive(map, () => this.ensure());
    const onClick = (e: MapLayerMouseEvent) => this.onClick(e);
    map.on('click', IDS.fill, onClick);
    const enter = () => (map.getCanvas().style.cursor = 'pointer');
    const leave = () => (map.getCanvas().style.cursor = '');
    map.on('mouseenter', IDS.fill, enter);
    map.on('mouseleave', IDS.fill, leave);
    this.dispose = () => {
      stopKeepAlive();
      map.off('click', IDS.fill, onClick);
      map.off('mouseenter', IDS.fill, enter);
      map.off('mouseleave', IDS.fill, leave);
    };
  }

  destroy() {
    this.dispose();
    this.popup?.remove();
    try {
      for (const id of Object.values(IDS)) if (this.map.getLayer(id)) this.map.removeLayer(id);
      if (this.map.getSource(SRC)) this.map.removeSource(SRC);
    } catch {
      /* map already removed */
    }
  }

  setGeofences(list: GeofenceDto[]) {
    this.byId = new Map(list.map((g) => [g.id, g]));
    const features: GeoJSON.Feature[] = [];
    for (const g of list) {
      features.push({ type: 'Feature', id: g.id, geometry: { type: 'Polygon', coordinates: [geometryRing(g.geometry)] }, properties: { id: g.id, color: g.color, mode: g.mode } });
      const lp = labelPoint(g.geometry);
      features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [lp.lng, lp.lat] }, properties: { id: g.id, name: g.name, color: g.color, label: true } });
    }
    this.data = { type: 'FeatureCollection', features };
    this.map.getSource<GeoJSONSource>(SRC)?.setData(this.data);
  }

  setVisible(visible: boolean) {
    this.visible = visible;
    if (!visible) this.popup?.remove();
    for (const id of Object.values(IDS)) if (this.map.getLayer(id)) this.map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
  }

  /** Fits the camera to one geofence (deep link from the geofence list). */
  focus(id: string) {
    const g = this.byId.get(id);
    if (!g) return false;
    const ring = geometryRing(g.geometry, 16);
    const bounds = new maplibregl.LngLatBounds();
    for (const c of ring) bounds.extend(c);
    this.map.fitBounds(bounds, { padding: 120, maxZoom: 16, duration: 600 });
    return true;
  }

  private ensure() {
    const map = this.map;
    if (!map.getSource(SRC)) map.addSource(SRC, { type: 'geojson', data: this.data });
    if (map.getLayer(IDS.fill)) return;
    const before = beneathMarkers(map);
    const vis = this.visible ? 'visible' : 'none';
    const polygon: maplibregl.FilterSpecification = ['==', ['geometry-type'], 'Polygon'];
    map.addLayer({ id: IDS.fill, type: 'fill', source: SRC, filter: polygon, layout: { visibility: vis }, paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.12 } }, before);
    map.addLayer(
      { id: IDS.line, type: 'line', source: SRC, filter: ['all', polygon, ['!=', ['get', 'mode'], 'NO_GO']], layout: { visibility: vis }, paint: { 'line-color': ['get', 'color'], 'line-width': 1.75, 'line-opacity': 0.9 } },
      before,
    );
    map.addLayer(
      {
        id: IDS.lineNoGo,
        type: 'line',
        source: SRC,
        filter: ['all', polygon, ['==', ['get', 'mode'], 'NO_GO']],
        layout: { visibility: vis },
        paint: { 'line-color': ['get', 'color'], 'line-width': 2.25, 'line-dasharray': [2, 1.2] },
      },
      before,
    );
    map.addLayer(
      {
        id: IDS.label,
        type: 'symbol',
        source: SRC,
        filter: ['==', ['geometry-type'], 'Point'],
        minzoom: 11,
        layout: { visibility: vis, 'text-field': ['get', 'name'], 'text-font': LABEL_FONT, 'text-size': 11.5, 'text-optional': true },
        paint: { 'text-color': ['get', 'color'], 'text-halo-color': cssToken('--map-label-halo') || '#ffffff', 'text-halo-width': 1.6 },
      },
      before,
    );
  }

  private onClick(e: MapLayerMouseEvent) {
    // Vehicle markers take precedence over the zone underneath.
    const markerLayers = [LAYERS.circle, LAYERS.clusters].filter((l) => this.map.getLayer(l));
    if (markerLayers.length && this.map.queryRenderedFeatures(e.point, { layers: markerLayers }).length) return;
    const id = e.features?.[0]?.properties?.id as string | undefined;
    const g = id ? this.byId.get(id) : undefined;
    if (!g) return;
    const extras = [
      g.maxStayMin ? i18n.t('Max stay {{minutes}} min', { minutes: g.maxStayMin }) : null,
      g.speedLimitKph ? i18n.t('Zone limit {{speed}} km/h', { speed: g.speedLimitKph }) : null,
    ]
      .filter(Boolean)
      .join(' · ');
    this.popup?.remove();
    this.popup = new maplibregl.Popup({ closeButton: true, maxWidth: '260px', className: 'vt-popup' })
      .setLngLat(e.lngLat)
      .setHTML(
        `<div class="vt-popup-body"><div class="vt-popup-title"><span class="vt-dot" style="background:${escapeHtml(g.color)}"></span>${escapeHtml(g.name)}</div>` +
          `<div class="vt-popup-meta">${escapeHtml(i18n.t(MODE_LABEL[g.mode]))} · ${escapeHtml(g.branchName ?? i18n.t('Company-wide'))}</div>` +
          (extras ? `<div class="vt-popup-meta">${escapeHtml(extras)}</div>` : '') +
          `</div>`,
      )
      .addTo(this.map);
  }
}

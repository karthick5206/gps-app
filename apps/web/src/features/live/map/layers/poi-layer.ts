import type { PoiDto } from '@veetracer/shared';
import maplibregl, { type GeoJSONSource, type Map as MlMap, type MapLayerMouseEvent, type MapStyleImageMissingEvent } from 'maplibre-gl';
import { circleRing } from '@/features/geofences/geometry';
import { humanize } from '@/lib/format';
import { i18n } from '@/lib/i18n';
import { cssToken, LABEL_FONT, LAYERS } from '../map-style';
import { beneathMarkers, escapeHtml, keepAlive } from './addon';

const SRC = 'pois';
const IDS = { radius: 'pois-radius', pin: 'pois-pin' } as const;
const PIN_PREFIX = 'poi-pin-';
/** Names only from this zoom on (they'd clutter a city-wide view). */
const LABEL_MINZOOM = 13;
/** Radius circles from this zoom on. */
const RADIUS_MINZOOM = 14;

/** Draws a teardrop pin in `color` (2× pixel ratio): white outline and centre dot. */
function pinImage(color: string): { width: number; height: number; data: Uint8ClampedArray } | null {
  const w = 44;
  const h = 56;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const cx = w / 2;
  const cy = 20;
  const r = 16;
  ctx.beginPath();
  ctx.moveTo(cx, h - 3);
  ctx.bezierCurveTo(cx - 4, h - 16, cx - r, cy + 12, cx - r, cy);
  ctx.arc(cx, cy, r, Math.PI, 0);
  ctx.bezierCurveTo(cx + r, cy + 12, cx + 4, h - 16, cx, h - 3);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.shadowColor = 'rgba(0,0,0,0.3)';
  ctx.shadowBlur = 3;
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#ffffff';
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, 6, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  const img = ctx.getImageData(0, 0, w, h);
  return { width: w, height: h, data: img.data };
}

export interface PoiLayerOptions {
  categoryLabel: (code: string) => string;
}

/** Live-map POI overlay: pins in each POI's colour (names from zoom 13, radius circles from zoom 14); click shows a popup. */
export class PoiLayer {
  private readonly map: MlMap;
  private data: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };
  private visible = false;
  private byId = new Map<string, PoiDto>();
  private popup: maplibregl.Popup | null = null;
  private categoryLabel: (code: string) => string = (c) => i18n.t(humanize(c));
  private readonly dispose: () => void;

  constructor(map: MlMap) {
    this.map = map;
    // Pins are generated per colour on demand (also after basemap swaps, which drop images).
    const onMissing = (e: MapStyleImageMissingEvent) => {
      if (!e.id.startsWith(PIN_PREFIX) || map.hasImage(e.id)) return;
      const img = pinImage(e.id.slice(PIN_PREFIX.length));
      if (img) map.addImage(e.id, img, { pixelRatio: 2 });
    };
    map.on('styleimagemissing', onMissing);
    const stopKeepAlive = keepAlive(map, () => this.ensure());
    const onClick = (e: MapLayerMouseEvent) => this.onClick(e);
    map.on('click', IDS.pin, onClick);
    const enter = () => (map.getCanvas().style.cursor = 'pointer');
    const leave = () => (map.getCanvas().style.cursor = '');
    map.on('mouseenter', IDS.pin, enter);
    map.on('mouseleave', IDS.pin, leave);
    this.dispose = () => {
      stopKeepAlive();
      map.off('styleimagemissing', onMissing);
      map.off('click', IDS.pin, onClick);
      map.off('mouseenter', IDS.pin, enter);
      map.off('mouseleave', IDS.pin, leave);
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

  setCategoryLabel(fn: (code: string) => string) {
    this.categoryLabel = fn;
  }

  setPois(list: PoiDto[]) {
    this.byId = new Map(list.map((p) => [p.id, p]));
    const features: GeoJSON.Feature[] = [];
    for (const p of list) {
      const color = /^#[0-9a-fA-F]{6}$/.test(p.color) ? p.color.toLowerCase() : '#2563eb';
      features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [p.lng, p.lat] }, properties: { id: p.id, name: p.name, color, icon: `${PIN_PREFIX}${color}` } });
      features.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [circleRing(p, p.radiusM, 32)] }, properties: { id: p.id, color } });
    }
    this.data = { type: 'FeatureCollection', features };
    this.map.getSource<GeoJSONSource>(SRC)?.setData(this.data);
  }

  setVisible(visible: boolean) {
    this.visible = visible;
    if (!visible) this.popup?.remove();
    for (const id of Object.values(IDS)) if (this.map.getLayer(id)) this.map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
  }

  /** Centres on one POI and opens its popup (deep link from the POI list). */
  focus(id: string) {
    const p = this.byId.get(id);
    if (!p) return false;
    this.map.flyTo({ center: [p.lng, p.lat], zoom: Math.max(this.map.getZoom(), 16), duration: 600 });
    this.openPopup(p);
    return true;
  }

  private ensure() {
    const map = this.map;
    if (!map.getSource(SRC)) map.addSource(SRC, { type: 'geojson', data: this.data });
    if (map.getLayer(IDS.pin)) return;
    const before = beneathMarkers(map);
    const vis = this.visible ? 'visible' : 'none';
    map.addLayer(
      {
        id: IDS.radius,
        type: 'line',
        source: SRC,
        filter: ['==', ['geometry-type'], 'Polygon'],
        minzoom: RADIUS_MINZOOM,
        layout: { visibility: vis },
        paint: { 'line-color': ['get', 'color'], 'line-width': 1.25, 'line-opacity': 0.7, 'line-dasharray': [2, 1.5] },
      },
      before,
    );
    map.addLayer(
      {
        id: IDS.pin,
        type: 'symbol',
        source: SRC,
        filter: ['==', ['geometry-type'], 'Point'],
        layout: {
          visibility: vis,
          'icon-image': ['get', 'icon'],
          'icon-anchor': 'bottom',
          'icon-size': ['interpolate', ['linear'], ['zoom'], 8, 0.7, 14, 1],
          'icon-allow-overlap': true,
          'text-field': ['step', ['zoom'], '', LABEL_MINZOOM, ['get', 'name']],
          'text-font': LABEL_FONT,
          'text-size': 11.5,
          'text-anchor': 'top',
          'text-offset': [0, 0.2],
          'text-optional': true,
        },
        paint: { 'text-color': ['get', 'color'], 'text-halo-color': cssToken('--map-label-halo') || '#ffffff', 'text-halo-width': 1.6 },
      },
      before,
    );
  }

  private onClick(e: MapLayerMouseEvent) {
    // Vehicle markers take precedence.
    const markerLayers = [LAYERS.circle, LAYERS.clusters].filter((l) => this.map.getLayer(l));
    if (markerLayers.length && this.map.queryRenderedFeatures(e.point, { layers: markerLayers }).length) return;
    const id = e.features?.[0]?.properties?.id as string | undefined;
    const p = id ? this.byId.get(id) : undefined;
    if (p) this.openPopup(p);
  }

  private openPopup(p: PoiDto) {
    const meta = [this.categoryLabel(p.category), i18n.t('Radius {{radius}} m', { radius: p.radiusM }), p.branchName ?? i18n.t('Company-wide')].join(' · ');
    this.popup?.remove();
    this.popup = new maplibregl.Popup({ closeButton: true, maxWidth: '280px', className: 'vt-popup', offset: [0, -26] })
      .setLngLat([p.lng, p.lat])
      .setHTML(
        `<div class="vt-popup-body"><div class="vt-popup-title"><span class="vt-dot" style="background:${escapeHtml(p.color)}"></span>${escapeHtml(p.name)}</div>` +
          `<div class="vt-popup-meta">${escapeHtml(meta)}</div>` +
          (p.address ? `<div class="vt-popup-text">${escapeHtml(p.address)}</div>` : '') +
          (p.description ? `<div class="vt-popup-meta">${escapeHtml(p.description)}</div>` : '') +
          `</div>`,
      )
      .addTo(this.map);
  }
}

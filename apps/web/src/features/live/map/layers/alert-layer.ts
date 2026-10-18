import { ALERT_TYPE_MAP, type AlertDto } from '@veetracer/shared';
import maplibregl, { type GeoJSONSource, type Map as MlMap, type MapLayerMouseEvent } from 'maplibre-gl';
import { SEVERITY_COLOR, SEVERITY_LABEL } from '@/features/alerts/severity';
import { formatDateTime } from '@/lib/format';
import { LAYERS } from '../map-style';
import { escapeHtml, keepAlive } from './addon';

const SRC = 'alert-markers';
const IDS = { halo: 'alert-markers-halo', point: 'alert-markers-point' } as const;
const MAX = 500;

export interface AlertLayerOptions {
  onOpen: (a: AlertDto) => void;
}

/** Live-map alert markers (recent alerts + realtime), coloured by severity; unacknowledged ones get a halo. */
export class AlertLayer {
  private readonly map: MlMap;
  private readonly opts: AlertLayerOptions;
  private alerts = new Map<string, AlertDto>();
  private visible = false;
  private popup: maplibregl.Popup | null = null;
  private readonly dispose: () => void;

  constructor(map: MlMap, opts: AlertLayerOptions) {
    this.map = map;
    this.opts = opts;
    const stop = keepAlive(map, () => this.ensure());
    const onClick = (e: MapLayerMouseEvent) => this.onClick(e);
    map.on('click', IDS.point, onClick);
    const enter = () => (map.getCanvas().style.cursor = 'pointer');
    const leave = () => (map.getCanvas().style.cursor = '');
    map.on('mouseenter', IDS.point, enter);
    map.on('mouseleave', IDS.point, leave);
    this.dispose = () => {
      stop();
      map.off('click', IDS.point, onClick);
      map.off('mouseenter', IDS.point, enter);
      map.off('mouseleave', IDS.point, leave);
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

  setAlerts(list: AlertDto[]) {
    this.alerts = new Map(list.filter((a) => a.lat !== null && a.lng !== null).slice(0, MAX).map((a) => [a.id, a]));
    this.push();
  }

  upsert(a: AlertDto) {
    if (a.lat === null || a.lng === null) return;
    this.alerts.set(a.id, a);
    if (this.alerts.size > MAX) {
      const oldest = [...this.alerts.values()].sort((x, y) => x.occurredAt.localeCompare(y.occurredAt))[0];
      this.alerts.delete(oldest.id);
    }
    this.push();
  }

  setVisible(visible: boolean) {
    this.visible = visible;
    if (!visible) this.popup?.remove();
    for (const id of Object.values(IDS)) if (this.map.getLayer(id)) this.map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
  }

  private toData(): GeoJSON.FeatureCollection {
    return {
      type: 'FeatureCollection',
      features: [...this.alerts.values()].map((a) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [a.lng!, a.lat!] },
        properties: { id: a.id, color: SEVERITY_COLOR[a.severity], unread: a.status === 'NEW', rank: a.severity === 'CRITICAL' ? 2 : a.severity === 'WARNING' ? 1 : 0 },
      })),
    };
  }

  private push() {
    this.map.getSource<GeoJSONSource>(SRC)?.setData(this.toData());
  }

  private ensure() {
    const map = this.map;
    if (!map.getSource(SRC)) map.addSource(SRC, { type: 'geojson', data: this.toData() });
    if (map.getLayer(IDS.point)) {
      // Keep on top even when the vehicle layers were added after us (initial load order).
      const layers = map.getStyle().layers;
      if (layers[layers.length - 1]?.id !== IDS.point) {
        map.moveLayer(IDS.halo);
        map.moveLayer(IDS.point);
      }
      return;
    }
    // Above vehicle clusters/markers (alerts are sparse and small).
    const before = undefined;
    const vis = this.visible ? 'visible' : 'none';
    map.addLayer(
      {
        id: IDS.halo,
        type: 'circle',
        source: SRC,
        filter: ['==', ['get', 'unread'], true],
        layout: { visibility: vis },
        paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 8, 15, 13], 'circle-color': ['get', 'color'], 'circle-opacity': 0.22 },
      },
      before,
    );
    map.addLayer(
      {
        id: IDS.point,
        type: 'circle',
        source: SRC,
        layout: { visibility: vis, 'circle-sort-key': ['get', 'rank'] },
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 3.5, 15, 6],
          'circle-color': ['get', 'color'],
          'circle-stroke-width': 1.5,
          'circle-stroke-color': '#ffffff',
          'circle-opacity': ['case', ['get', 'unread'], 1, 0.6],
        },
      },
      before,
    );
  }

  private onClick(e: MapLayerMouseEvent) {
    const markerLayers = [LAYERS.circle].filter((l) => this.map.getLayer(l));
    if (markerLayers.length && this.map.queryRenderedFeatures(e.point, { layers: markerLayers }).length) return;
    const id = e.features?.[0]?.properties?.id as string | undefined;
    const a = id ? this.alerts.get(id) : undefined;
    if (!a) return;
    const el = document.createElement('div');
    el.className = 'vt-popup-body';
    el.innerHTML =
      `<div class="vt-popup-title"><span class="vt-dot" style="background:${SEVERITY_COLOR[a.severity]}"></span>${escapeHtml(ALERT_TYPE_MAP[a.type]?.label ?? a.type)}</div>` +
      `<div class="vt-popup-meta">${escapeHtml(SEVERITY_LABEL[a.severity])} · ${escapeHtml(a.objectName)} · ${escapeHtml(formatDateTime(a.occurredAt))}</div>` +
      `<div class="vt-popup-text">${escapeHtml(a.message)}</div>` +
      (a.status !== 'NEW' ? `<div class="vt-popup-meta">Acknowledged${a.ackByName ? ` by ${escapeHtml(a.ackByName)}` : ''}</div>` : '');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'vt-popup-link';
    btn.textContent = 'Open alert';
    btn.onclick = () => this.opts.onOpen(a);
    el.appendChild(btn);
    this.popup?.remove();
    this.popup = new maplibregl.Popup({ closeButton: true, maxWidth: '280px', className: 'vt-popup' }).setLngLat([a.lng!, a.lat!]).setDOMContent(el).addTo(this.map);
  }
}

import type { PhotoNoteCategory, PhotoNoteDto } from '@veetracer/shared';
import type { GeoJSONSource, Map as MlMap, MapLayerMouseEvent, MapStyleImageMissingEvent } from 'maplibre-gl';
import { LAYERS } from '../map-style';
import { beneathMarkers, keepAlive } from './addon';

const SRC = 'photo-notes';
const PIN_LAYER = 'photo-notes-pin';
const PIN_PREFIX = 'photo-note-pin-';

/** Pin colour per category (bills / receipts warm, visits green, other blue). */
export const PHOTO_NOTE_PIN_COLORS: Record<PhotoNoteCategory, string> = {
  BILL: '#d97706',
  RECEIPT: '#c2410c',
  VISIT: '#059669',
  OTHER: '#2563eb',
};

/** Draws a teardrop pin in `color` with a white camera glyph (2× pixel ratio). */
function cameraPinImage(color: string): { width: number; height: number; data: Uint8ClampedArray } | null {
  const w = 48;
  const h = 60;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const cx = w / 2;
  const cy = 21;
  const r = 18;
  ctx.beginPath();
  ctx.moveTo(cx, h - 3);
  ctx.bezierCurveTo(cx - 4, h - 16, cx - r, cy + 13, cx - r, cy);
  ctx.arc(cx, cy, r, Math.PI, 0);
  ctx.bezierCurveTo(cx + r, cy + 13, cx + 4, h - 16, cx, h - 3);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.shadowColor = 'rgba(0,0,0,0.3)';
  ctx.shadowBlur = 3;
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#ffffff';
  ctx.stroke();
  // Camera body with a viewfinder bump and a lens.
  ctx.fillStyle = '#ffffff';
  const bw = 20;
  const bh = 14;
  const bx = cx - bw / 2;
  const by = cy - bh / 2 + 1;
  ctx.beginPath();
  ctx.roundRect(bx, by, bw, bh, 3);
  ctx.fill();
  ctx.beginPath();
  ctx.roundRect(cx - 4.5, by - 3.5, 9, 5, 1.5);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx, by + bh / 2, 4.6, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx, by + bh / 2, 2.2, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  const img = ctx.getImageData(0, 0, w, h);
  return { width: w, height: h, data: img.data };
}

export interface PhotoNoteLayerOptions {
  onOpen(note: PhotoNoteDto): void;
  /**
   * Keep the pins above every other layer (maps without vehicle-marker layers, e.g. history playback, whose own layers
   * are added after this one). Default: below the live map's vehicle markers.
   */
  onTop?: boolean;
}

/** Camera pins of location photo notes (colour per category); a click hands the note to `onOpen` (the lightbox). */
export class PhotoNoteLayer {
  private readonly map: MlMap;
  private readonly opts: PhotoNoteLayerOptions;
  private data: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };
  private visible = false;
  private byId = new Map<string, PhotoNoteDto>();
  private readonly dispose: () => void;

  constructor(map: MlMap, opts: PhotoNoteLayerOptions) {
    this.map = map;
    this.opts = opts;
    // Pins are drawn per colour on demand (also after basemap swaps, which drop images).
    const onMissing = (e: MapStyleImageMissingEvent) => {
      if (!e.id.startsWith(PIN_PREFIX) || map.hasImage(e.id)) return;
      const img = cameraPinImage(e.id.slice(PIN_PREFIX.length));
      if (img) map.addImage(e.id, img, { pixelRatio: 2 });
    };
    map.on('styleimagemissing', onMissing);
    const stopKeepAlive = keepAlive(map, () => this.ensure());
    const onClick = (e: MapLayerMouseEvent) => this.onClick(e);
    map.on('click', PIN_LAYER, onClick);
    const enter = () => (map.getCanvas().style.cursor = 'pointer');
    const leave = () => (map.getCanvas().style.cursor = '');
    map.on('mouseenter', PIN_LAYER, enter);
    map.on('mouseleave', PIN_LAYER, leave);
    this.dispose = () => {
      stopKeepAlive();
      map.off('styleimagemissing', onMissing);
      map.off('click', PIN_LAYER, onClick);
      map.off('mouseenter', PIN_LAYER, enter);
      map.off('mouseleave', PIN_LAYER, leave);
    };
  }

  destroy() {
    try {
      this.dispose();
      if (this.map.getLayer(PIN_LAYER)) this.map.removeLayer(PIN_LAYER);
      if (this.map.getSource(SRC)) this.map.removeSource(SRC);
    } catch {
      /* map already removed */
    }
  }

  setNotes(list: PhotoNoteDto[]) {
    this.byId = new Map(list.map((n) => [n.id, n]));
    // Oldest first, so the newest pin is drawn on top where several overlap.
    const sorted = [...list].sort((a, b) => a.takenAt.localeCompare(b.takenAt));
    this.data = {
      type: 'FeatureCollection',
      features: sorted.map((n) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [n.lng, n.lat] },
        properties: { id: n.id, icon: `${PIN_PREFIX}${PHOTO_NOTE_PIN_COLORS[n.category] ?? PHOTO_NOTE_PIN_COLORS.OTHER}` },
      })),
    };
    this.map.getSource<GeoJSONSource>(SRC)?.setData(this.data);
  }

  setVisible(visible: boolean) {
    this.visible = visible;
    if (this.map.getLayer(PIN_LAYER)) this.map.setLayoutProperty(PIN_LAYER, 'visibility', visible ? 'visible' : 'none');
  }

  /** [[minLng, minLat], [maxLng, maxLat]] of the notes shown, or null when there are none. */
  bounds(): [[number, number], [number, number]] | null {
    let b: [[number, number], [number, number]] | null = null;
    for (const n of this.byId.values()) {
      if (!b) b = [[n.lng, n.lat], [n.lng, n.lat]];
      else {
        b[0][0] = Math.min(b[0][0], n.lng);
        b[0][1] = Math.min(b[0][1], n.lat);
        b[1][0] = Math.max(b[1][0], n.lng);
        b[1][1] = Math.max(b[1][1], n.lat);
      }
    }
    return b;
  }

  private ensure() {
    const map = this.map;
    if (!map.getSource(SRC)) map.addSource(SRC, { type: 'geojson', data: this.data });
    if (map.getLayer(PIN_LAYER)) {
      // On top: move above layers the host added since (only when not already last, so this doesn't loop).
      if (this.opts.onTop) {
        const order = map.getLayersOrder();
        if (order[order.length - 1] !== PIN_LAYER) map.moveLayer(PIN_LAYER);
      }
      return;
    }
    map.addLayer(
      {
        id: PIN_LAYER,
        type: 'symbol',
        source: SRC,
        layout: {
          visibility: this.visible ? 'visible' : 'none',
          'icon-image': ['get', 'icon'],
          'icon-anchor': 'bottom',
          'icon-size': ['interpolate', ['linear'], ['zoom'], 8, 0.7, 14, 1],
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
        },
      },
      this.opts.onTop ? undefined : beneathMarkers(map),
    );
  }

  private onClick(e: MapLayerMouseEvent) {
    // Vehicle markers take precedence on the live map.
    const markerLayers = [LAYERS.circle, LAYERS.clusters].filter((l) => this.map.getLayer(l));
    if (markerLayers.length && this.map.queryRenderedFeatures(e.point, { layers: markerLayers }).length) return;
    // The top-most pin under the pointer (features come top-first).
    const id = e.features?.[0]?.properties?.id as string | undefined;
    const n = id ? this.byId.get(id) : undefined;
    if (n) this.opts.onOpen(n);
  }
}

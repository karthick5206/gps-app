import type { GeoJSONSource, Map as MlMap, MapMouseEvent, MapTouchEvent, PointLike } from 'maplibre-gl';
import {
  circleRing,
  clampRadius,
  closedRing,
  destination,
  haversineM,
  rectangleFromCorners,
  translate,
  type Geometry,
  type Pt,
} from '../geometry';
import { cssToken } from '@/features/live/map/map-style';

export type DrawMode = 'none' | 'circle' | 'polygon' | 'rectangle';

const SRC_SHAPE = 'gfd-shape';
const SRC_DRAFT = 'gfd-draft';
const SRC_HANDLES = 'gfd-handles';
const L = {
  fill: 'gfd-fill',
  outline: 'gfd-outline',
  draft: 'gfd-draft-line',
  mid: 'gfd-mid',
  handle: 'gfd-handle',
  radiusLabel: 'gfd-radius-label',
} as const;

/** Radius used when the user just clicks (no drag) in circle mode. */
const CLICK_RADIUS_M = 200;
/** Pixel tolerance for "close the polygon by clicking the first point" and duplicate-click detection. */
const SNAP_PX = 10;

type HandleKind = 'vertex' | 'mid' | 'center' | 'radius';

type Drag =
  | { kind: 'create-circle'; center: Pt }
  | { kind: 'create-rect'; start: Pt }
  | { kind: 'vertex'; index: number }
  | { kind: 'mid'; index: number }
  | { kind: 'center' }
  | { kind: 'radius' }
  | { kind: 'move'; last: Pt };

type PointerEvt = (MapMouseEvent | MapTouchEvent) & { point: { x: number; y: number } };

export interface GeofenceDrawOptions {
  map: MlMap;
  color: string;
  onChange: (g: Geometry | null) => void;
  onModeChange: (m: DrawMode) => void;
  /** Number of points placed while drafting a polygon (for toolbar hints). */
  onDraftChange?: (points: number) => void;
}

const toPt = (e: { lngLat: { lat: number; lng: number } }): Pt => ({ lat: e.lngLat.lat, lng: e.lngLat.lng });

/**
 * Imperative circle / polygon / rectangle drawing and editing on a MapLibre map using GeoJSON sources and
 * map pointer events (mouse + touch). Owned by the geofence editor; React pushes state in via methods.
 *
 * - Circle: press at the centre and drag out the radius (a plain click uses 200 m). Drag the centre to move,
 *   the edge handle to resize.
 * - Polygon: click to add points; double-click, Enter, or click the first point to finish; Backspace removes the
 *   last point; Escape cancels. Drag vertices; drag a midpoint to insert a vertex; right-click a vertex (or select it
 *   and press Delete) to remove it.
 * - Rectangle: press and drag between opposite corners; drag a corner to resize.
 * - Drag inside the shape to move it.
 */
export class GeofenceDraw {
  private readonly map: MlMap;
  private readonly opts: GeofenceDrawOptions;
  private geometry: Geometry | null = null;
  private mode: DrawMode = 'none';
  private draft: Pt[] = [];
  private hover: Pt | null = null;
  private drag: Drag | null = null;
  private selectedVertex: number | null = null;
  private color: string;
  private readonly disposers: (() => void)[] = [];

  constructor(opts: GeofenceDrawOptions) {
    this.opts = opts;
    this.map = opts.map;
    this.color = opts.color;
    const map = this.map;
    const on = <K extends string>(type: K, fn: (e: never) => void) => {
      map.on(type as 'mousedown', fn as (e: MapMouseEvent) => void);
      this.disposers.push(() => map.off(type as 'mousedown', fn as (e: MapMouseEvent) => void));
    };
    on('style.load', () => this.ensureLayers());
    on('mousedown', (e: MapMouseEvent) => this.onDown(e));
    on('touchstart', (e: MapTouchEvent) => {
      if (e.points.length === 1) this.onDown(e);
    });
    on('mousemove', (e: MapMouseEvent) => this.onMove(e));
    on('touchmove', (e: MapTouchEvent) => this.onMove(e));
    on('mouseup', (e: MapMouseEvent) => this.onUp(e));
    on('touchend', (e: MapTouchEvent) => this.onUp(e));
    on('click', (e: MapMouseEvent) => this.onClick(e));
    on('dblclick', (e: MapMouseEvent) => this.onDblClick(e));
    on('contextmenu', (e: MapMouseEvent) => this.onContextMenu(e));
    const key = (e: KeyboardEvent) => this.onKey(e);
    window.addEventListener('keydown', key);
    this.disposers.push(() => window.removeEventListener('keydown', key));
    if (map.isStyleLoaded()) this.ensureLayers();
    else map.once('load', () => this.ensureLayers());
  }

  destroy() {
    this.disposers.forEach((d) => d());
    this.restoreInteractions();
  }

  getGeometry() {
    return this.geometry;
  }

  getMode() {
    return this.mode;
  }

  setColor(color: string) {
    this.color = color;
    if (!this.map.getLayer(L.fill)) return;
    this.map.setPaintProperty(L.fill, 'fill-color', color);
    this.map.setPaintProperty(L.outline, 'line-color', color);
    this.map.setPaintProperty(L.draft, 'line-color', color);
    this.map.setPaintProperty(L.handle, 'circle-stroke-color', color);
    this.map.setPaintProperty(L.mid, 'circle-color', color);
  }

  /** Replaces the geometry from outside (form input, initial load). Does not emit onChange. */
  setGeometry(g: Geometry | null) {
    this.geometry = g;
    this.selectedVertex = null;
    this.render();
  }

  setMode(mode: DrawMode) {
    this.mode = mode;
    this.draft = [];
    this.hover = null;
    this.drag = null;
    this.selectedVertex = null;
    const canvas = this.map.getCanvasContainer();
    canvas.style.cursor = mode === 'none' ? '' : 'crosshair';
    if (mode === 'polygon') this.map.doubleClickZoom.disable();
    else this.map.doubleClickZoom.enable();
    this.opts.onModeChange(mode);
    this.opts.onDraftChange?.(0);
    this.render();
  }

  /** Finishes an in-progress polygon (toolbar "Finish" button). */
  finishPolygon() {
    if (this.mode !== 'polygon') return;
    const pts = this.dedupe(this.draft);
    if (pts.length < 3) return;
    this.commit({ type: 'POLYGON', points: pts });
  }

  undoPoint() {
    if (this.mode !== 'polygon' || !this.draft.length) return;
    this.draft = this.draft.slice(0, -1);
    this.opts.onDraftChange?.(this.draft.length);
    this.render();
  }

  deleteSelectedVertex() {
    if (this.selectedVertex === null) return;
    this.removeVertex(this.selectedVertex);
  }

  fitToGeometry(padding = 60) {
    const g = this.geometry;
    if (!g) return;
    const ring = g.type === 'CIRCLE' ? circleRing(g.center, g.radiusM, 16) : closedRing(g.points);
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
    for (const [lng, lat] of ring) {
      w = Math.min(w, lng); e = Math.max(e, lng); s = Math.min(s, lat); n = Math.max(n, lat);
    }
    this.map.fitBounds([[w, s], [e, n]], { padding, maxZoom: 17, duration: 0 });
  }

  // ---- layers -------------------------------------------------------------------------------------

  private ensureLayers() {
    const map = this.map;
    const empty: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };
    for (const id of [SRC_SHAPE, SRC_DRAFT, SRC_HANDLES]) if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data: empty });
    if (!map.getLayer(L.fill)) {
      map.addLayer({ id: L.fill, type: 'fill', source: SRC_SHAPE, paint: { 'fill-color': this.color, 'fill-opacity': 0.18 } });
      map.addLayer({ id: L.outline, type: 'line', source: SRC_SHAPE, paint: { 'line-color': this.color, 'line-width': 2.5 } });
      map.addLayer({
        id: L.draft,
        type: 'line',
        source: SRC_DRAFT,
        paint: { 'line-color': this.color, 'line-width': 2, 'line-dasharray': [2, 1.5] },
      });
      map.addLayer({
        id: L.mid,
        type: 'circle',
        source: SRC_HANDLES,
        filter: ['==', ['get', 'kind'], 'mid'],
        paint: { 'circle-radius': 4.5, 'circle-color': this.color, 'circle-opacity': 0.55, 'circle-stroke-width': 1.5, 'circle-stroke-color': '#ffffff' },
      });
      map.addLayer({
        id: L.handle,
        type: 'circle',
        source: SRC_HANDLES,
        filter: ['!=', ['get', 'kind'], 'mid'],
        paint: {
          'circle-radius': ['case', ['boolean', ['get', 'selected'], false], 8, 6.5],
          'circle-color': ['case', ['boolean', ['get', 'selected'], false], this.color, '#ffffff'],
          'circle-stroke-width': 2.5,
          'circle-stroke-color': this.color,
        },
      });
      map.addLayer({
        id: L.radiusLabel,
        type: 'symbol',
        source: SRC_HANDLES,
        filter: ['==', ['get', 'kind'], 'radius'],
        layout: {
          'text-field': ['get', 'label'],
          'text-font': [import.meta.env.VITE_MAP_FONT || 'Noto Sans Bold'],
          'text-size': 12,
          'text-offset': [0, -1.4],
          'text-allow-overlap': true,
        },
        paint: { 'text-color': cssToken('--map-label') || '#0f1d2b', 'text-halo-color': cssToken('--map-label-halo') || '#ffffff', 'text-halo-width': 1.5 },
      });
    }
    this.render();
  }

  private src(id: string) {
    return this.map.getSource<GeoJSONSource>(id);
  }

  private render() {
    const shape = this.src(SRC_SHAPE);
    const draftSrc = this.src(SRC_DRAFT);
    const handles = this.src(SRC_HANDLES);
    if (!shape || !draftSrc || !handles) return;
    const g = this.geometry;
    const shapeFeatures: GeoJSON.Feature[] = [];
    const handleFeatures: GeoJSON.Feature[] = [];
    const draftFeatures: GeoJSON.Feature[] = [];
    const point = (p: Pt, props: Record<string, unknown>): GeoJSON.Feature => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [p.lng, p.lat] }, properties: props });

    if (g && this.mode === 'none') {
      shapeFeatures.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [g.type === 'CIRCLE' ? circleRing(g.center, g.radiusM) : closedRing(g.points)] }, properties: {} });
      if (g.type === 'CIRCLE') {
        handleFeatures.push(point(g.center, { kind: 'center' }));
        handleFeatures.push(point(destination(g.center, g.radiusM, 90), { kind: 'radius', label: formatM(g.radiusM) }));
      } else {
        g.points.forEach((p, i) => handleFeatures.push(point(p, { kind: 'vertex', index: i, selected: i === this.selectedVertex })));
        if (g.type === 'POLYGON' && g.points.length < 500) {
          g.points.forEach((p, i) => {
            const q = g.points[(i + 1) % g.points.length];
            handleFeatures.push(point({ lat: (p.lat + q.lat) / 2, lng: (p.lng + q.lng) / 2 }, { kind: 'mid', index: i }));
          });
        }
      }
    }

    // In-progress drawing previews
    const d = this.drag;
    if (d?.kind === 'create-circle' && this.hover) {
      const r = haversineM(d.center, this.hover);
      shapeFeatures.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [circleRing(d.center, Math.max(r, 1))] }, properties: {} });
      handleFeatures.push(point(d.center, { kind: 'center' }));
      handleFeatures.push(point(this.hover, { kind: 'radius', label: formatM(r) }));
    }
    if (d?.kind === 'create-rect' && this.hover) {
      shapeFeatures.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [closedRing(rectangleFromCorners(d.start, this.hover))] }, properties: {} });
    }
    if (this.mode === 'polygon' && this.draft.length) {
      const line = [...this.draft, ...(this.hover ? [this.hover] : [])].map((p) => [p.lng, p.lat]);
      if (this.draft.length >= 2 && this.hover) line.push([this.draft[0].lng, this.draft[0].lat]);
      draftFeatures.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: line }, properties: {} });
      this.draft.forEach((p, i) => handleFeatures.push(point(p, { kind: 'vertex', index: i, selected: i === 0 && this.draft.length >= 3 })));
    }

    shape.setData({ type: 'FeatureCollection', features: shapeFeatures });
    draftSrc.setData({ type: 'FeatureCollection', features: draftFeatures });
    handles.setData({ type: 'FeatureCollection', features: handleFeatures });
  }

  // ---- interaction --------------------------------------------------------------------------------

  private hitHandle(point: PointLike): { kind: HandleKind; index: number } | null {
    if (!this.map.getLayer(L.handle)) return null;
    const box: [PointLike, PointLike] = [
      [(point as { x: number }).x - 8, (point as { y: number }).y - 8],
      [(point as { x: number }).x + 8, (point as { y: number }).y + 8],
    ];
    const hits = this.map.queryRenderedFeatures(box, { layers: [L.handle, L.mid] });
    // Prefer real handles over midpoints.
    const f = hits.find((h) => h.properties?.kind !== 'mid') ?? hits[0];
    if (!f) return null;
    return { kind: f.properties.kind as HandleKind, index: Number(f.properties.index ?? -1) };
  }

  private hitShape(point: PointLike): boolean {
    if (!this.map.getLayer(L.fill)) return false;
    return this.map.queryRenderedFeatures(point, { layers: [L.fill] }).length > 0;
  }

  private beginDrag(drag: Drag, e: PointerEvt) {
    this.drag = drag;
    e.preventDefault();
    this.map.dragPan.disable();
  }

  private restoreInteractions() {
    try {
      this.map.dragPan.enable();
      this.map.doubleClickZoom.enable();
    } catch {
      /* map already removed */
    }
  }

  private onDown(e: PointerEvt) {
    if ('originalEvent' in e && e.originalEvent instanceof MouseEvent && e.originalEvent.button !== 0) return;
    const p = toPt(e);
    if (this.mode === 'circle') return this.beginDrag({ kind: 'create-circle', center: p }, e);
    if (this.mode === 'rectangle') return this.beginDrag({ kind: 'create-rect', start: p }, e);
    if (this.mode !== 'none' || !this.geometry) return;
    const h = this.hitHandle(e.point);
    if (h) {
      if (h.kind === 'vertex') {
        this.selectedVertex = h.index;
        this.beginDrag({ kind: 'vertex', index: h.index }, e);
      } else if (h.kind === 'mid') this.beginDrag({ kind: 'mid', index: h.index }, e);
      else if (h.kind === 'center') this.beginDrag({ kind: 'center' }, e);
      else this.beginDrag({ kind: 'radius' }, e);
      this.render();
      return;
    }
    if (this.hitShape(e.point)) {
      this.selectedVertex = null;
      this.beginDrag({ kind: 'move', last: p }, e);
    }
  }

  private onMove(e: PointerEvt) {
    const p = toPt(e);
    const d = this.drag;
    if (!d) {
      if (this.mode === 'polygon') {
        this.hover = p;
        this.render();
      } else if (this.mode === 'none' && this.geometry) {
        const h = this.hitHandle(e.point);
        this.map.getCanvasContainer().style.cursor = h ? (h.kind === 'mid' ? 'copy' : 'grab') : this.hitShape(e.point) ? 'move' : '';
      }
      return;
    }
    const g = this.geometry;
    switch (d.kind) {
      case 'create-circle':
      case 'create-rect':
        this.hover = p;
        break;
      case 'vertex':
        if (g && g.type !== 'CIRCLE') {
          if (g.type === 'RECTANGLE') {
            const opposite = g.points[(d.index + 2) % 4];
            const rect = rectangleFromCorners(p, opposite);
            // Keep dragging the corner nearest the pointer after re-normalisation.
            const idx = nearestIndex(rect, p);
            this.geometry = { type: 'RECTANGLE', points: rect };
            this.drag = { kind: 'vertex', index: idx };
            this.selectedVertex = idx;
          } else {
            const pts = g.points.slice();
            pts[d.index] = p;
            this.geometry = { type: 'POLYGON', points: pts };
          }
        }
        break;
      case 'mid':
        if (g && g.type === 'POLYGON') {
          const pts = g.points.slice();
          pts.splice(d.index + 1, 0, p);
          this.geometry = { type: 'POLYGON', points: pts };
          this.drag = { kind: 'vertex', index: d.index + 1 };
          this.selectedVertex = d.index + 1;
        }
        break;
      case 'center':
        if (g && g.type === 'CIRCLE') this.geometry = { ...g, center: p };
        break;
      case 'radius':
        if (g && g.type === 'CIRCLE') this.geometry = { ...g, radiusM: clampRadius(haversineM(g.center, p)) };
        break;
      case 'move':
        if (g) {
          this.geometry = translate(g, p.lat - d.last.lat, p.lng - d.last.lng);
          this.drag = { kind: 'move', last: p };
        }
        break;
    }
    this.render();
  }

  private onUp(e: PointerEvt) {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    this.map.dragPan.enable();
    const p = this.hover ?? toPt(e);
    if (d.kind === 'create-circle') {
      const r = haversineM(d.center, p);
      const radiusM = r < 15 ? CLICK_RADIUS_M : clampRadius(r);
      this.hover = null;
      this.commit({ type: 'CIRCLE', center: d.center, radiusM });
      return;
    }
    if (d.kind === 'create-rect') {
      this.hover = null;
      const a = this.map.project([d.start.lng, d.start.lat]);
      const b = this.map.project([p.lng, p.lat]);
      if (Math.abs(a.x - b.x) < 6 || Math.abs(a.y - b.y) < 6) {
        // Plain click: a 200 m square around the point.
        const ne = destination(destination(d.start, CLICK_RADIUS_M, 0), CLICK_RADIUS_M, 90);
        const sw = destination(destination(d.start, CLICK_RADIUS_M, 180), CLICK_RADIUS_M, 270);
        this.commit({ type: 'RECTANGLE', points: rectangleFromCorners(ne, sw) });
      } else this.commit({ type: 'RECTANGLE', points: rectangleFromCorners(d.start, p) });
      return;
    }
    this.render();
    if (this.geometry) this.opts.onChange(this.geometry);
  }

  private onClick(e: MapMouseEvent) {
    if (this.mode !== 'polygon') return;
    const p = toPt(e);
    if (this.draft.length >= 3) {
      const first = this.map.project([this.draft[0].lng, this.draft[0].lat]);
      if (Math.hypot(first.x - e.point.x, first.y - e.point.y) <= SNAP_PX) {
        this.finishPolygon();
        return;
      }
    }
    const last = this.draft[this.draft.length - 1];
    if (last) {
      const lp = this.map.project([last.lng, last.lat]);
      if (Math.hypot(lp.x - e.point.x, lp.y - e.point.y) < 3) return; // second click of a double-click
    }
    this.draft = [...this.draft, p];
    this.opts.onDraftChange?.(this.draft.length);
    this.render();
  }

  private onDblClick(e: MapMouseEvent) {
    if (this.mode !== 'polygon') return;
    e.preventDefault();
    this.finishPolygon();
  }

  private onContextMenu(e: MapMouseEvent) {
    if (this.mode === 'polygon' && this.draft.length) {
      e.preventDefault();
      this.undoPoint();
      return;
    }
    if (this.mode !== 'none') return;
    const h = this.hitHandle(e.point);
    if (h?.kind === 'vertex') {
      e.preventDefault();
      this.removeVertex(h.index);
    }
  }

  private onKey(e: KeyboardEvent) {
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
    if (this.mode === 'polygon') {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.finishPolygon();
      } else if (e.key === 'Backspace') {
        e.preventDefault();
        this.undoPoint();
      } else if (e.key === 'Escape' && this.draft.length) {
        e.preventDefault();
        e.stopPropagation();
        this.setMode('none');
      }
      return;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && this.selectedVertex !== null) {
      e.preventDefault();
      this.removeVertex(this.selectedVertex);
    }
  }

  private removeVertex(index: number) {
    const g = this.geometry;
    if (!g || g.type !== 'POLYGON' || g.points.length <= 3) return;
    this.geometry = { type: 'POLYGON', points: g.points.filter((_, i) => i !== index) };
    this.selectedVertex = null;
    this.render();
    this.opts.onChange(this.geometry);
  }

  private dedupe(points: Pt[]): Pt[] {
    const out: Pt[] = [];
    for (const p of points) {
      const last = out[out.length - 1];
      if (last && haversineM(last, p) < 0.5) continue;
      out.push(p);
    }
    return out;
  }

  private commit(g: Geometry) {
    this.geometry = g;
    this.draft = [];
    this.hover = null;
    this.mode = 'none';
    this.map.getCanvasContainer().style.cursor = '';
    this.map.doubleClickZoom.enable();
    this.opts.onModeChange('none');
    this.opts.onDraftChange?.(0);
    this.render();
    this.opts.onChange(g);
  }
}

function nearestIndex(points: Pt[], p: Pt): number {
  let best = 0;
  let bestD = Infinity;
  points.forEach((q, i) => {
    const d = (q.lat - p.lat) ** 2 + (q.lng - p.lng) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}

function formatM(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`;
}

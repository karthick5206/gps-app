import { displayStatus, type LiveObject } from '@veetracer/shared';
import maplibregl, { type GeoJSONSource, type GeoJSONSourceDiff, type Map as MlMap } from 'maplibre-gl';
import type { ResolvedTheme } from '@/features/theme/theme-store';
import { interpolatePose, type Pose } from '@/lib/geo';
import { liveStore, type LiveEvent } from '../live-store';
import { displayStore } from '@/features/display/display-store';
import {
  ARROW_IMAGE,
  CLUSTER_MAX_ZOOM,
  CLUSTER_THRESHOLD,
  LABEL_FONT,
  LABEL_MIN_ZOOM,
  LAYERS,
  SOURCE_ID,
  createArrowImage,
  cssToken,
  statusColorExpression,
  keepOwnLayers,
  styleUrl,
} from './map-style';
import { createVehicleIcon, iconKind, parseIconId, rotates } from './vehicle-icons';

const GLIDE_MS = 1000;
const FRAME_MS = 1000 / 30; // source updates capped at 30 fps
const MAX_ANIMATED = 1000;
const DEFAULT_CENTER: [number, number] = [80.24, 13.07];

type Feature = GeoJSON.Feature<GeoJSON.Point>;

interface Glide {
  from: Pose;
  to: Pose;
  start: number;
}

export interface MapControllerOptions {
  container: HTMLElement;
  theme: ResolvedTheme;
  reducedMotion: boolean;
  onSelect: (objectId: string) => void;
  /** Called when the user pans the map while following, which ends follow mode. */
  onFollowInterrupted: () => void;
}

function hasCoords(o: LiveObject): o is LiveObject & { lat: number; lng: number } {
  return o.lat !== null && o.lng !== null;
}

function properties(o: LiveObject, bearing: number) {
  const kind = iconKind(o);
  const rotating = rotates(kind);
  return {
    id: o.objectId,
    status: displayStatus(o),
    label: o.plateNumber || o.name,
    kind,
    rotating,
    bearing,
    /** Icon rotation: vehicles point along their heading; round badges stay upright. */
    rot: rotating ? bearing : 0,
    moving: o.status === 'RUNNING' || o.status === 'OVERSPEED',
  };
}

/** `veh:<kind>:<status>:<theme>` image per feature (images are drawn on demand, see vehicle-icons). */
function iconImageExpression(theme: ResolvedTheme): maplibregl.ExpressionSpecification {
  return ['concat', 'veh:', ['get', 'kind'], ':', ['get', 'status'], ':', theme];
}

/**
 * Owns the MapLibre map imperatively: created once, fed from the live store, never re-created by React.
 * Markers live in one GeoJSON source; positional changes go through `updateData` diffs and glide with
 * requestAnimationFrame (≤30 fps, viewport-only, skipped above 1,000 movers or with reduced motion).
 */
/** Vehicle marker size by zoom (about 30 % larger than before), times the user's map icon size. */
function vehicleIconSize(scale: number): maplibregl.ExpressionSpecification {
  return ['interpolate', ['linear'], ['zoom'], 5, 0.6 * scale, 10, 0.85 * scale, 14, 1.1 * scale, 17, 1.4 * scale];
}
function arrowIconSize(scale: number): maplibregl.ExpressionSpecification {
  return ['interpolate', ['linear'], ['zoom'], 8, 0.7 * scale, 14, 1 * scale];
}

export class MapController {
  private readonly map: MlMap;
  private readonly opts: MapControllerOptions;
  private theme: ResolvedTheme;
  private reducedMotion: boolean;
  private loaded = false;
  private predicate: (o: LiveObject) => boolean = () => true;
  private visible = new Set<string>();
  private display = new Map<string, Pose>();
  private glides = new Map<string, Glide>();
  private clustered = false;
  private selectedId: string | null = null;
  private followId: string | null = null;
  private raf = 0;
  private lastFrame = 0;
  private fittedOnce = false;
  private unsubscribe: () => void;

  constructor(opts: MapControllerOptions) {
    this.opts = opts;
    this.theme = opts.theme;
    this.reducedMotion = opts.reducedMotion;
    this.map = new maplibregl.Map({
      container: opts.container,
      style: styleUrl(opts.theme),
      center: DEFAULT_CENTER,
      zoom: 11,
      attributionControl: { compact: true },
      fadeDuration: 0,
    });
    this.map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), 'bottom-right');
    this.map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
    this.map.on('load', () => this.onLoad());
    // Basemap style swaps (theme changes) drop runtime images; re-register the arrow on demand.
    this.map.on('styleimagemissing', (e) => {
      if (this.map.hasImage(e.id)) return;
      if (e.id === ARROW_IMAGE) {
        this.map.addImage(ARROW_IMAGE, createArrowImage(), { sdf: true, pixelRatio: 2 });
        return;
      }
      // Vehicle-type icons are drawn the first time a type/status/theme combination is shown.
      const icon = parseIconId(e.id);
      if (icon) this.map.addImage(e.id, createVehicleIcon(icon.kind, icon.status, icon.theme, cssToken('--map-marker-stroke') || '#ffffff'), { pixelRatio: 2 });
    });
    this.map.on('dragstart', () => {
      if (this.followId) {
        this.followId = null;
        this.opts.onFollowInterrupted();
      }
    });
    const offLive = liveStore.subscribe((e) => this.onLiveEvent(e));
    const offDisplay = displayStore.subscribe(() => this.applyIconSize());
    this.unsubscribe = () => {
      offLive();
      offDisplay();
    };
  }

  /** Underlying map for add-on layers (geofences, alert markers in ./layers); they re-add themselves after style swaps. */
  get mapInstance(): MlMap {
    return this.map;
  }

  /** Re-applies marker sizes after the user changes the map icon size. */
  private applyIconSize() {
    const map = this.map;
    if (!map.getLayer(LAYERS.circle)) return;
    const scale = displayStore.iconScale();
    map.setLayoutProperty(LAYERS.circle, 'icon-size', vehicleIconSize(scale));
    if (map.getLayer(LAYERS.arrow)) map.setLayoutProperty(LAYERS.arrow, 'icon-size', arrowIconSize(scale));
  }

  destroy() {
    this.unsubscribe();
    cancelAnimationFrame(this.raf);
    this.map.remove();
  }

  private get source(): GeoJSONSource | undefined {
    return this.loaded ? this.map.getSource<GeoJSONSource>(SOURCE_ID) : undefined;
  }

  private onLoad() {
    const map = this.map;
    map.addImage(ARROW_IMAGE, createArrowImage(), { sdf: true, pixelRatio: 2 });
    map.addSource(SOURCE_ID, {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
      cluster: false,
      clusterMaxZoom: CLUSTER_MAX_ZOOM,
      clusterRadius: 50,
    });
    const unclustered: maplibregl.FilterSpecification = ['!', ['has', 'point_count']];
    map.addLayer({
      id: LAYERS.clusters,
      type: 'circle',
      source: SOURCE_ID,
      filter: ['has', 'point_count'],
      paint: {
        'circle-radius': ['step', ['get', 'point_count'], 16, 50, 20, 250, 26, 1000, 32],
        'circle-opacity': 0.88,
        'circle-stroke-width': 3,
        'circle-stroke-opacity': 0.35,
      },
    });
    map.addLayer({
      id: LAYERS.clusterCount,
      type: 'symbol',
      source: SOURCE_ID,
      filter: ['has', 'point_count'],
      layout: { 'text-field': ['get', 'point_count_abbreviated'], 'text-font': LABEL_FONT, 'text-size': 12, 'text-allow-overlap': true },
    });
    map.addLayer({
      id: LAYERS.selected,
      type: 'circle',
      source: SOURCE_ID,
      filter: ['==', ['get', 'id'], ''],
      paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, 12, 12, 18, 16, 24], 'circle-opacity': 0.18, 'circle-stroke-width': 2 },
    });
    map.addLayer({
      id: LAYERS.arrow,
      type: 'symbol',
      source: SOURCE_ID,
      // Vehicle icons rotate with their heading; only round badges (people, assets, pets) need the arrow.
      filter: ['all', unclustered, ['==', ['get', 'moving'], true], ['==', ['get', 'rotating'], false]],
      layout: {
        'icon-image': ARROW_IMAGE,
        'icon-size': arrowIconSize(displayStore.iconScale()),
        'icon-rotate': ['get', 'bearing'],
        'icon-rotation-alignment': 'map',
        'icon-offset': [0, -15],
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
      paint: { 'icon-halo-width': 1.5 },
    });
    map.addLayer({
      id: LAYERS.circle,
      type: 'symbol',
      source: SOURCE_ID,
      filter: unclustered,
      layout: {
        'icon-image': iconImageExpression(this.theme),
        'icon-size': vehicleIconSize(displayStore.iconScale()),
        'icon-rotate': ['get', 'rot'],
        'icon-rotation-alignment': 'map',
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
    });
    map.addLayer({
      id: LAYERS.label,
      type: 'symbol',
      source: SOURCE_ID,
      minzoom: LABEL_MIN_ZOOM,
      filter: unclustered,
      layout: {
        'text-field': ['get', 'label'],
        'text-font': LABEL_FONT,
        'text-size': 11,
        'text-offset': [0, 1.5],
        'text-anchor': 'top',
        'text-optional': true,
      },
      paint: { 'text-halo-width': 1.5 },
    });
    this.applyThemePaint();

    map.on('click', LAYERS.circle, (e) => {
      const id = e.features?.[0]?.properties?.id;
      if (typeof id === 'string') this.opts.onSelect(id);
    });
    map.on('click', LAYERS.clusters, async (e) => {
      const f = e.features?.[0];
      const clusterId = f?.properties?.cluster_id;
      const source = this.source;
      if (!f || typeof clusterId !== 'number' || !source) return;
      const zoom = await source.getClusterExpansionZoom(clusterId);
      map.easeTo({ center: (f.geometry as GeoJSON.Point).coordinates as [number, number], zoom });
    });
    for (const layer of [LAYERS.circle, LAYERS.clusters]) {
      map.on('mouseenter', layer, () => (map.getCanvas().style.cursor = 'pointer'));
      map.on('mouseleave', layer, () => (map.getCanvas().style.cursor = ''));
    }

    this.loaded = true;
    this.rebuild();
  }

  private applyThemePaint() {
    const map = this.map;
    const primary = cssToken('--primary');
    const stroke = cssToken('--map-marker-stroke');
    map.setLayoutProperty(LAYERS.circle, 'icon-image', iconImageExpression(this.theme));
    map.setPaintProperty(LAYERS.arrow, 'icon-color', statusColorExpression(this.theme));
    map.setPaintProperty(LAYERS.arrow, 'icon-halo-color', stroke);
    map.setPaintProperty(LAYERS.clusters, 'circle-color', primary);
    map.setPaintProperty(LAYERS.clusters, 'circle-stroke-color', primary);
    map.setPaintProperty(LAYERS.clusterCount, 'text-color', cssToken('--primary-foreground'));
    map.setPaintProperty(LAYERS.selected, 'circle-color', primary);
    map.setPaintProperty(LAYERS.selected, 'circle-stroke-color', primary);
    map.setPaintProperty(LAYERS.label, 'text-color', cssToken('--map-label'));
    map.setPaintProperty(LAYERS.label, 'text-halo-color', cssToken('--map-label-halo'));
  }

  setTheme(theme: ResolvedTheme) {
    if (theme === this.theme) return;
    this.theme = theme;
    if (!this.loaded) {
      this.map.setStyle(styleUrl(theme));
      return;
    }
    this.map.once('style.load', () => {
      this.applyThemePaint();
      this.rebuild();
    });
    this.map.setStyle(styleUrl(theme), { transformStyle: keepOwnLayers });
  }

  setReducedMotion(reduced: boolean) {
    this.reducedMotion = reduced;
  }

  /** Replaces the visibility filter (search, status chips, branch/group/type, selected-only). */
  setPredicate(predicate: (o: LiveObject) => boolean) {
    this.predicate = predicate;
    this.rebuild();
  }

  setSelected(id: string | null) {
    this.selectedId = id;
    if (this.loaded) this.map.setFilter(LAYERS.selected, ['all', ['!', ['has', 'point_count']], ['==', ['get', 'id'], id ?? '']]);
  }

  follow(id: string | null) {
    this.followId = id;
    if (id) this.centerOn(id, false);
  }

  zoomTo(id: string) {
    const pose = this.display.get(id) ?? this.poseOf(liveStore.get(id));
    if (!pose) return;
    this.map.flyTo({ center: [pose.lng, pose.lat], zoom: Math.max(this.map.getZoom(), 16), duration: this.reducedMotion ? 0 : 1200 });
  }

  resize() {
    this.map.resize();
  }

  private poseOf(o: LiveObject | undefined): Pose | null {
    return o && hasCoords(o) ? { lng: o.lng, lat: o.lat, bearing: o.course } : null;
  }

  private centerOn(id: string, instant: boolean) {
    const pose = this.display.get(id);
    if (!pose) return;
    if (instant) this.map.jumpTo({ center: [pose.lng, pose.lat] });
    else this.map.easeTo({ center: [pose.lng, pose.lat], duration: this.reducedMotion ? 0 : 800 });
  }

  private onLiveEvent(e: LiveEvent) {
    if (e.type === 'batch') this.applyBatch(e.changed);
    else this.rebuild();
  }

  /** Full source replacement — used for snapshots and when the set of visible objects changes. */
  private rebuild() {
    const source = this.source;
    if (!source) return;
    const features: Feature[] = [];
    const nextVisible = new Set<string>();
    const nextDisplay = new Map<string, Pose>();
    for (const o of liveStore.all()) {
      if (!hasCoords(o) || !this.predicate(o)) continue;
      const pose = this.glides.has(o.objectId) ? (this.display.get(o.objectId) ?? this.poseOf(o)!) : this.poseOf(o)!;
      nextVisible.add(o.objectId);
      nextDisplay.set(o.objectId, pose);
      features.push({ type: 'Feature', id: o.objectId, geometry: { type: 'Point', coordinates: [pose.lng, pose.lat] }, properties: properties(o, pose.bearing) });
    }
    for (const id of this.glides.keys()) if (!nextVisible.has(id)) this.glides.delete(id);
    this.visible = nextVisible;
    this.display = nextDisplay;

    const cluster = features.length > CLUSTER_THRESHOLD;
    if (cluster !== this.clustered) {
      this.clustered = cluster;
      source.setClusterOptions({ cluster, clusterMaxZoom: CLUSTER_MAX_ZOOM, clusterRadius: 50 });
    }
    source.setData({ type: 'FeatureCollection', features });
    this.setSelected(this.selectedId);

    if (!this.fittedOnce && features.length) {
      this.fittedOnce = true;
      this.fitToVisible();
    }
  }

  private fitToVisible() {
    const bounds = new maplibregl.LngLatBounds();
    for (const p of this.display.values()) bounds.extend([p.lng, p.lat]);
    if (!bounds.isEmpty()) this.map.fitBounds(bounds, { padding: 80, maxZoom: 14, duration: 0 });
  }

  private canAnimate(): boolean {
    // Animating through a clustered source re-clusters every frame; only glide once points are unclustered.
    const clusteringActive = this.clustered && this.map.getZoom() <= CLUSTER_MAX_ZOOM;
    return !this.reducedMotion && !document.hidden && !clusteringActive;
  }

  private applyBatch(changed: LiveObject[]) {
    const source = this.source;
    if (!source) return;

    // Membership changes (filtered in/out, gained/lost coordinates) need a full rebuild.
    for (const o of changed) {
      const show = hasCoords(o) && this.predicate(o);
      if (show !== this.visible.has(o.objectId)) return this.rebuild();
    }

    const now = performance.now();
    const bounds = this.map.getBounds();
    const movers: LiveObject[] = [];
    const update: NonNullable<GeoJSONSourceDiff['update']> = [];

    for (const o of changed) {
      if (!this.visible.has(o.objectId) || !hasCoords(o)) continue;
      const to: Pose = { lng: o.lng, lat: o.lat, bearing: o.course };
      const current = this.display.get(o.objectId) ?? to;
      const moved = current.lng !== to.lng || current.lat !== to.lat;
      if (moved && bounds.contains([to.lng, to.lat])) movers.push(o);
      else {
        this.glides.delete(o.objectId);
        this.display.set(o.objectId, to);
        update.push({ id: o.objectId, newGeometry: { type: 'Point', coordinates: [to.lng, to.lat] }, addOrUpdateProperties: this.diffProps(o, to.bearing) });
      }
    }

    const animate = this.canAnimate() && movers.length + this.glides.size < MAX_ANIMATED;
    for (const o of movers) {
      const to: Pose = { lng: o.lng!, lat: o.lat!, bearing: o.course };
      const from = this.display.get(o.objectId) ?? to;
      if (animate) {
        this.glides.set(o.objectId, { from, to, start: now });
        update.push({ id: o.objectId, addOrUpdateProperties: this.diffProps(o, from.bearing) });
      } else {
        this.glides.delete(o.objectId);
        this.display.set(o.objectId, to);
        update.push({ id: o.objectId, newGeometry: { type: 'Point', coordinates: [to.lng, to.lat] }, addOrUpdateProperties: this.diffProps(o, to.bearing) });
      }
    }

    if (update.length) source.updateData({ update });
    if (this.glides.size) this.startLoop();
    else if (this.followId && changed.some((o) => o.objectId === this.followId)) this.centerOn(this.followId, false);
  }

  private diffProps(o: LiveObject, bearing: number) {
    return Object.entries(properties(o, bearing)).map(([key, value]) => ({ key, value }));
  }

  private startLoop() {
    if (!this.raf) this.raf = requestAnimationFrame(this.frame);
  }

  private frame = (now: number) => {
    this.raf = 0;
    const source = this.source;
    if (!source || !this.glides.size) return;
    if (now - this.lastFrame < FRAME_MS) {
      this.startLoop();
      return;
    }
    this.lastFrame = now;

    const update: NonNullable<GeoJSONSourceDiff['update']> = [];
    for (const [id, g] of this.glides) {
      const t = (now - g.start) / GLIDE_MS;
      const pose = t >= 1 ? g.to : interpolatePose(g.from, g.to, t);
      if (t >= 1) this.glides.delete(id);
      this.display.set(id, pose);
      update.push({
        id,
        newGeometry: { type: 'Point', coordinates: [pose.lng, pose.lat] },
        addOrUpdateProperties: [{ key: 'bearing', value: pose.bearing }],
      });
    }
    source.updateData({ update });
    if (this.followId && update.some((u) => u.id === this.followId)) this.centerOn(this.followId, true);
    if (this.glides.size) this.startLoop();
  };
}

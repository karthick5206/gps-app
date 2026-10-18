import { STATUS_META, TRACK_STATUS_CODES, type AlertDto, type StopDto } from '@veetracer/shared';
import { displayStore } from '@/features/display/display-store';
import maplibregl, { type ExpressionSpecification, type GeoJSONSource, type Map as MlMap, type StyleSpecification } from 'maplibre-gl';
import { ARROW_IMAGE, LABEL_FONT, createArrowImage, cssToken, styleUrl } from '@/features/live/map/map-style';
import type { ResolvedTheme } from '@/features/theme/theme-store';
import { coordsOf, findRun, type Sample, type TrackIndex, type TrackRun } from './playback-core';

export type ColorMode = 'status' | 'speed';

/** Colours of the speed bands (< 20, < 40, < 60, < 80, ≥ 80 km/h) per theme. */
export const SPEED_BAND_COLORS: Record<ResolvedTheme, string[]> = {
  light: ['#2563eb', '#16a34a', '#ca8a04', '#ea580c', '#dc2626'],
  dark: ['#60a5fa', '#4ade80', '#facc15', '#fb923c', '#f87171'],
};
export const SPEED_BAND_LABELS = ['< 20', '20–40', '40–60', '60–80', '80+'];
const STOP_COLORS = { parked: { light: '#1d4ed8', dark: '#60a5fa' }, idle: STATUS_META.IDLE };
const ALERT_COLORS = { INFO: { light: '#0284c7', dark: '#38bdf8' }, WARNING: STATUS_META.IDLE, CRITICAL: STATUS_META.OFF };

const SRC = { track: 'h-track', played: 'h-played', trip: 'h-trip', marks: 'h-marks', cursor: 'h-cursor' } as const;
const LYR = {
  trackCasing: 'h-track-casing',
  track: 'h-track-line',
  trackGap: 'h-track-gap',
  trip: 'h-trip-line',
  played: 'h-played-line',
  playedGap: 'h-played-gap',
  stops: 'h-stops',
  stopsText: 'h-stops-text',
  alerts: 'h-alerts',
  alertsText: 'h-alerts-text',
  ends: 'h-ends',
  endsText: 'h-ends-text',
  cursorHalo: 'h-cursor-halo',
  cursor: 'h-cursor-dot',
  cursorArrow: 'h-cursor-arrow',
} as const;
const OWN_PREFIX = 'h-';
const PATH_FRAME_MS = 1000 / 15; // drawn-path updates capped at ~15 fps
const DEFAULT_CENTER: [number, number] = [80.24, 13.07];
const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

export type MarkClick = { kind: 'stop'; index: number } | { kind: 'alert'; index: number };

export interface HistoryMapOptions {
  container: HTMLElement;
  theme: ResolvedTheme;
  reducedMotion: boolean;
  onMarkClick: (mark: MarkClick) => void;
  onFollowInterrupted: () => void;
}

/** Keeps our sources/layers when the basemap style is swapped for the theme. */
function keepHistoryLayers(previous: StyleSpecification | undefined, next: StyleSpecification): StyleSpecification {
  if (!previous) return next;
  const sources = Object.fromEntries(Object.entries(previous.sources).filter(([id]) => id.startsWith(OWN_PREFIX)));
  return { ...next, sources: { ...next.sources, ...sources }, layers: [...next.layers, ...previous.layers.filter((l) => l.id.startsWith(OWN_PREFIX))] };
}

function statusExpr(theme: ResolvedTheme): ExpressionSpecification {
  const pairs = TRACK_STATUS_CODES.flatMap((s, i) => [i, STATUS_META[s][theme]]);
  return ['match', ['get', 's'], ...pairs, STATUS_META.NO_DATA[theme]] as unknown as ExpressionSpecification;
}

function bandExpr(theme: ResolvedTheme): ExpressionSpecification {
  const pairs = SPEED_BAND_COLORS[theme].flatMap((c, i) => [i, c]);
  return ['match', ['get', 'b'], ...pairs, STATUS_META.NO_DATA[theme]] as unknown as ExpressionSpecification;
}

function runFeature(idx: TrackIndex, run: TrackRun, id: number, coords?: [number, number][]): GeoJSON.Feature<GeoJSON.LineString> {
  return {
    type: 'Feature',
    id,
    geometry: { type: 'LineString', coordinates: coords ?? coordsOf(idx, run.a, run.b) },
    properties: { s: run.status, b: run.band, gap: run.gap },
  };
}

const TAIL_ID = 1_000_000_000;

/**
 * History map, owned imperatively (never re-rendered by React):
 * - static track/marks are set once per dataset;
 * - the moving vehicle is a one-feature source updated every animation frame;
 * - the progressively drawn path is a set of completed run features plus one small "tail" feature,
 *   updated via `updateData` diffs at most ~15 fps.
 */
export class HistoryMap {
  private readonly map: MlMap;
  private readonly opts: HistoryMapOptions;
  private theme: ResolvedTheme;
  private reducedMotion: boolean;
  private loaded = false;
  private colorMode: ColorMode = 'status';
  private idx: TrackIndex | null = null;
  private runs: TrackRun[] = [];
  private stops: StopDto[] = [];
  private alertPositions: { alert: AlertDto; lat: number; lng: number }[] = [];
  private tailPresent = false;
  private highlighted: [number | null, number | null] = [null, null];
  private playedRuns = 0; // runs [0, playedRuns) are present as completed features
  private playedActive = false;
  private lastPathUpdate = 0;
  private lastSample: Sample | null = null;
  private follow = false;
  private pendingFit: [[number, number], [number, number]] | null = null;

  constructor(opts: HistoryMapOptions) {
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
    this.map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), 'top-right');
    this.map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
    this.map.on('load', () => this.onLoad());
    this.map.on('styleimagemissing', (e) => {
      if (e.id === ARROW_IMAGE && !this.map.hasImage(ARROW_IMAGE)) this.map.addImage(ARROW_IMAGE, createArrowImage(), { sdf: true, pixelRatio: 2 });
    });
    const interrupt = () => {
      if (!this.follow) return;
      this.follow = false;
      this.opts.onFollowInterrupted();
    };
    this.map.on('dragstart', interrupt);
    this.map.on('wheel', interrupt);
  }

  destroy() {
    this.map.remove();
  }

  resize() {
    this.map.resize();
  }

  private src(id: string): GeoJSONSource | undefined {
    return this.loaded ? this.map.getSource<GeoJSONSource>(id) : undefined;
  }

  private onLoad() {
    const map = this.map;
    if (!map.hasImage(ARROW_IMAGE)) map.addImage(ARROW_IMAGE, createArrowImage(), { sdf: true, pixelRatio: 2 });
    for (const id of Object.values(SRC)) map.addSource(id, { type: 'geojson', data: EMPTY });
    const round = { 'line-cap': 'round', 'line-join': 'round' } as const;
    const solid: maplibregl.FilterSpecification = ['==', ['get', 'gap'], false];
    const gap: maplibregl.FilterSpecification = ['==', ['get', 'gap'], true];
    map.addLayer({ id: LYR.trackCasing, type: 'line', source: SRC.track, filter: solid, layout: round, paint: { 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 4, 16, 9] } });
    map.addLayer({ id: LYR.track, type: 'line', source: SRC.track, filter: solid, layout: round, paint: { 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 2, 16, 5] } });
    map.addLayer({ id: LYR.trackGap, type: 'line', source: SRC.track, filter: gap, paint: { 'line-width': 2, 'line-dasharray': [2, 2], 'line-opacity': 0.7 } });
    map.addLayer({ id: LYR.trip, type: 'line', source: SRC.trip, layout: round, paint: { 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 8, 16, 16], 'line-opacity': 0.22 } });
    map.addLayer({ id: LYR.played, type: 'line', source: SRC.played, filter: solid, layout: round, paint: { 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 3, 16, 6.5] } });
    map.addLayer({ id: LYR.playedGap, type: 'line', source: SRC.played, filter: gap, paint: { 'line-width': 2.5, 'line-dasharray': [2, 2] } });

    const markText = { 'text-font': LABEL_FONT, 'text-size': 11, 'text-allow-overlap': true, 'text-ignore-placement': true } as const;
    map.addLayer({ id: LYR.stops, type: 'circle', source: SRC.marks, filter: ['==', ['get', 'kind'], 'stop'], paint: { 'circle-radius': 9, 'circle-stroke-width': 2 } });
    map.addLayer({ id: LYR.stopsText, type: 'symbol', source: SRC.marks, filter: ['==', ['get', 'kind'], 'stop'], layout: { ...markText, 'text-field': ['get', 'label'] }, paint: { 'text-color': '#ffffff' } });
    map.addLayer({ id: LYR.alerts, type: 'circle', source: SRC.marks, filter: ['==', ['get', 'kind'], 'alert'], paint: { 'circle-radius': 7, 'circle-stroke-width': 2 } });
    map.addLayer({ id: LYR.alertsText, type: 'symbol', source: SRC.marks, filter: ['==', ['get', 'kind'], 'alert'], layout: { ...markText, 'text-size': 10, 'text-field': '!' }, paint: { 'text-color': '#ffffff' } });
    map.addLayer({ id: LYR.ends, type: 'circle', source: SRC.marks, filter: ['==', ['get', 'kind'], 'end'], paint: { 'circle-radius': 11, 'circle-stroke-width': 2.5 } });
    map.addLayer({ id: LYR.endsText, type: 'symbol', source: SRC.marks, filter: ['==', ['get', 'kind'], 'end'], layout: { ...markText, 'text-size': 12, 'text-field': ['get', 'label'] }, paint: { 'text-color': '#ffffff' } });

    map.addLayer({ id: LYR.cursorHalo, type: 'circle', source: SRC.cursor, paint: { 'circle-radius': 22 * displayStore.iconScale(), 'circle-opacity': 0.18 } });
    map.addLayer({ id: LYR.cursor, type: 'circle', source: SRC.cursor, paint: { 'circle-radius': 12 * displayStore.iconScale(), 'circle-stroke-width': 2.5 } });
    map.addLayer({
      id: LYR.cursorArrow,
      type: 'symbol',
      source: SRC.cursor,
      layout: {
        'icon-image': ARROW_IMAGE,
        'icon-size': 0.75 * displayStore.iconScale(),
        'icon-rotate': ['get', 'bearing'],
        'icon-rotation-alignment': 'map',
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
      paint: { 'icon-color': '#ffffff' },
    });

    for (const layer of [LYR.stops, LYR.alerts]) {
      map.on('click', layer, (e) => {
        const f = e.features?.[0];
        const index = f?.properties?.index;
        if (typeof index === 'number') this.opts.onMarkClick({ kind: layer === LYR.stops ? 'stop' : 'alert', index });
      });
      map.on('mouseenter', layer, () => (map.getCanvas().style.cursor = 'pointer'));
      map.on('mouseleave', layer, () => (map.getCanvas().style.cursor = ''));
    }

    this.loaded = true;
    this.applyPaint();
    this.pushStatic();
    if (this.lastSample) this.updateCursor(this.lastSample, true);
    if (this.pendingFit) this.fit(this.pendingFit, true);
  }

  private applyPaint() {
    if (!this.loaded) return;
    const map = this.map;
    const t = this.theme;
    const line = this.colorMode === 'status' ? statusExpr(t) : bandExpr(t);
    const halo = cssToken('--map-marker-stroke') || '#fff';
    map.setPaintProperty(LYR.trackCasing, 'line-color', halo);
    map.setPaintProperty(LYR.trackCasing, 'line-opacity', this.playedActive ? 0.35 : 0.9);
    map.setPaintProperty(LYR.track, 'line-color', line);
    map.setPaintProperty(LYR.track, 'line-opacity', this.playedActive ? 0.32 : 1);
    map.setPaintProperty(LYR.trackGap, 'line-color', STATUS_META.OFFLINE[t]);
    map.setPaintProperty(LYR.trip, 'line-color', cssToken('--primary'));
    map.setPaintProperty(LYR.played, 'line-color', line);
    map.setPaintProperty(LYR.playedGap, 'line-color', STATUS_META.OFFLINE[t]);
    map.setPaintProperty(LYR.stops, 'circle-color', ['case', ['get', 'idle'], STOP_COLORS.idle[t], STOP_COLORS.parked[t]]);
    map.setPaintProperty(LYR.alerts, 'circle-color', [
      'match',
      ['get', 'severity'],
      'CRITICAL',
      ALERT_COLORS.CRITICAL[t],
      'WARNING',
      ALERT_COLORS.WARNING[t],
      ALERT_COLORS.INFO[t],
    ]);
    map.setPaintProperty(LYR.ends, 'circle-color', ['case', ['==', ['get', 'label'], 'S'], STATUS_META.RUNNING[t], STATUS_META.OFF[t]]);
    for (const l of [LYR.stops, LYR.alerts, LYR.ends, LYR.cursor]) map.setPaintProperty(l, 'circle-stroke-color', halo);
    map.setPaintProperty(LYR.cursor, 'circle-color', statusExpr(t));
    map.setPaintProperty(LYR.cursorHalo, 'circle-color', statusExpr(t));
  }

  setTheme(theme: ResolvedTheme) {
    if (theme === this.theme) return;
    this.theme = theme;
    if (!this.loaded) {
      this.map.setStyle(styleUrl(theme));
      return;
    }
    this.map.once('style.load', () => {
      // Re-push our data: serialised GeoJSON sources may not reflect incremental `updateData` diffs.
      this.applyPaint();
      this.pushStatic();
      this.highlight(this.highlighted[0], this.highlighted[1]);
      if (this.lastSample) this.updateCursor(this.lastSample, true);
    });
    this.map.setStyle(styleUrl(theme), { transformStyle: keepHistoryLayers });
  }

  setReducedMotion(reduced: boolean) {
    this.reducedMotion = reduced;
  }

  setColorMode(mode: ColorMode) {
    this.colorMode = mode;
    this.applyPaint();
  }

  setFollow(follow: boolean) {
    this.follow = follow;
    if (follow && this.lastSample) this.map.jumpTo({ center: [this.lastSample.lng, this.lastSample.lat] });
  }

  /** Replaces the dataset (track, stops, alerts with resolved positions). */
  setData(idx: TrackIndex, runs: TrackRun[], stops: StopDto[], alerts: { alert: AlertDto; lat: number; lng: number }[]) {
    this.idx = idx;
    this.runs = runs;
    this.stops = stops;
    this.alertPositions = alerts;
    this.playedRuns = 0;
    this.playedActive = false;
    this.lastSample = null;
    this.highlighted = [null, null];
    this.pushStatic();
    this.applyPaint();
  }

  private pushStatic() {
    const idx = this.idx;
    const track = this.src(SRC.track);
    const marks = this.src(SRC.marks);
    if (!idx || !track || !marks) return;
    track.setData({ type: 'FeatureCollection', features: this.runs.map((r, i) => runFeature(idx, r, i)) });
    this.src(SRC.played)?.setData(EMPTY);
    this.tailPresent = false;
    this.src(SRC.trip)?.setData(EMPTY);
    const features: GeoJSON.Feature<GeoJSON.Point>[] = [];
    this.stops.forEach((s, i) =>
      features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [s.lng, s.lat] }, properties: { kind: 'stop', index: i, idle: s.ignitionOn, label: s.ignitionOn ? 'I' : 'P' } }),
    );
    this.alertPositions.forEach((a, i) =>
      features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [a.lng, a.lat] }, properties: { kind: 'alert', index: i, severity: a.alert.severity } }),
    );
    if (idx.n) {
      features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [idx.lng[0], idx.lat[0]] }, properties: { kind: 'end', label: 'S' } });
      if (idx.n > 1) features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [idx.lng[idx.n - 1], idx.lat[idx.n - 1]] }, properties: { kind: 'end', label: 'E' } });
    }
    marks.setData({ type: 'FeatureCollection', features });
  }

  clear() {
    this.idx = null;
    this.runs = [];
    this.stops = [];
    this.alertPositions = [];
    for (const id of Object.values(SRC)) this.src(id)?.setData(EMPTY);
    this.tailPresent = false;
  }

  /**
   * Called every animation frame while playing (and on seeks). Moves the vehicle every call; redraws the
   * played path at most ~15 fps unless `force` (seek / pause).
   */
  updateCursor(s: Sample, force = false) {
    this.lastSample = s;
    const idx = this.idx;
    const cursor = this.src(SRC.cursor);
    if (!idx || !cursor) return;
    cursor.setData({ type: 'Feature', geometry: { type: 'Point', coordinates: [s.lng, s.lat] }, properties: { bearing: s.bearing, s: s.status } });
    if (this.follow) this.map.jumpTo({ center: [s.lng, s.lat] });

    const now = performance.now();
    if (!force && now - this.lastPathUpdate < PATH_FRAME_MS) return;
    this.lastPathUpdate = now;
    this.updatePlayed(s);
  }

  private updatePlayed(s: Sample) {
    const idx = this.idx;
    const played = this.src(SRC.played);
    if (!idx || !played || !this.runs.length) return;
    const active = s.t > idx.start;
    if (active !== this.playedActive) {
      this.playedActive = active;
      this.applyPaint();
    }
    const k = Math.max(0, findRun(this.runs, s.i));
    const run = this.runs[k];
    const tail = coordsOf(idx, run.a, Math.min(s.i, run.b));
    tail.push([s.lng, s.lat]);
    const tailFeature = runFeature(idx, run, TAIL_ID, tail);

    if (k < this.playedRuns || !this.tailPresent) {
      // First draw or seek backwards: rebuild (rare); otherwise send a small diff.
      const features = this.runs.slice(0, k).map((r, i) => runFeature(idx, r, i));
      features.push(tailFeature);
      played.setData({ type: 'FeatureCollection', features });
      this.tailPresent = true;
    } else {
      const add = this.runs.slice(this.playedRuns, k).map((r, i) => runFeature(idx, r, this.playedRuns + i));
      played.updateData({
        add,
        update: [{ id: TAIL_ID, newGeometry: tailFeature.geometry, addOrUpdateProperties: [{ key: 's', value: run.status }, { key: 'b', value: run.band }, { key: 'gap', value: run.gap }] }],
      });
    }
    this.playedRuns = k;
  }

  /** Highlights a trip's part of the track (null clears). */
  highlight(from: number | null, to: number | null) {
    this.highlighted = [from, to];
    const idx = this.idx;
    const src = this.src(SRC.trip);
    if (!src || !idx) return;
    if (from === null || to === null) return src.setData(EMPTY);
    const coords: [number, number][] = [];
    for (let i = 0; i < idx.n; i++) if (idx.t[i] >= from && idx.t[i] <= to) coords.push([idx.lng[i], idx.lat[i]]);
    src.setData(coords.length > 1 ? { type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} } : EMPTY);
  }

  fit(bounds: [[number, number], [number, number]], instant = false) {
    if (!this.loaded) {
      this.pendingFit = bounds;
      return;
    }
    this.pendingFit = null;
    const [[a, b], [c, d]] = bounds;
    const container = this.map.getContainer();
    const pad = Math.min(80, Math.max(24, Math.min(container.clientWidth, container.clientHeight) / 8));
    if (a === c && b === d) this.map.jumpTo({ center: [a, b], zoom: 15 });
    else this.map.fitBounds(bounds, { padding: pad, maxZoom: 16, duration: instant || this.reducedMotion ? 0 : 700 });
  }

  flyTo(lng: number, lat: number) {
    this.map.easeTo({ center: [lng, lat], zoom: Math.max(this.map.getZoom(), 15), duration: this.reducedMotion ? 0 : 700 });
  }
}

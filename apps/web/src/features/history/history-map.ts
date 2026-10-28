import {
  POINT_LABELS,
  STATUS_META,
  TRACK_STATUS_CODES,
  type AlertDto,
  type PointLabel,
  type PointQualityResponse,
  type StopDto,
} from "@veetracer/shared";
import { displayStore } from "@/features/display/display-store";
import maplibregl, {
  type ExpressionSpecification,
  type GeoJSONSource,
  type Map as MlMap,
  type StyleSpecification,
} from "maplibre-gl";
import {
  ARROW_IMAGE,
  LABEL_FONT,
  createArrowImage,
  cssToken,
  styleKey,
  styleUrl,
} from "@/features/live/map/map-style";
import { basemapStore } from "@/features/live/map/basemap-store";
import type { ResolvedTheme } from "@/features/theme/theme-store";
import { formatDateTime } from "@/lib/format";
import {
  coordsOf,
  findRun,
  type Sample,
  type TrackIndex,
  type TrackRun,
} from "./playback-core";
import { reverseGeocode } from "./use-history";

export type ColorMode = "status" | "speed";

/** Colours of the speed bands (< 20, < 40, < 60, < 80, ≥ 80 km/h) per theme. */
export const SPEED_BAND_COLORS: Record<ResolvedTheme, string[]> = {
  light: ["#2563eb", "#16a34a", "#ca8a04", "#ea580c", "#dc2626"],
  dark: ["#60a5fa", "#4ade80", "#facc15", "#fb923c", "#f87171"],
};
export const SPEED_BAND_LABELS = ["< 20", "20–40", "40–60", "60–80", "80+"];
export const STOP_COLORS = {
  parked: { light: "#1d4ed8", dark: "#60a5fa" },
  idle: STATUS_META.IDLE,
};
export const ESTIMATE_COLOR = { light: "#7c3aed", dark: "#a78bfa" };
/** History → All points: dot colour per quality label (index = POINT_LABELS), and the cleaned track. */
export const POINT_LABEL_COLORS: Record<PointLabel, string> = {
  good: "#16a34a",
  drift: "#f59e0b",
  spike: "#dc2626",
  jump: "#9333ea",
  inaccurate: "#64748b",
  mock: "#db2777",
  invalid: "#111827",
  duplicate: "#94a3b8",
};
export const CLEAN_TRACK_COLOR = "#0284c7";
const ALERT_COLORS = {
  INFO: { light: "#0284c7", dark: "#38bdf8" },
  WARNING: STATUS_META.IDLE,
  CRITICAL: STATUS_META.OFF,
};

const SRC = {
  track: "h-track",
  played: "h-played",
  trip: "h-trip",
  marks: "h-marks",
  cursor: "h-cursor",
  estimate: "h-estimate",
  allPoints: "h-allpts",
  clean: "h-clean",
} as const;
const LYR = {
  estimate: "h-estimate-line",
  clean: "h-clean-line",
  allPoints: "h-allpts-dots",
  trackCasing: "h-track-casing",
  track: "h-track-line",
  trackGap: "h-track-gap",
  trip: "h-trip-line",
  played: "h-played-line",
  playedGap: "h-played-gap",
  stops: "h-stops",
  stopsText: "h-stops-text",
  alerts: "h-alerts",
  alertsText: "h-alerts-text",
  ends: "h-ends",
  endsText: "h-ends-text",
  cursorHalo: "h-cursor-halo",
  cursor: "h-cursor-dot",
  cursorArrow: "h-cursor-arrow",
} as const;
const OWN_PREFIX = "h-";
const PATH_FRAME_MS = 1000 / 15; // drawn-path updates capped at ~15 fps
const DEFAULT_CENTER: [number, number] = [80.24, 13.07];
const EMPTY: GeoJSON.FeatureCollection = {
  type: "FeatureCollection",
  features: [],
};

/** Translated texts for the All points hover. */
export interface PointText {
  label: (l: PointLabel) => string;
  source: (src: number) => string;
}

export type MarkClick =
  { kind: "stop"; index: number } | { kind: "alert"; index: number };

/** Hovering the track shows the nearest recorded point within this many pixels. */
const HOVER_PX = 18;

const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!,
  );

export interface HistoryMapOptions {
  container: HTMLElement;
  theme: ResolvedTheme;
  reducedMotion: boolean;
  onMarkClick: (mark: MarkClick) => void;
  onFollowInterrupted: () => void;
}

/** Keeps our sources/layers when the basemap style is swapped for the theme. */
function keepHistoryLayers(
  previous: StyleSpecification | undefined,
  next: StyleSpecification,
): StyleSpecification {
  if (!previous) return next;
  const sources = Object.fromEntries(
    Object.entries(previous.sources).filter(([id]) =>
      id.startsWith(OWN_PREFIX),
    ),
  );
  return {
    ...next,
    sources: { ...next.sources, ...sources },
    layers: [
      ...next.layers,
      ...previous.layers.filter((l) => l.id.startsWith(OWN_PREFIX)),
    ],
  };
}

function statusExpr(theme: ResolvedTheme): ExpressionSpecification {
  const pairs = TRACK_STATUS_CODES.flatMap((s, i) => [
    i,
    STATUS_META[s][theme],
  ]);
  return [
    "match",
    ["get", "s"],
    ...pairs,
    STATUS_META.NO_DATA[theme],
  ] as unknown as ExpressionSpecification;
}

function bandExpr(theme: ResolvedTheme): ExpressionSpecification {
  const pairs = SPEED_BAND_COLORS[theme].flatMap((c, i) => [i, c]);
  return [
    "match",
    ["get", "b"],
    ...pairs,
    STATUS_META.NO_DATA[theme],
  ] as unknown as ExpressionSpecification;
}

function runFeature(
  idx: TrackIndex,
  run: TrackRun,
  id: number,
  coords?: [number, number][],
): GeoJSON.Feature<GeoJSON.LineString> {
  return {
    type: "Feature",
    id,
    geometry: {
      type: "LineString",
      coordinates: coords ?? coordsOf(idx, run.a, run.b),
    },
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
  private colorMode: ColorMode = "status";
  private idx: TrackIndex | null = null;
  private runs: TrackRun[] = [];
  private stops: StopDto[] = [];
  private alertPositions: { alert: AlertDto; lat: number; lng: number }[] = [];
  private estimates: [number, number][][] = [];
  private allPoints: PointQualityResponse | null = null;
  private pointText: PointText = {
    label: (l) => l,
    source: (s) => (s ? "raw" : "stored"),
  };
  private tailPresent = false;
  private highlighted: [number | null, number | null] = [null, null];
  private playedRuns = 0; // runs [0, playedRuns) are present as completed features
  private playedActive = false;
  private lastPathUpdate = 0;
  private lastSample: Sample | null = null;
  private follow = false;
  private pendingFit: [[number, number], [number, number]] | null = null;
  private styleKey: string;
  private readonly offBasemap: () => void;

  constructor(opts: HistoryMapOptions) {
    this.opts = opts;
    this.theme = opts.theme;
    this.reducedMotion = opts.reducedMotion;
    const style = styleUrl(opts.theme);
    this.styleKey = styleKey(style);
    this.map = new maplibregl.Map({
      container: opts.container,
      style,
      center: DEFAULT_CENTER,
      zoom: 11,
      attributionControl: { compact: true },
      fadeDuration: 0,
    });
    this.map.addControl(
      new maplibregl.NavigationControl({ visualizePitch: false }),
      "top-right",
    );
    this.map.addControl(
      new maplibregl.ScaleControl({ unit: "metric" }),
      "bottom-left",
    );
    this.map.on("load", () => this.onLoad());
    this.map.on("styleimagemissing", (e) => {
      if (e.id === ARROW_IMAGE && !this.map.hasImage(ARROW_IMAGE))
        this.map.addImage(ARROW_IMAGE, createArrowImage(), {
          sdf: true,
          pixelRatio: 2,
        });
    });
    const interrupt = () => {
      if (!this.follow) return;
      this.follow = false;
      this.opts.onFollowInterrupted();
    };
    this.map.on("dragstart", interrupt);
    this.map.on("wheel", interrupt);
    this.offBasemap = basemapStore.subscribe(() => this.restyle());
  }

  destroy() {
    this.offBasemap();
    this.hoverPopup?.remove();
    this.map.remove();
  }

  // ───────────── hover: time, speed and address of the nearest recorded point ─────────────

  private hoverPopup: maplibregl.Popup | null = null;
  private hoverIndex = -1;
  private hoverFrame = 0;
  private readonly addresses = new Map<string, string | null>();

  /** All points: label, time, accuracy, speed and source of the dot under the mouse. */
  private showPointHover(f: maplibregl.MapGeoJSONFeature | undefined) {
    if (!f || f.geometry.type !== "Point") return;
    const p = f.properties as {
      t: number;
      l: number;
      a: number;
      s: number;
      src: number;
    };
    const [lng, lat] = f.geometry.coordinates as [number, number];
    const label = POINT_LABELS[p.l] ?? "good";
    const popup = (this.hoverPopup ??= new maplibregl.Popup({
      closeButton: false,
      closeOnClick: false,
      offset: 12,
      maxWidth: "280px",
      className: "vt-hover-popup",
    }));
    this.hoverIndex = -1;
    popup
      .setLngLat([lng, lat])
      .setHTML(
        `<div style="font-size:12px;line-height:1.45"><div style="font-weight:600;color:${POINT_LABEL_COLORS[label]}">${escapeHtml(this.pointText.label(label))}</div>` +
          `<div>${escapeHtml(formatDateTime(new Date(p.t).toISOString()))}</div>` +
          `<div>${p.s} km/h · ${p.a >= 0 ? `±${p.a} m` : "±?"} · ${escapeHtml(this.pointText.source(p.src))}</div>` +
          `<div style="opacity:.8">${lat.toFixed(5)}, ${lng.toFixed(5)}</div></div>`,
      )
      .addTo(this.map);
  }

  private onTrackHover(point: maplibregl.Point) {
    if (this.allPoints) return; // the dots have their own hover
    cancelAnimationFrame(this.hoverFrame);
    this.hoverFrame = requestAnimationFrame(() => this.showHover(point));
  }

  private showHover(point: maplibregl.Point) {
    const idx = this.idx;
    if (!idx || !idx.n) return this.hideHover();
    // Nearest point in screen space (projecting is cheap enough for a few thousand points per frame).
    let best = -1;
    let bestD = HOVER_PX * HOVER_PX;
    const ll = this.map.unproject(point);
    const span =
      this.map.unproject([point.x + HOVER_PX * 4, point.y]).lng - ll.lng;
    for (let i = 0; i < idx.n; i++) {
      if (
        Math.abs(idx.lng[i] - ll.lng) > Math.abs(span) ||
        Math.abs(idx.lat[i] - ll.lat) > Math.abs(span)
      )
        continue;
      const p = this.map.project([idx.lng[i], idx.lat[i]]);
      const d = (p.x - point.x) ** 2 + (p.y - point.y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best < 0) return this.hideHover();
    if (best === this.hoverIndex && this.hoverPopup) return;
    this.hoverIndex = best;
    const lat = idx.lat[best];
    const lng = idx.lng[best];
    const key = `${lat.toFixed(4)},${lng.toFixed(4)}`;
    const popup = (this.hoverPopup ??= new maplibregl.Popup({
      closeButton: false,
      closeOnClick: false,
      offset: 12,
      maxWidth: "280px",
      className: "vt-hover-popup",
    }));
    const render = (address: string | null | undefined) =>
      `<div style="font-size:12px;line-height:1.45"><div style="font-weight:600">${escapeHtml(formatDateTime(new Date(idx.t[best]).toISOString()))}</div>` +
      `<div>${Math.round(idx.speed[best])} km/h · ${lat.toFixed(5)}, ${lng.toFixed(5)}</div>` +
      `<div style="opacity:.8">${address === undefined ? "…" : escapeHtml(address ?? "")}</div></div>`;
    popup
      .setLngLat([lng, lat])
      .setHTML(render(this.addresses.get(key)))
      .addTo(this.map);
    if (!this.addresses.has(key)) {
      void reverseGeocode(lat, lng).then((address) => {
        this.addresses.set(key, address);
        if (this.hoverIndex === best && this.hoverPopup)
          this.hoverPopup.setHTML(render(address));
      });
    }
  }

  private hideHover() {
    cancelAnimationFrame(this.hoverFrame);
    this.hoverIndex = -1;
    this.hoverPopup?.remove();
  }

  resize() {
    this.map.resize();
  }

  private src(id: string): GeoJSONSource | undefined {
    return this.loaded ? this.map.getSource<GeoJSONSource>(id) : undefined;
  }

  private onLoad() {
    const map = this.map;
    if (!map.hasImage(ARROW_IMAGE))
      map.addImage(ARROW_IMAGE, createArrowImage(), {
        sdf: true,
        pixelRatio: 2,
      });
    for (const id of Object.values(SRC))
      map.addSource(id, { type: "geojson", data: EMPTY });
    const round = { "line-cap": "round", "line-join": "round" } as const;
    const solid: maplibregl.FilterSpecification = ["==", ["get", "gap"], false];
    const gap: maplibregl.FilterSpecification = ["==", ["get", "gap"], true];
    // Likely road through data gaps (routing engine), under the recorded track.
    map.addLayer({
      id: LYR.estimate,
      type: "line",
      source: SRC.estimate,
      layout: round,
      paint: {
        "line-width": ["interpolate", ["linear"], ["zoom"], 8, 2, 16, 4.5],
        "line-dasharray": [0.6, 1.6],
        "line-opacity": 0.8,
      },
    });
    map.addLayer({
      id: LYR.trackCasing,
      type: "line",
      source: SRC.track,
      filter: solid,
      layout: round,
      paint: {
        "line-width": ["interpolate", ["linear"], ["zoom"], 8, 4, 16, 9],
      },
    });
    map.addLayer({
      id: LYR.track,
      type: "line",
      source: SRC.track,
      filter: solid,
      layout: round,
      paint: {
        "line-width": ["interpolate", ["linear"], ["zoom"], 8, 2, 16, 5],
      },
    });
    map.addLayer({
      id: LYR.trackGap,
      type: "line",
      source: SRC.track,
      filter: gap,
      paint: { "line-width": 2, "line-dasharray": [2, 2], "line-opacity": 0.7 },
    });
    map.addLayer({
      id: LYR.trip,
      type: "line",
      source: SRC.trip,
      layout: round,
      paint: {
        "line-width": ["interpolate", ["linear"], ["zoom"], 8, 8, 16, 16],
        "line-opacity": 0.22,
      },
    });
    map.addLayer({
      id: LYR.played,
      type: "line",
      source: SRC.played,
      filter: solid,
      layout: round,
      paint: {
        "line-width": ["interpolate", ["linear"], ["zoom"], 8, 3, 16, 6.5],
      },
    });
    map.addLayer({
      id: LYR.playedGap,
      type: "line",
      source: SRC.played,
      filter: gap,
      paint: { "line-width": 2.5, "line-dasharray": [2, 2] },
    });
    // History → All points: the cleaned track and every recorded point coloured by its quality label.
    map.addLayer({
      id: LYR.clean,
      type: "line",
      source: SRC.clean,
      layout: round,
      paint: {
        "line-color": CLEAN_TRACK_COLOR,
        "line-width": 3,
        "line-opacity": 0.85,
      },
    });
    map.addLayer({
      id: LYR.allPoints,
      type: "circle",
      source: SRC.allPoints,
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 2.5, 16, 5],
        "circle-color": [
          "match",
          ["get", "l"],
          ...POINT_LABELS.flatMap((l, i) => [i, POINT_LABEL_COLORS[l]]),
          "#999999",
        ] as unknown as ExpressionSpecification,
        "circle-stroke-width": ["case", ["==", ["get", "l"], 0], 0, 1],
        "circle-stroke-color": "#ffffff",
      },
    });
    map.on("mousemove", LYR.allPoints, (e) =>
      this.showPointHover(e.features?.[0]),
    );
    map.on("mouseleave", LYR.allPoints, () => this.hideHover());

    const markText = {
      "text-font": LABEL_FONT,
      "text-size": 11,
      "text-allow-overlap": true,
      "text-ignore-placement": true,
    } as const;
    map.addLayer({
      id: LYR.stops,
      type: "circle",
      source: SRC.marks,
      filter: ["==", ["get", "kind"], "stop"],
      paint: { "circle-radius": 9, "circle-stroke-width": 2 },
    });
    map.addLayer({
      id: LYR.stopsText,
      type: "symbol",
      source: SRC.marks,
      filter: ["==", ["get", "kind"], "stop"],
      layout: { ...markText, "text-field": ["get", "label"] },
      paint: { "text-color": "#ffffff" },
    });
    map.addLayer({
      id: LYR.alerts,
      type: "circle",
      source: SRC.marks,
      filter: ["==", ["get", "kind"], "alert"],
      paint: { "circle-radius": 7, "circle-stroke-width": 2 },
    });
    map.addLayer({
      id: LYR.alertsText,
      type: "symbol",
      source: SRC.marks,
      filter: ["==", ["get", "kind"], "alert"],
      layout: { ...markText, "text-size": 10, "text-field": "!" },
      paint: { "text-color": "#ffffff" },
    });
    map.addLayer({
      id: LYR.ends,
      type: "circle",
      source: SRC.marks,
      filter: ["==", ["get", "kind"], "end"],
      paint: { "circle-radius": 11, "circle-stroke-width": 2.5 },
    });
    map.addLayer({
      id: LYR.endsText,
      type: "symbol",
      source: SRC.marks,
      filter: ["==", ["get", "kind"], "end"],
      layout: { ...markText, "text-size": 12, "text-field": ["get", "label"] },
      paint: { "text-color": "#ffffff" },
    });

    map.addLayer({
      id: LYR.cursorHalo,
      type: "circle",
      source: SRC.cursor,
      paint: {
        "circle-radius": 22 * displayStore.iconScale(),
        "circle-opacity": 0.18,
      },
    });
    map.addLayer({
      id: LYR.cursor,
      type: "circle",
      source: SRC.cursor,
      paint: {
        "circle-radius": 12 * displayStore.iconScale(),
        "circle-stroke-width": 2.5,
      },
    });
    map.addLayer({
      id: LYR.cursorArrow,
      type: "symbol",
      source: SRC.cursor,
      layout: {
        "icon-image": ARROW_IMAGE,
        "icon-size": 0.75 * displayStore.iconScale(),
        "icon-rotate": ["get", "bearing"],
        "icon-rotation-alignment": "map",
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
      },
      paint: { "icon-color": "#ffffff" },
    });

    for (const layer of [LYR.stops, LYR.alerts]) {
      map.on("click", layer, (e) => {
        const f = e.features?.[0];
        const index = f?.properties?.index;
        if (typeof index === "number")
          this.opts.onMarkClick({
            kind: layer === LYR.stops ? "stop" : "alert",
            index,
          });
      });
      map.on(
        "mouseenter",
        layer,
        () => (map.getCanvas().style.cursor = "pointer"),
      );
      map.on("mouseleave", layer, () => (map.getCanvas().style.cursor = ""));
    }
    // Track hover: nearest recorded point with its time, speed and address.
    for (const layer of [LYR.trackCasing, LYR.played]) {
      map.on("mousemove", layer, (e) => this.onTrackHover(e.point));
      map.on("mouseleave", layer, () => this.hideHover());
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
    const line = this.colorMode === "status" ? statusExpr(t) : bandExpr(t);
    const halo = cssToken("--map-marker-stroke") || "#fff";
    map.setPaintProperty(LYR.trackCasing, "line-color", halo);
    map.setPaintProperty(
      LYR.trackCasing,
      "line-opacity",
      this.allPoints ? 0.2 : this.playedActive ? 0.35 : 0.9,
    );
    map.setPaintProperty(LYR.track, "line-color", line);
    map.setPaintProperty(
      LYR.track,
      "line-opacity",
      this.allPoints ? 0.25 : this.playedActive ? 0.32 : 1,
    );
    map.setPaintProperty(LYR.trackGap, "line-color", STATUS_META.OFFLINE[t]);
    map.setPaintProperty(LYR.estimate, "line-color", ESTIMATE_COLOR[t]);
    map.setPaintProperty(LYR.trip, "line-color", cssToken("--primary"));
    map.setPaintProperty(LYR.played, "line-color", line);
    map.setPaintProperty(LYR.playedGap, "line-color", STATUS_META.OFFLINE[t]);
    map.setPaintProperty(LYR.stops, "circle-color", [
      "case",
      ["get", "idle"],
      STOP_COLORS.idle[t],
      STOP_COLORS.parked[t],
    ]);
    map.setPaintProperty(LYR.alerts, "circle-color", [
      "match",
      ["get", "severity"],
      "CRITICAL",
      ALERT_COLORS.CRITICAL[t],
      "WARNING",
      ALERT_COLORS.WARNING[t],
      ALERT_COLORS.INFO[t],
    ]);
    map.setPaintProperty(LYR.ends, "circle-color", [
      "case",
      ["==", ["get", "label"], "S"],
      STATUS_META.RUNNING[t],
      STATUS_META.OFF[t],
    ]);
    for (const l of [LYR.stops, LYR.alerts, LYR.ends, LYR.cursor])
      map.setPaintProperty(l, "circle-stroke-color", halo);
    map.setPaintProperty(LYR.cursor, "circle-color", statusExpr(t));
    map.setPaintProperty(LYR.cursorHalo, "circle-color", statusExpr(t));
  }

  setTheme(theme: ResolvedTheme) {
    if (theme === this.theme) return;
    this.theme = theme;
    this.restyle();
  }

  /** Swaps the basemap for the current theme and map type (no-op when unchanged), keeping our layers. */
  private restyle() {
    const style = styleUrl(this.theme);
    const key = styleKey(style);
    if (key === this.styleKey) return;
    this.styleKey = key;
    if (!this.loaded) {
      this.map.setStyle(style);
      return;
    }
    this.map.once("style.load", () => {
      // Re-push our data: serialised GeoJSON sources may not reflect incremental `updateData` diffs.
      this.applyPaint();
      this.pushStatic();
      this.highlight(this.highlighted[0], this.highlighted[1]);
      if (this.lastSample) this.updateCursor(this.lastSample, true);
    });
    this.map.setStyle(style, { transformStyle: keepHistoryLayers });
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
    if (follow && this.lastSample)
      this.map.jumpTo({ center: [this.lastSample.lng, this.lastSample.lat] });
  }

  /** Replaces the dataset (track, stops, alerts with resolved positions). */
  setData(
    idx: TrackIndex,
    runs: TrackRun[],
    stops: StopDto[],
    alerts: { alert: AlertDto; lat: number; lng: number }[],
  ) {
    this.idx = idx;
    this.runs = runs;
    this.stops = stops;
    this.alertPositions = alerts;
    this.estimates = [];
    this.allPoints = null;
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
    track.setData({
      type: "FeatureCollection",
      features: this.runs.map((r, i) => runFeature(idx, r, i)),
    });
    this.src(SRC.played)?.setData(EMPTY);
    this.tailPresent = false;
    this.src(SRC.trip)?.setData(EMPTY);
    const features: GeoJSON.Feature<GeoJSON.Point>[] = [];
    this.stops.forEach((s, i) =>
      features.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: [s.lng, s.lat] },
        properties: {
          kind: "stop",
          index: i,
          idle: s.ignitionOn,
          label: s.ignitionOn ? "I" : "P",
        },
      }),
    );
    this.alertPositions.forEach((a, i) =>
      features.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: [a.lng, a.lat] },
        properties: { kind: "alert", index: i, severity: a.alert.severity },
      }),
    );
    if (idx.n) {
      features.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: [idx.lng[0], idx.lat[0]] },
        properties: { kind: "end", label: "S" },
      });
      if (idx.n > 1)
        features.push({
          type: "Feature",
          geometry: {
            type: "Point",
            coordinates: [idx.lng[idx.n - 1], idx.lat[idx.n - 1]],
          },
          properties: { kind: "end", label: "E" },
        });
    }
    marks.setData({ type: "FeatureCollection", features });
    this.pushEstimates();
    this.pushAllPoints();
  }

  /** History → All points: every point with its quality label and the cleaned track (null hides them). */
  setAllPoints(data: PointQualityResponse | null, text: PointText) {
    this.allPoints = data;
    this.pointText = text;
    this.pushAllPoints();
  }

  private pushAllPoints() {
    const d = this.allPoints;
    this.src(SRC.allPoints)?.setData(
      d
        ? {
            type: "FeatureCollection",
            features: d.points.map(([t, lat, lng, a, s, l, src]) => ({
              type: "Feature",
              geometry: { type: "Point", coordinates: [lng, lat] },
              properties: { t, a, s, l, src },
            })),
          }
        : EMPTY,
    );
    this.src(SRC.clean)?.setData(
      d && d.clean.length > 1
        ? {
            type: "FeatureCollection",
            features: [
              {
                type: "Feature",
                geometry: {
                  type: "LineString",
                  coordinates: d.clean.map(([, lat, lng]) => [lng, lat]),
                },
                properties: {},
              },
            ],
          }
        : EMPTY,
    );
    if (this.loaded) {
      // The recorded track fades so the dots and the clean line stand out.
      this.map.setPaintProperty(
        LYR.track,
        "line-opacity",
        d ? 0.25 : this.playedActive ? 0.32 : 1,
      );
      this.map.setPaintProperty(
        LYR.trackCasing,
        "line-opacity",
        d ? 0.2 : this.playedActive ? 0.35 : 0.9,
      );
    }
  }

  /** Likely roads through the track's data gaps, as [lng, lat] lines; drawn dashed under the track. */
  setEstimates(lines: [number, number][][]) {
    this.estimates = lines;
    this.pushEstimates();
  }

  private pushEstimates() {
    this.src(SRC.estimate)?.setData({
      type: "FeatureCollection",
      features: this.estimates.map((coordinates) => ({
        type: "Feature",
        geometry: { type: "LineString", coordinates },
        properties: {},
      })),
    });
  }

  clear() {
    this.idx = null;
    this.runs = [];
    this.stops = [];
    this.alertPositions = [];
    this.estimates = [];
    this.allPoints = null;
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
    cursor.setData({
      type: "Feature",
      geometry: { type: "Point", coordinates: [s.lng, s.lat] },
      properties: { bearing: s.bearing, s: s.status },
    });
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
      const features = this.runs
        .slice(0, k)
        .map((r, i) => runFeature(idx, r, i));
      features.push(tailFeature);
      played.setData({ type: "FeatureCollection", features });
      this.tailPresent = true;
    } else {
      const add = this.runs
        .slice(this.playedRuns, k)
        .map((r, i) => runFeature(idx, r, this.playedRuns + i));
      played.updateData({
        add,
        update: [
          {
            id: TAIL_ID,
            newGeometry: tailFeature.geometry,
            addOrUpdateProperties: [
              { key: "s", value: run.status },
              { key: "b", value: run.band },
              { key: "gap", value: run.gap },
            ],
          },
        ],
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
    for (let i = 0; i < idx.n; i++)
      if (idx.t[i] >= from && idx.t[i] <= to)
        coords.push([idx.lng[i], idx.lat[i]]);
    src.setData(
      coords.length > 1
        ? {
            type: "Feature",
            geometry: { type: "LineString", coordinates: coords },
            properties: {},
          }
        : EMPTY,
    );
  }

  fit(bounds: [[number, number], [number, number]], instant = false) {
    if (!this.loaded) {
      this.pendingFit = bounds;
      return;
    }
    this.pendingFit = null;
    const [[a, b], [c, d]] = bounds;
    const container = this.map.getContainer();
    const pad = Math.min(
      80,
      Math.max(24, Math.min(container.clientWidth, container.clientHeight) / 8),
    );
    if (a === c && b === d) this.map.jumpTo({ center: [a, b], zoom: 15 });
    else
      this.map.fitBounds(bounds, {
        padding: pad,
        maxZoom: 16,
        duration: instant || this.reducedMotion ? 0 : 700,
      });
  }

  flyTo(lng: number, lat: number) {
    this.map.easeTo({
      center: [lng, lat],
      zoom: Math.max(this.map.getZoom(), 15),
      duration: this.reducedMotion ? 0 : 700,
    });
  }
}

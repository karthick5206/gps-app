import 'maplibre-gl/dist/maplibre-gl.css';
import type { AlertDto } from '@veetracer/shared';
import { AlertTriangleIcon, ChevronDownIcon, ChevronUpIcon, LayersIcon, RouteIcon } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { themeStore } from '@/features/theme/theme-store';
import { prefersReducedMotion, useReducedMotion } from '@/hooks/use-reduced-motion';
import { ApiError, downloadCsv, errorMessage } from '@/lib/api';
import { toast } from 'sonner';
import { useAuth } from '@/features/auth/auth-context';
import { formatDuration } from '@/lib/format';
import { storage } from '@/lib/storage';
import { cn } from '@/lib/utils';
import { CLEAN_TRACK_COLOR, ESTIMATE_COLOR, HistoryMap, POINT_LABEL_COLORS, SPEED_BAND_COLORS, SPEED_BAND_LABELS, STOP_COLORS, type ColorMode, type MarkClick } from './history-map';
import { BasemapPicker } from '@/features/live/map/BasemapPicker';
import { HistorySidePanel, type SideTab } from './HistorySidePanel';
import { HistoryToolbar } from './HistoryToolbar';
import { LiveDataPanel } from './LiveDataPanel';
import { PlaybackBar } from './PlaybackBar';
import { MAX_COMPARE, compareColor, compareFeatures, noDataSeconds, parseCompareIds, unionBounds } from './compare';
import { formatKm } from './history-format';
import { boundsBetween, buildRuns, buildTrackIndex, gapSegments, sampleAt } from './playback-core';
import { PlaybackEngine } from './playback-engine';
import { detectPreset, rangeFromParams, type TimeRange } from './time-range';
import { useCompareHistories, useGapEstimates, useHistory, useMediaQuery, usePointQuality, usePointQualitySettings, useVehicleOptions } from './use-history';
import { useTheme } from '@/features/theme/use-theme';
import { MAX_GAP_ESTIMATES, POINT_LABELS, STATUS_META, TRACK_STATUS_CODES, type PointLabel, type PointQualityResponse } from '@veetracer/shared';

function useHistoryMap(containerRef: RefObject<HTMLDivElement | null>, onMarkClick: (m: MarkClick) => void, onFollowInterrupted: () => void) {
  const [map, setMap] = useState<HistoryMap | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const callbacks = useRef({ onMarkClick, onFollowInterrupted });
  callbacks.current = { onMarkClick, onFollowInterrupted };
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let m: HistoryMap;
    try {
      m = new HistoryMap({
        container: el,
        theme: themeStore.getResolved(),
        reducedMotion: prefersReducedMotion(),
        onMarkClick: (x) => callbacks.current.onMarkClick(x),
        onFollowInterrupted: () => callbacks.current.onFollowInterrupted(),
      });
    } catch {
      setUnsupported(true);
      return;
    }
    const unsubscribeTheme = themeStore.subscribe(() => m.setTheme(themeStore.getResolved()));
    const ro = new ResizeObserver(() => m.resize());
    ro.observe(el);
    setMap(m);
    return () => {
      ro.disconnect();
      unsubscribeTheme();
      m.destroy();
      setMap(null);
    };
  }, [containerRef]);

  useEffect(() => map?.setReducedMotion(reducedMotion), [map, reducedMotion]);
  return { map, unsupported };
}

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(el.tagName) || el.getAttribute('role') === 'combobox';
}

interface AllPointsControl {
  on: boolean;
  onToggle: (on: boolean) => void;
  data: PointQualityResponse | undefined;
  loading: boolean;
  error: boolean;
}

const POINT_LABEL_TEXT: Record<PointLabel, string> = {
  good: 'Good',
  drift: 'Parked drift',
  spike: 'Spike (out and back)',
  jump: 'Jump / outlier',
  inaccurate: 'Inaccurate',
  mock: 'Fake GPS',
  invalid: 'Invalid',
  duplicate: 'Duplicate',
  offroad: 'Off-road',
};

/** History → All points (when the feature is on): switch, each label's colour and count, the clean track and distances. */
function AllPointsLegend({ c }: { c: AllPointsControl }) {
  const { t } = useTranslation();
  return (
    <div className="mt-1.5 border-t pt-1.5">
      <label className="flex items-center justify-between gap-2 px-0.5">
        <span className="font-medium">{t('All points')}</span>
        <Switch checked={c.on} onCheckedChange={c.onToggle} aria-label={t('Show all points with their quality')} />
      </label>
      {c.on && c.loading && <Spinner className="mt-1 size-4" />}
      {c.on && c.error && <p className="mt-1 text-destructive">{t('Could not load the points.')}</p>}
      {c.on && c.data && (
        <>
          <ul className="mt-1 grid grid-cols-2 gap-x-2 gap-y-0.5 px-0.5 text-[11px] sm:text-xs">
            {POINT_LABELS.filter((l) => c.data!.counts[l] > 0).map((l) => (
              <li key={l} className="flex items-center gap-1.5 whitespace-nowrap">
                <span className="size-2.5 rounded-full" style={{ backgroundColor: POINT_LABEL_COLORS[l] }} aria-hidden />
                {t(POINT_LABEL_TEXT[l])} <span className="text-muted-foreground tabular-nums">{c.data!.counts[l]}</span>
              </li>
            ))}
            <li className="flex items-center gap-1.5 whitespace-nowrap">
              <span className="h-1 w-3.5 rounded-full" style={{ backgroundColor: CLEAN_TRACK_COLOR }} aria-hidden />
              {c.data.roadMatched ? t('Clean track (on roads)') : t('Clean track')}
            </li>
          </ul>
          <p className="mt-1 px-0.5 text-[11px] text-muted-foreground tabular-nums sm:text-xs">
            {t('Distance: recorded {{recorded}} km · clean {{clean}} km', { recorded: c.data.distanceKm.recorded.toFixed(1), clean: c.data.distanceKm.clean.toFixed(1) })}
          </p>
        </>
      )}
    </div>
  );
}

interface CompareRow {
  id: string;
  name: string;
  color: string;
  distanceKm: number | null;
  noDataSec: number;
  hasPoints: boolean;
  loading: boolean;
  error: boolean;
}

/** Compare mode: each vehicle's colour, distance and time without data in the period. */
function CompareLegend({ rows }: { rows: CompareRow[] }) {
  const { t } = useTranslation();
  return (
    <ul className="max-w-64 space-y-1 px-0.5 text-[11px] sm:max-w-72 sm:text-xs" aria-label={t('Compare with…')}>
      {rows.map((r) => (
        <li key={r.id} className="flex items-start gap-1.5">
          <span className="mt-1 h-1 w-3.5 shrink-0 rounded-full" style={{ backgroundColor: r.color }} aria-hidden />
          <span className="min-w-0">
            <span className="block truncate font-medium">{r.name}</span>
            <span className="block text-muted-foreground tabular-nums">
              {r.loading ? (
                <Spinner className="size-3" />
              ) : r.error ? (
                t("Couldn't load history")
              ) : !r.hasPoints ? (
                t('No positions in this period')
              ) : (
                <>
                  {r.distanceKm !== null && formatKm(r.distanceKm)}
                  {r.noDataSec > 0 && ` · ${t('No data for {{time}}', { time: formatDuration(r.noDataSec) })}`}
                </>
              )}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function Legend({
  mode,
  onModeChange,
  estimated,
  allPoints,
  compare,
}: {
  mode: ColorMode;
  onModeChange: (m: ColorMode) => void;
  estimated: boolean;
  allPoints: AllPointsControl | null;
  /** Compare mode: lines are coloured per vehicle, so this list replaces the status / speed key. */
  compare: CompareRow[] | null;
}) {
  const { t } = useTranslation();
  const { resolved } = useTheme();
  const [open, setOpen] = useState(() => storage.get(LEGEND_KEY) !== '0');
  const toggle = () => {
    storage.set(LEGEND_KEY, open ? '0' : '1');
    setOpen(!open);
  };
  const items =
    mode === 'status'
      ? TRACK_STATUS_CODES.map((s) => ({ label: t(STATUS_META[s].label), color: STATUS_META[s][resolved] }))
      : SPEED_BAND_LABELS.map((l, i) => ({ label: l, color: SPEED_BAND_COLORS[resolved][i] }));
  return (
    <div className={cn('pointer-events-auto rounded-xl border bg-card/95 text-xs shadow-lg backdrop-blur-sm', open ? 'w-60 p-2 sm:w-72' : 'p-1')}>
      <button type="button" onClick={toggle} aria-expanded={open} className={cn('flex w-full items-center justify-between gap-2 rounded-md font-medium hover:bg-muted', open ? 'mb-1.5 px-1 py-0.5' : 'px-2 py-1')}>
        <span className="inline-flex items-center gap-1.5">
          <LayersIcon className="size-3.5" />
          {compare ? t('Compare') : t('Map key')}
        </span>
        {open ? <ChevronDownIcon className="size-3.5" aria-label={t('Minimise')} /> : <ChevronUpIcon className="size-3.5" aria-label={t('Open')} />}
      </button>
      {open && <>
      <BasemapPicker className="mb-1.5" />
      {compare ? <CompareLegend rows={compare} /> : <>
      <div className="flex rounded-md bg-muted p-0.5" role="group" aria-label={t('Colour track by')}>
        {(['status', 'speed'] as const).map((m) => (
          <button
            key={m}
            type="button"
            aria-pressed={mode === m}
            onClick={() => onModeChange(m)}
            className={cn('h-6 flex-1 rounded px-2 font-medium capitalize transition-colors', mode === m ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}
          >
            {m === 'status' ? t('Status') : t('Speed')}
          </button>
        ))}
      </div>
      {/* Always shown (phones too): compact text below the sm breakpoint. */}
      <ul className="mt-1.5 grid grid-cols-2 gap-x-2 gap-y-0.5 px-0.5 text-[11px] sm:gap-x-3 sm:gap-y-1 sm:text-xs">
        {items.map((i) => (
          <li key={i.label} className="flex items-center gap-1.5 whitespace-nowrap">
            <span className="h-1 w-3.5 rounded-full" style={{ backgroundColor: i.color }} aria-hidden />
            {i.label}
            {mode === 'speed' && <span className="sr-only"> km/h</span>}
          </li>
        ))}
        <li className="flex items-center gap-1.5 whitespace-nowrap">
          <span className="h-0 w-3.5 border-t-2 border-dashed" style={{ borderColor: STATUS_META.OFFLINE[resolved] }} aria-hidden />
          {t('No data (gap)')}
        </li>
        {estimated && (
          <li className="flex items-center gap-1.5 whitespace-nowrap">
            <span className="h-0 w-3.5 border-t-2 border-dotted" style={{ borderColor: ESTIMATE_COLOR[resolved] }} aria-hidden />
            {t('Estimated road (no data)')}
          </li>
        )}
        <li className="flex items-center gap-1.5 whitespace-nowrap">
          <span className="size-2.5 rounded-full border border-white" style={{ backgroundColor: STOP_COLORS.idle[resolved] }} aria-hidden />
          {t('Idle stop')}
        </li>
        <li className="flex items-center gap-1.5 whitespace-nowrap">
          <span className="size-2.5 rounded-full border border-white" style={{ backgroundColor: STOP_COLORS.parked[resolved] }} aria-hidden />
          {t('Parked')}
        </li>
      </ul>
      </>}
      {allPoints && <AllPointsLegend c={allPoints} />}
      </>}
    </div>
  );
}

const LEGEND_KEY = 'vt.history.legend';

function Overlay({ children }: { children: React.ReactNode }) {
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-6">
      <div className="pointer-events-auto max-w-sm rounded-xl border bg-card/95 p-5 text-center shadow-lg backdrop-blur-sm">{children}</div>
    </div>
  );
}

export function HistoryPage() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const objectId = params.get('objectId');
  const fromParam = params.get('from');
  const toParam = params.get('to');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const range = useMemo(() => rangeFromParams(params), [fromParam, toParam]);
  const preset = detectPreset(range);
  const isDesktop = useMediaQuery('(min-width: 1024px)');
  const { can } = useAuth();
  const reducedMotion = useReducedMotion();

  const [skipStops, setSkipStops] = useState(true);
  const [colorMode, setColorMode] = useState<ColorMode>('status');
  const [follow, setFollow] = useState(() => !prefersReducedMotion());
  const [tab, setTab] = useState<SideTab>('trips');
  const [sheetExpanded, setSheetExpanded] = useState(false);
  const [activeTrip, setActiveTrip] = useState(-1);
  const [selected, setSelected] = useState<{ kind: 'stop' | 'alert'; index: number } | null>(null);

  // The period includes now (e.g. Today): reload the track every 20 s so a moving vehicle is seen moving.
  const live = range.from.getTime() < Date.now() && range.to.getTime() > Date.now();
  const query = useHistory(objectId, range.from, range.to, live);
  const data = query.data;

  // Other vehicles drawn over the selected one, each in its own colour.
  const compareParam = params.get('compare');
  const compareIds = useMemo(() => parseCompareIds(compareParam, objectId), [compareParam, objectId]);
  const comparing = !!objectId && compareIds.length > 0;
  const compareQueries = useCompareHistories(comparing ? compareIds : [], range.from, range.to);
  const compareVersion = compareQueries.map((q) => q.dataUpdatedAt).join();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const compareTracks = useMemo(() => compareQueries.map((q) => (q.data ? buildTrackIndex(q.data.points, { skipStops: false }) : null)), [compareVersion]);
  const { resolved } = useTheme();
  const { options: vehicleOptions } = useVehicleOptions('');

  // A vehicle from the URL that this user can't reach (deleted, moved, other company): back to the picker, with a note.
  const [unavailable, setUnavailable] = useState(false);
  const notFound = query.error instanceof ApiError && query.error.status === 404;
  useEffect(() => {
    if (!notFound) return;
    setUnavailable(true);
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('objectId');
        return next;
      },
      { replace: true },
    );
  }, [notFound, setParams]);

  const idx = useMemo(() => (data ? buildTrackIndex(data.points, { skipStops }) : null), [data, skipStops]);
  // One engine per dataset; skip-stops only swaps its index.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const engine = useMemo(() => (idx ? new PlaybackEngine(idx) : null), [data]);
  useEffect(() => {
    if (engine && idx && engine.index !== idx) engine.setIndex(idx);
  }, [engine, idx]);
  useEffect(() => () => engine?.destroy(), [engine]);
  // A new dataset (first load, or a live reload): on a live period start at the latest position; on a reload keep
  // the cursor where it was, or move with the vehicle when it was at the end.
  const lastEngine = useRef<PlaybackEngine | null>(null);
  useEffect(() => {
    const old = lastEngine.current;
    lastEngine.current = engine;
    if (!engine || old === engine) return;
    if (!old || old.index.start !== engine.index.start) {
      if (live) engine.seek(engine.index.end);
      return;
    }
    const t = old.getSample().t;
    const atEnd = t >= old.index.end - 5_000;
    engine.seek(atEnd ? engine.index.end : t, { play: old.getState().playing && !atEnd });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine]);
  // Dev-only handle for diagnostics (frame-time stats: `__vtPlayback.frameStats()`).
  useEffect(() => {
    if (import.meta.env.DEV) (window as unknown as { __vtPlayback?: PlaybackEngine | null }).__vtPlayback = engine;
  }, [engine]);

  const alertPositions = useMemo(() => {
    if (!data || !idx) return [] as { alert: AlertDto; lat: number; lng: number }[];
    return data.alerts.flatMap((alert) => {
      if (alert.lat !== null && alert.lng !== null) return [{ alert, lat: alert.lat, lng: alert.lng }];
      if (!idx.n) return [];
      const s = sampleAt(idx, Date.parse(alert.occurredAt));
      return [{ alert, lat: s.lat, lng: s.lng }];
    });
  }, [data, idx]);

  const containerRef = useRef<HTMLDivElement>(null);
  const markClickRef = useRef<(m: MarkClick) => void>(() => {});
  const { map, unsupported } = useHistoryMap(containerRef, (m) => markClickRef.current(m), () => setFollow(false));

  // Push the dataset into the map and keep the vehicle marker in sync with the engine.
  useEffect(() => {
    if (!map) return;
    if (!data || !idx || !engine) {
      map.clear();
      return;
    }
    map.setData(idx, buildRuns(idx), data.stops, alertPositions);
    const b = boundsBetween(idx, idx.start, idx.end);
    if (b) map.fit(b, true);
    return engine.onFrame((s, { force }) => map.updateCursor(s, force));
    // idx geometry is identical across skip-stops toggles; re-run only for a new dataset.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, engine]);

  // After the effect above, so a new dataset picks up the compare colours and the map fits every path.
  useEffect(() => {
    if (!map) return;
    const features = comparing ? compareTracks.flatMap((c, i) => (c ? compareFeatures(c, compareColor(resolved, i + 1), i) : [])) : [];
    map.setCompare(features, comparing ? compareColor(resolved, 0) : null);
  }, [map, engine, comparing, compareTracks, resolved]);
  useEffect(() => {
    if (!map || !comparing) return;
    const b = unionBounds([idx, ...compareTracks]);
    if (b) map.fit(b, true);
    // idx geometry is identical across skip-stops toggles; `engine` stands for a new dataset.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, engine, comparing, compareTracks]);

  // All points: every recorded point with its quality label + the cleaned track (feature switched on by Super Admin).
  const qualitySettings = usePointQualitySettings();
  const allPointsAvailable = qualitySettings.data?.enabled === true;
  const [allPoints, setAllPoints] = useState(false);
  const quality = usePointQuality(objectId, range.from, range.to, allPoints && allPointsAvailable);
  useEffect(() => {
    if (!map || !engine) return;
    map.setAllPoints(allPoints && allPointsAvailable && quality.data ? quality.data : null, {
      label: (l) => t(POINT_LABEL_TEXT[l]),
      source: (src) => (src === 1 ? t('raw phone record') : t('stored point')),
    });
  }, [map, engine, allPoints, allPointsAvailable, quality.data, t]);
  const allPointsControl: AllPointsControl | null = allPointsAvailable
    ? { on: allPoints, onToggle: setAllPoints, data: quality.data, loading: quality.isFetching, error: quality.isError }
    : null;

  // Likely roads through data gaps (when the server has a routing engine), drawn under the track.
  const gaps = useMemo(() => (idx ? gapSegments(idx, MAX_GAP_ESTIMATES) : []), [idx]);
  const estimates = useGapEstimates(data ? `${data.objectId}|${data.from}|${data.to}` : null, gaps);
  useEffect(() => {
    if (map && engine) map.setEstimates(estimates);
  }, [map, engine, estimates]);

  useEffect(() => map?.setColorMode(colorMode), [map, colorMode]);
  useEffect(() => map?.setFollow(follow), [map, follow]);

  // Track which trip the cursor is in (React state changes only when the trip changes).
  useEffect(() => {
    setActiveTrip(-1);
    setSelected(null);
    if (!engine || !data?.trips.length) return;
    const starts = data.trips.map((t) => Date.parse(t.startTime));
    const ends = data.trips.map((t) => Date.parse(t.endTime));
    let last = -1;
    return engine.onFrame((s) => {
      let k = -1;
      for (let i = 0; i < starts.length && starts[i] <= s.t; i++) if (s.t <= ends[i]) k = i;
      if (k !== last) {
        last = k;
        setActiveTrip(k);
      }
    });
  }, [engine, data]);

  useEffect(() => {
    const trip = activeTrip >= 0 ? data?.trips[activeTrip] : undefined;
    map?.highlight(trip ? Date.parse(trip.startTime) : null, trip ? Date.parse(trip.endTime) : null);
  }, [map, data, activeTrip]);

  // Space toggles playback when focus isn't in a control.
  useEffect(() => {
    if (!engine) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || isTypingTarget(e.target) || e.defaultPrevented) return;
      e.preventDefault();
      engine.toggle();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [engine]);

  const onTrip = useCallback(
    (i: number) => {
      const trip = data?.trips[i];
      if (!trip || !engine || !idx) return;
      const from = Date.parse(trip.startTime);
      const to = Date.parse(trip.endTime);
      const b = boundsBetween(idx, from, to);
      if (b) map?.fit(b, follow);
      setSelected(null);
      engine.seek(from, { play: true, until: to });
    },
    [data, engine, idx, map, follow],
  );
  const onStop = useCallback(
    (i: number) => {
      const stop = data?.stops[i];
      if (!stop || !engine) return;
      engine.pause();
      engine.seek(Date.parse(stop.startTime));
      map?.flyTo(stop.lng, stop.lat);
      setSelected({ kind: 'stop', index: i });
    },
    [data, engine, map],
  );
  const onAlert = useCallback(
    (i: number) => {
      const a = alertPositions[i];
      if (!a || !engine) return;
      engine.pause();
      engine.seek(Date.parse(a.alert.occurredAt));
      map?.flyTo(a.lng, a.lat);
      setSelected({ kind: 'alert', index: i });
    },
    [alertPositions, engine, map],
  );
  markClickRef.current = (m) => {
    setTab(m.kind === 'stop' ? 'stops' : 'alerts');
    if (!isDesktop) setSheetExpanded(true);
    if (m.kind === 'stop') onStop(m.index);
    else onAlert(m.index);
  };

  const setObject = (id: string | null) => {
    setUnavailable(false);
    const next = new URLSearchParams(params);
    if (id) next.set('objectId', id);
    else next.delete('objectId');
    setParams(next, { replace: true });
  };
  const setCompare = (ids: string[]) => {
    if (ids.length > MAX_COMPARE) {
      toast.info(t('You can compare up to {{count}} more vehicles.', { count: MAX_COMPARE }));
      return;
    }
    const next = new URLSearchParams(params);
    if (ids.length) next.set('compare', ids.join(','));
    else next.delete('compare');
    setParams(next, { replace: true });
  };
  const setRange = (r: TimeRange) => {
    const next = new URLSearchParams(params);
    next.set('from', r.from.toISOString());
    next.set('to', r.to.toISOString());
    setParams(next, { replace: true });
  };

  const multiDay = range.to.getTime() - range.from.getTime() > 86_400_000;
  const hasTrack = !!idx && idx.n > 0;
  const vehicleName = (id: string) => vehicleOptions.find((o) => o.value === id)?.label ?? t('Selected item');
  const compareRows: CompareRow[] | null = comparing
    ? [
        {
          id: objectId!,
          name: vehicleName(objectId!),
          color: compareColor(resolved, 0),
          distanceKm: data?.summary.distanceKm ?? null,
          noDataSec: idx ? noDataSeconds(idx) : 0,
          hasPoints: hasTrack,
          loading: query.isFetching,
          error: query.isError,
        },
        ...compareIds.map((id, i) => {
          const q = compareQueries[i];
          const track = compareTracks[i];
          return {
            id,
            name: vehicleName(id),
            color: compareColor(resolved, i + 1),
            distanceKm: q?.data?.summary.distanceKm ?? null,
            noDataSec: track ? noDataSeconds(track) : 0,
            hasPoints: !!track && track.n > 0,
            loading: !!q?.isFetching,
            error: !!q?.isError,
          };
        }),
      ]
    : null;

  const side = (
    <HistorySidePanel
      data={data}
      tab={tab}
      onTabChange={setTab}
      activeTrip={activeTrip}
      selected={selected}
      onTrip={onTrip}
      onStop={onStop}
      onAlert={onAlert}
      multiDay={multiDay}
      mobile={!isDesktop}
      expanded={isDesktop || sheetExpanded}
      onExpandedChange={setSheetExpanded}
      onExport={
        can('history', 'export') && objectId
          ? (kind) =>
              downloadCsv(`/objects/${objectId}/${kind}`, { from: range.from.toISOString(), to: range.to.toISOString() }, `${kind}.csv`).catch((err) =>
                toast.error(errorMessage(err)),
              )
          : undefined
      }
      className={isDesktop ? 'w-[22rem] shrink-0 border-l' : cn('shrink-0 border-t', sheetExpanded ? 'h-[42%]' : '')}
    />
  );

  return (
    <div className={cn('flex h-full flex-col', isDesktop ? 'min-h-[600px]' : sheetExpanded ? 'min-h-[820px]' : 'min-h-[640px]')}>
      <div className="border-b bg-card px-3 py-2.5 sm:px-4">
        <HistoryToolbar objectId={objectId} onObjectChange={setObject} compareIds={compareIds} onCompareChange={setCompare} range={range} preset={preset} onRangeChange={setRange} />
      </div>
      {(data?.truncated || (comparing && compareQueries.some((q) => q.data?.truncated))) && (
        <div role="status" className="flex items-start gap-2 border-b bg-warning/10 px-4 py-2 text-xs text-warning sm:text-sm">
          <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" />
          <span>{t('This period has more points than can be drawn, so the track was simplified (stops and alert points are kept). Choose a shorter period for full detail.')}</span>
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="relative min-h-0 flex-1">
            <div ref={containerRef} className="h-full w-full" role="region" aria-label={t('History map')} />
            {unsupported && (
              <Overlay>
                <p className="text-sm text-muted-foreground">{t("The map can't be shown because WebGL is turned off or not supported in this browser.")}</p>
              </Overlay>
            )}
            {engine && hasTrack && (
              <div className="pointer-events-none absolute top-2 right-12 left-2 sm:top-3 sm:left-3 sm:right-auto sm:w-80">
                <LiveDataPanel engine={engine} totalKm={data?.summary.distanceKm ?? null} />
              </div>
            )}
            {(hasTrack || comparing) && (
              <div className="pointer-events-none absolute right-2 bottom-7 sm:right-3">
                <Legend mode={colorMode} onModeChange={setColorMode} estimated={estimates.length > 0} allPoints={allPointsControl} compare={compareRows} />
              </div>
            )}
            {!objectId && (
              <Overlay>
                <RouteIcon className="mx-auto size-8 text-primary" />
                <p className="mt-2 font-medium">{unavailable ? t("This vehicle isn't available") : t('Pick a vehicle')}</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {unavailable ? t('It may have been deleted or moved, or you may no longer have access. Choose another vehicle.') : t('Choose a vehicle and a period to replay its route, trips, stops and alerts.')}
                </p>
              </Overlay>
            )}
            {objectId && query.isFetching && (
              <div className="pointer-events-none absolute inset-x-0 top-24 flex justify-center sm:top-3">
                <span className="flex items-center gap-2 rounded-full border bg-card px-3 py-1.5 text-sm shadow-md">
                  <Spinner /> {t('Loading history…')}
                </span>
              </div>
            )}
            {objectId && query.isError && !notFound && (
              <Overlay>
                <AlertTriangleIcon className="mx-auto size-7 text-destructive" />
                <p className="mt-2 font-medium">{t("Couldn't load history")}</p>
                <p className="mt-1 text-sm text-muted-foreground">{errorMessage(query.error)}</p>
              </Overlay>
            )}
            {objectId && data && !hasTrack && !query.isFetching && !comparing && (
              <Overlay>
                <p className="font-medium">{t('No positions in this period')}</p>
                <p className="mt-1 text-sm text-muted-foreground">{t('Try another day or a longer range.')}</p>
              </Overlay>
            )}
          </div>
          {engine && hasTrack && data && (
            <PlaybackBar
              engine={engine}
              trips={data.trips}
              alerts={data.alerts}
              fuel={data.fuel}
              follow={follow}
              onFollowChange={setFollow}
              skipStops={skipStops}
              onSkipStopsChange={setSkipStops}
              className="border-t"
            />
          )}
          {!isDesktop && side}
        </div>
        {isDesktop && side}
      </div>
      {reducedMotion && <span className="sr-only">{t('Reduced motion is on: the camera does not animate automatically.')}</span>}
    </div>
  );
}

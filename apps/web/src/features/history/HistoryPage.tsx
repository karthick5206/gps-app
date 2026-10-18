import 'maplibre-gl/dist/maplibre-gl.css';
import type { AlertDto } from '@veetracer/shared';
import { AlertTriangleIcon, RouteIcon } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import { Spinner } from '@/components/ui/spinner';
import { themeStore } from '@/features/theme/theme-store';
import { prefersReducedMotion, useReducedMotion } from '@/hooks/use-reduced-motion';
import { downloadCsv, errorMessage } from '@/lib/api';
import { toast } from 'sonner';
import { useAuth } from '@/features/auth/auth-context';
import { cn } from '@/lib/utils';
import { HistoryMap, SPEED_BAND_COLORS, SPEED_BAND_LABELS, type ColorMode, type MarkClick } from './history-map';
import { HistorySidePanel, type SideTab } from './HistorySidePanel';
import { HistoryToolbar } from './HistoryToolbar';
import { LiveDataPanel } from './LiveDataPanel';
import { PlaybackBar } from './PlaybackBar';
import { boundsBetween, buildRuns, buildTrackIndex, sampleAt } from './playback-core';
import { PlaybackEngine } from './playback-engine';
import { detectPreset, rangeFromParams, type TimeRange } from './time-range';
import { useHistory, useMediaQuery } from './use-history';
import { useTheme } from '@/features/theme/use-theme';
import { STATUS_META, TRACK_STATUS_CODES } from '@veetracer/shared';

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

function Legend({ mode, onModeChange }: { mode: ColorMode; onModeChange: (m: ColorMode) => void }) {
  const { t } = useTranslation();
  const { resolved } = useTheme();
  const items =
    mode === 'status'
      ? TRACK_STATUS_CODES.map((s) => ({ label: t(STATUS_META[s].label), color: STATUS_META[s][resolved] }))
      : SPEED_BAND_LABELS.map((l, i) => ({ label: l, color: SPEED_BAND_COLORS[resolved][i] }));
  return (
    <div className="pointer-events-auto rounded-xl border bg-card/95 p-2 text-xs shadow-lg backdrop-blur-sm">
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
      <ul className="mt-1.5 hidden grid-cols-2 gap-x-3 gap-y-1 px-0.5 sm:grid">
        {items.map((i) => (
          <li key={i.label} className="flex items-center gap-1.5 whitespace-nowrap">
            <span className="h-1 w-3.5 rounded-full" style={{ backgroundColor: i.color }} aria-hidden />
            {i.label}
            {mode === 'speed' && <span className="sr-only"> km/h</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

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

  const query = useHistory(objectId, range.from, range.to);
  const data = query.data;

  const idx = useMemo(() => (data ? buildTrackIndex(data.points, { skipStops }) : null), [data, skipStops]);
  // One engine per dataset; skip-stops only swaps its index.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const engine = useMemo(() => (idx ? new PlaybackEngine(idx) : null), [data]);
  useEffect(() => {
    if (engine && idx && engine.index !== idx) engine.setIndex(idx);
  }, [engine, idx]);
  useEffect(() => () => engine?.destroy(), [engine]);
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
    const next = new URLSearchParams(params);
    if (id) next.set('objectId', id);
    else next.delete('objectId');
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
        <HistoryToolbar objectId={objectId} onObjectChange={setObject} range={range} preset={preset} onRangeChange={setRange} />
      </div>
      {data?.truncated && (
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
                <LiveDataPanel engine={engine} />
              </div>
            )}
            {hasTrack && (
              <div className="pointer-events-none absolute right-2 bottom-7 sm:right-3">
                <Legend mode={colorMode} onModeChange={setColorMode} />
              </div>
            )}
            {!objectId && (
              <Overlay>
                <RouteIcon className="mx-auto size-8 text-primary" />
                <p className="mt-2 font-medium">{t('Pick a vehicle')}</p>
                <p className="mt-1 text-sm text-muted-foreground">{t('Choose a vehicle and a period to replay its route, trips, stops and alerts.')}</p>
              </Overlay>
            )}
            {objectId && query.isFetching && (
              <div className="pointer-events-none absolute inset-x-0 top-24 flex justify-center sm:top-3">
                <span className="flex items-center gap-2 rounded-full border bg-card px-3 py-1.5 text-sm shadow-md">
                  <Spinner /> {t('Loading history…')}
                </span>
              </div>
            )}
            {objectId && query.isError && (
              <Overlay>
                <AlertTriangleIcon className="mx-auto size-7 text-destructive" />
                <p className="mt-2 font-medium">{t("Couldn't load history")}</p>
                <p className="mt-1 text-sm text-muted-foreground">{errorMessage(query.error)}</p>
              </Overlay>
            )}
            {objectId && data && !hasTrack && !query.isFetching && (
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

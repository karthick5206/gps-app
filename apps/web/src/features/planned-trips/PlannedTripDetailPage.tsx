import 'maplibre-gl/dist/maplibre-gl.css';
import type { PlannedTripDto, PlannedTripEventDto, PlannedTripStopDto } from '@veetracer/shared';
import { AlertTriangleIcon, ArrowLeftIcon, CalendarClockIcon, ChevronDownIcon, ChevronUpIcon, LayersIcon, OctagonPauseIcon, RouteIcon } from 'lucide-react';
import type { ExpressionSpecification } from 'maplibre-gl';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';
import { FormError } from '@/components/form-error';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { useAuth } from '@/features/auth/auth-context';
import { HistoryMap } from '@/features/history/history-map';
import { PlaybackBar } from '@/features/history/PlaybackBar';
import { boundsBetween, buildRuns, buildTrackIndex } from '@/features/history/playback-core';
import { PlaybackEngine } from '@/features/history/playback-engine';
import { useHistory } from '@/features/history/use-history';
import { BasemapPicker } from '@/features/live/map/BasemapPicker';
import { dayKeyInZone, getReportTimeZone } from '@/features/reports/report-time';
import { themeStore } from '@/features/theme/theme-store';
import { prefersReducedMotion, useReducedMotion } from '@/hooks/use-reduced-motion';
import { ApiError, errorMessage } from '@/lib/api';
import { formatDuration } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useTripActionDialogs } from './TripDialogs';
import { actualDwellSec, formatClock, isActiveTrip, isEtmsTrip, plannedDwellSec, progressLabel, trackWindow, tripSourceLabel } from './trip-format';
import { buildPlanFeatures, corridorWidth, deviationFeatures, deviationSegments, lineLatitude, planBounds, plannedLine, stopTone, type StopTone } from './trip-map';
import { DelayText, TripActionButtons, TripStatusBadge } from './trip-ui';
import { usePlannedTripLive, useTrip } from './use-planned-trips';

const TONE_LABEL: Record<StopTone, string> = {
  ontime: 'On time',
  late: 'Late',
  early: 'Early',
  skipped: 'Skipped',
  pending: 'Pending',
  next: 'Next stop',
};
const TONE_CLASS: Record<StopTone, string> = {
  ontime: 'bg-success text-white',
  late: 'bg-warning text-white',
  early: 'bg-info text-white',
  skipped: 'bg-destructive text-white',
  pending: 'bg-muted text-muted-foreground',
  next: 'bg-primary text-primary-foreground',
};
const TONE_TEXT: Record<StopTone, string> = {
  ontime: 'text-success-fg',
  late: 'text-warning-fg',
  early: 'text-info-fg',
  skipped: 'text-destructive-fg',
  pending: 'text-muted-foreground',
  next: 'text-primary',
};

const HOUR = 3_600_000;

/** The map lives in a container that only mounts once the trip has loaded, so it is keyed on the element (callback ref), not a ref object. */
function useTripMap(el: HTMLDivElement | null, onFollowInterrupted: () => void) {
  const [map, setMap] = useState<HistoryMap | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const cb = useRef(onFollowInterrupted);
  cb.current = onFollowInterrupted;
  const reducedMotion = useReducedMotion();
  useEffect(() => {
    if (!el) return;
    let m: HistoryMap;
    try {
      m = new HistoryMap({
        container: el,
        theme: themeStore.getResolved(),
        reducedMotion: prefersReducedMotion(),
        onMarkClick: () => undefined,
        onFollowInterrupted: () => cb.current(),
      });
    } catch {
      setUnsupported(true);
      return;
    }
    const offTheme = themeStore.subscribe(() => m.setTheme(themeStore.getResolved()));
    const ro = new ResizeObserver(() => m.resize());
    ro.observe(el);
    setMap(m);
    return () => {
      ro.disconnect();
      offTheme();
      m.destroy();
      setMap(null);
    };
  }, [el]);
  useEffect(() => map?.setReducedMotion(reducedMotion), [map, reducedMotion]);
  return { map, unsupported };
}

function Stat({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn('min-w-0', className)}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 truncate text-sm font-medium tabular-nums">{children}</dd>
    </div>
  );
}

function MapLegend() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <div className={cn('pointer-events-auto rounded-xl border bg-card/95 text-xs shadow-lg backdrop-blur-sm', open ? 'w-56 p-2' : 'p-1')}>
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className={cn('flex w-full items-center justify-between gap-2 rounded-md font-medium hover:bg-muted', open ? 'mb-1.5 px-1 py-0.5' : 'px-2 py-1')}>
        <span className="inline-flex items-center gap-1.5">
          <LayersIcon className="size-3.5" />
          {t('Map key')}
        </span>
        {open ? <ChevronDownIcon className="size-3.5" aria-label={t('Minimise')} /> : <ChevronUpIcon className="size-3.5" aria-label={t('Open')} />}
      </button>
      {open && (
        <>
          <BasemapPicker className="mb-1.5" />
          <ul className="space-y-1 px-0.5">
            <li className="flex items-center gap-1.5">
              <span className="h-0 w-4 border-t-2 border-dashed border-primary" aria-hidden />
              {t('Planned route')}
            </li>
            <li className="flex items-center gap-1.5">
              <span className="h-2.5 w-4 rounded-sm bg-primary/20" aria-hidden />
              {t('Corridor')}
            </li>
            <li className="flex items-center gap-1.5">
              <span className="h-1 w-4 rounded-full bg-destructive" aria-hidden />
              {t('Off route')}
            </li>
            {(['ontime', 'late', 'early', 'skipped', 'next', 'pending'] as const).map((k) => (
              <li key={k} className="flex items-center gap-1.5">
                <span className={cn('size-2.5 rounded-full', TONE_CLASS[k].split(' ')[0])} aria-hidden />
                {t(TONE_LABEL[k])}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function StopTimeline({ trip, clock, onPick }: { trip: PlannedTripDto; clock: (iso: string | null | undefined) => string; onPick: (s: PlannedTripStopDto) => void }) {
  const { t } = useTranslation();
  const stops = [...trip.stops].sort((a, b) => a.seq - b.seq);
  return (
    <ol className="relative">
      {stops.map((s, i) => {
        const tone = stopTone(trip, s);
        const dwell = actualDwellSec(s);
        const isNext = tone === 'next';
        const last = i === stops.length - 1;
        return (
          <li key={s.id} className="relative flex gap-3 pb-4 last:pb-0">
            {!last && <span className="absolute top-7 bottom-0 left-[13px] w-px bg-border" aria-hidden />}
            <button
              type="button"
              onClick={() => onPick(s)}
              className={cn('relative z-[1] flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring', TONE_CLASS[tone])}
              aria-label={t('Show {{name}} on the map', { name: s.name })}
            >
              {s.seq + 1}
            </button>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="min-w-0 truncate font-medium">{s.name}</span>
                <span className={cn('text-xs font-medium', TONE_TEXT[tone])}>{t(TONE_LABEL[tone])}</span>
              </div>
              <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs tabular-nums">
                <dt className="text-muted-foreground">{t('Planned')}</dt>
                <dd>
                  {i === 0 ? `${t('dep.')} ${clock(s.plannedDeparture)}` : last ? `${t('arr.')} ${clock(s.plannedArrival)}` : `${clock(s.plannedArrival)} – ${clock(s.plannedDeparture)}`}
                  {i > 0 && !last && plannedDwellSec(s) > 0 && <span className="text-muted-foreground">{` · ${formatDuration(plannedDwellSec(s))}`}</span>}
                </dd>
                <dt className="text-muted-foreground">{t('Actual')}</dt>
                <dd>
                  {s.status === 'SKIPPED' ? (
                    <span className="text-muted-foreground">{t('Not visited')}</span>
                  ) : s.actualArrival || s.actualDeparture ? (
                    <>
                      {i === 0 && !s.actualArrival ? `${t('dep.')} ${clock(s.actualDeparture)}` : `${clock(s.actualArrival)}${last ? '' : ` – ${clock(s.actualDeparture)}`}`}
                      {dwell !== null && <span className="text-muted-foreground">{` · ${formatDuration(dwell)}`}</span>}
                      {s.delaySec !== null && (
                        <>
                          {' · '}
                          <DelayText delaySec={s.delaySec} />
                        </>
                      )}
                    </>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </dd>
                {isNext && trip.etaNextStop && (
                  <>
                    <dt className="text-primary">{t('ETA')}</dt>
                    <dd className="font-medium text-primary">
                      {clock(trip.etaNextStop)}
                      {trip.delaySec !== null && (
                        <>
                          {' · '}
                          <DelayText delaySec={trip.delaySec} />
                        </>
                      )}
                    </dd>
                  </>
                )}
              </dl>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function EventList({ events, clock, onPick }: { events: PlannedTripEventDto[]; clock: (iso: string | null | undefined) => string; onPick: (e: PlannedTripEventDto) => void }) {
  const { t } = useTranslation();
  if (!events.length) return <p className="text-sm text-muted-foreground">{t('No deviations or unscheduled stops.')}</p>;
  return (
    <ul className="divide-y">
      {events.map((e) => {
        const deviation = e.kind === 'DEVIATION';
        const data = e.data ?? {};
        const maxM = typeof data.maxM === 'number' ? data.maxM : null;
        const durationSec = typeof data.durationSec === 'number' ? data.durationSec : e.endAt ? (Date.parse(e.endAt) - Date.parse(e.startAt)) / 1000 : null;
        return (
          <li key={e.id}>
            <button type="button" onClick={() => onPick(e)} className="flex w-full items-start gap-3 py-2 text-left hover:bg-accent/50 focus-visible:bg-accent/50 focus-visible:outline-none">
              <span className={cn('mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full', deviation ? 'bg-destructive-soft text-destructive-fg' : 'bg-warning-soft text-warning-fg')} aria-hidden>
                {deviation ? <RouteIcon className="size-4" /> : <OctagonPauseIcon className="size-4" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">{deviation ? t('Off route') : t('Unscheduled stop')}</span>
                <span className="block text-xs text-muted-foreground tabular-nums">
                  {clock(e.startAt)} – {e.endAt ? clock(e.endAt) : t('ongoing')}
                  {durationSec !== null && ` · ${formatDuration(durationSec)}`}
                  {deviation && maxM !== null && ` · ${t('max {{m}} m', { m: Math.round(maxM) })}`}
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** Tracking → Planned trips → one trip: plan vs actual, stop timeline, events, map with playback (SPEC §4.5). */
export function PlannedTripDetailPage() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const { can } = useAuth();
  const tz = getReportTimeZone();
  const query = useTrip(id);
  const trip = query.data;
  const { request, dialogs } = useTripActionDialogs();
  usePlannedTripLive();

  const day = trip ? dayKeyInZone(trip.plannedStart, tz) : undefined;
  const clock = (iso: string | null | undefined) => formatClock(iso, tz, day);

  // Actual track: actual start → actual end; while active up to the next full hour after now / the planned end, reloaded every 20 s.
  const active = !!trip && isActiveTrip(trip.status);
  const hourBucket = Math.floor(Date.now() / HOUR);
  const trackRange = useMemo(() => {
    const w = trip ? trackWindow(trip) : null;
    if (!w || !trip) return null;
    // Active: a stable end (next full hour) so the query key does not change on every render; the API stops at now.
    const to = active ? (Math.floor(Math.max(Date.now(), Date.parse(trip.plannedEnd)) / HOUR) + 1) * HOUR : w.to;
    return { from: new Date(w.from), to: new Date(to) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trip?.actualStart, trip?.actualEnd, trip?.plannedEnd, trip?.status, active, hourBucket]);
  const canHistory = can('history');
  const history = useHistory(trip && trackRange && canHistory ? trip.objectId : null, trackRange?.from ?? new Date(0), trackRange?.to ?? new Date(0), active);
  const data = trackRange ? history.data : undefined;

  const [follow, setFollow] = useState(false);
  const [skipStops, setSkipStops] = useState(false);
  const idx = useMemo(() => (data ? buildTrackIndex(data.points, { skipStops }) : null), [data, skipStops]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const engine = useMemo(() => (idx && idx.n > 0 ? new PlaybackEngine(idx) : null), [data]);
  useEffect(() => {
    if (engine && idx && engine.index !== idx) engine.setIndex(idx);
  }, [engine, idx]);
  useEffect(() => () => engine?.destroy(), [engine]);
  // While active, the first load starts at the latest position; a reload keeps the cursor where it was, or moves with
  // the vehicle when it was at the end (as History does).
  const lastEngine = useRef<PlaybackEngine | null>(null);
  useEffect(() => {
    const old = lastEngine.current;
    lastEngine.current = engine;
    if (!engine || old === engine || !active) return;
    if (!old) return engine.seek(engine.index.end);
    const at = old.getSample().t;
    const atEnd = at >= old.index.end - 5_000;
    engine.seek(atEnd ? engine.index.end : at, { play: old.getState().playing && !atEnd });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine]);

  const [mapEl, setMapEl] = useState<HTMLDivElement | null>(null);
  const { map, unsupported } = useTripMap(mapEl, () => setFollow(false));

  useEffect(() => {
    if (!map) return;
    if (!idx || !engine) {
      map.clear();
      return;
    }
    map.setData(idx, buildRuns(idx), [], []);
    return engine.onFrame((s, { force }) => map.updateCursor(s, force));
    // A new dataset only (skip-stops swaps the index, same geometry).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, engine]);
  useEffect(() => map?.setFollow(follow), [map, follow]);

  // Plan overlay: route, corridor, stops (live colours) and deviation stretches of the track.
  useEffect(() => {
    if (!map || !trip) return;
    const line = plannedLine(trip);
    map.setPlan({
      features: buildPlanFeatures(trip) as unknown as GeoJSON.FeatureCollection,
      deviations: { type: 'FeatureCollection', features: deviationFeatures(deviationSegments(data?.points ?? [], trip.events)) as unknown as GeoJSON.Feature[] },
      corridorWidth: line.length > 1 ? (corridorWidth(trip.corridorM, lineLatitude(line)) as ExpressionSpecification) : null,
    });
  }, [map, trip, data]);

  // Fit once per trip (plan + track when it arrives), not on every live reload.
  const fitted = useRef<string | null>(null);
  useEffect(() => {
    if (!map || !trip) return;
    const key = `${trip.id}|${idx && idx.n > 0 ? 'track' : 'plan'}`;
    if (fitted.current === key) return;
    let b = planBounds(trip);
    const tb = idx && idx.n > 0 ? boundsBetween(idx, idx.start, idx.end) : null;
    if (b && tb) b = [[Math.min(b[0][0], tb[0][0]), Math.min(b[0][1], tb[0][1])], [Math.max(b[1][0], tb[1][0]), Math.max(b[1][1], tb[1][1])]];
    b = b ?? tb;
    if (!b) return;
    fitted.current = key;
    map.fit(b, true);
  }, [map, trip, idx]);

  const pickStop = (s: PlannedTripStopDto) => {
    map?.flyTo(s.lng, s.lat);
    const at = s.actualArrival ?? s.actualDeparture;
    if (engine && at) {
      engine.pause();
      engine.seek(Date.parse(at));
    }
  };
  const pickEvent = (e: PlannedTripEventDto) => {
    map?.flyTo(e.lng, e.lat);
    if (engine) {
      engine.pause();
      engine.seek(Date.parse(e.startAt));
    }
  };

  if (query.isError) {
    const notFound = query.error instanceof ApiError && query.error.status === 404;
    return (
      <div className="flex w-full min-w-0 flex-col gap-5 p-4 sm:p-6">
        <BackLink />
        {notFound ? <EmptyState icon={CalendarClockIcon} title={t('Trip not found')} description={t('It may have been deleted, or you may not have access to its vehicle.')} /> : <FormError message={errorMessage(query.error)} />}
      </div>
    );
  }
  if (!trip) {
    return (
      <div className="flex w-full min-w-0 flex-col gap-4 p-4 sm:p-6" aria-busy>
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  const hasTrack = !!engine && !!idx && idx.n > 0;
  const distance = trip.distanceKm ?? (active && data ? data.summary.distanceKm : null);

  return (
    <div className="flex w-full min-w-0 flex-col gap-4 p-4 sm:p-6">
      <PageHeader
        title={tripSourceLabel(trip, t)}
        description={
          <>
            {trip.objectName ?? '—'}
            {trip.driverName && ` · ${trip.driverName}`}
          </>
        }
        actions={
          <>
            <BackLink />
            <TripActionButtons trip={trip} onAction={request} />
          </>
        }
      />

      {isEtmsTrip(trip) && (
        <div role="note" className="flex flex-wrap items-center gap-2 rounded-lg border border-info/40 bg-info-soft p-3 text-sm text-info-fg">
          <span className="min-w-0 flex-1">{t('Managed by employee transport: passengers, changes and cancelling are done in Transport → Dispatch.')}</span>
          {can('etms_dispatch') && (
            <Button asChild size="sm" variant="outline">
              <Link to="/transport/dispatch">{t('Open Dispatch')}</Link>
            </Button>
          )}
        </div>
      )}

      <Card className="gap-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <TripStatusBadge status={trip.status} />
          <span className="text-sm text-muted-foreground">{progressLabel(trip, t)}</span>
          {trip.closedBy && trip.status !== 'CANCELLED' && (
            <span className="text-xs text-muted-foreground">{trip.closedBy === 'AUTO' ? t('Closed automatically') : trip.closedBy === 'TIMEOUT' ? t('Timed out') : t('Closed by hand')}</span>
          )}
        </div>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3 xl:grid-cols-6">
          <Stat label={t('Planned start / end')}>
            {clock(trip.plannedStart)} – {clock(trip.plannedEnd)}
          </Stat>
          <Stat label={t('Actual start / end')}>
            {clock(trip.actualStart)} – {trip.actualEnd ? clock(trip.actualEnd) : active ? t('now') : '—'}
          </Stat>
          <Stat label={t('Delay')}>
            <DelayText delaySec={trip.delaySec} />
          </Stat>
          <Stat label={active ? t('Next stop ETA') : t('Distance')}>{active ? clock(trip.etaNextStop) : distance !== null ? `${distance.toFixed(1)} km` : '—'}</Stat>
          <Stat label={t('Deviations')}>
            {trip.deviationCount}
            {trip.maxDeviationM !== null && <span className="text-muted-foreground">{` · ${t('max {{m}} m', { m: Math.round(trip.maxDeviationM) })}`}</span>}
          </Stat>
          <Stat label={t('Corridor')}>{`± ${trip.corridorM} m`}</Stat>
        </dl>
        {trip.cancelReason && (
          <p className="text-sm">
            <span className="text-muted-foreground">{t('Cancel reason')}: </span>
            {trip.cancelReason}
          </p>
        )}
        {trip.notes && (
          <p className="text-sm">
            <span className="text-muted-foreground">{t('Notes')}: </span>
            {trip.notes}
          </p>
        )}
      </Card>

      <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <Card className="min-w-0 gap-0 overflow-hidden py-0">
          <div className="relative h-[360px] sm:h-[480px]">
            <div ref={setMapEl} className="h-full w-full" role="region" aria-label={t('Trip map')} />
            {!unsupported && (
              <div className="pointer-events-none absolute right-2 bottom-7 sm:right-3">
                <MapLegend />
              </div>
            )}
            {unsupported && (
              <div className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-muted-foreground">{t("The map can't be shown because WebGL is turned off or not supported in this browser.")}</div>
            )}
            {trackRange && history.isFetching && (
              <div className="pointer-events-none absolute inset-x-0 top-3 flex justify-center">
                <span className="flex items-center gap-2 rounded-full border bg-card px-3 py-1.5 text-sm shadow-md">
                  <Spinner /> {t('Loading track…')}
                </span>
              </div>
            )}
          </div>
          {hasTrack && data ? (
            <PlaybackBar engine={engine} trips={[]} alerts={data.alerts} fuel={data.fuel} follow={follow} onFollowChange={setFollow} skipStops={skipStops} onSkipStopsChange={setSkipStops} className="border-t" />
          ) : (
            <p className="flex items-center gap-2 border-t px-4 py-3 text-xs text-muted-foreground">
              {trackRange && history.isError ? (
                <>
                  <AlertTriangleIcon className="size-4 shrink-0 text-destructive" />
                  {t("Couldn't load the track: {{message}}", { message: errorMessage(history.error) })}
                </>
              ) : !trackRange ? (
                t('The actual track appears once the trip starts.')
              ) : !canHistory ? (
                t('You need access to History to see the actual track.')
              ) : history.isFetching ? (
                t('Loading track…')
              ) : (
                t('No positions recorded during this trip yet.')
              )}
            </p>
          )}
        </Card>

        <div className="flex min-w-0 flex-col gap-4">
          <Card className="gap-3 p-4">
            <h2 className="font-semibold">{t('Stops')}</h2>
            <StopTimeline trip={trip} clock={clock} onPick={pickStop} />
          </Card>
          <Card className="gap-2 p-4">
            <h2 className="font-semibold">{t('Events')}</h2>
            <EventList events={trip.events} clock={clock} onPick={pickEvent} />
          </Card>
        </div>
      </div>
      {dialogs}
    </div>
  );
}

function BackLink() {
  const { t } = useTranslation();
  return (
    <Button variant="ghost" size="sm" asChild>
      <Link to="/planned-trips">
        <ArrowLeftIcon /> {t('All trips')}
      </Link>
    </Button>
  );
}

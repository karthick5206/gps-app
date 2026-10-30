import { useQuery } from '@tanstack/react-query';
import { chargeState, type LiveObject, type VehicleDayStatsDto } from '@veetracer/shared';
import { CircleParkingIcon, GaugeIcon, HourglassIcon, MilestoneIcon, NavigationIcon, RouteIcon, TimerIcon, ZapIcon, ZapOffIcon } from 'lucide-react';
import type { ComponentType, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Skeleton } from '@/components/ui/skeleton';
import { useAddress } from '@/features/geocoding/use-address';
import { api } from '@/lib/api';
import { formatDuration, formatNumber } from '@/lib/format';
import { cn } from '@/lib/utils';

export type DayStatsMap = Record<string, VehicleDayStatsDto>;

/** Today's figures of every vehicle in scope (GET /live/day-stats); the summarizer refreshes them once a minute. */
export function useDayStats(enabled = true) {
  return useQuery({
    queryKey: ['live-day-stats'],
    queryFn: ({ signal }) => api.get<DayStatsMap>('/live/day-stats', undefined, signal),
    refetchInterval: 60_000,
    staleTime: 30_000,
    enabled,
  });
}

const km = (v: number) => (v >= 100 ? `${formatNumber(Math.round(v))} km` : `${v.toFixed(1)} km`);
const clock = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const dayClock = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** "Off since 14:05 (2 h 10 min)"; null for objects without an ignition reading (phones, ID cards). */
export function ignitionText(o: LiveObject, now: number, t: (k: string, v?: Record<string, string>) => string): string | null {
  if (o.ignition === null || o.type === 'PERSON') return null;
  if (o.ignition) return t('On');
  const since = o.statusSince ? Date.parse(o.statusSince) : NaN;
  if (Number.isNaN(since)) return t('Off');
  const fmt = new Date(since).toDateString() === new Date(now).toDateString() ? clock : dayClock;
  return t('Off since {{time}} ({{duration}})', { time: fmt.format(since), duration: formatDuration((now - since) / 1000) });
}

/** Second and third line of a live-map list row: address, then today's distance, stops and max speed. */
export function RowDayLine({ o, s }: { o: LiveObject; s: VehicleDayStatsDto | undefined }) {
  const { t } = useTranslation();
  const { address } = useAddress(o.lat, o.lng);
  return (
    <>
      <span className="block truncate text-[11px] text-muted-foreground">{address ?? ' '}</span>
      <span className="block truncate text-[11px] text-muted-foreground tabular-nums">
        {s ? (
          <>
            <span className="font-medium text-foreground/80">{km(s.distanceKm)}</span> {t('today')} · {t('{{n}} stops', { n: String(s.stops) })} · {t('max {{speed}} km/h', { speed: String(s.maxSpeedKph) })}
          </>
        ) : (
          ' '
        )}
      </span>
    </>
  );
}

function Tile({ icon: Icon, label, value, tone }: { icon: ComponentType<{ className?: string }>; label: string; value: ReactNode; tone: string }) {
  return (
    <div className="rounded-lg border bg-background/60 p-2.5">
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <span className={cn('flex size-5 items-center justify-center rounded-md', tone)}>
          <Icon className="size-3" />
        </span>
        {label}
      </div>
      <div className="mt-1 text-sm font-semibold tabular-nums">{value}</div>
    </div>
  );
}

/** Drawer → Overview: today's figures as tiles, the current / last trip and the odometer. */
export function TodayCard({ s, loading }: { s: VehicleDayStatsDto | undefined; loading: boolean }) {
  const { t } = useTranslation();
  if (loading && !s) return <Skeleton className="my-3 h-40 w-full rounded-xl" />;
  if (!s) return null;
  return (
    <section aria-label={t('Today')} className="my-3 space-y-2 rounded-xl border bg-muted/30 p-3">
      <div className="flex items-baseline justify-between">
        <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{t('Today')}</h3>
        <span className="text-[11px] text-muted-foreground">{t('{{n}} trips', { n: String(s.trips) })}</span>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <Tile icon={RouteIcon} label={t('Distance')} value={km(s.distanceKm)} tone="bg-primary/15 text-primary" />
        <Tile icon={TimerIcon} label={t('Moving')} value={formatDuration(s.movingSec)} tone="bg-emerald-500/15 text-emerald-600" />
        <Tile icon={HourglassIcon} label={t('Idle')} value={formatDuration(s.idleSec)} tone="bg-amber-500/15 text-amber-600" />
        <Tile icon={CircleParkingIcon} label={t('Stops')} value={formatNumber(s.stops)} tone="bg-slate-500/15 text-slate-600 dark:text-slate-300" />
        <Tile icon={GaugeIcon} label={t('Max speed')} value={`${s.maxSpeedKph} km/h`} tone="bg-rose-500/15 text-rose-600" />
        <Tile icon={MilestoneIcon} label={t('Odometer')} value={`${formatNumber(s.odometerKm)} km`} tone="bg-violet-500/15 text-violet-600" />
      </div>
      {s.trip && (
        <div className="flex items-center gap-3 rounded-lg border bg-background/60 p-2.5">
          <span className="relative flex size-8 shrink-0 items-center justify-center rounded-full bg-sky-500/15 text-sky-600">
            <NavigationIcon className="size-4" />
            {s.trip.ongoing && <span className="absolute -top-0.5 -right-0.5 size-2.5 animate-pulse rounded-full bg-emerald-500 ring-2 ring-card" aria-hidden />}
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[11px] text-muted-foreground">{s.trip.ongoing ? t('Current trip') : t('Last trip')}</div>
            <div className="text-sm font-semibold tabular-nums">
              {km(s.trip.distanceKm)} <span className="font-normal text-muted-foreground">· {formatDuration(s.trip.durationSec)}</span>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

/** List icon: ⚡ while a phone / ID card charges; a red power-off icon when a vehicle tracker loses main power. */
export function ChargeIcon({ o }: { o: LiveObject }) {
  const { t } = useTranslation();
  const c = chargeState(o);
  if (!c) return null;
  if (c.kind === 'CHARGER' && c.on) return <ZapIcon className="ms-1 inline size-3 text-emerald-600" aria-label={t('Charging')} />;
  if (c.kind === 'MAIN_POWER' && !c.on) return <ZapOffIcon className="ms-1 inline size-3 text-destructive" aria-label={t('Main power disconnected')} />;
  return null;
}

/** "Charging since 14:05 (2 h)" / "Not charging", or for vehicles "Connected" / "Disconnected since …". */
export function chargeText(o: LiveObject, now: number, t: (k: string, v?: Record<string, string>) => string): string | null {
  const c = chargeState(o);
  if (!c) return null;
  const since = o.chargingSince ? Date.parse(o.chargingSince) : NaN;
  const when = Number.isNaN(since)
    ? ''
    : ` ${t('since {{time}} ({{duration}})', { time: (new Date(since).toDateString() === new Date(now).toDateString() ? clock : dayClock).format(since), duration: formatDuration((now - since) / 1000) })}`;
  if (c.kind === 'CHARGER') return c.on ? `${t('Charging')}${when}` : t('Not charging');
  return c.on ? t('Connected') : `${t('Disconnected')}${when}`;
}

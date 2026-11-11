import type { EtaValue, TransportBookingStatus, TransportDirection, TransportTripDerivedState, TransportTripPassengerDto } from '@veetracer/shared';
import { ArrowDownLeftIcon, ArrowUpRightIcon, CircleAlertIcon, RouteIcon, RouteOffIcon, WifiIcon, WifiOffIcon } from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useRealtimeStatus } from '@/features/live/use-live';
import { formatClock } from '@/features/planned-trips/trip-format';
import { cleanDays, WEEK_DISPLAY_ORDER, weekdayNames, formatDays } from '@/features/routes/schedule-days';
import { ApiError, errorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';
import { BOOKING_STATUS_META, DIRECTION_SHORT, e3ErrorText, etaView, occupancy, occupancyLabel, passengerOutcomeView, TRIP_STATE_META, type Occupancy } from './e3-format';

export function BookingStatusBadge({ status, className }: { status: TransportBookingStatus; className?: string }) {
  const { t } = useTranslation();
  const m = BOOKING_STATUS_META[status];
  return (
    <Badge variant={m.tone} className={className} title={t(m.hint)}>
      {t(m.label)}
    </Badge>
  );
}

export function TripStateBadge({ state, className }: { state: TransportTripDerivedState; className?: string }) {
  const { t } = useTranslation();
  const m = TRIP_STATE_META[state];
  return (
    <Badge variant={m.tone} className={className}>
      {m.live && <span className="size-1.5 animate-pulse rounded-full bg-current motion-reduce:animate-none" aria-hidden />}
      {t(m.label)}
    </Badge>
  );
}

export function PassengerOutcomeBadge({ passenger }: { passenger: Pick<TransportTripPassengerDto, 'status' | 'outcomeMissing' | 'outcomeSource'> }) {
  const { t } = useTranslation();
  const v = passengerOutcomeView(passenger);
  return (
    <Badge variant={v.tone} title={v.source ? t(v.source) : undefined}>
      {v.tone === 'warning' && <CircleAlertIcon aria-hidden />}
      {t(v.label)}
    </Badge>
  );
}

export function DirectionBadge({ direction }: { direction: TransportDirection }) {
  const { t } = useTranslation();
  const Icon = direction === 'IN' ? ArrowDownLeftIcon : ArrowUpRightIcon;
  return (
    <Badge variant="outline" title={direction === 'IN' ? t('To site (login)') : t('From site (logout)')}>
      <Icon aria-hidden />
      {t(DIRECTION_SHORT[direction])}
    </Badge>
  );
}

const BAR: Record<Occupancy['level'], string> = {
  unknown: 'bg-muted-foreground/40',
  empty: 'bg-muted-foreground/40',
  available: 'bg-primary',
  full: 'bg-warning',
  over: 'bg-destructive',
};

/** "3 / 6 seats" as text plus a bar (never colour alone, doc 07 §7.1); `after` previews the draft. */
export function OccupancyBar({ used, capacity, after, className }: { used: number; capacity: number | null; after?: number; className?: string }) {
  const { t } = useTranslation();
  const now = occupancy(used, capacity);
  const next = after !== undefined && after !== used ? occupancy(after, capacity) : null;
  const shown = next ?? now;
  return (
    <div className={cn('grid gap-1', className)}>
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="font-medium tabular-nums">
          {next ? (
            <>
              <span className="text-muted-foreground line-through">{now.used}</span> → {occupancyLabel(next, t)}
            </>
          ) : (
            occupancyLabel(now, t)
          )}
        </span>
        {shown.level === 'full' && <span className="text-warning-fg">{t('Full')}</span>}
        {shown.level === 'over' && <span className="font-medium text-destructive-fg">{t('Over capacity')}</span>}
      </div>
      <div
        className="h-1.5 overflow-hidden rounded-full bg-muted"
        role="meter"
        aria-label={t('Seats used')}
        aria-valuemin={0}
        aria-valuemax={shown.capacity ?? 0}
        aria-valuenow={shown.used}
        aria-valuetext={occupancyLabel(shown, t)}
      >
        <div className={cn('h-full rounded-full transition-[width] motion-reduce:transition-none', BAR[shown.level])} style={{ width: `${Math.round(shown.ratio * 100)}%` }} />
      </div>
    </div>
  );
}

/** A time with its provenance, or the reason there is none ("Routing unavailable: no ETA"). Never a guessed number. */
export function EtaText({ eta, tz, day, className }: { eta: EtaValue | null | undefined; tz: string | undefined; day?: string; className?: string }) {
  const { t } = useTranslation();
  const v = etaView(eta);
  if (!v.at) return <span className={cn('text-xs', v.degraded ? 'text-warning-fg' : 'text-muted-foreground', className)}>{t(v.note)}</span>;
  return (
    <span className={cn('text-xs', className)}>
      <span className="font-medium tabular-nums">{formatClock(v.at, tz, day)}</span> <span className="text-muted-foreground">· {t(v.note)}</span>
    </span>
  );
}

/** Routing health from the board / candidates (doc 07 §4.3): text, not only colour. */
export function RoutingChip({ available }: { available: boolean }) {
  const { t } = useTranslation();
  return available ? (
    <Badge variant="success" title={t('Estimated times do not include live traffic.')}>
      <RouteIcon aria-hidden /> {t('Routing OK')}
    </Badge>
  ) : (
    <Badge variant="warning" title={t('No road estimates. Assign manually; times shown are the planned ones.')}>
      <RouteOffIcon aria-hidden /> {t('Routing offline')}
    </Badge>
  );
}

export function ConnectionChip() {
  const { t } = useTranslation();
  const s = useRealtimeStatus();
  if (s === 'connected')
    return (
      <Badge variant="success">
        <WifiIcon aria-hidden /> {t('Live')}
      </Badge>
    );
  return (
    <Badge variant={s === 'disconnected' ? 'destructive' : 'muted'}>
      <WifiOffIcon aria-hidden /> {s === 'disconnected' ? t('Offline') : t('Connecting…')}
    </Badge>
  );
}

/** Localised short weekday names (index 0 = Sunday). */
export function useDayWords() {
  const { t, i18n } = useTranslation();
  return useMemo(() => ({ names: weekdayNames(i18n.language || 'en'), everyDay: t('Every day'), weekdays: t('Mon–Fri'), weekends: t('Weekends') }), [t, i18n.language]);
}

export function DaysText({ days }: { days: number[] }) {
  const words = useDayWords();
  return <>{formatDays(days, words)}</>;
}

/** Monday-first toggle buttons for days 0 = Sunday … 6; `allowed` limits the choice (schedule days ⊆ shift days). */
export function DayPicker({ value, onChange, allowed, disabled, id }: { value: number[]; onChange: (days: number[]) => void; allowed?: number[]; disabled?: boolean; id?: string }) {
  const { t } = useTranslation();
  const words = useDayWords();
  return (
    <div id={id} className="flex flex-wrap gap-1" role="group" aria-label={t('Days')}>
      {WEEK_DISPLAY_ORDER.map((d) => {
        const on = value.includes(d);
        const off = allowed ? !allowed.includes(d) : false;
        return (
          <button
            key={d}
            type="button"
            disabled={disabled || off}
            aria-pressed={on}
            onClick={() => onChange(cleanDays(on ? value.filter((x) => x !== d) : [...value, d]))}
            className={cn(
              'h-8 min-w-11 rounded-md border px-2 text-xs font-semibold transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-40',
              on ? 'border-primary bg-primary text-primary-foreground' : 'border-input bg-card text-muted-foreground hover:bg-accent',
            )}
          >
            {words.names[d]}
          </button>
        );
      })}
    </div>
  );
}

/** Radix select over plain options (labels already translated). */
export function SimpleSelect({ value, onChange, options, id, label, className, disabled }: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; id?: string; label?: string; className?: string; disabled?: boolean }) {
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger id={id} aria-label={label} className={cn('h-9 w-full', className)}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Friendly text for an API error code (VERSION_CONFLICT, CAPACITY_EXCEEDED, CONSENT_REQUIRED, …) plus the server's detail. */
export function e3ErrorMessage(err: unknown, t: (k: string) => string): string {
  if (err instanceof ApiError) {
    const friendly = e3ErrorText(err.code);
    if (friendly) return err.message && err.code !== 'VERSION_CONFLICT' ? `${t(friendly)} (${err.message})` : t(friendly);
  }
  return errorMessage(err);
}

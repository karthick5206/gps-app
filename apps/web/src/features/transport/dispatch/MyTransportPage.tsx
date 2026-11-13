import type { MeTripDto } from '@veetracer/shared';
import { BusIcon, CalendarIcon, MapPinIcon, SmartphoneIcon, TicketIcon } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { FormError } from '@/components/form-error';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { formatClock } from '@/features/planned-trips/trip-format';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/utils';
import { DIRECTION_LABEL, PASSENGER_STATUS_META } from './e3-format';
import { BookingStatusBadge, DirectionBadge, e3ErrorMessage, EtaText, TripStateBadge } from './e3-ui';
import { hiddenVehicleText, myMapStops, shouldPollVehicle, sortMyTrips } from './me-format';
import { MyProfilePanel } from './MyProfilePanel';
import { TransportMap } from './TransportMap';
import { useMyBookings, useMyTrips, useMyVehicle } from './use-e3';

function useNow(ms: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

/** One trip: my pickup / drop, and the vehicle only inside the window (polled every 15 s). */
function TripCard({ trip, now, expanded, onToggle }: { trip: MeTripDto; now: number; expanded: boolean; onToggle: () => void }) {
  const { t } = useTranslation();
  const tz = trip.timeZone;
  const clock = (iso: string | null | undefined) => formatClock(iso, tz, trip.serviceDate);
  const poll = expanded && shouldPollVehicle(trip, now);
  const vehicle = useMyVehicle(trip.id, poll);
  const v = vehicle.data;
  const visible = poll && v?.visible ? v : null;
  // My own pickup / drop (sent only with my routing consent) stay on the map; the vehicle joins inside its window.
  const mine = myMapStops(trip);
  return (
    <Card className="grid gap-3 p-4">
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="font-medium">
            {trip.serviceDate} · {t(DIRECTION_LABEL[trip.direction])}
          </p>
          <p className="text-sm text-muted-foreground">
            {trip.vehicle ? `${trip.vehicle.name}${trip.vehicle.plate ? ` · ${trip.vehicle.plate}` : ''}` : t('Vehicle to be confirmed')}
            {trip.driverFirstName && ` · ${t('Driver {{name}}', { name: trip.driverFirstName })}`}
          </p>
        </div>
        <TripStateBadge state={trip.derivedState} />
        <Badge variant={PASSENGER_STATUS_META[trip.myStatus].tone}>{t(PASSENGER_STATUS_META[trip.myStatus].label)}</Badge>
      </div>
      <dl className="grid gap-2 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs text-muted-foreground">{t('My pickup')}</dt>
          <dd>
            {trip.myStop ? (
              <>
                <span className="font-medium tabular-nums">{clock(trip.myStop.plannedAt)}</span> · {trip.myStop.label}
                <span className="block">
                  <EtaText eta={trip.myStop.eta} tz={tz} day={trip.serviceDate} />
                </span>
              </>
            ) : (
              '—'
            )}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">{t('My drop')}</dt>
          <dd>{trip.myDrop ? `${clock(trip.myDrop.plannedAt)} · ${trip.myDrop.label}` : '—'}</dd>
        </div>
      </dl>
      <p className="text-xs text-muted-foreground">{t('{{n}} other passenger(s) on this trip', { n: trip.coRiders })}</p>
      <div>
        <Button size="sm" variant={expanded ? 'secondary' : 'outline'} onClick={onToggle} aria-expanded={expanded}>
          <MapPinIcon /> {expanded ? t('Hide vehicle') : t('Where is my vehicle?')}
        </Button>
      </div>
      {expanded && (
        <div className="grid gap-2">
          {(visible || mine.length > 0) && <TransportMap line={[]} stops={mine.map((s) => ({ ...s, label: t(s.label) }))} vehicle={visible ? { lat: visible.lat, lng: visible.lng, heading: visible.heading } : null} className="h-64" label={visible ? t('Map with your vehicle') : t('Map with your pickup and drop')} />}
          {trip.pointsHidden === 'CONSENT_REQUIRED' && <p className="text-xs text-muted-foreground">{t('Your pickup point is not shown: you have not given (or have withdrawn) your transport consent.')}</p>}
          {visible ? (
            <>
              <p className="text-xs text-muted-foreground">
                {t('Position at {{time}}', { time: clock(visible.fixAt) })}
                {visible.speedKph !== null && ` · ${Math.round(visible.speedKph)} km/h`}
                {' · '}
                {t('Updated every 15 seconds')}
              </p>
            </>
          ) : (
            <p className={cn('rounded-lg border border-dashed p-3 text-sm text-muted-foreground')}>
              {!poll ? t('The vehicle is shown from 30 minutes before your pickup until the trip ends.') : vehicle.isPending ? t('Looking for the vehicle…') : vehicle.isError ? e3ErrorMessage(vehicle.error, t) : t(hiddenVehicleText(v))}
            </p>
          )}
        </div>
      )}
    </Card>
  );
}

/** Transport → My commute (menu etms_self, 12 WP 3.6): my bookings and trips; the vehicle only during the trip window. */
export function MyTransportPage() {
  const { t } = useTranslation();
  const now = useNow(30_000);
  const trips = useMyTrips({});
  const bookings = useMyBookings({});
  const [expanded, setExpanded] = useState<string | null>(null);
  const list = useMemo(() => sortMyTrips(trips.data ?? [], now), [trips.data, now]);
  const notPassenger = trips.error instanceof ApiError && trips.error.code === 'NOT_A_PASSENGER';

  // Open the trip whose window is current by default.
  useEffect(() => {
    if (expanded === null) {
      const live = list.find((x) => x.liveVisible);
      if (live) setExpanded(live.id);
    }
  }, [list, expanded]);

  if (notPassenger) {
    return (
      <div className="p-4 sm:p-6">
        <PageHeader title={t('My commute')} />
        <Card className="mt-4 py-0">
          <EmptyState icon={BusIcon} title={t('No passenger profile')} description={t('Your account is not linked to an active passenger profile. Ask your transport desk.')} />
        </Card>
      </div>
    );
  }

  return (
    <div className="flex w-full min-w-0 flex-col gap-4 p-4 sm:p-6">
      <PageHeader
        title={t('My commute')}
        description={t('Your bookings and trips. The vehicle appears on the map only around your trip.')}
        actions={
          <Button asChild variant="outline">
            <Link to="/download">
              <SmartphoneIcon /> {t('Get the app')}
            </Link>
          </Button>
        }
      />

      <section aria-labelledby="my-trips" className="grid gap-3">
        <h2 id="my-trips" className="font-semibold">
          {t('My trips')}
        </h2>
        {trips.isPending ? (
          <Skeleton className="h-40 w-full" />
        ) : trips.isError ? (
          <FormError message={e3ErrorMessage(trips.error, t)} />
        ) : list.length === 0 ? (
          <Card className="py-0">
            <EmptyState icon={CalendarIcon} title={t('No trips in the next days')} description={t('When the transport desk seats you on a trip, it appears here.')} />
          </Card>
        ) : (
          <div className="grid gap-3 lg:grid-cols-2">
            {list.map((trip) => (
              <TripCard key={trip.passengerTripId} trip={trip} now={now} expanded={expanded === trip.id} onToggle={() => setExpanded(expanded === trip.id ? null : trip.id)} />
            ))}
          </div>
        )}
      </section>

      <section aria-labelledby="my-profile" className="grid gap-3">
        <h2 id="my-profile" className="font-semibold">
          {t('My transport profile')}
        </h2>
        <MyProfilePanel />
      </section>

      <section aria-labelledby="my-bookings" className="grid gap-3">
        <h2 id="my-bookings" className="font-semibold">
          {t('My bookings')}
        </h2>
        {bookings.isPending ? (
          <Skeleton className="h-24 w-full" />
        ) : bookings.isError ? (
          <FormError message={e3ErrorMessage(bookings.error, t)} />
        ) : !bookings.data?.length ? (
          <Card className="py-0">
            <EmptyState icon={TicketIcon} title={t('No bookings')} description={t('Bookings come from your regular schedule or are made by the transport desk.')} />
          </Card>
        ) : (
          <ul className="divide-y rounded-xl border bg-card">
            {bookings.data.map((b) => (
              <li key={b.id} className="flex flex-wrap items-center gap-2 p-3 text-sm">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">
                    {b.serviceDate} · <span className="tabular-nums">{formatClock(b.windowStart, b.timeZone, b.serviceDate)}–{formatClock(b.windowEnd, b.timeZone, b.serviceDate)}</span>
                  </p>
                  <p className="truncate text-xs text-muted-foreground">{[b.pickupLabel, b.dropLabel].filter(Boolean).join(' → ') || '—'}</p>
                </div>
                <DirectionBadge direction={b.direction} />
                <BookingStatusBadge status={b.status} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

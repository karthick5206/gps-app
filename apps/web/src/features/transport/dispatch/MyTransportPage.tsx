import type { MeBookingDto, MeTripDto } from '@veetracer/shared';
import { BusIcon, CalendarIcon, MapPinIcon, PlusIcon, SmartphoneIcon, TicketIcon } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Link } from 'react-router';
import { FormError } from '@/components/form-error';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { formatClock } from '@/features/planned-trips/trip-format';
import { ApiError, errorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';
import { DIRECTION_LABEL, PASSENGER_STATUS_META } from './e3-format';
import { BookingStatusBadge, DirectionBadge, e3ErrorMessage, EtaText, TripStateBadge } from './e3-ui';
import { hiddenVehicleText, myMapStops, shouldPollVehicle, sortMyTrips } from './me-format';
import { MyProfilePanel } from './MyProfilePanel';
import { TransportMap } from './TransportMap';
import { JOURNEY_LABEL } from './adhoc-booking';
import { approvalMeta, cancelBody, cancelErrorText, cancelState, canRequestRide, myRouteText, type RequestPolicy } from './my-request';
import { useCancelMyBooking } from './my-request-api';
import { MyRideRequestDialog } from './MyRideRequestDialog';
import { ReasonDialog } from './ReasonDialog';
import { useMyBookings, useMyPolicy, useMyTrips, useMyVehicle } from './use-e3';

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
  // v1.15.1: "Request a ride" and own-booking cancel only while the company has self-booking (+ requests) on.
  const policyQuery = useMyPolicy();
  const policy = policyQuery.data as RequestPolicy | undefined;
  const canRequest = canRequestRide(policy);
  const selfService = policy?.selfBooking === true;
  const [requestOpen, setRequestOpen] = useState(false);
  const [cancelling, setCancelling] = useState<MeBookingDto | null>(null);
  const cancel = useCancelMyBooking();
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
          <>
            {canRequest && (
              <Button onClick={() => setRequestOpen(true)}>
                <PlusIcon /> {t('Request a ride')}
              </Button>
            )}
            <Button asChild variant="outline">
              <Link to="/download">
                <SmartphoneIcon /> {t('Get the app')}
              </Link>
            </Button>
          </>
        }
      />
      {canRequest && policy && <MyRideRequestDialog open={requestOpen} onOpenChange={setRequestOpen} policy={policy} />}

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
              <MyBookingRow key={b.id} booking={b} now={now} canCancel={selfService} onCancel={() => setCancelling(b)} />
            ))}
          </ul>
        )}
      </section>

      <ReasonDialog
        open={!!cancelling}
        onOpenChange={(o) => {
          if (!o) {
            setCancelling(null);
            cancel.reset();
          }
        }}
        title={t('Cancel this ride?')}
        description={cancelling ? bookingSummary(cancelling) : undefined}
        label={t('Reason (optional)')}
        confirmLabel={t('Cancel ride')}
        destructive
        optional
        pending={cancel.isPending}
        error={cancel.error ? ((cancel.error instanceof ApiError ? cancelErrorText(cancel.error.code, t) : null) ?? errorMessage(cancel.error)) : null}
        onConfirm={(reason) => {
          if (!cancelling) return;
          cancel.mutate(
            { id: cancelling.id, ...cancelBody(reason) },
            {
              onSuccess: () => {
                toast.success(t('Your ride is cancelled.'));
                setCancelling(null);
              },
            },
          );
        }}
      />
    </div>
  );
}

function bookingSummary(b: MeBookingDto): string {
  const route = myRouteText(b);
  return `${b.serviceDate} · ${formatClock(b.windowStart, b.timeZone, b.serviceDate)}–${formatClock(b.windowEnd, b.timeZone, b.serviceDate)}${route ? ` · ${route}` : ''}`;
}

/** One of my bookings (v1.15.1): day, window, route, journey, approval, purpose; cancel before the cut-off. */
function MyBookingRow({ booking: b, now, canCancel, onCancel }: { booking: MeBookingDto; now: number; canCancel: boolean; onCancel: () => void }) {
  const { t } = useTranslation();
  const approval = approvalMeta(b);
  const route = myRouteText(b);
  const cs = canCancel ? cancelState(b, now) : 'NONE';
  return (
    <li className="flex flex-wrap items-start gap-2 p-3 text-sm">
      <div className="min-w-0 flex-1 basis-56">
        <p className="font-medium">
          {b.serviceDate} · <span className="tabular-nums">{formatClock(b.windowStart, b.timeZone, b.serviceDate)}–{formatClock(b.windowEnd, b.timeZone, b.serviceDate)}</span>
        </p>
        <p className="text-xs break-words text-muted-foreground">{route ?? '—'}</p>
        {b.purpose && <p className="text-xs break-words text-muted-foreground">{t('Purpose: {{purpose}}', { purpose: b.purpose })}</p>}
        {b.arrangedByDesk && <p className="text-xs text-muted-foreground">{t('Arranged by the transport desk')}</p>}
        {approval?.label === 'Rejected' && <p className="text-xs break-words text-destructive">{approval.reason ? t('Not approved: {{reason}}', { reason: approval.reason }) : t('Not approved.')}</p>}
        {cs === 'AFTER_CUTOFF' && <p className="text-xs text-muted-foreground">{t('Cancellation closed (cut-off passed). Call your transport desk.')}</p>}
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2">
        {b.journey === 'POINT_TO_POINT' ? <Badge variant="outline">{t(JOURNEY_LABEL.POINT_TO_POINT)}</Badge> : <DirectionBadge direction={b.direction} />}
        {approval ? <Badge variant={approval.tone}>{t(approval.label)}</Badge> : <BookingStatusBadge status={b.status} />}
        {cs === 'CAN_CANCEL' && (
          <Button size="sm" variant="outline" onClick={onCancel}>
            {t('Cancel ride')}
          </Button>
        )}
      </div>
    </li>
  );
}


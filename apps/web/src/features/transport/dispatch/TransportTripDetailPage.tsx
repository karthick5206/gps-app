import type { TransportPassengerOutcome, TransportTripDto, TransportTripPassengerDto, TransportTripStopDto } from '@veetracer/shared';
import { ArrowLeftIcon, CalendarPlusIcon, CheckCircle2Icon, CircleAlertIcon, HandIcon, MapIcon, MapPinCheckIcon, PlayIcon, ShieldAlertIcon, XCircleIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { FormError } from '@/components/form-error';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { useAuth } from '@/features/auth/auth-context';
import { formatClock, shiftDay } from '@/features/planned-trips/trip-format';
import { getReportTimeZone } from '@/features/reports/report-time';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/utils';
import { OUTCOME_ACTION_LABEL, TRIP_ACTION_LABEL, unresolvedCount } from './e3-format';
import { DayPicker, DirectionBadge, e3ErrorMessage, OccupancyBar, PassengerOutcomeBadge, TripStateBadge } from './e3-ui';
import { ReasonDialog } from './ReasonDialog';
import { locatedStops, TransportMap, tripLine } from './TransportMap';
import { useRepeatTrip, useTransportTrip, useTransportTripLive, useTripCommand } from './use-e3';

const EVENT_LABEL: Record<string, string> = {
  PUBLISHED: 'Published',
  CHANGED: 'Changed',
  PASSENGER_ADDED: 'Passenger added',
  PASSENGER_REMOVED: 'Passenger removed',
  VEHICLE_CHANGED: 'Vehicle changed',
  DRIVER_CHANGED: 'Driver changed',
  ACKNOWLEDGE: 'Driver acknowledged',
  STARTED: 'Trip started',
  ARRIVED: 'Arrived at a stop',
  BOARDED: 'Boarded',
  NO_SHOW: 'No-show',
  DROPPED: 'Dropped',
  COMPLETED: 'Trip completed',
  CANCELLED: 'Trip cancelled',
};
const SOURCE_LABEL: Record<string, string> = { WEB: 'Dispatcher (web)', DRIVER_APP: 'Driver app', PASSENGER_APP: 'Passenger app', SYSTEM: 'System' };
const STOP_STATUS_LABEL: Record<string, string> = { PENDING: 'Not reached', ARRIVED: 'Arrived', DEPARTED: 'Departed', SKIPPED: 'Skipped' };

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 truncate text-sm font-medium tabular-nums">{children}</dd>
    </div>
  );
}

function PassengerRow({ p, canOutcome, onOutcome, pending }: { p: TransportTripPassengerDto; canOutcome: boolean; onOutcome: (p: TransportTripPassengerDto, o: TransportPassengerOutcome) => void; pending: boolean }) {
  const { t } = useTranslation();
  return (
    <li className="flex flex-wrap items-center gap-2 py-2">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">
          {p.passenger.displayName} <span className="font-mono text-xs font-normal text-muted-foreground">{p.passenger.employeeCode}</span>
        </p>
        <p className="truncate text-xs text-muted-foreground">
          {t('To stop {{n}}', { n: p.dropSeq + 1 })}
          {p.dropLabel && ` · ${p.dropLabel}`}
          {p.seats > 1 && ` · ${t('{{n}} seats', { n: p.seats })}`}
          {p.noShowReason && ` · ${p.noShowReason}`}
        </p>
      </div>
      <PassengerOutcomeBadge passenger={p} />
      {canOutcome && p.allowedOutcomes.length > 0 && (
        <div className="flex flex-wrap gap-1" role="group" aria-label={t('Record outcome for {{name}}', { name: p.passenger.displayName })}>
          {p.allowedOutcomes.map((o) => (
            <Button key={o} size="sm" variant={o === 'NO_SHOW' ? 'outline' : 'default'} className={cn('h-8', o === 'NO_SHOW' && 'text-destructive hover:text-destructive')} disabled={pending} onClick={() => onOutcome(p, o)}>
              {t(OUTCOME_ACTION_LABEL[o])}
            </Button>
          ))}
        </div>
      )}
    </li>
  );
}

function StopList({ trip, clock, canArrive, canOutcome, onArrive, onOutcome, pending }: { trip: TransportTripDto; clock: (iso: string | null) => string; canArrive: boolean; canOutcome: boolean; onArrive: (s: TransportTripStopDto) => void; onOutcome: (p: TransportTripPassengerDto, o: TransportPassengerOutcome) => void; pending: boolean }) {
  const { t } = useTranslation();
  const stops = [...trip.stops].sort((a, b) => a.seq - b.seq);
  return (
    <ol className="relative">
      {stops.map((s, i) => {
        const pickups = trip.passengers.filter((p) => p.pickupSeq === s.seq && p.status !== 'CANCELLED');
        const drops = trip.passengers.filter((p) => p.dropSeq === s.seq && p.status !== 'CANCELLED');
        const reached = s.status === 'ARRIVED' || s.status === 'DEPARTED';
        const last = i === stops.length - 1;
        return (
          <li key={s.id} className="relative flex gap-3 pb-5 last:pb-0">
            {!last && <span className="absolute top-8 bottom-0 left-[15px] w-px bg-border" aria-hidden />}
            <span className={cn('relative z-[1] flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold', reached ? 'bg-success text-white' : s.status === 'SKIPPED' ? 'bg-destructive text-white' : 'bg-muted text-muted-foreground')} aria-hidden>
              {s.seq + 1}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <h3 className="min-w-0 truncate font-medium">
                  <span className="sr-only">{t('Stop {{n}}', { n: s.seq + 1 })}: </span>
                  {s.name}
                </h3>
                <span className="text-xs text-muted-foreground">{t(STOP_STATUS_LABEL[s.status] ?? s.status)}</span>
                {s.outcomesPending > 0 && reached && (
                  <Badge variant="warning">
                    <CircleAlertIcon aria-hidden /> {t('{{n}} outcome(s) not recorded', { n: s.outcomesPending })}
                  </Badge>
                )}
              </div>
              <p className="mt-0.5 text-xs tabular-nums text-muted-foreground">
                {t('Planned {{time}}', { time: clock(s.plannedArrival) })}
                {s.actualArrival && ` · ${t('arrived {{time}}', { time: clock(s.actualArrival) })}`}
                {` · ${t('{{p}} pickup(s), {{d}} drop(s)', { p: s.pickups, d: s.drops })}`}
              </p>
              {canArrive && s.status === 'PENDING' && (
                <Button size="sm" variant="outline" className="mt-2 h-8" disabled={pending} onClick={() => onArrive(s)}>
                  <MapPinCheckIcon /> {t('Mark arrived')}
                </Button>
              )}
              {pickups.length > 0 && (
                <div className="mt-2">
                  <p className="text-xs font-medium text-muted-foreground">{t('Pick up here')}</p>
                  <ul className="divide-y">
                    {pickups.map((p) => (
                      <PassengerRow key={p.id} p={p} canOutcome={canOutcome} onOutcome={onOutcome} pending={pending} />
                    ))}
                  </ul>
                </div>
              )}
              {drops.length > 0 && (
                <p className="mt-1 text-xs text-muted-foreground">
                  {t('Drop here')}: {drops.map((p) => p.passenger.displayName).join(', ')}
                </p>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function RepeatDialog({ trip, open, onOpenChange }: { trip: TransportTripDto; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t } = useTranslation();
  const repeat = useRepeatTrip(trip.id);
  const [toDate, setToDate] = useState(shiftDay(trip.serviceDate, 4));
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const max = shiftDay(trip.serviceDate, 31);
  const invalid = !toDate || toDate <= trip.serviceDate || toDate > max;
  return (
    <Dialog open={open} onOpenChange={(o) => !repeat.isPending && onOpenChange(o)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('Repeat to date')}</DialogTitle>
          <DialogDescription>{t('Copy this trip (vehicle, driver, stops at the same local time, and passengers who have a booking that day) to later dates. Each date becomes a saved draft to review and publish in Dispatch.')}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          {repeat.isError && <FormError message={e3ErrorMessage(repeat.error, t)} />}
          <Field label={t('Until (inclusive)')} htmlFor="rep-to" required error={invalid ? t('A date after the trip, at most 31 days ahead') : undefined}>
            <Input id="rep-to" type="date" value={toDate} min={shiftDay(trip.serviceDate, 1)} max={max} onChange={(e) => setToDate(e.target.value)} />
          </Field>
          <Field label={t('On these days')}>
            <DayPicker value={days} onChange={setDays} />
          </Field>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={repeat.isPending}>
            {t('Back')}
          </Button>
          <Button
            disabled={invalid || !days.length || repeat.isPending}
            onClick={() =>
              repeat.mutate(
                { toDate, days },
                {
                  onSuccess: (r) => {
                    toast.success(t('{{n}} draft(s) created; {{s}} date(s) skipped (no booking waiting).', { n: r.drafts.length, s: r.skippedDates.length }));
                    const missing = r.drafts.reduce((s, d) => s + d.missingBookings.length, 0);
                    if (missing) toast.warning(t('{{n}} passenger-day(s) had no booking waiting and were left out.', { n: missing }));
                    onOpenChange(false);
                  },
                },
              )
            }
          >
            {repeat.isPending ? <Spinner /> : <CalendarPlusIcon />} {t('Create drafts')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Transport → Dispatch → one trip (dispatcher, 02 §5.3, 12 WP 3.5): stops with passengers, dispatcher progression
 * (start, arrive, outcomes, complete, cancel), repeat to date. Vehicle GPS never marks boarding: a stop reached without
 * a recorded outcome shows "outcome not recorded". Map and playback reuse the planned-trip page.
 */
export function TransportTripDetailPage() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const { can } = useAuth();
  const tz = getReportTimeZone();
  const query = useTransportTrip(id);
  const trip = query.data;
  const cmd = useTripCommand(id ?? '');
  const [confirm, setConfirm] = useState<'start' | 'complete' | 'acknowledge' | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelBookings, setCancelBookings] = useState(false);
  const [repeatOpen, setRepeatOpen] = useState(false);
  const [noShow, setNoShow] = useState<TransportTripPassengerDto | null>(null);
  useTransportTripLive();

  if (query.isPending) {
    return (
      <div className="space-y-4 p-4 sm:p-6" aria-busy>
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }
  if (query.isError || !trip) {
    const notFound = query.error instanceof ApiError && query.error.status === 404;
    return (
      <div className="p-4 sm:p-6">
        <EmptyState icon={MapIcon} title={notFound ? t('Trip not found') : t('Could not load the trip')} description={notFound ? undefined : e3ErrorMessage(query.error, t)} action={<Button asChild variant="outline"><Link to="/transport/dispatch">{t('Back to Dispatch')}</Link></Button>} />
      </div>
    );
  }

  const clock = (iso: string | null) => formatClock(iso, tz, trip.serviceDate);
  const command = can('etms_dispatch', 'command');
  const edit = can('etms_dispatch', 'edit');
  const allowed = new Set(command ? trip.allowedActions : []);
  const running = ['EN_ROUTE', 'AT_STOP', 'IN_PROGRESS'].includes(trip.derivedState);
  const canOutcome = edit && (running || trip.derivedState === 'COMPLETED' || trip.derivedState === 'INCOMPLETE');
  const unresolved = unresolvedCount(trip.passengers);
  const ok = (msg: string) => () => toast.success(msg);
  const fail = (e: unknown) => toast.error(e3ErrorMessage(e, t));

  const run = (kind: 'start' | 'complete' | 'acknowledge') =>
    cmd.mutate({ kind, version: trip.version }, { onSuccess: () => { setConfirm(null); toast.success(kind === 'start' ? t('Trip started') : kind === 'complete' ? t('Trip completed') : t('Marked as acknowledged by the driver')); }, onError: fail });
  const outcome = (p: TransportTripPassengerDto, o: TransportPassengerOutcome, note?: string) =>
    cmd.mutate({ kind: 'outcome', passengerTripId: p.id, input: { outcome: o, ...(note ? { note } : {}) } }, { onSuccess: ok(t('{{name}}: {{outcome}} recorded', { name: p.passenger.displayName, outcome: t(OUTCOME_ACTION_LABEL[o]) })), onError: fail });

  return (
    <div className="flex w-full min-w-0 flex-col gap-4 p-4 sm:p-6">
      <Link to="/transport/dispatch" className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeftIcon className="size-4" /> {t('Dispatch')}
      </Link>
      <PageHeader
        title={`${trip.vehicleName ?? t('No vehicle')}${trip.plateNumber ? ` · ${trip.plateNumber}` : ''}`}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <TripStateBadge state={trip.derivedState} />
            <DirectionBadge direction={trip.direction} />
            <span>
              {trip.serviceDate} · {trip.name}
            </span>
          </span>
        }
        breadcrumb={false}
        actions={
          <>
            {allowed.has('start') && (
              <Button onClick={() => setConfirm('start')} disabled={cmd.isPending}>
                <PlayIcon /> {t(TRIP_ACTION_LABEL.start)}
              </Button>
            )}
            {allowed.has('complete') && (
              <Button onClick={() => setConfirm('complete')} disabled={cmd.isPending}>
                <CheckCircle2Icon /> {t(TRIP_ACTION_LABEL.complete)}
              </Button>
            )}
            {allowed.has('acknowledge') && (
              <Button variant="outline" onClick={() => setConfirm('acknowledge')} disabled={cmd.isPending}>
                <HandIcon /> {t(TRIP_ACTION_LABEL.acknowledge)}
              </Button>
            )}
            {edit && trip.allowedActions.includes('repeat') && (
              <Button variant="outline" onClick={() => setRepeatOpen(true)}>
                <CalendarPlusIcon /> {t(TRIP_ACTION_LABEL.repeat)}
              </Button>
            )}
            {allowed.has('cancel') && (
              <Button variant="outline" className="text-destructive hover:text-destructive" onClick={() => setCancelOpen(true)} disabled={cmd.isPending}>
                <XCircleIcon /> {t(TRIP_ACTION_LABEL.cancel)}
              </Button>
            )}
          </>
        }
      />

      <div role="note" className="flex gap-3 rounded-lg border border-info/40 bg-info-soft p-3 text-sm text-info-fg">
        <ShieldAlertIcon className="mt-0.5 size-5 shrink-0" aria-hidden />
        <p>{t('Vehicle GPS never marks a passenger as boarded. When the vehicle reaches a stop, its passengers show "outcome not recorded" until you record boarded or no-show here.')}</p>
      </div>

      {trip.cancelReason && <FormError message={t('Cancelled: {{reason}}', { reason: trip.cancelReason })} />}

      <Card className="p-4">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3 lg:grid-cols-6">
          <Stat label={t('Planned')}>
            {clock(trip.plannedStart)} – {clock(trip.plannedEnd)}
          </Stat>
          <Stat label={t('Actual')}>
            {clock(trip.actualStart)} – {clock(trip.actualEnd)}
          </Stat>
          <Stat label={t('Driver')}>{trip.driverName ?? '—'}</Stat>
          <Stat label={t('Next stop ETA')}>{running && trip.etaNextStop ? `${clock(trip.etaNextStop)} · ${t('from the vehicle tracker')}` : '—'}</Stat>
          <Stat label={t('Outcomes')}>{t('{{b}} boarded · {{n}} no-show · {{w}} waiting', { b: trip.passengerCounts.boarded + trip.passengerCounts.dropped, n: trip.passengerCounts.noShow, w: trip.passengerCounts.pending })}</Stat>
          <div className="col-span-2 sm:col-span-1">
            <OccupancyBar used={trip.occupiedSeats} capacity={trip.seatCapacity} />
          </div>
        </dl>
      </Card>

      <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Card className="min-w-0 gap-3 p-4">
          <h2 className="font-semibold">{t('Stops and passengers')}</h2>
          {trip.stops.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('This trip has no stops (its vehicle was removed).')}</p>
          ) : (
            <StopList trip={trip} clock={clock} canArrive={allowed.has('arrive')} canOutcome={canOutcome} pending={cmd.isPending} onArrive={(s) => cmd.mutate({ kind: 'arrive', version: trip.version, stopSeq: s.seq }, { onSuccess: ok(t('Arrival at {{name}} recorded', { name: s.name })), onError: fail })} onOutcome={(p, o) => (o === 'NO_SHOW' ? setNoShow(p) : outcome(p, o))} />
          )}
        </Card>
        <div className="flex min-w-0 flex-col gap-4">
          {trip.stops.length > 0 && (
            <Card className="min-w-0 gap-2 p-3">
              <div className="flex items-center justify-between gap-2">
                <h2 className="font-semibold">{t('Map')}</h2>
                {trip.plannedTripId && can('plannedTrips') && (
                  <Button asChild size="sm" variant="outline">
                    <Link to={`/planned-trips/${trip.plannedTripId}`}>
                      <MapIcon /> {t('Track and playback')}
                    </Link>
                  </Button>
                )}
              </div>
              <TransportMap line={tripLine(trip.path, trip.stops)} stops={locatedStops(trip.stops).map((s) => ({ seq: s.seq, lat: s.lat, lng: s.lng, label: s.name, done: s.status === 'ARRIVED' || s.status === 'DEPARTED' }))} className="h-72" label={t('Map of the trip stops')} />
            </Card>
          )}
          <Card className="min-w-0 gap-2 p-4">
            <h2 className="font-semibold">{t('Activity')}</h2>
            {trip.events.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('No activity yet.')}</p>
            ) : (
              <ul className="divide-y text-sm">
                {[...trip.events].reverse().map((e) => {
                  const who = e.passengerTripId ? trip.passengers.find((p) => p.id === e.passengerTripId)?.passenger.displayName : null;
                  return (
                    <li key={e.id} className="flex gap-3 py-2">
                      <span className="w-12 shrink-0 text-xs tabular-nums text-muted-foreground">{clock(e.occurredAt)}</span>
                      <span className="min-w-0 flex-1">
                        <span className="font-medium">{t(EVENT_LABEL[e.kind] ?? e.kind)}</span>
                        {who && ` · ${who}`}
                        {e.stopSeq !== null && ` · ${t('stop {{n}}', { n: e.stopSeq + 1 })}`}
                        <span className="block text-xs text-muted-foreground">
                          {t(SOURCE_LABEL[e.source] ?? e.source)}
                          {e.outcome !== 'ACCEPTED' && ` · ${e.outcome}`}
                        </span>
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        </div>
      </div>

      <ConfirmDialog
        open={!!confirm}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={confirm === 'start' ? t('Start the trip now?') : confirm === 'complete' ? t('Complete the trip?') : t('Mark as acknowledged by the driver?')}
        description={
          confirm === 'complete'
            ? unresolved > 0
              ? t('{{n}} passenger(s) have no outcome yet. You can still complete the trip; they stay marked "outcome not recorded" for review. Record boarded or no-show first if you know it.', { n: unresolved })
              : t('All passengers have an outcome.')
            : confirm === 'start'
              ? t('Use this when the driver has set off (for example, after a call). Boarding is still recorded per passenger.')
              : t('Record that the driver confirmed this trip (for example, by phone).')
        }
        confirmLabel={confirm ? t(TRIP_ACTION_LABEL[confirm]) : ''}
        pending={cmd.isPending}
        onConfirm={() => confirm && run(confirm)}
      />

      <ReasonDialog
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        title={t('Cancel the trip?')}
        description={t('Passengers still waiting are taken off the trip.')}
        label={t('Reason')}
        confirmLabel={t('Cancel trip')}
        destructive
        pending={cmd.isPending}
        onConfirm={(reason) => cmd.mutate({ kind: 'cancel', version: trip.version, reason, cancelBookings }, { onSuccess: () => { setCancelOpen(false); toast.success(t('Trip cancelled')); }, onError: fail })}
      >
        <label className="flex items-start gap-2 text-sm">
          <Checkbox checked={cancelBookings} onCheckedChange={(v) => setCancelBookings(!!v)} className="mt-0.5" />
          <span>{t('Also cancel their bookings (otherwise they go back to the queue to be seated again).')}</span>
        </label>
      </ReasonDialog>

      <ReasonDialog
        open={!!noShow}
        onOpenChange={(o) => !o && setNoShow(null)}
        title={t('Record no-show?')}
        description={noShow?.passenger.displayName}
        label={t('Note')}
        optional
        confirmLabel={t('No-show')}
        destructive
        pending={cmd.isPending}
        onConfirm={(note) => {
          if (noShow) outcome(noShow, 'NO_SHOW', note || undefined);
          setNoShow(null);
        }}
      />

      <RepeatDialog trip={trip} open={repeatOpen} onOpenChange={setRepeatOpen} />
    </div>
  );
}

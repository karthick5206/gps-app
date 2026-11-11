import type { PlannedTripSummaryDto } from '@veetracer/shared';
import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { FormError } from '@/components/form-error';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input, Textarea } from '@/components/ui/input';
import { Combobox } from '@/components/ui/multi-select';
import { Spinner } from '@/components/ui/spinner';
import { useAuth } from '@/features/auth/auth-context';
import { useVehicleOptions } from '@/features/history/use-history';
import { getReportTimeZone, reportZoneLabel } from '@/features/reports/report-time';
import { errorMessage } from '@/lib/api';
import { fromZonedWall, toZonedWall, type TripAction } from './trip-format';
import { useDriverOptions, useRouteOptions, useTripMutation } from './use-planned-trips';

/** New trip (no `trip`) or edit of a SCHEDULED trip: route (new only), vehicle, driver, planned start, notes. */
export function TripFormDialog({
  open,
  onOpenChange,
  trip,
  defaultDay,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trip?: PlannedTripSummaryDto | null;
  /** YYYY-MM-DD the list shows; a new trip defaults to the next full hour on that day. */
  defaultDay?: string;
  onCreated?: (id: string) => void;
}) {
  const { t } = useTranslation();
  const tz = getReportTimeZone();
  const mutation = useTripMutation();
  const [routeId, setRouteId] = useState<string | null>(null);
  const [objectId, setObjectId] = useState<string | null>(null);
  const [driverId, setDriverId] = useState<string | null>(null);
  const [start, setStart] = useState('');
  const [notes, setNotes] = useState('');
  const [vehicleQ, setVehicleQ] = useState('');
  const [driverQ, setDriverQ] = useState('');
  const [tried, setTried] = useState(false);
  const routes = useRouteOptions();
  const vehicles = useVehicleOptions(vehicleQ);
  const drivers = useDriverOptions(driverQ);
  const { can } = useAuth();

  useEffect(() => {
    if (!open) return;
    mutation.reset();
    setTried(false);
    if (trip) {
      setRouteId(trip.routeId);
      setObjectId(trip.objectId);
      setDriverId(trip.driverId);
      setStart(toZonedWall(Date.parse(trip.plannedStart), tz));
      setNotes(trip.notes ?? '');
    } else {
      setRouteId(null);
      setObjectId(null);
      setDriverId(null);
      const nextHour = Math.ceil(Date.now() / 3_600_000) * 3_600_000;
      const today = toZonedWall(nextHour, tz);
      setStart(defaultDay && !today.startsWith(defaultDay) ? `${defaultDay}T09:00` : today);
      setNotes('');
    }
    // Reset only when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const startMs = fromZonedWall(start, tz);
  const errors = {
    route: !routeId ? t('Required') : undefined,
    vehicle: !objectId ? t('Required') : undefined,
    start: Number.isNaN(startMs) ? t('Required') : undefined,
  };
  const valid = !errors.route && !errors.vehicle && !errors.start;

  const submit = () => {
    setTried(true);
    if (!valid) return;
    const plannedStart = new Date(startMs).toISOString();
    const done = (msg: string) => () => {
      toast.success(msg);
      onOpenChange(false);
    };
    if (trip) {
      mutation.mutate(
        { kind: 'edit', id: trip.id, input: { objectId: objectId!, driverId, plannedStart, notes: notes.trim() || null } },
        { onSuccess: done(t('Trip updated')) },
      );
    } else {
      mutation.mutate(
        { kind: 'create', input: { routeId: routeId!, objectId: objectId!, driverId, plannedStart, notes: notes.trim() || null } },
        {
          onSuccess: (created) => {
            done(t('Trip created'))();
            onCreated?.(created.id);
          },
        },
      );
    }
  };

  const zone = reportZoneLabel();
  return (
    <Dialog open={open} onOpenChange={(o) => !mutation.isPending && onOpenChange(o)}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{trip ? t('Edit trip') : t('New trip')}</DialogTitle>
          <DialogDescription>
            {trip ? t('Change the vehicle, driver or start time. Stop times move with the start.') : t('A one-off trip on a route. Stop times follow from the planned start.')}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="grid gap-4">
          <Field label={t('Route')} htmlFor="trip-route" required error={tried ? errors.route : undefined} hint={!trip && !can('routes') ? t('You need access to Routes to pick one.') : undefined}>
            {trip ? (
              <Input id="trip-route" value={trip.routeName} disabled />
            ) : (
              <Combobox
                id="trip-route"
                value={routeId}
                onChange={setRouteId}
                options={routes.options}
                loading={routes.loading}
                placeholder={t('Select a route…')}
                searchPlaceholder={t('Search routes…')}
                emptyText={t('No routes found')}
                invalid={tried && !!errors.route}
              />
            )}
          </Field>
          <Field label={t('Vehicle')} htmlFor="trip-vehicle" required error={tried ? errors.vehicle : undefined}>
            <Combobox
              id="trip-vehicle"
              value={objectId}
              onChange={setObjectId}
              options={vehicles.options}
              loading={vehicles.loading}
              onSearch={vehicles.remoteSearch ? setVehicleQ : undefined}
              selectedOption={trip && trip.objectName ? { value: trip.objectId, label: trip.objectName } : null}
              placeholder={t('Select a vehicle…')}
              searchPlaceholder={t('Search name or plate…')}
              emptyText={t('No vehicles found')}
              invalid={tried && !!errors.vehicle}
            />
          </Field>
          <Field label={t('Driver')} htmlFor="trip-driver">
            <Combobox
              id="trip-driver"
              value={driverId}
              onChange={setDriverId}
              options={drivers.options}
              loading={drivers.loading}
              onSearch={setDriverQ}
              selectedOption={trip && trip.driverId && trip.driverName ? { value: trip.driverId, label: trip.driverName } : null}
              placeholder={t('No driver')}
              searchPlaceholder={t('Search drivers…')}
              emptyText={t('No drivers found')}
            />
          </Field>
          <Field label={zone ? t('Planned start ({{zone}})', { zone }) : t('Planned start')} htmlFor="trip-start" required error={tried ? errors.start : undefined}>
            <Input id="trip-start" type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} aria-invalid={(tried && !!errors.start) || undefined} />
          </Field>
          <Field label={t('Notes')} htmlFor="trip-notes">
            <Textarea id="trip-notes" value={notes} maxLength={1000} rows={2} onChange={(e) => setNotes(e.target.value)} />
          </Field>
          {mutation.isError && <FormError message={errorMessage(mutation.error)} />}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={mutation.isPending}>
            {t('Cancel')}
          </Button>
          <Button onClick={submit} disabled={mutation.isPending}>
            {mutation.isPending && <Spinner />}
            {trip ? t('Save') : t('Create trip')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Cancel with a required reason. */
function CancelTripDialog({ trip, onClose }: { trip: PlannedTripSummaryDto | null; onClose: () => void }) {
  const { t } = useTranslation();
  const mutation = useTripMutation();
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  useEffect(() => {
    if (!trip) return;
    setReason('');
    setTried(false);
    mutation.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trip?.id]);
  const empty = !reason.trim();
  const submit = () => {
    setTried(true);
    if (!trip || empty) return;
    mutation.mutate(
      { kind: 'cancel', id: trip.id, reason: reason.trim() },
      {
        onSuccess: () => {
          toast.success(t('Trip cancelled'));
          onClose();
        },
      },
    );
  };
  return (
    <Dialog open={!!trip} onOpenChange={(o) => !o && !mutation.isPending && onClose()}>
      <DialogContent className="max-w-md" hideClose>
        <DialogHeader>
          <DialogTitle>{t('Cancel this trip?')}</DialogTitle>
          <DialogDescription>{trip ? t('{{route}} · {{vehicle}}. The trip stops being tracked and its pending stops are marked skipped.', { route: trip.routeName, vehicle: trip.objectName ?? '' }) : ''}</DialogDescription>
        </DialogHeader>
        <Field label={t('Reason')} htmlFor="trip-cancel-reason" required error={tried && empty ? t('Give a reason') : undefined}>
          <Textarea id="trip-cancel-reason" value={reason} maxLength={300} rows={3} autoFocus onChange={(e) => setReason(e.target.value)} aria-invalid={(tried && empty) || undefined} />
        </Field>
        {mutation.isError && <FormError message={errorMessage(mutation.error)} />}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={mutation.isPending}>
            {t('Keep trip')}
          </Button>
          <Button variant="destructive" onClick={submit} disabled={mutation.isPending}>
            {mutation.isPending && <Spinner />}
            {t('Cancel trip')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Manual start / complete (override), confirmed first. */
function ManualActionDialog({ pending, onClose }: { pending: { action: 'start' | 'complete'; trip: PlannedTripSummaryDto } | null; onClose: () => void }) {
  const { t } = useTranslation();
  const mutation = useTripMutation();
  const [last, setLast] = useState(pending);
  if (pending && pending !== last) setLast(pending);
  const shown = pending ?? last;
  const start = shown?.action === 'start';
  return (
    <ConfirmDialog
      open={!!pending}
      onOpenChange={(o) => !o && onClose()}
      title={start ? t('Start this trip now?') : t('Complete this trip now?')}
      description={
        shown
          ? start
            ? t('{{route}} · {{vehicle}} starts now as if it left the first stop. Normally the trip starts by itself when the vehicle leaves the start stop.', { route: shown.trip.routeName, vehicle: shown.trip.objectName ?? '' })
            : t('{{route}} · {{vehicle}} is closed now; stops not reached are marked skipped. Normally the trip completes by itself at the last stop.', { route: shown.trip.routeName, vehicle: shown.trip.objectName ?? '' })
          : ''
      }
      confirmLabel={start ? t('Start trip') : t('Complete trip')}
      pending={mutation.isPending}
      onConfirm={() => {
        if (!pending) return;
        mutation.mutate(
          { kind: pending.action, id: pending.trip.id },
          {
            onSuccess: () => {
              toast.success(start ? t('Trip started') : t('Trip completed'));
              onClose();
            },
            onError: (e) => toast.error(errorMessage(e)),
          },
        );
      }}
    />
  );
}

/** Row / header actions: `request(action, trip)` opens the matching dialog; render `dialogs` once. */
export function useTripActionDialogs(): { request: (action: TripAction, trip: PlannedTripSummaryDto) => void; dialogs: ReactNode } {
  const [edit, setEdit] = useState<PlannedTripSummaryDto | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [cancel, setCancel] = useState<PlannedTripSummaryDto | null>(null);
  const [manual, setManual] = useState<{ action: 'start' | 'complete'; trip: PlannedTripSummaryDto } | null>(null);
  const request = (action: TripAction, trip: PlannedTripSummaryDto) => {
    if (action === 'edit') {
      setEdit(trip);
      setEditOpen(true);
    } else if (action === 'cancel') setCancel(trip);
    else setManual({ action, trip });
  };
  const dialogs = (
    <>
      <TripFormDialog open={editOpen} onOpenChange={setEditOpen} trip={edit} />
      <CancelTripDialog trip={cancel} onClose={() => setCancel(null)} />
      <ManualActionDialog pending={manual} onClose={() => setManual(null)} />
    </>
  );
  return { request, dialogs };
}

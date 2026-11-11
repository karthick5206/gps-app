import type { PlannedTripSummaryDto } from '@veetracer/shared';
import { CalendarClockIcon, ChevronLeftIcon, ChevronRightIcon, DownloadIcon, PlusIcon, XIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { FormError } from '@/components/form-error';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Combobox } from '@/components/ui/multi-select';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useAuth } from '@/features/auth/auth-context';
import { useVehicleOptions } from '@/features/history/use-history';
import { getReportTimeZone, reportZoneLabel, todayInZone } from '@/features/reports/report-time';
import { downloadCsv, errorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';
import { TripFormDialog, useTripActionDialogs } from './TripDialogs';
import { chipOf, dayRange, formatClock, isActiveTrip, progressLabel, shiftDay, STATUS_CHIPS, STATUS_LABEL, statusCounts, type StatusChip, type TripAction } from './trip-format';
import { DelayText, TripActionsMenu, TripStatusBadge } from './trip-ui';
import { useDriverOptions, usePlannedTripLive, useRouteOptions, useTripList, type TripListFilters } from './use-planned-trips';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const CHIP_DOT: Record<StatusChip, string> = {
  SCHEDULED: 'bg-neutral-fg',
  IN_PROGRESS: 'bg-primary',
  COMPLETED: 'bg-success',
  INCOMPLETE: 'bg-warning',
  CANCELLED: 'bg-muted-foreground',
};

function StatusChips({ counts, value, onChange }: { counts: Record<StatusChip, number>; value: StatusChip | null; onChange: (v: StatusChip | null) => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap gap-2" role="group" aria-label={t('Filter by status')}>
      {STATUS_CHIPS.map((s) => (
        <button
          key={s}
          type="button"
          aria-pressed={value === s}
          onClick={() => onChange(value === s ? null : s)}
          className={cn(
            'inline-flex h-8 items-center gap-2 rounded-full border bg-card px-3 text-sm transition-colors outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring',
            value === s && 'border-primary bg-primary/8 text-foreground',
          )}
        >
          <span className={cn('size-2 rounded-full', CHIP_DOT[s])} aria-hidden />
          {t(STATUS_LABEL[s])}
          <span className="font-semibold tabular-nums">{counts[s]}</span>
        </button>
      ))}
    </div>
  );
}

/** Planned start, actual start / end of a row in the company zone (with the date when it is another day). */
function useClock(day: string) {
  const tz = getReportTimeZone();
  return (iso: string | null | undefined) => formatClock(iso, tz, day);
}

function TripCard({ trip, day, onAction }: { trip: PlannedTripSummaryDto; day: string; onAction: (a: TripAction, t: PlannedTripSummaryDto) => void }) {
  const { t } = useTranslation();
  const clock = useClock(day);
  const active = isActiveTrip(trip.status);
  return (
    <Card className="gap-2 p-3">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <Link to={`/planned-trips/${trip.id}`} className="block truncate font-medium hover:underline">
            {trip.routeName}
          </Link>
          <p className="truncate text-sm text-muted-foreground">
            {trip.objectName ?? '—'}
            {trip.driverName && ` · ${trip.driverName}`}
          </p>
        </div>
        <TripStatusBadge status={trip.status} />
        <TripActionsMenu trip={trip} onAction={onAction} className="-mt-1 -mr-1" />
      </div>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
        <div className="min-w-0">
          <dt className="text-xs text-muted-foreground">{t('Planned start')}</dt>
          <dd className="tabular-nums">{clock(trip.plannedStart)}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs text-muted-foreground">{t('Progress')}</dt>
          <dd className="truncate">{progressLabel(trip, t)}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs text-muted-foreground">{active ? t('Next stop ETA') : t('Actual start / end')}</dt>
          <dd className="truncate tabular-nums">{active ? clock(trip.etaNextStop) : `${clock(trip.actualStart)} – ${clock(trip.actualEnd)}`}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs text-muted-foreground">{t('Delay')}</dt>
          <dd>
            <DelayText delaySec={trip.delaySec} />
          </dd>
        </div>
      </dl>
    </Card>
  );
}

function TripTable({ trips, day, onAction }: { trips: PlannedTripSummaryDto[]; day: string; onAction: (a: TripAction, t: PlannedTripSummaryDto) => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const clock = useClock(day);
  return (
    <Card className="overflow-hidden py-0">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('Planned start')}</TableHead>
            <TableHead>{t('Route')}</TableHead>
            <TableHead>{t('Vehicle')}</TableHead>
            <TableHead>{t('Driver')}</TableHead>
            <TableHead>{t('Status')}</TableHead>
            <TableHead>{t('Progress')}</TableHead>
            <TableHead>{t('Next stop ETA')}</TableHead>
            <TableHead>{t('Delay')}</TableHead>
            <TableHead>{t('Actual start / end')}</TableHead>
            <TableHead className="w-10">
              <span className="sr-only">{t('Actions')}</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {trips.map((trip) => (
            <TableRow key={trip.id} className="cursor-pointer" onClick={() => navigate(`/planned-trips/${trip.id}`)}>
              <TableCell className="font-medium tabular-nums">{clock(trip.plannedStart)}</TableCell>
              <TableCell className="max-w-56 truncate">
                <Link to={`/planned-trips/${trip.id}`} className="hover:underline" onClick={(e) => e.stopPropagation()}>
                  {trip.routeName}
                </Link>
              </TableCell>
              <TableCell className="max-w-44 truncate">{trip.objectName ?? '—'}</TableCell>
              <TableCell className="max-w-40 truncate text-muted-foreground">{trip.driverName ?? '—'}</TableCell>
              <TableCell>
                <TripStatusBadge status={trip.status} />
              </TableCell>
              <TableCell>{progressLabel(trip, t)}</TableCell>
              <TableCell className="tabular-nums">{isActiveTrip(trip.status) ? clock(trip.etaNextStop) : '—'}</TableCell>
              <TableCell>
                <DelayText delaySec={trip.delaySec} />
              </TableCell>
              <TableCell className="tabular-nums text-muted-foreground">
                {clock(trip.actualStart)} – {clock(trip.actualEnd)}
              </TableCell>
              <TableCell onClick={(e) => e.stopPropagation()}>
                <TripActionsMenu trip={trip} onAction={onAction} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}

/** Tracking → Planned trips: one day of trips with filters, status chips, live progress and row actions (SPEC §4.5). */
export function PlannedTripsPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const navigate = useNavigate();
  const tz = getReportTimeZone();
  const [params, setParams] = useSearchParams();
  const dayParam = params.get('day');
  const day = dayParam && DAY_RE.test(dayParam) ? dayParam : todayInZone(tz);
  const setDay = (d: string) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        if (DAY_RE.test(d) && d !== todayInZone(tz)) n.set('day', d);
        else n.delete('day');
        return n;
      },
      { replace: true },
    );
  const [routeId, setRouteId] = useState<string | null>(null);
  const [objectId, setObjectId] = useState<string | null>(null);
  const [driverId, setDriverId] = useState<string | null>(null);
  const [chip, setChip] = useState<StatusChip | null>(null);
  const [vehicleQ, setVehicleQ] = useState('');
  const [driverQ, setDriverQ] = useState('');
  const [newOpen, setNewOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const routes = useRouteOptions();
  const vehicles = useVehicleOptions(vehicleQ);
  const drivers = useDriverOptions(driverQ);
  const { request, dialogs } = useTripActionDialogs();

  usePlannedTripLive();

  const range = useMemo(() => dayRange(day, tz), [day, tz]);
  const filters: TripListFilters = { ...range, routeId, objectId, driverId };
  const list = useTripList(filters);
  const items = useMemo(() => list.data?.items ?? [], [list.data]);
  const counts = useMemo(() => statusCounts(items), [items]);
  const visible = useMemo(() => (chip ? items.filter((tr) => chipOf(tr.status) === chip) : items), [items, chip]);

  const exportCsv = async () => {
    setExporting(true);
    try {
      const tripStatus = chip === 'IN_PROGRESS' ? 'STARTED,IN_PROGRESS' : (chip ?? undefined);
      await downloadCsv('/planned-trips', { ...filters, tripStatus, sort: 'plannedStart', order: 'asc' }, `planned-trips-${day}.csv`);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setExporting(false);
    }
  };

  const hasFilters = !!(routeId || objectId || driverId || chip);
  const clear = () => {
    setRouteId(null);
    setObjectId(null);
    setDriverId(null);
    setChip(null);
  };
  const zone = reportZoneLabel();
  const today = todayInZone(tz);

  return (
    <div className="flex w-full min-w-0 flex-col gap-5 p-4 sm:p-6">
      <PageHeader
        title={t('Planned trips')}
        description={t('Trips planned on a route, tracked against their stops and times.')}
        actions={
          <>
            {can('plannedTrips', 'export') && (
              <Button variant="outline" onClick={exportCsv} disabled={exporting || !items.length}>
                {exporting ? <Spinner /> : <DownloadIcon />}
                {t('CSV')}
              </Button>
            )}
            {can('plannedTrips', 'create') && (
              <Button onClick={() => setNewOpen(true)}>
                <PlusIcon /> {t('New trip')}
              </Button>
            )}
          </>
        }
      />

      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <div className="flex items-center gap-1">
          <Button variant="outline" size="icon" onClick={() => setDay(shiftDay(day, -1))} aria-label={t('Previous day')}>
            <ChevronLeftIcon />
          </Button>
          <Input type="date" value={day} onChange={(e) => e.target.value && setDay(e.target.value)} className="h-9 min-w-0 flex-1 sm:w-40 sm:flex-none" aria-label={zone ? t('Day ({{zone}})', { zone }) : t('Day')} />
          <Button variant="outline" size="icon" onClick={() => setDay(shiftDay(day, 1))} aria-label={t('Next day')}>
            <ChevronRightIcon />
          </Button>
          {day !== today && (
            <Button variant="ghost" size="sm" onClick={() => setDay(today)}>
              {t('Today')}
            </Button>
          )}
        </div>
        {can('routes') && (
          <Combobox value={routeId} onChange={setRouteId} options={routes.options} loading={routes.loading} placeholder={t('All routes')} searchPlaceholder={t('Search routes…')} emptyText={t('No routes found')} className="w-full sm:w-48" />
        )}
        <Combobox
          value={objectId}
          onChange={setObjectId}
          options={vehicles.options}
          loading={vehicles.loading}
          onSearch={vehicles.remoteSearch ? setVehicleQ : undefined}
          placeholder={t('All vehicles')}
          searchPlaceholder={t('Search name or plate…')}
          emptyText={t('No vehicles found')}
          className="w-full sm:w-48"
        />
        {can('drivers') && (
          <Combobox value={driverId} onChange={setDriverId} options={drivers.options} loading={drivers.loading} onSearch={setDriverQ} placeholder={t('All drivers')} searchPlaceholder={t('Search drivers…')} emptyText={t('No drivers found')} className="w-full sm:w-48" />
        )}
        {hasFilters && (
          <Button variant="ghost" size="sm" onClick={clear} className="self-start sm:self-auto">
            <XIcon /> {t('Clear')}
          </Button>
        )}
        {list.isFetching && !list.isPending && <Spinner className="text-muted-foreground" />}
      </div>

      <StatusChips counts={counts} value={chip} onChange={setChip} />

      {list.isError && <FormError message={errorMessage(list.error)} />}
      {list.isPending ? (
        <Skeleton className="h-72 w-full rounded-xl" />
      ) : visible.length === 0 ? (
        <EmptyState
          icon={CalendarClockIcon}
          title={items.length ? t('No trips with this status') : t('No planned trips on this day')}
          description={items.length ? undefined : t('Trips appear here when a route schedule generates them or when you create one.')}
          action={
            !items.length && can('plannedTrips', 'create') ? (
              <Button variant="outline" onClick={() => setNewOpen(true)}>
                <PlusIcon /> {t('New trip')}
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className={cn(list.isPlaceholderData && 'opacity-60 transition-opacity')}>
          <div className="hidden lg:block">
            <TripTable trips={visible} day={day} onAction={request} />
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:hidden">
            {visible.map((trip) => (
              <TripCard key={trip.id} trip={trip} day={day} onAction={request} />
            ))}
          </div>
        </div>
      )}
      {list.data && list.data.total > list.data.items.length && (
        <p className="text-xs text-muted-foreground">{t('Showing the first {{shown}} of {{total}} trips. Narrow the filters to see the rest.', { shown: list.data.items.length, total: list.data.total })}</p>
      )}

      <TripFormDialog open={newOpen} onOpenChange={setNewOpen} defaultDay={day} onCreated={(id) => navigate(`/planned-trips/${id}`)} />
      {dialogs}
    </div>
  );
}

import type { CreateTransportBookingInput, PassengerDto, TransportBookingDto, TransportBookingSource, TransportBookingStatus, TransportDirection, TransportShiftDto } from '@veetracer/shared';
import { CheckCheckIcon, CheckIcon, ChevronLeftIcon, ChevronRightIcon, MoreHorizontalIcon, PlusIcon, RouteIcon, SearchIcon, TicketIcon, XCircleIcon, XIcon } from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { FormError } from '@/components/form-error';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { EmptyState } from '@/components/ui/empty-state';
import { Field } from '@/components/ui/field';
import { Input, Textarea } from '@/components/ui/input';
import { Combobox, type Option } from '@/components/ui/multi-select';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useAuth } from '@/features/auth/auth-context';
import { FormDialog } from '@/features/masters/FormDialog';
import { useEntityOptions } from '@/features/masters/use-options';
import { formatClock, shiftDay } from '@/features/planned-trips/trip-format';
import { getReportTimeZone, todayInZone } from '@/features/reports/report-time';
import { cn } from '@/lib/utils';
import { idempotencyFor, type IdempotencySlot } from './dispatch-draft';
import { approvableIds, BOOKING_SOURCE_LABEL, BOOKING_STATUS_CHIPS, BOOKING_STATUS_META, cutoffLabel, DIRECTION_LABEL, newUuid } from './e3-format';
import { BookingStatusBadge, DirectionBadge, e3ErrorMessage, SimpleSelect } from './e3-ui';
import { ReasonDialog } from './ReasonDialog';
import { SHIFTS_ENDPOINT, transportTripPath, useBookingCommand, useBookings, useBulkApprove, useCreateBooking, type BookingCommand } from './use-e3';

const PAGE_SIZE = 50;
const ALL = '__all';
const passengerOption = (p: PassengerDto): Option => ({ value: p.id, label: `${p.displayName} · ${p.employeeCode}` });
const shiftOption = (s: TransportShiftDto): Option => ({ value: s.id, label: s.name });

function useClock(day: string, tz: string | undefined) {
  return (iso: string | null | undefined) => formatClock(iso, tz, day);
}

function windowText(b: TransportBookingDto, clock: (iso: string) => string) {
  return `${clock(b.windowStart)} – ${clock(b.windowEnd)}`;
}

function BookingMenu({ b, onCommand }: { b: TransportBookingDto; onCommand: (kind: BookingCommand['kind'], b: TransportBookingDto) => void }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const canEdit = can('etms_bookings', 'edit');
  const acts = canEdit ? b.allowedActions.filter((a) => a !== 'edit') : [];
  if (!acts.length && !b.tripId) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="icon-sm" variant="ghost" aria-label={t('Actions for {{name}}', { name: b.passenger.displayName })}>
          <MoreHorizontalIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {acts.includes('approve') && (
          <DropdownMenuItem onSelect={() => onCommand('approve', b)}>
            <CheckIcon /> {b.status === 'ASSIGNED' ? t('Confirm') : t('Approve')}
          </DropdownMenuItem>
        )}
        {acts.includes('reject') && (
          <DropdownMenuItem onSelect={() => onCommand('reject', b)}>
            <XIcon /> {t('Reject')}
          </DropdownMenuItem>
        )}
        {acts.includes('cancel') && (
          <DropdownMenuItem variant="destructive" onSelect={() => onCommand('cancel', b)}>
            <XCircleIcon /> {t('Cancel booking')}
          </DropdownMenuItem>
        )}
        {b.tripId && can('etms_dispatch') && (
          <DropdownMenuItem asChild>
            <Link to={transportTripPath(b.tripId)}>
              <RouteIcon /> {t('Open trip')}
            </Link>
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function NewBookingDialog({ open, onOpenChange, day }: { open: boolean; onOpenChange: (o: boolean) => void; day: string }) {
  const { t } = useTranslation();
  const create = useCreateBooking();
  const [q, setQ] = useState('');
  const passengers = useEntityOptions<PassengerDto>('/transport/passengers', passengerOption, { q, enabled: open });
  const shifts = useEntityOptions<TransportShiftDto>(SHIFTS_ENDPOINT, shiftOption, { enabled: open });
  const [passengerId, setPassengerId] = useState<string | null>(null);
  const [date, setDate] = useState(day);
  const [direction, setDirection] = useState<TransportDirection>('IN');
  const [shiftId, setShiftId] = useState<string | null>(null);
  const [count, setCount] = useState('1');
  const [hold, setHold] = useState(false);
  const [note, setNote] = useState('');
  const [tried, setTried] = useState(false);
  const [slot, setSlot] = useState<IdempotencySlot | null>(null);

  useEffect(() => {
    if (!open) return;
    create.reset();
    setTried(false);
    setPassengerId(null);
    setDate(day);
    setDirection('IN');
    setShiftId(null);
    setCount('1');
    setHold(false);
    setNote('');
    setSlot(null);
    // Reset only when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const n = Number(count);
  const errors = {
    passenger: !passengerId ? t('Required') : undefined,
    shift: !shiftId ? t('Choose the shift: it gives the pickup window and the site.') : undefined,
    count: !Number.isInteger(n) || n < 1 || n > 6 ? t('1 to 6') : undefined,
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (Object.values(errors).some(Boolean) || !passengerId) return;
    const input: CreateTransportBookingInput = { passengerId, serviceDate: date, direction, shiftId, passengerCount: n, hold, ...(note.trim() ? { note: note.trim() } : {}) };
    // Same form retried (e.g. lost response) → same Idempotency-Key → the server replays instead of booking twice.
    const next = idempotencyFor(slot, input, newUuid);
    setSlot(next);
    create.mutate(
      { input, key: next.key },
      {
        onSuccess: (b) => {
          toast.success(b.status === 'REQUESTED' ? t('Booking created; it needs approval.') : t('Booking created; it is waiting for a seat.'));
          onOpenChange(false);
        },
      },
    );
  };

  return (
    <FormDialog open={open} onOpenChange={onOpenChange} title="New one-off booking" description="Book a ride for a passenger on one day. Pickup comes from the passenger's profile (with consent), the site and window from the shift." onSubmit={submit} pending={create.isPending} error={create.error ? new Error(e3ErrorMessage(create.error, t)) : undefined}>
      <Field label={t('Passenger')} required error={tried ? errors.passenger : undefined}>
        <Combobox value={passengerId} onChange={setPassengerId} options={passengers.options} loading={passengers.loading} onSearch={setQ} placeholder={t('Choose a passenger')} searchPlaceholder={t('Search name or code…')} emptyText={t('No passengers found')} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('Date')} htmlFor="bk-date" required>
          <Input id="bk-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label={t('Direction')}>
          <SimpleSelect
            value={direction}
            onChange={(v) => setDirection(v as TransportDirection)}
            label={t('Direction')}
            options={[
              { value: 'IN', label: t(DIRECTION_LABEL.IN) },
              { value: 'OUT', label: t(DIRECTION_LABEL.OUT) },
            ]}
          />
        </Field>
      </div>
      <Field label={t('Shift')} required error={tried ? errors.shift : undefined}>
        <Combobox value={shiftId} onChange={setShiftId} options={shifts.options} loading={shifts.loading} placeholder={t('Choose a shift')} searchPlaceholder={t('Search shifts…')} emptyText={t('No shifts found')} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('Seats')} htmlFor="bk-count" error={tried ? errors.count : undefined}>
          <Input id="bk-count" type="number" min={1} max={6} value={count} onChange={(e) => setCount(e.target.value)} />
        </Field>
        <label className="flex items-center gap-2 self-end pb-2 text-sm">
          <Switch checked={hold} onCheckedChange={setHold} />
          {t('Needs approval')}
        </label>
      </div>
      <Field label={t('Note')} htmlFor="bk-note">
        <Textarea id="bk-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} rows={2} />
      </Field>
    </FormDialog>
  );
}

/** Transport → Bookings (menu etms_bookings, doc 07 §6.3, 12 WP 3.5): one day, filters, approve / reject / cancel, bulk approve. */
export function BookingsPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const tz = getReportTimeZone();
  const today = todayInZone(tz);
  const [day, setDay] = useState(today);
  const [direction, setDirection] = useState<string>(ALL);
  const [status, setStatus] = useState<TransportBookingStatus | null>(null);
  const [source, setSource] = useState<string>(ALL);
  const [unassigned, setUnassigned] = useState(false);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [command, setCommand] = useState<{ kind: 'reject' | 'cancel'; b: TransportBookingDto } | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  const query = {
    serviceDate: day,
    direction: direction === ALL ? undefined : (direction as TransportDirection),
    bookingStatus: status ?? undefined,
    source: source === ALL ? undefined : (source as TransportBookingSource),
    unassigned: unassigned ? ('true' as const) : undefined,
    q: search.trim() || undefined,
    sort: 'windowStart' as const,
    order: 'asc' as const,
    page,
    pageSize: PAGE_SIZE,
  };
  const list = useBookings(query);
  const rows = useMemo(() => list.data?.items ?? [], [list.data]);
  const total = list.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const cmd = useBookingCommand();
  const bulk = useBulkApprove();
  const clock = useClock(day, tz);
  const canEdit = can('etms_bookings', 'edit');

  useEffect(() => {
    setPage(1);
    setSelected(new Set());
  }, [day, direction, status, source, unassigned, search]);

  const approvable = approvableIds(rows, selected);
  const toggle = (id: string, on: boolean) =>
    setSelected((s) => {
      const n = new Set(s);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });
  const allOnPage = rows.length > 0 && rows.every((r) => selected.has(r.id));

  const run = (kind: BookingCommand['kind'], b: TransportBookingDto, reason?: string) =>
    cmd.mutate(
      { kind, id: b.id, version: b.version, reason },
      {
        onSuccess: () => {
          toast.success(kind === 'approve' ? t('Booking approved') : kind === 'reject' ? t('Booking rejected') : t('Booking cancelled'));
          setCommand(null);
        },
        onError: (e) => toast.error(e3ErrorMessage(e, t)),
      },
    );
  const onCommand = (kind: BookingCommand['kind'], b: TransportBookingDto) => (kind === 'approve' ? run('approve', b) : setCommand({ kind, b }));

  const bulkApprove = () =>
    bulk.mutate(approvable, {
      onSuccess: (r) => {
        if (r.approved.length) toast.success(t('{{n}} booking(s) approved', { n: r.approved.length }));
        if (r.skipped.length) toast.warning(t('{{n}} booking(s) skipped (changed meanwhile or not approvable)', { n: r.skipped.length }));
        setSelected(new Set());
      },
      onError: (e) => toast.error(e3ErrorMessage(e, t)),
    });

  const hasFilters = direction !== ALL || status || source !== ALL || unassigned || search;

  return (
    <div className="flex w-full min-w-0 flex-col gap-4 p-4 sm:p-6">
      <PageHeader
        title={t('Bookings')}
        description={t('Rides requested for a day: approve them, then seat them on trips in Dispatch.')}
        actions={
          can('etms_bookings', 'create') && (
            <Button onClick={() => setNewOpen(true)}>
              <PlusIcon /> {t('New booking')}
            </Button>
          )
        }
      />

      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <div className="flex items-center gap-1">
          <Button variant="outline" size="icon" onClick={() => setDay(shiftDay(day, -1))} aria-label={t('Previous day')}>
            <ChevronLeftIcon />
          </Button>
          <Input type="date" value={day} onChange={(e) => e.target.value && setDay(e.target.value)} className="h-9 min-w-0 flex-1 sm:w-40 sm:flex-none" aria-label={t('Service date')} />
          <Button variant="outline" size="icon" onClick={() => setDay(shiftDay(day, 1))} aria-label={t('Next day')}>
            <ChevronRightIcon />
          </Button>
          {day !== today && (
            <Button variant="ghost" size="sm" onClick={() => setDay(today)}>
              {t('Today')}
            </Button>
          )}
        </div>
        <SimpleSelect
          value={direction}
          onChange={setDirection}
          label={t('Direction')}
          className="sm:w-48"
          options={[
            { value: ALL, label: t('Both directions') },
            { value: 'IN', label: t(DIRECTION_LABEL.IN) },
            { value: 'OUT', label: t(DIRECTION_LABEL.OUT) },
          ]}
        />
        <SimpleSelect
          value={source}
          onChange={setSource}
          label={t('Source')}
          className="sm:w-40"
          options={[
            { value: ALL, label: t('All sources') },
            { value: 'SCHEDULE', label: t(BOOKING_SOURCE_LABEL.SCHEDULE) },
            { value: 'ADHOC', label: t(BOOKING_SOURCE_LABEL.ADHOC) },
          ]}
        />
        <div className="relative min-w-0 sm:w-56">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('Search passenger…')} aria-label={t('Search passenger')} className="h-9 pl-8" />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={unassigned} onCheckedChange={setUnassigned} />
          {t('Only without a seat')}
        </label>
        {hasFilters && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setDirection(ALL);
              setStatus(null);
              setSource(ALL);
              setUnassigned(false);
              setSearch('');
            }}
          >
            <XIcon /> {t('Clear')}
          </Button>
        )}
        {list.isFetching && !list.isPending && <Spinner className="text-muted-foreground" />}
      </div>

      <div className="flex flex-wrap gap-2" role="group" aria-label={t('Filter by status')}>
        {BOOKING_STATUS_CHIPS.map((s) => (
          <button
            key={s}
            type="button"
            aria-pressed={status === s}
            onClick={() => setStatus(status === s ? null : s)}
            className={cn('inline-flex h-8 items-center gap-2 rounded-full border bg-card px-3 text-sm transition-colors outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring', status === s && 'border-primary bg-primary/8')}
          >
            {t(BOOKING_STATUS_META[s].label)}
          </button>
        ))}
      </div>

      {canEdit && selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-card p-2 text-sm" role="region" aria-label={t('Selection')}>
          <span className="px-1">{t('{{n}} selected', { n: selected.size })}</span>
          <Button size="sm" onClick={bulkApprove} disabled={!approvable.length || bulk.isPending}>
            {bulk.isPending ? <Spinner /> : <CheckCheckIcon />} {t('Approve {{n}}', { n: approvable.length })}
          </Button>
          {approvable.length < selected.size && <span className="text-xs text-muted-foreground">{t('Only bookings that need approval are approved.')}</span>}
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
            {t('Clear selection')}
          </Button>
        </div>
      )}

      {list.isError && <FormError message={e3ErrorMessage(list.error, t)} />}
      {list.isPending ? (
        <Skeleton className="h-72 w-full rounded-xl" />
      ) : rows.length === 0 ? (
        <Card className="py-0">
          <EmptyState icon={TicketIcon} title={hasFilters ? t('No bookings match these filters') : t('No bookings on this day')} description={hasFilters ? undefined : t('Bookings appear from recurring schedules (up to 72 hours ahead) or when you add a one-off booking.')} />
        </Card>
      ) : (
        <div className={cn(list.isPlaceholderData && 'opacity-60 transition-opacity')}>
          <Card className="hidden overflow-hidden py-0 lg:block">
            <Table>
              <TableHeader>
                <TableRow>
                  {canEdit && (
                    <TableHead className="w-10">
                      <Checkbox aria-label={t('Select all on this page')} checked={allOnPage} onCheckedChange={(v) => setSelected(v ? new Set(rows.map((r) => r.id)) : new Set())} />
                    </TableHead>
                  )}
                  <TableHead>{t('Passenger')}</TableHead>
                  <TableHead>{t('Direction')}</TableHead>
                  <TableHead>{t('Window')}</TableHead>
                  <TableHead>{t('Shift')}</TableHead>
                  <TableHead>{t('Pickup')}</TableHead>
                  <TableHead>{t('Source')}</TableHead>
                  <TableHead>{t('Status')}</TableHead>
                  <TableHead>{t('Trip')}</TableHead>
                  <TableHead className="w-10">
                    <span className="sr-only">{t('Actions')}</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((b) => {
                  const cut = cutoffLabel(b.cutoffAt, b.status, now, t);
                  return (
                    <TableRow key={b.id} data-state={selected.has(b.id) ? 'selected' : undefined}>
                      {canEdit && (
                        <TableCell>
                          <Checkbox aria-label={t('Select {{name}}', { name: b.passenger.displayName })} checked={selected.has(b.id)} onCheckedChange={(v) => toggle(b.id, !!v)} />
                        </TableCell>
                      )}
                      <TableCell>
                        <span className="flex flex-col">
                          <span className="font-medium">{b.passenger.displayName}</span>
                          <span className="font-mono text-xs text-muted-foreground">{b.passenger.employeeCode}</span>
                        </span>
                      </TableCell>
                      <TableCell>
                        <DirectionBadge direction={b.direction} />
                      </TableCell>
                      <TableCell className="tabular-nums">
                        {windowText(b, clock)}
                        {cut && <span className={cn('block text-xs', cut === t('After cut-off') ? 'text-muted-foreground' : 'text-warning-fg')}>{cut}</span>}
                      </TableCell>
                      <TableCell className="max-w-40 truncate">{b.shiftName ?? '—'}</TableCell>
                      <TableCell className="max-w-48">
                        {b.needsLocation ? <Badge variant="warning">{t('Needs location')}</Badge> : <span className="block truncate">{b.pickup?.label ?? t('Home')}</span>}
                      </TableCell>
                      <TableCell className="text-muted-foreground">{t(BOOKING_SOURCE_LABEL[b.source])}</TableCell>
                      <TableCell>
                        <BookingStatusBadge status={b.status} />
                        {b.statusReason && <span className="block max-w-40 truncate text-xs text-muted-foreground" title={b.statusReason}>{b.statusReason}</span>}
                      </TableCell>
                      <TableCell>
                        {b.tripId && can('etms_dispatch') ? (
                          <Link to={transportTripPath(b.tripId)} className="text-primary hover:underline">
                            {t('Open')}
                          </Link>
                        ) : (
                          '—'
                        )}
                      </TableCell>
                      <TableCell>
                        <BookingMenu b={b} onCommand={onCommand} />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </Card>
          <ul className="grid gap-3 sm:grid-cols-2 lg:hidden">
            {rows.map((b) => {
              const cut = cutoffLabel(b.cutoffAt, b.status, now, t);
              return (
                <li key={b.id}>
                  <Card className="gap-2 p-3">
                    <div className="flex items-start gap-2">
                      {canEdit && <Checkbox className="mt-1" aria-label={t('Select {{name}}', { name: b.passenger.displayName })} checked={selected.has(b.id)} onCheckedChange={(v) => toggle(b.id, !!v)} />}
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium">{b.passenger.displayName}</p>
                        <p className="truncate text-xs text-muted-foreground">
                          {b.passenger.employeeCode} · {b.shiftName ?? '—'}
                        </p>
                      </div>
                      <BookingStatusBadge status={b.status} />
                      <BookingMenu b={b} onCommand={onCommand} />
                    </div>
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <DirectionBadge direction={b.direction} />
                      <span className="tabular-nums">{windowText(b, clock)}</span>
                      {b.needsLocation && <Badge variant="warning">{t('Needs location')}</Badge>}
                      {cut && <span className="text-xs text-muted-foreground">{cut}</span>}
                    </div>
                    {b.tripId && can('etms_dispatch') && (
                      <Link to={transportTripPath(b.tripId)} className="text-sm text-primary hover:underline">
                        {t('Open trip')}
                      </Link>
                    )}
                  </Card>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {total > PAGE_SIZE && (
        <div className="flex items-center justify-between gap-2 text-sm">
          <span className="text-muted-foreground">{t('Page {{page}} of {{pages}} · {{total}} bookings', { page, pages, total })}</span>
          <div className="flex gap-1">
            <Button variant="outline" size="icon-sm" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1} aria-label={t('Previous page')}>
              <ChevronLeftIcon />
            </Button>
            <Button variant="outline" size="icon-sm" onClick={() => setPage((p) => Math.min(pages, p + 1))} disabled={page >= pages} aria-label={t('Next page')}>
              <ChevronRightIcon />
            </Button>
          </div>
        </div>
      )}

      <ReasonDialog
        open={!!command}
        onOpenChange={(o) => !o && setCommand(null)}
        title={command?.kind === 'reject' ? t('Reject booking?') : t('Cancel booking?')}
        description={command ? `${command.b.passenger.displayName} · ${command.b.serviceDate} · ${t(DIRECTION_LABEL[command.b.direction])}` : undefined}
        label={t('Reason')}
        confirmLabel={command?.kind === 'reject' ? t('Reject') : t('Cancel booking')}
        destructive
        pending={cmd.isPending}
        onConfirm={(reason) => command && run(command.kind, command.b, reason)}
      />
      <NewBookingDialog open={newOpen} onOpenChange={setNewOpen} day={day} />
    </div>
  );
}

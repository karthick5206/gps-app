import type {
  CreateTransportSchedulesInput,
  CreateTransportSchedulesResult,
  CreateTransportShiftInput,
  PassengerDto,
  PoiDto,
  TransportDirection,
  TransportExceptionKind,
  TransportPickupMode,
  TransportScheduleDto,
  TransportShiftDto,
  UpdateTransportScheduleInput,
} from '@veetracer/shared';
import { useMutation } from '@tanstack/react-query';
import { ArchiveIcon, ArchiveRestoreIcon, CalendarClockIcon, CalendarOffIcon, CalendarRangeIcon, ClockIcon, Trash2Icon } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { FormError } from '@/components/form-error';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { EmptyState } from '@/components/ui/empty-state';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Combobox, MultiSelect, type Option } from '@/components/ui/multi-select';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAuth } from '@/features/auth/auth-context';
import { Dash } from '@/features/masters/cells';
import { FormDialog } from '@/features/masters/FormDialog';
import { MasterPage } from '@/features/masters/MasterPage';
import type { MasterColumn, MasterFilter, MasterFormProps } from '@/features/masters/types';
import { useEntityOptions } from '@/features/masters/use-options';
import { dayRange, shiftDay } from '@/features/planned-trips/trip-format';
import { getReportTimeZone, todayInZone } from '@/features/reports/report-time';
import { minutesToTime, timeToMinutes } from '@/features/routes/schedule-days';
import { api, errorMessage } from '@/lib/api';
import { i18n } from '@/lib/i18n';
import { DIRECTION_LABEL, shiftTimesLabel } from './e3-format';
import { DayPicker, DaysText, DirectionBadge, SimpleSelect } from './e3-ui';
import { SCHEDULES_ENDPOINT, SHIFTS_ENDPOINT, useInvalidateSchedules, useScheduleExceptions, useSchedulePreview } from './use-e3';

const poiOption = (p: PoiDto): Option => ({ value: p.id, label: p.name });
const passengerOption = (p: PassengerDto): Option => ({ value: p.id, label: `${p.displayName} · ${p.employeeCode}` });
const shiftOption = (s: TransportShiftDto): Option => ({ value: s.id, label: `${s.name} (${shiftTimesLabel(s.startMin, s.endMin, (k) => i18n.t(k))})` });

function zones(): string[] {
  try {
    return (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? [];
  } catch {
    return [];
  }
}

// ───────────────────────────── Shifts ─────────────────────────────

function ShiftForm({ record, open, onOpenChange }: MasterFormProps<TransportShiftDto>) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const invalidate = useInvalidateSchedules();
  const sites = useEntityOptions<PoiDto>('/pois', poiOption, { enabled: can('pois') && open });
  const [name, setName] = useState('');
  const [site, setSite] = useState<string | null>(null);
  const [start, setStart] = useState('09:00');
  const [end, setEnd] = useState('18:00');
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [tz, setTz] = useState('');
  const [tried, setTried] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTried(false);
    setName(record?.name ?? '');
    setSite(record?.site?.id ?? null);
    setStart(minutesToTime(record?.startMin ?? 540));
    setEnd(minutesToTime(record?.endMin ?? 1080));
    setDays(record?.days ?? [1, 2, 3, 4, 5]);
    setTz(record?.timeZone ?? getReportTimeZone() ?? '');
  }, [open, record]);

  const save = useMutation({
    mutationFn: (body: CreateTransportShiftInput) => (record ? api.patch<TransportShiftDto>(`${SHIFTS_ENDPOINT}/${record.id}`, body) : api.post<TransportShiftDto>(SHIFTS_ENDPOINT, body)),
    onSuccess: () => {
      toast.success(record ? t('Shift updated') : t('Shift created'));
      invalidate();
      onOpenChange(false);
    },
  });

  const startMin = timeToMinutes(start);
  const endMin = timeToMinutes(end);
  const errors = {
    name: !name.trim() ? t('Required') : undefined,
    start: startMin === null ? t('Enter a time as HH:MM') : undefined,
    end: endMin === null ? t('Enter a time as HH:MM') : startMin !== null && endMin === startMin ? t('Logout must differ from login') : undefined,
    days: days.length === 0 ? t('Choose at least one day') : undefined,
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (Object.values(errors).some(Boolean) || startMin === null || endMin === null) return;
    save.mutate({ name: name.trim(), sitePoiId: site, startMin, endMin, days, ...(tz.trim() ? { timeZone: tz.trim() } : {}) });
  };
  const zoneList = useMemo(() => zones(), []);

  return (
    <FormDialog open={open} onOpenChange={onOpenChange} title={record ? 'Edit shift' : 'New shift'} description="Login and logout times in the shift's time zone. A logout before the login is on the next day." onSubmit={submit} pending={save.isPending} error={save.error}>
      <Field label={t('Name')} htmlFor="shift-name" required error={tried ? errors.name : undefined}>
        <Input id="shift-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
      </Field>
      {can('pois') && (
        <Field label={t('Office / site')} hint={t('Where passengers are dropped (login) and picked up (logout).')}>
          <Combobox value={site} onChange={setSite} options={sites.options} loading={sites.loading} placeholder={t('No site')} searchPlaceholder={t('Search places…')} emptyText={t('No places found')} />
        </Field>
      )}
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('Login')} htmlFor="shift-start" required error={tried ? errors.start : undefined}>
          <Input id="shift-start" type="time" value={start} onChange={(e) => setStart(e.target.value)} />
        </Field>
        <Field label={t('Logout')} htmlFor="shift-end" required error={tried ? errors.end : undefined} hint={startMin !== null && endMin !== null && endMin < startMin ? t('Overnight: logout on the next day') : undefined}>
          <Input id="shift-end" type="time" value={end} onChange={(e) => setEnd(e.target.value)} />
        </Field>
      </div>
      <Field label={t('Days')} required error={tried ? errors.days : undefined}>
        <DayPicker value={days} onChange={setDays} />
      </Field>
      <Field label={t('Time zone')} htmlFor="shift-tz" hint={t('Defaults to the company time zone.')}>
        <Input id="shift-tz" value={tz} onChange={(e) => setTz(e.target.value)} list="shift-tz-list" placeholder="Asia/Kolkata" />
        <datalist id="shift-tz-list">
          {zoneList.map((z) => (
            <option key={z} value={z} />
          ))}
        </datalist>
      </Field>
    </FormDialog>
  );
}

function ShiftsTab() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const invalidate = useInvalidateSchedules();
  const archive = useMutation({
    mutationFn: ({ row, restore }: { row: TransportShiftDto; restore: boolean }) => (restore ? api.patch(`${SHIFTS_ENDPOINT}/${row.id}`, { isActive: true }) : api.delete(`${SHIFTS_ENDPOINT}/${row.id}`)),
    onSuccess: (_, v) => {
      toast.success(v.restore ? t('Shift restored') : t('Shift archived'));
      invalidate();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const columns = useMemo<MasterColumn<TransportShiftDto>[]>(
    () => [
      { id: 'name', header: 'Name', sortable: true, hideable: false, cell: (r) => <span className="font-medium">{r.name}</span> },
      { id: 'site', header: 'Office / site', cell: (r) => <Dash value={r.site?.name} /> },
      { id: 'startMin', header: 'Login – logout', sortable: true, cell: (r) => <span className="tabular-nums">{shiftTimesLabel(r.startMin, r.endMin, (k) => i18n.t(k))}</span> },
      { id: 'days', header: 'Days', cell: (r) => <DaysText days={r.days} /> },
      { id: 'timeZone', header: 'Time zone', cell: (r) => <span className="text-xs text-muted-foreground">{r.timeZone}</span> },
      { id: 'scheduleCount', header: 'Schedules', cell: (r) => <span className="tabular-nums">{r.scheduleCount}</span> },
      { id: 'isActive', header: 'Status', cell: (r) => (r.isActive ? <Badge variant="success">{i18n.t('Active')}</Badge> : <Badge variant="muted">{i18n.t('Archived')}</Badge>) },
    ],
    [],
  );
  const rowActions = useCallback(
    (r: TransportShiftDto) =>
      can('etms_schedules', r.isActive ? 'delete' : 'edit') ? (
        <DropdownMenuItem variant={r.isActive ? 'destructive' : 'default'} onSelect={() => archive.mutate({ row: r, restore: !r.isActive })}>
          {r.isActive ? <ArchiveIcon /> : <ArchiveRestoreIcon />} {r.isActive ? t('Archive') : t('Restore')}
        </DropdownMenuItem>
      ) : null,
    [can, archive, t],
  );
  return (
    <MasterPage<TransportShiftDto>
      menu="etms_schedules"
      title="Shifts"
      description="Login and logout times per site. Schedules and bookings take their times from the shift."
      endpoint={SHIFTS_ENDPOINT}
      columns={columns}
      rowLabel={(r) => r.name}
      defaultSort={{ id: 'name', desc: false }}
      Form={ShiftForm}
      bulkActions={false}
      history={false}
      canDeleteRow={() => false}
      rowActions={rowActions}
      emptyIcon={ClockIcon}
    />
  );
}

// ───────────────────────────── Schedules ─────────────────────────────

function ScheduleForm({ record, open, onOpenChange }: MasterFormProps<TransportScheduleDto>) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const invalidate = useInvalidateSchedules();
  const tz = getReportTimeZone();
  const [passengerQ, setPassengerQ] = useState('');
  const passengers = useEntityOptions<PassengerDto>('/transport/passengers', passengerOption, { q: passengerQ, enabled: open && !record });
  const shifts = useEntityOptions<TransportShiftDto>(SHIFTS_ENDPOINT, shiftOption, { enabled: open });
  const stops = useEntityOptions<PoiDto>('/pois', poiOption, { enabled: open && can('pois') });
  const [profileIds, setProfileIds] = useState<string[]>([]);
  const [shiftId, setShiftId] = useState<string | null>(null);
  const [directions, setDirections] = useState<TransportDirection[]>(['IN', 'OUT']);
  const [days, setDays] = useState<number[]>([]);
  const [mode, setMode] = useState<TransportPickupMode>('HOME');
  const [stopId, setStopId] = useState<string | null>(null);
  const [validFrom, setValidFrom] = useState('');
  const [validTo, setValidTo] = useState('');
  const [tried, setTried] = useState(false);
  const shift = shifts.rows.find((s) => s.id === shiftId) ?? null;

  useEffect(() => {
    if (!open) return;
    setTried(false);
    setProfileIds([]);
    setShiftId(record?.shiftId ?? null);
    setDirections(record ? [record.direction] : ['IN', 'OUT']);
    setDays(record?.days ?? []);
    setMode(record?.pickupMode ?? 'HOME');
    setStopId(record?.stop?.id ?? null);
    setValidFrom(record?.validFrom ?? todayInZone(tz));
    setValidTo(record?.validTo ?? '');
  }, [open, record, tz]);

  // A new shift brings its days (schedule days must be a subset of the shift's).
  const pickShift = (id: string | null) => {
    setShiftId(id);
    const s = shifts.rows.find((x) => x.id === id);
    if (s) setDays((d) => (d.length && d.every((x) => s.days.includes(x)) ? d : s.days));
  };

  const save = useMutation({
    mutationFn: (body: CreateTransportSchedulesInput | UpdateTransportScheduleInput): Promise<TransportScheduleDto | CreateTransportSchedulesResult> =>
      record ? api.patch<TransportScheduleDto>(`${SCHEDULES_ENDPOINT}/${record.id}`, body) : api.post<CreateTransportSchedulesResult>(SCHEDULES_ENDPOINT, body),
    onSuccess: (res) => {
      if (record) toast.success(t('Schedule updated. Future unassigned bookings follow the new pattern.'));
      else {
        const r = res as CreateTransportSchedulesResult;
        toast.success(t('{{n}} schedule(s) created; {{b}} booking(s) generated for the next 72 hours.', { n: r.created.length, b: r.generatedBookings }));
      }
      invalidate();
      onOpenChange(false);
    },
  });

  const errors = {
    passengers: !record && profileIds.length === 0 ? t('Choose at least one passenger') : undefined,
    shift: !shiftId ? t('Required') : undefined,
    directions: directions.length === 0 ? t('Choose login, logout or both') : undefined,
    days: days.length === 0 ? t('Choose at least one day') : undefined,
    stop: mode === 'STOP' && !stopId ? t('Choose the pickup stop') : undefined,
    validTo: validTo && validFrom && validTo < validFrom ? t('Must be on or after the start date') : undefined,
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (Object.values(errors).some(Boolean) || !shiftId) return;
    const common = { days, pickupMode: mode, stopPoiId: mode === 'STOP' ? stopId : null, validFrom, validTo: validTo || null };
    if (record) save.mutate({ expectedVersion: record.version, shiftId, ...common });
    else save.mutate({ profileIds, shiftId, directions, ...common });
  };
  const toggleDir = (d: TransportDirection, on: boolean) => setDirections((x) => (on ? [...new Set([...x, d])] : x.filter((y) => y !== d)));

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={record ? 'Edit schedule' : 'New recurring schedules'}
      description={record ? undefined : 'One schedule per passenger and direction. Bookings for the next 72 hours are generated at once.'}
      onSubmit={submit}
      pending={save.isPending}
      error={save.error}
      wide
    >
      {record ? (
        <p className="text-sm">
          <span className="font-medium">{record.passenger.displayName}</span> <span className="text-muted-foreground">· {record.passenger.employeeCode} · {t(DIRECTION_LABEL[record.direction])}</span>
        </p>
      ) : (
        <Field label={t('Passengers')} required error={tried ? errors.passengers : undefined}>
          <MultiSelect value={profileIds} onChange={setProfileIds} options={passengers.options} loading={passengers.loading} onSearch={setPassengerQ} placeholder={t('Choose passengers…')} searchPlaceholder={t('Search name or code…')} emptyText={t('No passengers found')} />
        </Field>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('Shift')} required error={tried ? errors.shift : undefined}>
          <Combobox value={shiftId} onChange={pickShift} options={shifts.options} loading={shifts.loading} placeholder={t('Choose a shift')} searchPlaceholder={t('Search shifts…')} emptyText={t('No shifts found')} clearable={false} />
        </Field>
        {!record && (
          <Field label={t('Directions')} required error={tried ? errors.directions : undefined}>
            <div className="flex flex-wrap gap-4 pt-2">
              {(['IN', 'OUT'] as const).map((d) => (
                <label key={d} className="flex items-center gap-2 text-sm">
                  <Checkbox checked={directions.includes(d)} onCheckedChange={(v) => toggleDir(d, !!v)} />
                  {t(DIRECTION_LABEL[d])}
                </label>
              ))}
            </div>
          </Field>
        )}
      </div>
      <Field label={t('Days')} required error={tried ? errors.days : undefined} hint={shift ? t('Only the days of the shift can be chosen.') : t('Choose a shift first.')}>
        <DayPicker value={days} onChange={setDays} allowed={shift?.days ?? []} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('Pickup')}>
          <SimpleSelect
            value={mode}
            onChange={(v) => setMode(v as TransportPickupMode)}
            label={t('Pickup')}
            options={[
              { value: 'HOME', label: t('Home (needs consent)') },
              { value: 'STOP', label: t('Pickup stop') },
            ]}
          />
        </Field>
        {mode === 'STOP' && (
          <Field label={t('Pickup stop')} required error={tried ? errors.stop : undefined}>
            <Combobox value={stopId} onChange={setStopId} options={stops.options} loading={stops.loading} placeholder={t('Choose a place')} searchPlaceholder={t('Search places…')} emptyText={t('No places found')} />
          </Field>
        )}
      </div>
      <div className="grid grid-cols-2 gap-4">
        <Field label={t('Valid from')} htmlFor="sch-from" required>
          <Input id="sch-from" type="date" value={validFrom} onChange={(e) => setValidFrom(e.target.value)} />
        </Field>
        <Field label={t('Valid to')} htmlFor="sch-to" error={tried ? errors.validTo : undefined} hint={t('Empty = no end date')}>
          <Input id="sch-to" type="date" value={validTo} onChange={(e) => setValidTo(e.target.value)} />
        </Field>
      </div>
    </FormDialog>
  );
}

function ExceptionsSheet({ schedule, onClose }: { schedule: TransportScheduleDto | null; onClose: () => void }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const list = useScheduleExceptions(schedule?.id ?? null);
  const invalidate = useInvalidateSchedules();
  const [date, setDate] = useState('');
  const [kind, setKind] = useState<TransportExceptionKind>('SKIP');
  const [time, setTime] = useState('');
  const [reason, setReason] = useState('');
  const editable = can('etms_schedules', 'edit');

  useEffect(() => {
    setDate(todayInZone(schedule?.timeZone));
    setKind('SKIP');
    setTime('');
    setReason('');
  }, [schedule]);

  const add = useMutation({
    mutationFn: () => {
      const timeMin = timeToMinutes(time);
      return api.post(`${SCHEDULES_ENDPOINT}/${schedule!.id}/exceptions`, { date, kind, ...(kind === 'OVERRIDE' && timeMin !== null ? { override: { timeMin } } : {}), ...(reason.trim() ? { reason: reason.trim() } : {}) });
    },
    onSuccess: () => {
      toast.success(kind === 'SKIP' ? t('Day skipped. Its unassigned booking is cancelled.') : t('Time changed for that day.'));
      setReason('');
      invalidate();
    },
  });
  const remove = useMutation({
    mutationFn: (d: string) => api.delete(`${SCHEDULES_ENDPOINT}/${schedule!.id}/exceptions/${d}`),
    onSuccess: () => invalidate(),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const overrideInvalid = kind === 'OVERRIDE' && timeToMinutes(time) === null;

  return (
    <Sheet open={!!schedule} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full gap-0 sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{t('Exceptions')}</SheetTitle>
          <SheetDescription>
            {schedule ? `${schedule.passenger.displayName} · ${schedule.shiftName} · ${t(DIRECTION_LABEL[schedule.direction])}` : ''}
          </SheetDescription>
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
          {editable && (
            <form
              className="grid gap-3 rounded-lg border p-3"
              onSubmit={(e) => {
                e.preventDefault();
                if (!date || overrideInvalid) return;
                add.mutate();
              }}
            >
              <div className="grid grid-cols-2 gap-3">
                <Field label={t('Date')} htmlFor="exc-date" required>
                  <Input id="exc-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
                </Field>
                <Field label={t('Change')}>
                  <SimpleSelect
                    value={kind}
                    onChange={(v) => setKind(v as TransportExceptionKind)}
                    label={t('Change')}
                    options={[
                      { value: 'SKIP', label: t('Skip this day') },
                      { value: 'OVERRIDE', label: t('Other time') },
                    ]}
                  />
                </Field>
              </div>
              {kind === 'OVERRIDE' && (
                <Field label={schedule?.direction === 'OUT' ? t('Logout time that day') : t('Login time that day')} htmlFor="exc-time" required error={time && overrideInvalid ? t('Enter a time as HH:MM') : undefined}>
                  <Input id="exc-time" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
                </Field>
              )}
              <Field label={t('Reason')} htmlFor="exc-reason">
                <Input id="exc-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder={t('e.g. holiday, leave')} />
              </Field>
              {add.isError && <FormError message={errorMessage(add.error)} />}
              <Button type="submit" disabled={add.isPending || !date || overrideInvalid} className="justify-self-start">
                {add.isPending && <Spinner />} {t('Add exception')}
              </Button>
            </form>
          )}
          {list.isPending ? (
            <Skeleton className="h-24 w-full" />
          ) : list.isError ? (
            <FormError message={errorMessage(list.error)} />
          ) : !list.data?.length ? (
            <p className="text-sm text-muted-foreground">{t('No exceptions. Every scheduled day generates a booking.')}</p>
          ) : (
            <ul className="divide-y rounded-lg border">
              {list.data.map((x) => (
                <li key={x.id} className="flex items-center gap-3 p-3 text-sm">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium tabular-nums">{x.date}</p>
                    <p className="text-xs text-muted-foreground">
                      {x.kind === 'SKIP' ? t('Skipped') : t('Time {{time}}', { time: x.override?.timeMin !== undefined ? minutesToTime(x.override.timeMin) : '—' })}
                      {x.reason && ` · ${x.reason}`}
                    </p>
                  </div>
                  {editable && (
                    <Button size="icon-sm" variant="ghost" onClick={() => remove.mutate(x.date)} disabled={remove.isPending} aria-label={t('Remove the exception of {{date}}', { date: x.date })}>
                      <Trash2Icon />
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function SchedulesTab() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const invalidate = useInvalidateSchedules();
  const [exceptionsOf, setExceptionsOf] = useState<TransportScheduleDto | null>(null);
  const shifts = useEntityOptions<TransportShiftDto>(SHIFTS_ENDPOINT, shiftOption);
  const archive = useMutation({
    mutationFn: ({ row, restore }: { row: TransportScheduleDto; restore: boolean }) =>
      restore ? api.patch(`${SCHEDULES_ENDPOINT}/${row.id}`, { expectedVersion: row.version, isActive: true }) : api.delete(`${SCHEDULES_ENDPOINT}/${row.id}`),
    onSuccess: (_, v) => {
      toast.success(v.restore ? t('Schedule restored') : t('Schedule archived. Its future unassigned bookings are cancelled.'));
      invalidate();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const filters = useMemo<MasterFilter[]>(
    () => [
      { key: 'shiftId', label: 'Shift', options: shifts.options },
      {
        key: 'direction',
        label: 'Direction',
        options: [
          { value: 'IN', label: i18n.t(DIRECTION_LABEL.IN) },
          { value: 'OUT', label: i18n.t(DIRECTION_LABEL.OUT) },
        ],
      },
    ],
    [shifts.options],
  );
  const columns = useMemo<MasterColumn<TransportScheduleDto>[]>(
    () => [
      {
        id: 'passenger',
        header: 'Passenger',
        sortable: true,
        hideable: false,
        cell: (r) => (
          <span className="flex flex-col">
            <span className="font-medium">{r.passenger.displayName}</span>
            <span className="font-mono text-xs text-muted-foreground">{r.passenger.employeeCode}</span>
          </span>
        ),
      },
      { id: 'shiftName', header: 'Shift', cell: (r) => r.shiftName },
      { id: 'direction', header: 'Direction', cell: (r) => <DirectionBadge direction={r.direction} /> },
      { id: 'days', header: 'Days', cell: (r) => <DaysText days={r.days} /> },
      {
        id: 'pickup',
        header: 'Pickup',
        cell: (r) => (
          <span className="flex flex-wrap items-center gap-1">
            {r.pickupMode === 'STOP' ? (r.stop?.name ?? i18n.t('Pickup stop')) : i18n.t('Home')}
            {r.needsLocation && <Badge variant="warning">{i18n.t('Needs location')}</Badge>}
          </span>
        ),
      },
      { id: 'validFrom', header: 'Valid', sortable: true, cell: (r) => <span className="text-xs tabular-nums">{r.validTo ? `${r.validFrom} – ${r.validTo}` : i18n.t('From {{date}}', { date: r.validFrom })}</span> },
      { id: 'isActive', header: 'Status', cell: (r) => (r.isActive ? <Badge variant="success">{i18n.t('Active')}</Badge> : <Badge variant="muted">{i18n.t('Archived')}</Badge>) },
    ],
    [],
  );
  const rowActions = useCallback(
    (r: TransportScheduleDto) => (
      <>
        <DropdownMenuItem onSelect={() => setExceptionsOf(r)}>
          <CalendarOffIcon /> {t('Exceptions')}
        </DropdownMenuItem>
        {can('etms_schedules', r.isActive ? 'delete' : 'edit') && (
          <DropdownMenuItem variant={r.isActive ? 'destructive' : 'default'} onSelect={() => archive.mutate({ row: r, restore: !r.isActive })}>
            {r.isActive ? <ArchiveIcon /> : <ArchiveRestoreIcon />} {r.isActive ? t('Archive') : t('Restore')}
          </DropdownMenuItem>
        )}
      </>
    ),
    [can, archive, t],
  );
  return (
    <>
      <MasterPage<TransportScheduleDto>
        menu="etms_schedules"
        title="Recurring schedules"
        description="The regular commute of each passenger. Bookings are generated from these up to 72 hours ahead."
        endpoint={SCHEDULES_ENDPOINT}
        columns={columns}
        rowLabel={(r) => `${r.passenger.displayName} · ${r.direction}`}
        filters={filters}
        defaultSort={{ id: 'passenger', desc: false }}
        Form={ScheduleForm}
        bulkActions={false}
        history={false}
        canDeleteRow={() => false}
        rowActions={rowActions}
        emptyIcon={CalendarRangeIcon}
      />
      <ExceptionsSheet schedule={exceptionsOf} onClose={() => setExceptionsOf(null)} />
    </>
  );
}

// ───────────────────────────── Preview ─────────────────────────────

function PreviewTab() {
  const { t } = useTranslation();
  const tz = getReportTimeZone();
  const today = todayInZone(tz);
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(shiftDay(today, 2));
  const valid = from && to && to >= from;
  const range = useMemo(() => (valid ? { from: dayRange(from, tz).from, to: dayRange(to, tz).to } : null), [valid, from, to, tz]);
  const preview = useSchedulePreview(range);
  const p = preview.data;
  return (
    <div className="flex flex-col gap-4">
      <Card className="gap-3 p-4">
                <div className="flex flex-wrap items-end gap-3">
          <Field label={t('From')} htmlFor="pv-from">
            <Input id="pv-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-40" />
          </Field>
          <Field label={t('To')} htmlFor="pv-to" error={!valid ? t('Must be on or after the start date') : undefined}>
            <Input id="pv-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-40" />
          </Field>
          {preview.isFetching && <Spinner className="mb-2 text-muted-foreground" />}
        </div>
      </Card>
      {preview.isError && <FormError message={errorMessage(preview.error)} />}
      {p && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {(
              [
                ['Schedules', p.schedules],
                ['Would create', p.wouldCreate],
                ['Already booked', p.existing],
                ['Skipped by exception', p.skippedByException],
                ['Skipped: other booking', p.skippedDuplicate],
                ['Need a location', p.needsLocation],
              ] as const
            ).map(([label, n]) => (
              <Card key={label} className="gap-1 p-3">
                <span className="text-xs text-muted-foreground">{t(label)}</span>
                <span className="text-xl font-semibold tabular-nums">{n}</span>
              </Card>
            ))}
          </div>
          {p.byDate.length === 0 ? (
            <Card className="py-0">
              <EmptyState icon={CalendarClockIcon} title={t('Nothing to generate')} description={t('Every scheduled day in this range already has a booking or is skipped.')} />
            </Card>
          ) : (
            <Card className="overflow-hidden py-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('Date')}</TableHead>
                    <TableHead>{t('Direction')}</TableHead>
                    <TableHead className="text-right">{t('Bookings')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {p.byDate.map((r) => (
                    <TableRow key={`${r.date}-${r.direction}`}>
                      <TableCell className="tabular-nums">{r.date}</TableCell>
                      <TableCell>
                        <DirectionBadge direction={r.direction} />
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{r.count}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

/**
 * Transport → Shifts & schedules (menu etms_schedules, doc 07 §6.4, 12 WP 3.5): recurring schedules with exceptions,
 * shifts, and the generator preview. Each tab is a full list (MasterPage) with its own header.
 */
export function ShiftsSchedulesPage() {
  const { t } = useTranslation();
  const [tab, setTab] = useState('schedules');
  return (
    <Tabs value={tab} onValueChange={setTab} className="flex h-full w-full min-w-0 flex-col gap-0">
      <div className="px-4 pt-4 sm:px-6 sm:pt-6">
        <TabsList className="w-full sm:w-fit" aria-label={t('Shifts & schedules')}>
          <TabsTrigger value="schedules">{t('Schedules')}</TabsTrigger>
          <TabsTrigger value="shifts">{t('Shifts')}</TabsTrigger>
          <TabsTrigger value="preview">{t('Preview')}</TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value="schedules" className="min-h-0 min-w-0 flex-1">
        <SchedulesTab />
      </TabsContent>
      <TabsContent value="shifts" className="min-h-0 min-w-0 flex-1">
        <ShiftsTab />
      </TabsContent>
      <TabsContent value="preview" className="min-w-0 p-4 sm:p-6">
        <PageHeader title={t('Booking preview')} description={t('What the booking generator would create for these days. Nothing is written.')} />
        <div className="mt-4">
          <PreviewTab />
        </div>
      </TabsContent>
    </Tabs>
  );
}

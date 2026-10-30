import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { attendanceSettingsError, formatMinutes, WEEKDAY_SHORT, WEEKDAYS, type AttendanceDayDto, type AttendanceRowDto, type AttendanceSettingsDto, type AttendanceStatus } from '@veetracer/shared';
import { CalendarCheckIcon, DownloadIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { MultiSelect } from '@/components/ui/multi-select';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAuth } from '@/features/auth/auth-context';
import { named, useEntityOptions } from '@/features/masters/use-options';
import { api, downloadCsv, errorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';

const STATUS: Record<AttendanceStatus, { label: string; cls: string }> = {
  PRESENT: { label: 'Present', cls: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' },
  LATE: { label: 'Late', cls: 'bg-amber-500/15 text-amber-800 dark:text-amber-300' },
  NOT_ARRIVED: { label: 'Not arrived', cls: 'bg-orange-500/15 text-orange-700 dark:text-orange-300' },
  ABSENT: { label: 'Absent', cls: 'bg-rose-500/15 text-rose-700 dark:text-rose-300' },
  DAY_OFF: { label: 'Day off', cls: 'bg-muted text-muted-foreground' },
  UPCOMING: { label: 'Not started', cls: 'bg-muted text-muted-foreground' },
};
const clock = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const time = (iso: string | null) => (iso ? clock.format(Date.parse(iso)) : '—');
const hours = (min: number) => (min ? `${Math.floor(min / 60)} h ${min % 60} min` : '—');
const today = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
const toMin = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
};

function StatusBadge({ s }: { s: AttendanceStatus }) {
  const { t } = useTranslation();
  return <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', STATUS[s].cls)}>{t(STATUS[s].label)}</span>;
}

function Rows({ rows, withDay }: { rows: AttendanceRowDto[]; withDay?: boolean }) {
  const { t } = useTranslation();
  return (
    <Table>
      <TableHeader>
        <TableRow>
          {withDay && <TableHead>{t('Date')}</TableHead>}
          <TableHead>{t('Staff')}</TableHead>
          <TableHead>{t('Status')}</TableHead>
          <TableHead>{t('First in')}</TableHead>
          <TableHead>{t('Last out')}</TableHead>
          <TableHead>{t('On site')}</TableHead>
          <TableHead className="hidden md:table-cell">{t('Site')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={`${r.day}:${r.objectId}`}>
            {withDay && <TableCell className="tabular-nums">{r.day}</TableCell>}
            <TableCell className="font-medium">{r.name}</TableCell>
            <TableCell>
              <StatusBadge s={r.status} />
              {r.lateMin > 0 && <span className="ms-1.5 text-xs text-muted-foreground">{t('+{{n}} min', { n: r.lateMin })}</span>}
            </TableCell>
            <TableCell className="tabular-nums">{time(r.firstIn)}</TableCell>
            <TableCell className="tabular-nums">{r.firstIn && !r.lastOut ? t('On site') : time(r.lastOut)}</TableCell>
            <TableCell className="tabular-nums">{hours(r.onSiteMin)}</TableCell>
            <TableCell className="hidden text-muted-foreground md:table-cell">{r.site ?? '—'}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function TodayTab() {
  const { t } = useTranslation();
  const [day, setDay] = useState(today());
  const q = useQuery({ queryKey: ['attendance', day], queryFn: ({ signal }) => api.get<AttendanceDayDto>('/attendance', { day }, signal), refetchInterval: 60_000 });
  const d = q.data;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input type="date" value={day} max={today()} onChange={(e) => setDay(e.target.value || today())} className="w-44" aria-label={t('Date')} />
        {d && (Object.keys(STATUS) as AttendanceStatus[]).filter((s) => d.counts[s] > 0).map((s) => (
          <span key={s} className={cn('rounded-full px-2.5 py-1 text-xs font-medium', STATUS[s].cls)}>
            {t(STATUS[s].label)} {d.counts[s]}
          </span>
        ))}
      </div>
      <Card className="overflow-hidden p-0">
        {q.isPending ? (
          <Skeleton className="m-4 h-40" />
        ) : !d?.enabled ? (
          <EmptyState icon={CalendarCheckIcon} title={t('Attendance is off')} description={t('Turn it on in Settings and choose the work-site geofences.')} />
        ) : !d.rows.length ? (
          <EmptyState icon={CalendarCheckIcon} title={t('No staff to show')} description={t('People tracked by phone or ID card appear here.')} />
        ) : (
          <Rows rows={d.rows} />
        )}
      </Card>
    </div>
  );
}

function TimesheetTab() {
  const { t } = useTranslation();
  const [from, setFrom] = useState(() => today().slice(0, 8) + '01');
  const [to, setTo] = useState(today());
  const q = useQuery({ queryKey: ['attendance-sheet', from, to], queryFn: ({ signal }) => api.get<AttendanceRowDto[]>('/attendance/timesheet', { from, to }, signal), enabled: !!from && !!to && from <= to });
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <Field label={t('From')} htmlFor="ts-from">
          <Input id="ts-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-44" />
        </Field>
        <Field label={t('To')} htmlFor="ts-to">
          <Input id="ts-to" type="date" value={to} max={today()} onChange={(e) => setTo(e.target.value)} className="w-44" />
        </Field>
        <Button variant="outline" onClick={() => void downloadCsv('/attendance/timesheet', { from, to }, 'timesheet.csv').catch((e) => toast.error(errorMessage(e)))}>
          <DownloadIcon /> {t('Download CSV')}
        </Button>
      </div>
      <Card className="max-h-[65vh] overflow-auto p-0">{q.isPending ? <Skeleton className="m-4 h-40" /> : q.data?.length ? <Rows rows={q.data} withDay /> : <EmptyState icon={CalendarCheckIcon} title={t('Nothing in this range')} />}</Card>
    </div>
  );
}

function SettingsTab({ canEdit }: { canEdit: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['attendance-settings'], queryFn: ({ signal }) => api.get<AttendanceSettingsDto>('/attendance/settings', undefined, signal) });
  const geofences = useEntityOptions<{ id: string; name: string }>('/geofences', named);
  const staff = useEntityOptions<{ id: string; name: string }>('/objects', named, { params: { type: 'PERSON' } });
  const [s, setS] = useState<AttendanceSettingsDto | null>(null);
  useEffect(() => {
    if (q.data && !s) setS(q.data);
  }, [q.data, s]);
  const save = useMutation({
    mutationFn: (v: AttendanceSettingsDto) => api.put<AttendanceSettingsDto>('/attendance/settings', v),
    onSuccess: (v) => {
      qc.setQueryData(['attendance-settings'], v);
      void qc.invalidateQueries({ queryKey: ['attendance'] });
      toast.success(t('Saved'));
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  if (!s) return <Skeleton className="h-60" />;
  const error = attendanceSettingsError(s);
  const set = (p: Partial<AttendanceSettingsDto>) => setS({ ...s, ...p });
  return (
    <Card className="max-w-2xl space-y-4 p-4">
      <label className="flex items-center justify-between gap-3">
        <span>
          <span className="block font-medium">{t('Attendance on')}</span>
          <span className="block text-xs text-muted-foreground">{t('Staff check in and out automatically when they enter and leave a work site.')}</span>
        </span>
        <Switch checked={s.enabled} onCheckedChange={(enabled) => set({ enabled })} disabled={!canEdit} />
      </label>
      <Field label={t('Work sites (geofences)')} htmlFor="att-sites" hint={t('Draw them in Geofences first (office, depot, client sites…).')}>
        <MultiSelect id="att-sites" value={s.geofenceIds} onChange={(geofenceIds) => set({ geofenceIds })} options={geofences.options} loading={geofences.loading} disabled={!canEdit} placeholder={t('Choose geofences')} />
      </Field>
      <Field label={t('Staff (optional)')} htmlFor="att-staff" hint={t('Leave empty to include every person tracked by phone or ID card.')}>
        <MultiSelect id="att-staff" value={s.objectIds} onChange={(objectIds) => set({ objectIds })} options={staff.options} loading={staff.loading} disabled={!canEdit} placeholder={t('All staff')} />
      </Field>
      <div className="space-y-1.5">
        <span className="text-sm font-medium">{t('Working days')}</span>
        <div className="flex flex-wrap gap-1.5">
          {WEEKDAYS.map((d) => {
            const on = s.days.includes(d);
            return (
              <button key={d} type="button" disabled={!canEdit} aria-pressed={on} onClick={() => set({ days: on ? s.days.filter((x) => x !== d) : [...s.days, d] })} className={cn('h-8 min-w-11 rounded-full border px-2.5 text-xs font-medium', on ? 'border-primary bg-primary text-primary-foreground' : 'hover:bg-muted')}>
                {t(WEEKDAY_SHORT[d])}
              </button>
            );
          })}
        </div>
      </div>
      <div className="flex flex-wrap gap-3">
        <Field label={t('Start')} htmlFor="att-start">
          <Input id="att-start" type="time" className="w-32" value={formatMinutes(s.startMin)} onChange={(e) => set({ startMin: toMin(e.target.value) })} disabled={!canEdit} />
        </Field>
        <Field label={t('End')} htmlFor="att-end">
          <Input id="att-end" type="time" className="w-32" value={formatMinutes(s.endMin)} onChange={(e) => set({ endMin: toMin(e.target.value) })} disabled={!canEdit} />
        </Field>
        <Field label={t('Grace (min)')} htmlFor="att-grace">
          <Input id="att-grace" type="number" min={0} max={180} className="w-28" value={s.graceMin} onChange={(e) => set({ graceMin: Number(e.target.value) || 0 })} disabled={!canEdit} />
        </Field>
      </div>
      <p className="text-xs text-muted-foreground">{t('Alerts: "Staff not arrived" when nobody has reached a work site by start + grace, and "Staff absent" at the end of the working day. Choose who gets them in Alert Settings.')}</p>
      {error && <p className="text-sm text-destructive">{t(error)}</p>}
      {canEdit && (
        <Button onClick={() => save.mutate(s)} disabled={!!error || save.isPending}>
          {save.isPending && <Spinner />} {t('Save')}
        </Button>
      )}
    </Card>
  );
}

/** Field staff attendance: today's board, timesheet and settings. */
export function AttendancePage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  return (
    <div className="space-y-4 p-4 sm:p-6">
      <PageHeader title={t('Staff attendance')} description={t('Automatic check-in and check-out when staff with the Tracker app or an ID card reach or leave a work site.')} />
      <Tabs defaultValue="today">
        <TabsList>
          <TabsTrigger value="today">{t('Today')}</TabsTrigger>
          <TabsTrigger value="sheet">{t('Timesheet')}</TabsTrigger>
          <TabsTrigger value="settings">{t('Settings')}</TabsTrigger>
        </TabsList>
        <TabsContent value="today" className="pt-3">
          <TodayTab />
        </TabsContent>
        <TabsContent value="sheet" className="pt-3">
          <TimesheetTab />
        </TabsContent>
        <TabsContent value="settings" className="pt-3">
          <SettingsTab canEdit={can('attendance', 'edit')} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

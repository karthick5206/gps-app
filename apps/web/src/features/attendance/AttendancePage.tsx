import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  attendanceSettingsError,
  formatMinutes,
  WEEKDAY_SHORT,
  WEEKDAYS,
  type AttendanceDayDto,
  type AttendanceFix,
  CHECK_IN_PROOFS,
  type CheckInProof,
  type AttendanceLiveState,
  type AttendanceOverride,
  type AttendanceRowDto,
  type AttendanceSettingsDto,
  type AttendanceShiftDto,
  type AttendanceStatus,
  type OutingKind,
} from '@veetracer/shared';
import { CalendarCheckIcon, DownloadIcon, FileSpreadsheetIcon, MapPinIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Field } from '@/components/ui/field';
import { Input, Textarea } from '@/components/ui/input';
import { MultiSelect } from '@/components/ui/multi-select';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAuth, useMe } from '@/features/auth/auth-context';
import { named, useEntityOptions } from '@/features/masters/use-options';
import { api, downloadCsv, errorMessage, fetchBlob } from '@/lib/api';
import { cn } from '@/lib/utils';

const STATUS: Record<AttendanceStatus, { label: string; cls: string }> = {
  PRESENT: { label: 'Present', cls: 'bg-success-soft text-success-fg' },
  LATE: { label: 'Late', cls: 'bg-warning-soft text-warning-fg' },
  NOT_ARRIVED: { label: 'Not arrived', cls: 'bg-neutral-soft text-neutral-fg' },
  ABSENT: { label: 'Absent', cls: 'bg-destructive-soft text-destructive-fg' },
  DAY_OFF: { label: 'Day off', cls: 'bg-muted text-muted-foreground' },
  UPCOMING: { label: 'Not started', cls: 'bg-muted text-muted-foreground' },
};
const HALF_DAY = { label: 'Half day', cls: 'bg-info-soft text-info-fg' };
const LIVE: Record<AttendanceLiveState, { label: string; cls: string }> = {
  INSIDE: { label: 'Inside', cls: 'text-success-fg' },
  OUT: { label: 'Out now', cls: 'text-destructive-fg' },
  NO_SIGNAL: { label: 'No signal', cls: 'text-warning-fg' },
};
const KINDS: Record<OutingKind, string> = { UNEXPLAINED: 'Unexplained', OFFICIAL: 'Official duty', PERSONAL: 'Personal' };
const OVERRIDES: { value: AttendanceOverride; label: string }[] = [
  { value: 'PRESENT', label: 'Present' },
  { value: 'HALF_DAY', label: 'Half day' },
  { value: 'ABSENT', label: 'Absent' },
  { value: 'DAY_OFF', label: 'Day off' },
];
const ALL = '__all__';
const NONE = '__none__';

const clock = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const time = (iso: string | null) => (iso ? clock.format(Date.parse(iso)) : '—');
const hours = (min: number) => (min ? `${Math.floor(min / 60)} h ${min % 60} min` : '—');
const today = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
const toMin = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
};

function StatusBadge({ r }: { r: AttendanceRowDto }) {
  const { t } = useTranslation();
  const s = r.halfDay ? HALF_DAY : STATUS[r.status];
  return <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', s.cls)}>{t(s.label)}</span>;
}

function Place({ fix }: { fix: AttendanceFix | null }) {
  const { t } = useTranslation();
  if (!fix) return <span className="text-muted-foreground">—</span>;
  return (
    <a className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline" href={`https://www.google.com/maps?q=${fix.lat},${fix.lng}`} target="_blank" rel="noreferrer">
      <MapPinIcon className="size-3.5" />
      <span className="tabular-nums">
        {fix.lat.toFixed(5)}, {fix.lng.toFixed(5)}
      </span>
      {fix.accuracyM !== null && <span className="text-muted-foreground">{t('±{{n}} m', { n: Math.round(fix.accuracyM) })}</span>}
    </a>
  );
}

/** The selfie with where and when across the bottom (before 2026-11-06 no selfie location was kept: the first-in location is shown). */
const PROOF_LABEL: Record<CheckInProof, string> = { PHOTO: 'Photo', VIDEO: '10-second video', PHOTO_AND_VIDEO: 'Photo and video' };
const PROOF_HINT: Record<CheckInProof, string> = {
  PHOTO: 'Staff take a selfie.',
  VIDEO: 'Staff record a 10-second video; a photo is taken from it.',
  PHOTO_AND_VIDEO: 'The camera starts recording by itself for 10 seconds when staff open it, with a visible countdown; a photo is taken from the video.',
};

/** The check-in video, with where and when under it (the photo carries the same details burnt in). */
function CheckInVideo({ objectId, day, at, fix }: { objectId: string; day: string; at: string; fix: AttendanceFix | null }) {
  const { t } = useTranslation();
  const q = useQuery({
    queryKey: ['attendance-video', objectId, day, at],
    queryFn: async () => URL.createObjectURL(await fetchBlob(`/attendance/video?objectId=${objectId}&day=${day}`)),
    retry: false,
    staleTime: Infinity,
  });
  if (q.isError) return <p className="text-xs text-muted-foreground">{t('The video is no longer kept.')}</p>;
  if (!q.data) return <Skeleton className="h-56 w-44" />;
  return (
    <figure className="w-fit overflow-hidden rounded-md border">
      <video src={q.data} controls playsInline className="h-56 max-w-full bg-black" aria-label={t('Check-in video')} />
      <figcaption className="bg-black/80 px-2 py-1 text-xs text-white tabular-nums">
        {fix ? `${fix.lat.toFixed(6)}, ${fix.lng.toFixed(6)}` : t('Location not available')} · {day} · {time(at)}
      </figcaption>
    </figure>
  );
}

function Selfie({ objectId, day, at, fix }: { objectId: string; day: string; at: string; fix: AttendanceFix | null }) {
  const { t } = useTranslation();
  const q = useQuery({
    queryKey: ['attendance-selfie', objectId, day, at],
    queryFn: async () => URL.createObjectURL(await fetchBlob(`/attendance/selfie?objectId=${objectId}&day=${day}`)),
    retry: false,
    staleTime: Infinity,
  });
  if (q.isError) return <p className="text-xs text-muted-foreground">{t('The photo is no longer kept.')}</p>;
  if (!q.data) return <Skeleton className="h-56 w-44" />;
  return (
    <figure className="relative w-fit overflow-hidden rounded-md border">
      <img src={q.data} alt={t('Check-in selfie')} className="h-56 max-w-full object-cover" />
      <figcaption className="absolute inset-x-0 bottom-0 bg-black/65 px-2 py-1 text-xs text-white tabular-nums">
        {fix ? (
          <a href={`https://www.google.com/maps?q=${fix.lat},${fix.lng}`} target="_blank" rel="noreferrer" className="block font-medium hover:underline">
            {fix.lat.toFixed(6)}, {fix.lng.toFixed(6)}
          </a>
        ) : (
          <span className="block">{t('Location not available')}</span>
        )}
        <span className="block text-white/80">
          {day} · {time(at)}
        </span>
      </figcaption>
    </figure>
  );
}

/** Hours of one person's day, the location at each crossing, approval of outings and manual correction. */
function DayDialog({ row, canEdit, onClose }: { row: AttendanceRowDto; canEdit: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [r, setR] = useState(row);
  const [status, setStatus] = useState<string>(NONE);
  const [note, setNote] = useState(row.correctionNote ?? '');
  const done = (v: AttendanceRowDto) => {
    setR(v);
    void qc.invalidateQueries({ queryKey: ['attendance'] });
    void qc.invalidateQueries({ queryKey: ['attendance-sheet'] });
    toast.success(t('Saved'));
  };
  const decide = useMutation({
    mutationFn: (v: { leftAt: string; kind: OutingKind }) => api.put<AttendanceRowDto>('/attendance/outing', { objectId: r.objectId, ...v }),
    onSuccess: done,
    onError: (e) => toast.error(errorMessage(e)),
  });
  const correct = useMutation({
    mutationFn: (v: { status: string | null; note: string }) => api.put<AttendanceRowDto>('/attendance/correction', { objectId: r.objectId, day: r.day, ...v }),
    onSuccess: (v) => {
      setStatus(NONE);
      done(v);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const figures: [string, number][] = [
    ['Worked', r.workedMin],
    ['Inside', r.onSiteMin],
    ['Official duty', r.officialMin],
    ['Personal', r.personalMin],
    ['Unexplained', r.unexplainedMin],
    ['No signal', r.noSignalMin],
    ['Late', r.lateMin],
    ['Early leave', r.earlyMin],
    ['Overtime', r.overtimeMin],
  ];
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {r.name} · {r.day}
          </DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <StatusBadge r={r} />
            {r.corrected && <span className="text-xs text-muted-foreground">{t('Corrected by hand')}{r.correctionNote ? `: ${r.correctionNote}` : ''}</span>}
            <span className="text-muted-foreground">
              {r.shift === 'Default' ? t('Default shift') : r.shift}
              {r.branch ? ` · ${r.branch}` : ''}
            </span>
          </div>
          {r.carriedOver && <p className="rounded-md bg-warning-soft p-2 text-sm text-warning-fg">{t('This phone was already inside before the shift. It may have stayed at the site overnight, so check this day.')}</p>}
          <div className="grid grid-cols-3 gap-2">
            {figures.map(([label, min]) => (
              <div key={label} className="rounded-md border p-2">
                <div className="text-xs text-muted-foreground">{t(label)}</div>
                <div className="text-sm font-medium tabular-nums">{hours(min)}</div>
              </div>
            ))}
          </div>
          <div className="space-y-1 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="w-20 text-muted-foreground">{t('First in')}</span>
              <span className="tabular-nums">{time(r.firstIn)}</span>
              <Place fix={r.inFix} />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="w-20 text-muted-foreground">{t('Last out')}</span>
              <span className="tabular-nums">{time(r.lastOut)}</span>
              <Place fix={r.outFix} />
            </div>
          </div>
          {(r.selfieAt || r.selfieMissing) && (
            <div className="space-y-1.5">
              <h3 className="text-sm font-medium">{t('Check-in selfie')}</h3>
              {r.selfieAt ? (
                <>
                  <div className="flex flex-wrap gap-2">
                    <Selfie objectId={r.objectId} day={r.day} at={r.selfieAt} fix={r.selfieFix ?? r.inFix} />
                    {r.videoAt && <CheckInVideo objectId={r.objectId} day={r.day} at={r.videoAt} fix={r.selfieFix ?? r.inFix} />}
                  </div>
                  {r.videoMissing && <p className="text-sm text-warning-fg">{t('No video was recorded.')}</p>}
                </>
              ) : (
                <p className="text-sm text-warning-fg">{t('No selfie was taken.')}</p>
              )}
            </div>
          )}
          <div className="space-y-2">
            <h3 className="text-sm font-medium">{t('Time outside during the shift')}</h3>
            {!r.outings.length && <p className="text-sm text-muted-foreground">{t('None')}</p>}
            {r.outings.map((o) => (
              <div key={o.leftAt} className="space-y-2 rounded-md border p-2 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium tabular-nums">
                    {time(o.leftAt)} – {o.returnedAt ? time(o.returnedAt) : t('not back')} · {hours(o.minutes)}
                  </span>
                  <span className={cn('text-xs font-medium', o.kind === 'UNEXPLAINED' ? 'text-destructive-fg' : 'text-muted-foreground')}>{t(KINDS[o.kind])}</span>
                </div>
                <Place fix={o.fix} />
                {o.employeeKind && (
                  <p className="text-xs text-muted-foreground">
                    {t('Employee says: {{answer}}', { answer: t(KINDS[o.employeeKind]) })}
                    {o.employeeNote ? ` · ${o.employeeNote}` : ''}
                    {o.decidedByAdmin ? ` · ${t('decided by admin')}` : ''}
                  </p>
                )}
                {canEdit && (
                  <div className="flex flex-wrap gap-1.5">
                    {(['OFFICIAL', 'PERSONAL', 'UNEXPLAINED'] as OutingKind[]).filter((k) => k !== o.kind).map((kind) => (
                      <Button key={kind} size="sm" variant="outline" disabled={decide.isPending} onClick={() => decide.mutate({ leftAt: o.leftAt, kind })}>
                        {kind === 'UNEXPLAINED' ? t('Undo') : t(KINDS[kind])}
                      </Button>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
          {canEdit && (
            <div className="space-y-2 border-t pt-3">
              <h3 className="text-sm font-medium">{t('Correct this day')}</h3>
              <Select value={status} onValueChange={setStatus}>
                <SelectTrigger aria-label={t('Correct this day')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>{t('Choose a status')}</SelectItem>
                  {OVERRIDES.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {t(o.label)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder={t('Reason')} aria-label={t('Reason')} />
              <div className="flex flex-wrap gap-2">
                <Button size="sm" disabled={status === NONE || correct.isPending} onClick={() => correct.mutate({ status, note })}>
                  {correct.isPending && <Spinner />} {t('Save correction')}
                </Button>
                {r.corrected && (
                  <Button size="sm" variant="outline" disabled={correct.isPending} onClick={() => correct.mutate({ status: null, note: '' })}>
                    {t('Remove correction')}
                  </Button>
                )}
              </div>
            </div>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

const statusKey = (r: AttendanceRowDto) => (r.halfDay ? 'HALF_DAY' : r.status);

/** Name search and status filter over the rows shown, with a count per status. */
function useRowFilter(rows: AttendanceRowDto[]) {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState(ALL);
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(statusKey(r), (counts.get(statusKey(r)) ?? 0) + 1);
  const s = q.trim().toLowerCase();
  const shown = rows.filter((r) => (status === ALL || statusKey(r) === status) && (!s || r.name.toLowerCase().includes(s)));
  return { q, setQ, status, setStatus, counts, shown };
}

function RowFilter({ f, total }: { f: ReturnType<typeof useRowFilter>; total: number }) {
  const { t } = useTranslation();
  const chips = [...(Object.keys(STATUS) as AttendanceStatus[]).map((k) => [k, STATUS[k]] as const), ['HALF_DAY', HALF_DAY] as const].filter(([k]) => f.counts.get(k));
  if (!total) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Input value={f.q} onChange={(e) => f.setQ(e.target.value)} placeholder={t('Search staff')} aria-label={t('Search staff')} className="h-8 w-48" />
      <button type="button" aria-pressed={f.status === ALL} onClick={() => f.setStatus(ALL)} className={cn('rounded-full border px-2.5 py-1 text-xs font-medium', f.status === ALL ? 'border-primary bg-primary text-primary-foreground' : 'hover:bg-muted')}>
        {t('All')} {total}
      </button>
      {chips.map(([k, s]) => (
        <button key={k} type="button" aria-pressed={f.status === k} onClick={() => f.setStatus(f.status === k ? ALL : k)} className={cn('rounded-full px-2.5 py-1 text-xs font-medium ring-primary', s.cls, f.status === k && 'ring-2')}>
          {t(s.label)} {f.counts.get(k)}
        </button>
      ))}
    </div>
  );
}

function Rows({ rows, withDay, canEdit }: { rows: AttendanceRowDto[]; withDay?: boolean; canEdit: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState<AttendanceRowDto | null>(null);
  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            {withDay && <TableHead>{t('Date')}</TableHead>}
            <TableHead>{t('Staff')}</TableHead>
            <TableHead>{t('Status')}</TableHead>
            <TableHead>{t('First in')}</TableHead>
            <TableHead>{t('Last out')}</TableHead>
            <TableHead>{t('Worked')}</TableHead>
            <TableHead>{t('Inside')}</TableHead>
            <TableHead className="hidden md:table-cell">{t('Official duty')}</TableHead>
            <TableHead className="hidden md:table-cell">{t('Unexplained')}</TableHead>
            <TableHead className="hidden lg:table-cell">{t('No signal')}</TableHead>
            <TableHead className="hidden lg:table-cell">{t('Branch')}</TableHead>
            <TableHead className="hidden xl:table-cell">{t('Selfie')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={`${r.day}:${r.objectId}`} className="cursor-pointer" onClick={() => setOpen(r)}>
              {withDay && <TableCell className="tabular-nums">{r.day}</TableCell>}
              <TableCell className="font-medium">
                <button type="button" className="text-start hover:underline" onClick={() => setOpen(r)}>
                  {r.name}
                </button>
                {r.state && <span className={cn('block text-xs font-normal', LIVE[r.state].cls)}>{t(LIVE[r.state].label)}</span>}
              </TableCell>
              <TableCell>
                <StatusBadge r={r} />
                {r.lateMin > 0 && <span className="ms-1.5 text-xs text-muted-foreground">{t('+{{n}} min', { n: r.lateMin })}</span>}
                {r.earlyMin > 0 && <span className="ms-1.5 text-xs text-muted-foreground">{t('Left {{n}} min early', { n: r.earlyMin })}</span>}
                {r.overtimeMin > 0 && <span className="ms-1.5 text-xs text-muted-foreground">{t('OT {{n}} min', { n: r.overtimeMin })}</span>}
                {r.corrected && <span className="ms-1.5 text-xs text-muted-foreground">{t('Corrected')}</span>}
                {r.selfieMissing && <span className="ms-1.5 text-xs text-warning-fg">{t('No selfie')}</span>}
              </TableCell>
              <TableCell className="tabular-nums">{time(r.firstIn)}</TableCell>
              <TableCell className="tabular-nums">{r.firstIn && !r.lastOut ? t('On site') : time(r.lastOut)}</TableCell>
              <TableCell className="font-medium tabular-nums">{hours(r.workedMin)}</TableCell>
              <TableCell className="tabular-nums">{hours(r.onSiteMin)}</TableCell>
              <TableCell className="hidden tabular-nums md:table-cell">{hours(r.officialMin)}</TableCell>
              <TableCell className={cn('hidden tabular-nums md:table-cell', r.unexplainedMin > 0 && 'text-destructive-fg')}>{hours(r.unexplainedMin)}</TableCell>
              <TableCell className="hidden tabular-nums lg:table-cell">{hours(r.noSignalMin)}</TableCell>
              <TableCell className="hidden text-muted-foreground lg:table-cell">{r.branch ?? '—'}</TableCell>
              <TableCell className="hidden tabular-nums xl:table-cell">{r.selfieAt ? time(r.selfieAt) : r.selfieMissing ? <span className="text-warning-fg">{t('Missing')}</span> : '—'}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {open && <DayDialog key={`${open.day}:${open.objectId}`} row={open} canEdit={canEdit} onClose={() => setOpen(null)} />}
    </>
  );
}

/** Excel / PDF, monthly summary, time outside and corrections, which can also be e-mailed on a schedule. */
function ReportsLink() {
  const { t } = useTranslation();
  const { can } = useAuth();
  if (!can('reports')) return null;
  return (
    <Button variant="outline" asChild>
      <Link to="/reports?type=ATTENDANCE_SUMMARY">
        <FileSpreadsheetIcon /> {t('Attendance reports')}
      </Link>
    </Button>
  );
}

function BranchFilter({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const branches = useEntityOptions<{ id: string; name: string }>('/branches', named, { enabled: can('branches') });
  if (!branches.options.length) return null;
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="w-48" aria-label={t('Branch')}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>{t('All branches')}</SelectItem>
        {branches.options.map((b) => (
          <SelectItem key={b.value} value={b.value}>
            {b.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function TodayTab({ canEdit }: { canEdit: boolean }) {
  const { t } = useTranslation();
  const [day, setDay] = useState(today());
  const [branch, setBranch] = useState(ALL);
  const branchId = branch === ALL ? undefined : branch;
  const q = useQuery({ queryKey: ['attendance', day, branch], queryFn: ({ signal }) => api.get<AttendanceDayDto>('/attendance', { day, branchId }, signal), refetchInterval: 60_000 });
  const d = q.data;
  const filter = useRowFilter(d?.enabled ? d.rows : []);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input type="date" value={day} max={today()} onChange={(e) => setDay(e.target.value || today())} className="w-44" aria-label={t('Date')} />
        <BranchFilter value={branch} onChange={setBranch} />
        <ReportsLink />
      </div>
      <RowFilter f={filter} total={d?.enabled ? d.rows.length : 0} />
      <Card className="overflow-x-auto p-0">
        {q.isPending ? (
          <Skeleton className="m-4 h-40" />
        ) : !d?.enabled ? (
          <EmptyState icon={CalendarCheckIcon} title={t('Attendance is off')} description={t('Turn it on in Settings and choose the work-site geofences.')} />
        ) : !d.rows.length ? (
          <EmptyState icon={CalendarCheckIcon} title={t('No staff to show')} description={t('People tracked by phone or ID card appear here.')} />
        ) : (
          <Rows rows={filter.shown} canEdit={canEdit} />
        )}
      </Card>
    </div>
  );
}

function TimesheetTab({ canEdit }: { canEdit: boolean }) {
  const { t } = useTranslation();
  const [from, setFrom] = useState(() => today().slice(0, 8) + '01');
  const [to, setTo] = useState(today());
  const [branch, setBranch] = useState(ALL);
  const branchId = branch === ALL ? undefined : branch;
  const q = useQuery({ queryKey: ['attendance-sheet', from, to, branch], queryFn: ({ signal }) => api.get<AttendanceRowDto[]>('/attendance/timesheet', { from, to, branchId }, signal), enabled: !!from && !!to && from <= to });
  const filter = useRowFilter(q.data ?? []);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <Field label={t('From')} htmlFor="ts-from">
          <Input id="ts-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-44" />
        </Field>
        <Field label={t('To')} htmlFor="ts-to">
          <Input id="ts-to" type="date" value={to} max={today()} onChange={(e) => setTo(e.target.value)} className="w-44" />
        </Field>
        <BranchFilter value={branch} onChange={setBranch} />
        <Button variant="outline" onClick={() => void downloadCsv('/attendance/timesheet', { from, to, branchId }, 'timesheet.csv').catch((e) => toast.error(errorMessage(e)))}>
          <DownloadIcon /> {t('Download CSV')}
        </Button>
        <ReportsLink />
      </div>
      <RowFilter f={filter} total={q.data?.length ?? 0} />
      <Card className="max-h-[65vh] overflow-auto p-0">{q.isPending ? <Skeleton className="m-4 h-40" /> : q.data?.length ? <Rows rows={filter.shown} withDay canEdit={canEdit} /> : <EmptyState icon={CalendarCheckIcon} title={t('Nothing in this range')} />}</Card>
    </div>
  );
}

function DayPicker({ days, disabled, onChange }: { days: number[]; disabled: boolean; onChange: (days: number[]) => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap gap-1.5">
      {WEEKDAYS.map((d) => {
        const on = days.includes(d);
        return (
          <button key={d} type="button" disabled={disabled} aria-pressed={on} onClick={() => onChange(on ? days.filter((x) => x !== d) : [...days, d])} className={cn('h-8 min-w-11 rounded-full border px-2.5 text-xs font-medium', on ? 'border-primary bg-primary text-primary-foreground' : 'hover:bg-muted')}>
            {t(WEEKDAY_SHORT[d])}
          </button>
        );
      })}
    </div>
  );
}

function NumberField({ id, label, hint, value, onChange, disabled, max, scale = 1, step }: { id: string; label: string; hint?: string; value: number; onChange: (v: number) => void; disabled: boolean; max: number; scale?: number; step?: number }) {
  return (
    <Field label={label} htmlFor={id} hint={hint} className="w-44">
      <Input id={id} type="number" min={0} max={max} step={step} value={value / scale} onChange={(e) => onChange(Math.round((Number(e.target.value) || 0) * scale))} disabled={disabled} />
    </Field>
  );
}

function ShiftCard({ shift, canEdit, branches, staff, onChange, onRemove }: { shift: AttendanceShiftDto; canEdit: boolean; branches: ReturnType<typeof useEntityOptions>; staff: ReturnType<typeof useEntityOptions>; onChange: (p: Partial<AttendanceShiftDto>) => void; onRemove: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-3 rounded-md border p-3">
      <div className="flex items-end gap-2">
        <Field label={t('Shift name')} htmlFor={`sh-${shift.id}`} className="flex-1">
          <Input id={`sh-${shift.id}`} value={shift.name} maxLength={60} onChange={(e) => onChange({ name: e.target.value })} disabled={!canEdit} />
        </Field>
        {canEdit && (
          <Button variant="outline" size="icon" aria-label={t('Remove shift')} onClick={onRemove}>
            <Trash2Icon />
          </Button>
        )}
      </div>
      <DayPicker days={shift.days} disabled={!canEdit} onChange={(days) => onChange({ days })} />
      <div className="flex flex-wrap gap-3">
        <Field label={t('Start')} htmlFor={`sh-${shift.id}-s`}>
          <Input id={`sh-${shift.id}-s`} type="time" className="w-32" value={formatMinutes(shift.startMin)} onChange={(e) => onChange({ startMin: toMin(e.target.value) })} disabled={!canEdit} />
        </Field>
        <Field label={t('End')} htmlFor={`sh-${shift.id}-e`}>
          <Input id={`sh-${shift.id}-e`} type="time" className="w-32" value={formatMinutes(shift.endMin)} onChange={(e) => onChange({ endMin: toMin(e.target.value) })} disabled={!canEdit} />
        </Field>
      </div>
      <Field label={t('Branches on this shift')} htmlFor={`sh-${shift.id}-b`}>
        <MultiSelect id={`sh-${shift.id}-b`} value={shift.branchIds} onChange={(branchIds) => onChange({ branchIds })} options={branches.options} loading={branches.loading} disabled={!canEdit} placeholder={t('Choose branches')} />
      </Field>
      <Field label={t('People on this shift')} htmlFor={`sh-${shift.id}-p`} hint={t('These people follow this shift whatever their branch.')}>
        <MultiSelect id={`sh-${shift.id}-p`} value={shift.objectIds} onChange={(objectIds) => onChange({ objectIds })} options={staff.options} loading={staff.loading} disabled={!canEdit} placeholder={t('Choose people')} />
      </Field>
    </div>
  );
}

function SettingsTab({ canEdit }: { canEdit: boolean }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const me = useMe();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['attendance-settings'], queryFn: ({ signal }) => api.get<AttendanceSettingsDto>('/attendance/settings', undefined, signal) });
  const geofences = useEntityOptions<{ id: string; name: string }>('/geofences', named);
  const staff = useEntityOptions<{ id: string; name: string }>('/objects', named, { params: { type: 'PERSON' } });
  const branches = useEntityOptions<{ id: string; name: string }>('/branches', named, { enabled: can('branches') });
  const [s, setS] = useState<AttendanceSettingsDto | null>(null);
  useEffect(() => {
    if (q.data && !s) setS(q.data);
  }, [q.data, s]);
  const save = useMutation({
    mutationFn: (v: AttendanceSettingsDto) => api.put<AttendanceSettingsDto>('/attendance/settings', v),
    onSuccess: (v) => {
      qc.setQueryData(['attendance-settings'], v);
      setS(v);
      void qc.invalidateQueries({ queryKey: ['attendance'] });
      toast.success(t('Saved'));
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  if (!s) return <Skeleton className="h-60" />;
  const error = attendanceSettingsError(s);
  const set = (p: Partial<AttendanceSettingsDto>) => setS({ ...s, ...p });
  const setShift = (id: string, p: Partial<AttendanceShiftDto>) => set({ shifts: s.shifts.map((x) => (x.id === id ? { ...x, ...p } : x)) });
  const addShift = () => set({ shifts: [...s.shifts, { id: crypto.randomUUID(), name: '', days: s.days, startMin: s.startMin, endMin: s.endMin, branchIds: [], objectIds: [] }] });
  return (
    <Card className="max-w-2xl space-y-4 p-4">
      <label className="flex items-center justify-between gap-3">
        <span>
          <span className="block font-medium">{t('Attendance on')}</span>
          <span className="block text-xs text-muted-foreground">{t('Staff check in and out automatically when they enter and leave a work site.')}</span>
        </span>
        <Switch checked={s.enabled} onCheckedChange={(enabled) => set({ enabled })} disabled={!canEdit} />
      </label>
      <Field label={t('Work sites (geofences)')} htmlFor="att-sites" hint={t('Draw them in Geofences first and give each store its branch. Staff count only at their own branch, and at sites without a branch.')}>
        <MultiSelect id="att-sites" value={s.geofenceIds} onChange={(geofenceIds) => set({ geofenceIds })} options={geofences.options} loading={geofences.loading} disabled={!canEdit} placeholder={t('Choose geofences')} />
      </Field>
      <Field label={t('Staff (optional)')} htmlFor="att-staff" hint={t('Leave empty to include every person tracked by phone or ID card.')}>
        <MultiSelect id="att-staff" value={s.objectIds} onChange={(objectIds) => set({ objectIds })} options={staff.options} loading={staff.loading} disabled={!canEdit} placeholder={t('All staff')} />
      </Field>
      <Field label={t('Staff who can attend at any branch')} htmlFor="att-any" hint={t('Optional. Everyone else counts only at their own branch.')}>
        <MultiSelect id="att-any" value={s.anyBranchObjectIds} onChange={(anyBranchObjectIds) => set({ anyBranchObjectIds })} options={staff.options} loading={staff.loading} disabled={!canEdit} placeholder={t('Nobody')} />
      </Field>

      <label className="flex items-center justify-between gap-3 border-t pt-4">
        <span>
          <span className="block font-medium">{t('Selfie at check-in')}</span>
          <span className="block text-xs text-muted-foreground">{t('Staff are asked for a selfie in the Tracker app when they reach their work site. It is kept for 90 days. A missing selfie is flagged and does not change the status. Needs Tracker 1.3.5 or later.')}</span>
        </span>
        <Switch checked={s.selfieRequired} onCheckedChange={(selfieRequired) => set({ selfieRequired })} disabled={!canEdit} aria-label={t('Selfie at check-in')} />
      </label>
      {s.selfieRequired && (
        <Field label={t('Check-in proof')} htmlFor="att-proof" hint={t(PROOF_HINT[s.checkInProof ?? 'PHOTO'])}>
          <Select value={s.checkInProof ?? 'PHOTO'} onValueChange={(v) => set({ checkInProof: v as CheckInProof })} disabled={!canEdit}>
            <SelectTrigger id="att-proof" className="w-64">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CHECK_IN_PROOFS.map((p) => (
                <SelectItem key={p} value={p}>
                  {t(PROOF_LABEL[p])}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      )}

      <div className="space-y-3 border-t pt-4">
        <h3 className="font-medium">{t('Default shift')}</h3>
        <p className="text-xs text-muted-foreground">{t('For everyone not on one of the shifts below.')}</p>
        <div className="space-y-1.5">
          <span className="text-sm font-medium">{t('Working days')}</span>
          <DayPicker days={s.days} disabled={!canEdit} onChange={(days) => set({ days })} />
        </div>
        <div className="flex flex-wrap gap-3">
          <Field label={t('Start')} htmlFor="att-start">
            <Input id="att-start" type="time" className="w-32" value={formatMinutes(s.startMin)} onChange={(e) => set({ startMin: toMin(e.target.value) })} disabled={!canEdit} />
          </Field>
          <Field label={t('End')} htmlFor="att-end">
            <Input id="att-end" type="time" className="w-32" value={formatMinutes(s.endMin)} onChange={(e) => set({ endMin: toMin(e.target.value) })} disabled={!canEdit} />
          </Field>
        </div>
      </div>

      <div className="space-y-3 border-t pt-4">
        <h3 className="font-medium">{t('Other shifts')}</h3>
        {s.shifts.map((shift) => (
          <ShiftCard key={shift.id} shift={shift} canEdit={canEdit} branches={branches} staff={staff} onChange={(p) => setShift(shift.id, p)} onRemove={() => set({ shifts: s.shifts.filter((x) => x.id !== shift.id) })} />
        ))}
        {canEdit && (
          <Button variant="outline" onClick={addShift}>
            <PlusIcon /> {t('Add shift')}
          </Button>
        )}
      </div>

      <div className="space-y-3 border-t pt-4">
        <h3 className="font-medium">{t('Rules')}</h3>
        <div className="flex flex-wrap items-start gap-3">
          <NumberField id="att-grace" label={t('Grace (min)')} hint={me.user.isSuperAdmin ? undefined : t('Set by Super Admin')} value={s.graceMin} max={180} onChange={(graceMin) => set({ graceMin })} disabled={!canEdit || !me.user.isSuperAdmin} />
          <NumberField id="att-short" label={t('Short exit (min)')} hint={t('Shorter exits count as inside, with no alert')} value={s.shortExitMin} max={60} onChange={(shortExitMin) => set({ shortExitMin })} disabled={!canEdit} />
          <NumberField id="att-signal" label={t('No signal after (min)')} hint={t('15 at least. No data for this long is not counted as worked')} value={s.noSignalMin} max={240} onChange={(noSignalMin) => set({ noSignalMin })} disabled={!canEdit} />
          <NumberField id="att-half" label={t('Half day from (hours)')} hint={t('Less than this is absent')} value={s.halfDayMin} max={24} scale={60} step={0.5} onChange={(halfDayMin) => set({ halfDayMin })} disabled={!canEdit} />
          <NumberField id="att-full" label={t('Full day from (hours)')} value={s.fullDayMin} max={24} scale={60} step={0.5} onChange={(fullDayMin) => set({ fullDayMin })} disabled={!canEdit} />
          <NumberField id="att-rem" label={t('Still out alert (min)')} hint={t('0 = no second alert')} value={s.outReminderMin} max={720} onChange={(outReminderMin) => set({ outReminderMin })} disabled={!canEdit} />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">{t('Alerts: "Staff not arrived" after start + grace, "Staff absent" at the end of the shift, "Staff left work site" when someone is out during the shift for longer than a short exit, and "Staff still out" after the time above. Choose who gets them in Alert Settings.')}</p>
      {error && <p className="text-sm text-destructive">{t(error)}</p>}
      {canEdit && (
        <Button onClick={() => save.mutate(s)} disabled={!!error || save.isPending}>
          {save.isPending && <Spinner />} {t('Save')}
        </Button>
      )}
    </Card>
  );
}

/** Staff attendance: today's board, timesheet and settings. */
export function AttendancePage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const canEdit = can('attendance', 'edit');
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
          <TodayTab canEdit={canEdit} />
        </TabsContent>
        <TabsContent value="sheet" className="pt-3">
          <TimesheetTab canEdit={canEdit} />
        </TabsContent>
        <TabsContent value="settings" className="pt-3">
          <SettingsTab canEdit={canEdit} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

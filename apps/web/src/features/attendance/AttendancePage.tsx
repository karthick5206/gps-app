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
import { CalendarCheckIcon, ChartColumnIcon, DownloadIcon, FileSpreadsheetIcon, MapPinIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { PageCapture } from '@/components/page-capture';
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
import { useAddress } from '@/features/geocoding/use-address';
import { cn } from '@/lib/utils';
import { calendarDays, change, daysIn, employeeStats, employeeSummary, MAX_PERIOD_DAYS, monthlyTrend, previousRange, teamFigures, trendRange } from './employee-stats';
import { DaySpanChart, HoursChart, LateByWeekday, StatusSplit, TimeAway, TrendCharts, type ChartFormat } from './EmployeeCharts';

const STATUS: Record<AttendanceStatus, { label: string; cls: string }> = {
  PRESENT: { label: 'Present', cls: 'bg-success-soft text-success-fg' },
  LATE: { label: 'Late', cls: 'bg-warning-soft text-warning-fg' },
  NOT_ARRIVED: { label: 'Not arrived', cls: 'bg-neutral-soft text-neutral-fg' },
  ABSENT: { label: 'Absent', cls: 'bg-destructive-soft text-destructive-fg' },
  DAY_OFF: { label: 'Day off', cls: 'bg-muted text-muted-foreground' },
  UPCOMING: { label: 'Not started', cls: 'bg-muted text-muted-foreground' },
};
const HALF_DAY = { label: 'Half day', cls: 'bg-info-soft text-info-fg' };
const LIVE: Record<AttendanceLiveState, { label: string; cls: string; dot: string; tile: string }> = {
  INSIDE: { label: 'Inside', cls: 'text-success-fg', dot: 'bg-success', tile: 'bg-success-soft text-success-fg' },
  OUT: { label: 'Out now', cls: 'text-destructive-fg', dot: 'bg-destructive', tile: 'bg-destructive/10 text-destructive-fg' },
  NO_SIGNAL: { label: 'No signal', cls: 'text-warning-fg', dot: 'bg-warning', tile: 'bg-warning-soft text-warning-fg' },
};
const LIVE_STATES = Object.keys(LIVE) as AttendanceLiveState[];
const OUTING_WORDS: Record<OutingKind, string> = { UNEXPLAINED: 'Not explained yet', OFFICIAL: 'Official duty', PERSONAL: 'Personal work' };
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

/** Address on the first line, then "lat, lng · within N m · View on map". Wraps cleanly in narrow dialogs. */
function PlaceDetail({ fix }: { fix: AttendanceFix | null }) {
  const { t } = useTranslation();
  const { address, loading } = useAddress(fix?.lat, fix?.lng);
  if (!fix) return <span className="text-muted-foreground">—</span>;
  return (
    <div className="min-w-0 space-y-0.5">
      <p className="text-sm leading-snug break-words">{address ?? (loading ? <span className="text-muted-foreground">{t('Finding the address…')}</span> : <span className="text-muted-foreground">{t('Address not available')}</span>)}</p>
      <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
        <span className="tabular-nums">
          {fix.lat.toFixed(5)}, {fix.lng.toFixed(5)}
        </span>
        {fix.accuracyM !== null && <span>{t('within {{n}} m', { n: Math.round(fix.accuracyM) })}</span>}
        <a className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline" href={`https://www.google.com/maps?q=${fix.lat},${fix.lng}`} target="_blank" rel="noreferrer">
          <MapPinIcon className="size-3.5" />
          {t('View on map')}
        </a>
      </p>
    </div>
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
          <dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3 gap-y-3 rounded-md border p-3 text-sm sm:grid-cols-[5.5rem_5.5rem_minmax(0,1fr)]">
            {(
              [
                ['First in', r.firstIn, r.inFix],
                ['Last out', r.lastOut, r.outFix],
              ] as const
            ).map(([label, at, where]) => (
              <div key={label} className="contents">
                <dt className="text-muted-foreground">{t(label)}</dt>
                <dd className="font-medium tabular-nums">{time(at)}</dd>
                <dd className="col-span-2 min-w-0 sm:col-span-1">{at ? <PlaceDetail fix={where} /> : <span className="text-muted-foreground">—</span>}</dd>
              </div>
            ))}
          </dl>
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
            <h3 className="text-sm font-medium">{t('Times away from the work site')}</h3>
            {!r.outings.length && <p className="text-sm text-muted-foreground">{t('None')}</p>}
            {r.outings.map((o) => (
              <div key={o.leftAt} className="space-y-2 rounded-md border p-2 text-sm">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="space-y-0.5">
                    <p className="font-medium tabular-nums">
                      {o.site ? t('Left {{site}} at {{time}}', { site: o.site, time: time(o.leftAt) }) : t('Left at {{time}}', { time: time(o.leftAt) })}
                      {' · '}
                      {o.returnedAt ? t('Back at {{time}}', { time: time(o.returnedAt) }) : <span className="text-warning-fg">{t('Not back yet')}</span>}
                    </p>
                    <p className="text-xs text-muted-foreground">{t('Away for {{time}}', { time: hours(o.minutes) })}</p>
                  </div>
                  <span className={cn('rounded-full px-2 py-0.5 text-xs font-semibold', o.kind === 'UNEXPLAINED' ? 'bg-destructive/10 text-destructive-fg' : o.kind === 'OFFICIAL' ? 'bg-success-soft text-success-fg' : 'bg-muted text-muted-foreground')}>
                    {o.kind === 'UNEXPLAINED' ? t('Not explained yet') : t('Counted as: {{kind}}', { kind: t(OUTING_WORDS[o.kind]) })}
                  </span>
                  {o.auto === 'TRAVEL' && <span className="w-full text-xs text-muted-foreground">{t('Travel between work sites, counted automatically')}</span>}
                </div>
                {o.fix && (
                  <div className="space-y-0.5">
                    <p className="text-xs text-muted-foreground">{t('Where they left the site:')}</p>
                    <PlaceDetail fix={o.fix} />
                  </div>
                )}
                {o.employeeKind && (
                  <p className="text-xs text-muted-foreground">
                    {t("Employee's answer: {{answer}}", { answer: t(OUTING_WORDS[o.employeeKind]) })}
                    {o.employeeNote ? ` — “${o.employeeNote}”` : ''}
                    {o.decidedByAdmin && o.employeeKind !== o.kind ? ` · ${t('The admin changed it to {{kind}}', { kind: t(OUTING_WORDS[o.kind]) })}` : ''}
                  </p>
                )}
                {!o.employeeKind && o.decidedByAdmin && <p className="text-xs text-muted-foreground">{t('Decided by the admin')}</p>}
                {canEdit && (
                  <div className="flex flex-wrap gap-1.5">
                    {(['OFFICIAL', 'PERSONAL', 'UNEXPLAINED'] as OutingKind[]).filter((k) => k !== o.kind).map((kind) => (
                      <Button key={kind} size="sm" variant="outline" disabled={decide.isPending} onClick={() => decide.mutate({ leftAt: o.leftAt, kind })}>
                        {kind === 'UNEXPLAINED' ? t('Clear the decision') : kind === 'OFFICIAL' ? t('Mark as official duty') : t('Mark as personal work')}
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
  const [live, setLive] = useState<AttendanceLiveState | null>(null);
  const counts = new Map<string, number>();
  const liveCounts = new Map<AttendanceLiveState, number>();
  for (const r of rows) {
    counts.set(statusKey(r), (counts.get(statusKey(r)) ?? 0) + 1);
    if (r.state) liveCounts.set(r.state, (liveCounts.get(r.state) ?? 0) + 1);
  }
  const s = q.trim().toLowerCase();
  const shown = rows.filter((r) => (status === ALL || statusKey(r) === status) && (!live || r.state === live) && (!s || r.name.toLowerCase().includes(s)));
  return { q, setQ, status, setStatus, live, setLive, counts, liveCounts, shown };
}

/**
 * "Right now" for today: how many staff are inside a work site, out, or without a recent signal. Each tile filters
 * the list to those people (click again to show everyone). Hidden when no one has a live state (a past day).
 */
function LiveStrip({ f }: { f: ReturnType<typeof useRowFilter> }) {
  const { t } = useTranslation();
  if (!f.liveCounts.size) return null;
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-bold tracking-wider text-muted-foreground uppercase">{t('Right now')}</p>
      <div className="grid grid-cols-3 gap-2 sm:max-w-xl" role="group" aria-label={t('Right now')}>
        {LIVE_STATES.map((k) => {
          const on = f.live === k;
          return (
            <button
              key={k}
              type="button"
              aria-pressed={on}
              onClick={() => f.setLive(on ? null : k)}
              className={cn('flex flex-col items-start gap-0.5 rounded-lg border bg-card px-3 py-2 text-left transition-colors hover:bg-muted', on && cn(LIVE[k].tile, 'border-current'))}
            >
              <span className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
                <span className={cn('size-2 rounded-full', LIVE[k].dot)} aria-hidden />
                {t(LIVE[k].label)}
              </span>
              <span className="text-2xl leading-none font-bold tabular-nums">{f.liveCounts.get(k) ?? 0}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
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
  const insights = useContext(InsightsContext);
  const [open, setOpen] = useState<AttendanceRowDto | null>(null);
  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            {withDay && <TableHead>{t('Date')}</TableHead>}
            <TableHead>{t('Staff')}</TableHead>
            {!withDay && <TableHead>{t('Right now')}</TableHead>}
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
                <span className="inline-flex items-center gap-1.5">
                  <button type="button" className="text-start hover:underline" onClick={() => setOpen(r)}>
                    {r.name}
                  </button>
                  {insights && (
                    <button
                      type="button"
                      title={t('Employee insights')}
                      aria-label={t('Employee insights for {{name}}', { name: r.name })}
                      onClick={(e) => {
                        e.stopPropagation();
                        insights(r.objectId);
                      }}
                      className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                    >
                      <ChartColumnIcon className="size-3.5" />
                    </button>
                  )}
                </span>
              </TableCell>
              {!withDay && (
                <TableCell className="whitespace-nowrap">
                  {r.state ? (
                    <span className={cn('inline-flex items-center gap-1.5 text-sm font-semibold', LIVE[r.state].cls)}>
                      <span className={cn('size-2 rounded-full', LIVE[r.state].dot)} aria-hidden />
                      {t(LIVE[r.state].label)}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
              )}
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
      <LiveStrip f={filter} />
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

/** Minutes that may be left empty to use the company setting (shown as the placeholder). */
function OptionalMinutes({ id, label, value, fallback, max, onChange, disabled }: { id: string; label: string; value: number | null | undefined; fallback: number; max: number; onChange: (v: number | null) => void; disabled: boolean }) {
  const { t } = useTranslation();
  return (
    <Field label={label} htmlFor={id} hint={t('Empty = company setting')} className="w-44">
      <Input
        id={id}
        type="number"
        min={0}
        max={max}
        value={value ?? ''}
        placeholder={String(fallback)}
        onChange={(e) => onChange(e.target.value === '' ? null : Math.max(0, Math.min(max, Math.round(Number(e.target.value) || 0))))}
        disabled={disabled}
      />
    </Field>
  );
}

/** A rule that can be switched off, with its minutes beside it while on. Off saves 0. */
function MinutesRule({ id, title, hint, value, fallback, max, unit, onChange, disabled }: { id: string; title: string; hint: string; value: number; fallback: number; max: number; unit: string; onChange: (v: number) => void; disabled: boolean }) {
  const on = value > 0;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3">
      <span className="min-w-0 flex-1">
        <span className="block font-medium">{title}</span>
        <span className="block text-xs text-muted-foreground">{hint}</span>
      </span>
      {on && (
        <span className="flex items-center gap-2">
          <Input id={id} type="number" min={1} max={max} className="w-24" value={value} onChange={(e) => onChange(Math.max(1, Math.min(max, Math.round(Number(e.target.value) || 1))))} disabled={disabled} aria-label={title} />
          <span className="text-sm text-muted-foreground">{unit}</span>
        </span>
      )}
      <Switch checked={on} onCheckedChange={(v) => onChange(v ? fallback : 0)} disabled={disabled} aria-label={title} />
    </div>
  );
}

function ShiftCard({ shift, canEdit, branches, staff, onChange, onRemove, company }: { shift: AttendanceShiftDto; company: { breakMin: number; travelMaxMin: number }; canEdit: boolean; branches: ReturnType<typeof useEntityOptions>; staff: ReturnType<typeof useEntityOptions>; onChange: (p: Partial<AttendanceShiftDto>) => void; onRemove: () => void }) {
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
        <OptionalMinutes id={`sh-${shift.id}-brk`} label={t('Break allowance (min a day)')} value={shift.breakMin} fallback={company.breakMin} max={180} onChange={(breakMin) => onChange({ breakMin })} disabled={!canEdit} />
        <OptionalMinutes id={`sh-${shift.id}-trv`} label={t('Travel between sites (min)')} value={shift.travelMaxMin} fallback={company.travelMaxMin} max={480} onChange={(travelMaxMin) => onChange({ travelMaxMin })} disabled={!canEdit} />
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
      <Field label={t('Work sites (geofences)')} htmlFor="att-sites" hint={t('Draw them in Geofences first and give each one its branch.')}>
        <MultiSelect id="att-sites" value={s.geofenceIds} onChange={(geofenceIds) => set({ geofenceIds })} options={geofences.options} loading={geofences.loading} disabled={!canEdit} placeholder={t('Choose geofences')} />
      </Field>
      <Field label={t('Staff (optional)')} htmlFor="att-staff" hint={t('Leave empty to include every person tracked by phone or ID card.')}>
        <MultiSelect id="att-staff" value={s.objectIds} onChange={(objectIds) => set({ objectIds })} options={staff.options} loading={staff.loading} disabled={!canEdit} placeholder={t('All staff')} />
      </Field>
      <label className="flex items-center justify-between gap-3">
        <span>
          <span className="block font-medium">{t('Count work sites of every branch')}</span>
          <span className="block text-xs text-muted-foreground">{t('On: being at any of your work sites counts as worked, e.g. a day at another branch or a meeting at head office. Off: staff count only at their own branch.')}</span>
        </span>
        <Switch checked={s.otherBranchSites !== false} onCheckedChange={(otherBranchSites) => set({ otherBranchSites })} disabled={!canEdit} aria-label={t('Count work sites of every branch')} />
      </label>
      {s.otherBranchSites === false && (
        <Field label={t('Staff who can attend at any branch')} htmlFor="att-any" hint={t('Optional. Everyone else counts only at their own branch.')}>
          <MultiSelect id="att-any" value={s.anyBranchObjectIds} onChange={(anyBranchObjectIds) => set({ anyBranchObjectIds })} options={staff.options} loading={staff.loading} disabled={!canEdit} placeholder={t('Nobody')} />
        </Field>
      )}

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
          <ShiftCard company={{ breakMin: s.breakMin ?? 45, travelMaxMin: s.travelMaxMin ?? 120 }} key={shift.id} shift={shift} canEdit={canEdit} branches={branches} staff={staff} onChange={(p) => setShift(shift.id, p)} onRemove={() => set({ shifts: s.shifts.filter((x) => x.id !== shift.id) })} />
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
        {/* Overtime: the company decides whether it counts at all, and from how many minutes past the shift end. */}
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3">
          <span className="min-w-0 flex-1">
            <span className="block font-medium">{t('Count overtime')}</span>
            <span className="block text-xs text-muted-foreground">{t('Time worked after the shift end, beyond a full shift. Coming late and staying late to make up is not overtime.')}</span>
          </span>
          {s.overtimeOn !== false && (
            <span className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">{t('from')}</span>
              <Input id="att-ot" type="number" min={0} max={240} className="w-24" value={s.overtimeMinMin ?? 15} onChange={(e) => set({ overtimeMinMin: Math.max(0, Math.min(240, Math.round(Number(e.target.value) || 0))) })} disabled={!canEdit} aria-label={t('Overtime from (min)')} />
              <span className="text-sm text-muted-foreground">{t('min past the end')}</span>
            </span>
          )}
          <Switch checked={s.overtimeOn !== false} onCheckedChange={(overtimeOn) => set({ overtimeOn })} disabled={!canEdit} aria-label={t('Count overtime')} />
        </div>
        <MinutesRule id="att-travel" title={t('Travel between work sites is official duty')} hint={t('Going straight from one work site to a different one within this time counts as worked, and staff are not asked.')} value={s.travelMaxMin ?? 120} fallback={120} max={480} unit={t('min at most')} onChange={(travelMaxMin) => set({ travelMaxMin })} disabled={!canEdit} />
        <MinutesRule id="att-break" title={t('Break allowance')} hint={t('Short trips out that come back, up to this total a day, are not questioned and count as worked.')} value={s.breakMin ?? 45} fallback={45} max={180} unit={t('min a day')} onChange={(breakMin) => set({ breakMin })} disabled={!canEdit} />
        <p className="text-xs text-muted-foreground">{t('A shift can have its own break allowance and travel time (Shifts above); empty uses these.')}</p>
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
/** Opens the Employee tab for a person (from a name in the Today / Timesheet lists). */
const InsightsContext = createContext<((objectId: string) => void) | null>(null);

type Period = 'this' | 'last' | '30' | '90' | 'custom';
const minusDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
const periodRange = (p: Exclude<Period, 'custom'>): { from: string; to: string } => {
  const t = today();
  if (p === 'this') return { from: `${t.slice(0, 8)}01`, to: t };
  if (p === '30') return { from: minusDays(t, 29), to: t };
  if (p === '90') return { from: minusDays(t, 89), to: t };
  const end = minusDays(`${t.slice(0, 8)}01`, 1);
  return { from: `${end.slice(0, 8)}01`, to: end };
};
/** Why a custom range can't be shown, or null when it can. */
const customError = (from: string, to: string): string | null => {
  if (!from || !to) return 'Choose both dates';
  if (from > to) return 'The start date must be before the end date';
  if (to > today()) return 'The end date can’t be in the future';
  if (daysIn(from, to) > MAX_PERIOD_DAYS) return 'Choose up to 6 months';
  return null;
};
const clockOf = (min: number) => clock.format(new Date(2000, 0, 1, Math.floor(min / 60), min % 60));
const DOW_LONG = (i: number) => new Intl.DateTimeFormat(undefined, { weekday: 'long' }).format(new Date(Date.UTC(2026, 10, 1 + i, 12)));
const DOW_ABBR = (i: number) => new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(new Date(Date.UTC(2026, 10, 1 + i, 12))); // Sunday = 0
const DOW_SHORT = (i: number) => new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(new Date(Date.UTC(2026, 10, 2 + i, 12))); // Monday first
const DAY_CELL: Record<string, string> = {
  PRESENT: 'bg-success-soft text-success-fg border-success/30',
  LATE: 'bg-warning-soft text-warning-fg border-warning/30',
  HALF: 'bg-info-soft text-info-fg border-info/30',
  ABSENT: 'bg-destructive-soft text-destructive-fg border-destructive/30',
  DAY_OFF: 'bg-muted text-muted-foreground border-transparent',
};
/** The calendar shows each day up to this many days; the day-by-day span chart up to CHART_SPAN_DAYS. */
const CALENDAR_DAYS = 93;
const CHART_SPAN_DAYS = 62;

function Tile({ label, value, sub, compare, className }: { label: string; value: ReactNode; sub?: ReactNode; compare?: ReactNode; className?: string }) {
  return (
    <div className={cn('rounded-lg border bg-card px-4 py-3', className)}>
      <div className="text-xs font-semibold text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-bold tabular-nums">{value}</div>
      {sub && <div className="mt-1 text-xs text-muted-foreground">{sub}</div>}
      {compare && <div className="mt-1.5 space-y-0.5 border-t pt-1.5 text-xs text-muted-foreground tabular-nums">{compare}</div>}
    </div>
  );
}

/**
 * "▲ 3.2 pts" against the previous period. The arrow shows the direction; its colour says whether that is better
 * (green) or worse (red) for this figure, and the words carry the meaning without the colour.
 */
function Delta({ value, text, higherIsBetter }: { value: number | null; text: (abs: number) => string; higherIsBetter: boolean }) {
  const { t } = useTranslation();
  if (value === null) return null;
  if (value === 0) return <div>{t('Same as the previous period')}</div>;
  const better = value > 0 === higherIsBetter;
  return (
    <div>
      <span className={cn('font-semibold', better ? 'text-success-fg' : 'text-destructive-fg')} aria-hidden>
        {value > 0 ? '▲' : '▼'}
      </span>{' '}
      {t(value > 0 ? '{{v}} more than the previous period' : '{{v}} less than the previous period', { v: text(Math.abs(value)) })}
    </div>
  );
}

/**
 * One person over a period: headline figures compared with the previous period and the team, a plain-language summary,
 * a calendar coloured by status, hours and times each day, patterns (days, late weekdays, time away) and the last
 * 12 months. Built from the same timesheet rows as the reports, so the figures match them.
 */
function EmployeeTab({ canEdit, objectId, onObjectId }: { canEdit: boolean; objectId: string | null; onObjectId: (id: string | null) => void }) {
  const { t } = useTranslation();
  const me = useMe();
  const staff = useEntityOptions<{ id: string; name: string }>('/objects', named, { params: { type: 'PERSON' } });
  const [period, setPeriod] = useState<Period>('this');
  const [custom, setCustom] = useState(() => periodRange('30'));
  const [open, setOpen] = useState<AttendanceRowDto | null>(null);
  const insightsRef = useRef<HTMLDivElement>(null);
  const badRange = period === 'custom' ? customError(custom.from, custom.to) : null;
  const range = period === 'custom' ? custom : periodRange(period);
  const days = daysIn(range.from, range.to);
  const prev = previousRange(range.from, range.to);
  const trend = trendRange(today());
  const sheet = (from: string, to: string, signal: AbortSignal) => api.get<AttendanceRowDto[]>('/attendance/timesheet', { from, to, objectId: objectId ?? undefined }, signal);
  const q = useQuery({ queryKey: ['attendance-person', objectId, range.from, range.to], queryFn: ({ signal }) => sheet(range.from, range.to, signal), enabled: !!objectId && !badRange });
  const before = useQuery({ queryKey: ['attendance-person', objectId, prev.from, prev.to], queryFn: ({ signal }) => sheet(prev.from, prev.to, signal), enabled: !!objectId && !badRange, staleTime: 5 * 60_000 });
  const year = useQuery({ queryKey: ['attendance-person', objectId, trend.from, trend.to], queryFn: ({ signal }) => sheet(trend.from, trend.to, signal), enabled: !!objectId, staleTime: 10 * 60_000 });
  // The team for the same period: everyone's timesheet (same request as the Timesheet tab), up to 62 days.
  const team = useQuery({
    queryKey: ['attendance-sheet', range.from, range.to, ALL],
    queryFn: ({ signal }) => api.get<AttendanceRowDto[]>('/attendance/timesheet', { from: range.from, to: range.to }, signal),
    enabled: !!objectId && !badRange && days <= CHART_SPAN_DAYS,
    staleTime: 5 * 60_000,
  });
  const rows = useMemo(() => (q.data ?? []).filter((r) => r.objectId === objectId).sort((a, b) => a.day.localeCompare(b.day)), [q.data, objectId]);
  const st = useMemo(() => employeeStats(rows), [rows]);
  const pst = useMemo(() => (before.data ? employeeStats(before.data.filter((r) => r.objectId === objectId)) : null), [before.data, objectId]);
  const tf = useMemo(() => (team.data ? teamFigures(team.data) : null), [team.data]);
  const months = useMemo(() => monthlyTrend((year.data ?? []).filter((r) => r.objectId === objectId)), [year.data, objectId]);
  const byDay = useMemo(() => new Map(rows.map((r) => [r.day, r])), [rows]);
  const first = rows[0];
  // Shift times for the charts: the person's named shift, else the company default (charts work without them).
  const settings = useQuery({ queryKey: ['attendance-settings'], queryFn: ({ signal }) => api.get<AttendanceSettingsDto>('/attendance/settings', undefined, signal), enabled: !!objectId, retry: false });
  const shift = useMemo(() => {
    const s = settings.data;
    if (!s || !first) return null;
    const named = s.shifts.find((x) => x.name === first.shift);
    return { startMin: named?.startMin ?? s.startMin, endMin: named?.endMin ?? s.endMin, graceMin: s.graceMin };
  }, [settings.data, first]);
  const shiftMin = shift ? shift.endMin - shift.startMin : null;
  const chartFormat: ChartFormat = { duration: hours, time, clock: clockOf, status: (r) => t(r.halfDay ? HALF_DAY.label : STATUS[r.status].label) };
  const summary = employeeSummary(st, rows, shiftMin, { duration: hours, weekday: DOW_LONG });
  // Previous period only counts when something was due then (a new joiner has nothing to compare with).
  const p = pst && pst.dueDays > 0 ? pst : null;
  const lateCount = rows.filter((r) => r.lateMin > 0).length;
  const prevLate = before.data ? before.data.filter((r) => r.objectId === objectId && r.lateMin > 0).length : null;
  const pts = (v: number) => t('{{n}} pts', { n: v });
  const mins = (v: number) => hours(Math.round(v));

  const patterns: string[] = [];
  if (lateCount > 0) {
    patterns.push(t('Late on {{n}} of {{due}} working days ({{min}} in total).', { n: lateCount, due: st.dueDays, min: hours(st.lateMin) }));
    if (st.lateWeekday !== null) patterns.push(t('Late most often on {{day}} ({{n}} of {{total}} late days).', { day: DOW_LONG(st.lateWeekday), n: st.lateByWeekday[st.lateWeekday], total: lateCount }));
  }
  if (st.earlyDays) patterns.push(t('Left early on {{n}} days ({{min}} in total).', { n: st.earlyDays, min: hours(st.earlyMin) }));
  if (st.absentDays) patterns.push(t('Absent on {{n}} days.', { n: st.absentDays }));
  if (st.unexplainedMin) patterns.push(t('{{min}} away from the work site not explained yet.', { min: hours(st.unexplainedMin) }));
  if (st.overtimeMin) patterns.push(t('{{min}} overtime in this period.', { min: hours(st.overtimeMin) }));
  if (st.correctedDays) patterns.push(t('{{n}} days corrected by hand.', { n: st.correctedDays }));

  const periods: [Period, string][] = [
    ['this', 'This month'],
    ['last', 'Last month'],
    ['30', 'Last 30 days'],
    ['90', 'Last 3 months'],
    ['custom', 'Custom'],
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-2">
        <Field label={t('Staff member')} htmlFor="emp-pick">
          <Select value={objectId ?? ''} onValueChange={(v) => onObjectId(v || null)}>
            <SelectTrigger id="emp-pick" className="w-64">
              <SelectValue placeholder={t('Choose a staff member')} />
            </SelectTrigger>
            <SelectContent>
              {staff.options.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('Period')}>
          {periods.map(([v, l]) => (
            <button key={v} type="button" aria-pressed={period === v} onClick={() => setPeriod(v)} className={cn('h-9 rounded-md border px-3 text-sm font-medium', period === v ? 'border-primary bg-primary text-primary-foreground' : 'hover:bg-muted')}>
              {t(l)}
            </button>
          ))}
        </div>
        {period === 'custom' && (
          <>
            <Field label={t('From')} htmlFor="emp-from">
              <Input id="emp-from" type="date" className="w-40" value={custom.from} max={today()} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} />
            </Field>
            <Field label={t('To')} htmlFor="emp-to">
              <Input id="emp-to" type="date" className="w-40" value={custom.to} max={today()} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} />
            </Field>
          </>
        )}
        <span className="pb-2 text-xs text-muted-foreground tabular-nums">{badRange ? <span className="font-medium text-destructive-fg">{t(badRange)}</span> : `${range.from} – ${range.to}`}</span>
        {objectId && rows.length > 0 && !badRange && (
          <div className="ms-auto flex gap-2">
            <Button variant="outline" onClick={() => void downloadCsv('/attendance/timesheet', { from: range.from, to: range.to, objectId }, 'timesheet.csv').catch((e) => toast.error(errorMessage(e)))}>
              <FileSpreadsheetIcon /> {t('Excel (CSV)')}
            </Button>
            {/* PNG / PDF of the insights below with the VeeTrax · company header. */}
            <PageCapture target={insightsRef} fileName={() => `attendance-${(first?.name ?? 'staff').replace(/[^\w-]+/g, '-')}-${range.from}-${range.to}`} caption={() => ({ title: me?.company.name ?? '', lines: [`${t('Staff attendance')} · ${first?.name ?? ''}`, `${range.from} – ${range.to}`] })} />
          </div>
        )}
      </div>

      {!objectId ? (
        <Card className="p-0">
          <EmptyState icon={ChartColumnIcon} title={t('Choose a staff member')} description={t('See their attendance %, usual check-in time, hours, overtime and patterns for the month, with a calendar of every day.')} />
        </Card>
      ) : badRange ? null : q.isPending ? (
        <Skeleton className="h-80" />
      ) : q.isError ? (
        <Card className="p-4 text-sm text-destructive-fg">{errorMessage(q.error)}</Card>
      ) : !rows.length ? (
        <Card className="p-0">
          <EmptyState icon={CalendarCheckIcon} title={t('Nothing in this period')} description={t('This person is not covered by attendance on these days.')} />
        </Card>
      ) : (
        <div ref={insightsRef} className="space-y-4 bg-background">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h2 className="text-lg font-bold">{first.name}</h2>
            <span className="text-sm text-muted-foreground">{[first.branch, first.shift === 'Default' ? t('Default shift') : first.shift].filter(Boolean).join(' · ')}</span>
          </div>

          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <Tile
              label={t('Attendance')}
              value={`${st.attendancePct}%`}
              sub={
                <span className="block h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
                  <span className={cn('block h-full rounded-full', st.attendancePct >= 90 ? 'bg-success' : st.attendancePct >= 75 ? 'bg-warning' : 'bg-destructive')} style={{ width: `${st.attendancePct}%` }} />
                </span>
              }
              compare={
                (p || tf) && (
                  <>
                    <Delta value={change(st.attendancePct, p?.attendancePct ?? null)} text={pts} higherIsBetter />
                    {tf && <div>{t('Team {{v}}', { v: `${tf.attendancePct}%` })}</div>}
                  </>
                )
              }
            />
            <Tile label={t('Days')} value={`${st.presentDays + st.lateDays} / ${st.dueDays}`} sub={t('{{late}} late · {{half}} half · {{absent}} absent', { late: st.lateDays, half: st.halfDays, absent: st.absentDays })} compare={p && <Delta value={change(st.absentDays, p.absentDays)} text={(v) => t('{{n}} absent', { n: v })} higherIsBetter={false} />} />
            <Tile
              label={t('Usual check-in')}
              value={st.usualCheckInMin === null ? '—' : clockOf(st.usualCheckInMin)}
              sub={t('Middle of all check-in times')}
              compare={
                ((p && p.usualCheckInMin !== null && st.usualCheckInMin !== null) || tf?.usualCheckInMin != null) && (
                  <>
                    {p && st.usualCheckInMin !== null && p.usualCheckInMin !== null && st.usualCheckInMin !== p.usualCheckInMin && (
                      <div>
                        <span className={cn('font-semibold', st.usualCheckInMin < p.usualCheckInMin ? 'text-success-fg' : 'text-destructive-fg')} aria-hidden>
                          {st.usualCheckInMin < p.usualCheckInMin ? '▼' : '▲'}
                        </span>{' '}
                        {t(st.usualCheckInMin < p.usualCheckInMin ? '{{v}} earlier than the previous period' : '{{v}} later than the previous period', { v: mins(Math.abs(st.usualCheckInMin - p.usualCheckInMin)) })}
                      </div>
                    )}
                    {tf?.usualCheckInMin != null && <div>{t('Team {{v}}', { v: clockOf(tf.usualCheckInMin) })}</div>}
                  </>
                )
              }
            />
            <Tile
              label={t('Average a day')}
              value={hours(st.avgWorkedMin)}
              sub={t('On the days they came')}
              compare={
                (p || tf) && (
                  <>
                    {p && p.avgWorkedMin > 0 && <Delta value={change(st.avgWorkedMin, p.avgWorkedMin)} text={mins} higherIsBetter />}
                    {tf && <div>{t('Team {{v}}', { v: hours(tf.avgWorkedMin) })}</div>}
                  </>
                )
              }
            />
            <Tile
              label={t('Overtime')}
              value={hours(st.overtimeMin)}
              compare={
                (p || tf) && (
                  <>
                    {/* More overtime is neither good nor bad here: shown in neutral words only. */}
                    {p && st.overtimeMin !== p.overtimeMin && <div>{t('Previous period {{v}}', { v: hours(p.overtimeMin) })}</div>}
                    {tf && <div>{t('Team {{v}} each', { v: hours(tf.overtimeMin) })}</div>}
                  </>
                )
              }
            />
            <Tile
              label={t('Late')}
              value={hours(st.lateMin)}
              sub={t('{{n}} days', { n: lateCount })}
              compare={
                (p || tf) && (
                  <>
                    {p && prevLate !== null && <Delta value={change(lateCount, prevLate)} text={(v) => t('{{n}} days', { n: v })} higherIsBetter={false} />}
                    {tf && <div>{t('Team {{v}} each', { v: hours(tf.lateMin) })}</div>}
                  </>
                )
              }
            />
          </div>
          {(p || tf) && (
            <p className="text-xs text-muted-foreground">
              {[p && t('Arrows compare with {{from}} – {{to}}.', { from: prev.from, to: prev.to }), tf && t('Team = the typical figure of {{n}} staff in the same days.', { n: tf.people })].filter(Boolean).join(' ')}
            </p>
          )}

          {summary.length > 0 && (
            <Card className="gap-1.5 border-primary/30 bg-primary/5 p-4">
              <h3 className="text-[15px] font-bold">{t('Summary')}</h3>
              <p className="text-sm leading-relaxed">{summary.map((x) => t(x.key, x.values)).join(' ')}</p>
            </Card>
          )}

          <div className="grid gap-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
            {days <= CALENDAR_DAYS ? (
              <Card className="gap-3 p-4">
                <h3 className="text-[15px] font-bold">{t('Calendar')}</h3>
                <div className="grid grid-cols-7 gap-1.5 text-center">
                  {Array.from({ length: 7 }, (_, i) => (
                    <div key={i} className="text-[11px] font-semibold text-muted-foreground uppercase">
                      {DOW_SHORT(i)}
                    </div>
                  ))}
                  {calendarDays(range.from, range.to).map((d, i) => {
                    if (!d) return <div key={i} />;
                    const r = byDay.get(d);
                    const key = r ? (r.halfDay ? 'HALF' : r.status) : '';
                    const label = r ? t(r.halfDay ? HALF_DAY.label : STATUS[r.status].label) : t('Not covered');
                    return (
                      <button
                        key={d}
                        type="button"
                        disabled={!r}
                        onClick={() => r && setOpen(r)}
                        title={`${d} · ${label}${r?.firstIn ? ` · ${time(r.firstIn)} – ${r.lastOut ? time(r.lastOut) : t('still in')}` : ''}${r?.corrected ? ` · ${t('Corrected')}` : ''}`}
                        aria-label={`${d}: ${label}${r?.corrected ? `, ${t('Corrected')}` : ''}`}
                        className={cn('relative flex min-h-14 flex-col items-center justify-center rounded-md border p-1 text-xs transition-colors', DAY_CELL[key] ?? 'border-dashed text-muted-foreground', r && 'hover:ring-2 hover:ring-ring/40')}
                      >
                        {r?.corrected && <span className="absolute end-1 top-0.5 text-[10px] font-bold" aria-hidden>✎</span>}
                        <span className="font-bold">{Number(d.slice(8))}</span>
                        {r?.firstIn && <span className="text-[10px] leading-tight tabular-nums opacity-80">{time(r.firstIn)}</span>}
                        {r?.lastOut && <span className="text-[10px] leading-tight tabular-nums opacity-60">{time(r.lastOut)}</span>}
                      </button>
                    );
                  })}
                </div>
                <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
                  {(
                    [
                      ['PRESENT', 'Present'],
                      ['LATE', 'Late'],
                      ['HALF', 'Half day'],
                      ['ABSENT', 'Absent'],
                      ['DAY_OFF', 'Day off'],
                    ] as const
                  ).map(([k, l]) => (
                    <span key={k} className="flex items-center gap-1.5">
                      <span className={cn('size-3 rounded-sm border', DAY_CELL[k])} aria-hidden />
                      {t(l)}
                    </span>
                  ))}
                  <span className="flex items-center gap-1.5">
                    <span className="font-bold text-foreground" aria-hidden>
                      ✎
                    </span>
                    {t('Corrected')}
                  </span>
                  <span>{t('Times: first in, last out')}</span>
                </div>
              </Card>
            ) : (
              <Card className="gap-2 p-4">
                <h3 className="text-[15px] font-bold">{t('Calendar')}</h3>
                <p className="text-sm text-muted-foreground">{t('The calendar shows up to 3 months. Choose a shorter period to see each day.')}</p>
              </Card>
            )}

            <div className="space-y-4">
              <Card className="gap-3 p-4">
                <h3 className="text-[15px] font-bold">{t('Days')}</h3>
                <StatusSplit present={st.presentDays} late={st.lateDays} half={st.halfDays} absent={st.absentDays} />
              </Card>
              <Card className="gap-3 p-4">
                <h3 className="text-[15px] font-bold">{t('Late by weekday')}</h3>
                <LateByWeekday rows={rows} f={chartFormat} weekday={DOW_ABBR} />
              </Card>
              <Card className="gap-3 p-4">
                <h3 className="text-[15px] font-bold">{t('Time away from the work site')}</h3>
                <TimeAway official={st.officialMin} personal={st.personalMin} unexplained={st.unexplainedMin} noSignal={st.noSignalMin} f={chartFormat} />
              </Card>
              <Card className="gap-2 p-4">
                <h3 className="text-[15px] font-bold">{t('Details')}</h3>
                {patterns.length ? (
                  <ul className="list-disc space-y-1 ps-5 text-sm">
                    {patterns.map((x) => (
                      <li key={x}>{x}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-muted-foreground">{t('No late arrivals, early leaves or absences in this period.')}</p>
                )}
              </Card>
            </div>
          </div>

          <Card className="gap-3 p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-[15px] font-bold">{t('Hours worked each day')}</h3>
              <span className="text-xs text-muted-foreground">{t('Point at a day for details; click to open it.')}</span>
            </div>
            <HoursChart rows={rows} shiftMin={shiftMin} f={chartFormat} onPick={setOpen} />
          </Card>

          <Card className="gap-3 p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-[15px] font-bold">{t('When they worked each day')}</h3>
              <span className="text-xs text-muted-foreground">{t('First in to last out, against the shift.')}</span>
            </div>
            {days <= CHART_SPAN_DAYS ? <DaySpanChart rows={rows} shift={shift} f={chartFormat} onPick={setOpen} /> : <p className="text-sm text-muted-foreground">{t('Shown for periods up to 2 months. Choose a shorter period to see each day.')}</p>}
          </Card>

          <Card className="gap-3 p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-[15px] font-bold">{t('Last 12 months')}</h3>
              <span className="text-xs text-muted-foreground">{t('Point at a month for details.')}</span>
            </div>
            {year.isPending ? (
              <Skeleton className="h-44" />
            ) : months.length < 2 ? (
              <p className="text-sm text-muted-foreground">{t('The trend appears once there are two months of attendance.')}</p>
            ) : (
              <TrendCharts points={months.map((x) => ({ month: x.month, attendancePct: x.stats.attendancePct, avgWorkedMin: x.stats.avgWorkedMin, lateDays: x.stats.lateByWeekday.reduce((a, b) => a + b, 0), dueDays: x.stats.dueDays }))} shiftMin={shiftMin} f={chartFormat} />
            )}
          </Card>
        </div>
      )}
      {open && <DayDialog key={`${open.day}:${open.objectId}`} row={open} canEdit={canEdit} onClose={() => setOpen(null)} />}
    </div>
  );
}

export function AttendancePage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const canEdit = can('attendance', 'edit');
  // ?tab=employee&objectId=… (e.g. from Ask VeeTrax) opens that person's Employee view.
  const [params] = useSearchParams();
  const [tab, setTab] = useState(() => (params.get('tab') === 'employee' ? 'employee' : 'today'));
  const [employee, setEmployee] = useState<string | null>(() => params.get('objectId'));
  // A link followed while this page is already open (Ask VeeTrax).
  useEffect(() => {
    if (params.get('tab') !== 'employee') return;
    setTab('employee');
    if (params.get('objectId')) setEmployee(params.get('objectId'));
  }, [params]);
  const showEmployee = useCallback((id: string) => {
    setEmployee(id);
    setTab('employee');
  }, []);
  return (
    <InsightsContext.Provider value={showEmployee}>
    <div className="space-y-4 p-4 sm:p-6">
      <PageHeader title={t('Staff attendance')} description={t('Automatic check-in and check-out when staff with the Tracker app or an ID card reach or leave a work site.')} />
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="today">{t('Today')}</TabsTrigger>
          <TabsTrigger value="sheet">{t('Timesheet')}</TabsTrigger>
          <TabsTrigger value="employee">{t('Employee')}</TabsTrigger>
          <TabsTrigger value="settings">{t('Settings')}</TabsTrigger>
        </TabsList>
        <TabsContent value="today" className="pt-3">
          <TodayTab canEdit={canEdit} />
        </TabsContent>
        <TabsContent value="sheet" className="pt-3">
          <TimesheetTab canEdit={canEdit} />
        </TabsContent>
        <TabsContent value="employee" className="pt-3">
          <EmployeeTab canEdit={canEdit} objectId={employee} onObjectId={setEmployee} />
        </TabsContent>
        <TabsContent value="settings" className="pt-3">
          <SettingsTab canEdit={canEdit} />
        </TabsContent>
      </Tabs>
    </div>
    </InsightsContext.Provider>
  );
}

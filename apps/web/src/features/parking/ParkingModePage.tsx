import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatMinutes, parkingScheduleError, WEEKDAY_SHORT, WEEKDAYS, type ParkingRowDto, type ParkingWindowDto } from '@veetracer/shared';
import { BellRingIcon, CalendarClockIcon, PlusIcon, SearchIcon, ShieldAlertIcon, ShieldCheckIcon, ShieldOffIcon, Trash2Icon } from 'lucide-react';
import { useDeferredValue, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useAuth } from '@/features/auth/auth-context';
import { api, errorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';

const QUERY_KEY = ['parking-mode'];
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const dayTimeFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });

const toMin = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
};

/** "Mon–Fri", "Every day", "Sat, Sun" or "Mon, Wed, Fri". */
function daysLabel(days: number[], t: (k: string) => string): string {
  const set = new Set(days);
  if (set.size === 7) return t('Every day');
  if (set.size === 5 && [1, 2, 3, 4, 5].every((d) => set.has(d))) return t('Mon–Fri');
  return WEEKDAYS.filter((d) => set.has(d)).map((d) => t(WEEKDAY_SHORT[d])).join(', ');
}

function windowLabel(w: ParkingWindowDto, t: (k: string) => string): string {
  return `${daysLabel(w.days, t)} ${formatMinutes(w.startMin)}–${formatMinutes(w.endMin)}${w.endMin <= w.startMin ? ' (+1)' : ''}`;
}

function StateBadge({ row }: { row: ParkingRowDto }) {
  const { t } = useTranslation();
  if (row.armedUntil) {
    return (
      <Badge variant="destructive" className="gap-1">
        <ShieldAlertIcon className="size-3" /> {t('Armed until {{time}}', { time: timeFmt.format(Date.parse(row.armedUntil)) })}
      </Badge>
    );
  }
  if (row.schedule?.enabled && row.nextStart) {
    return (
      <Badge variant="secondary" className="gap-1">
        <ShieldCheckIcon className="size-3" /> {t('Next: {{time}}', { time: dayTimeFmt.format(Date.parse(row.nextStart)) })}
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="gap-1 text-muted-foreground">
      <ShieldOffIcon className="size-3" /> {t('Off')}
    </Badge>
  );
}

/** Day chips (Mon … Sun) with quick presets, start / end time. */
function WindowEditor({ w, onChange, onRemove }: { w: ParkingWindowDto; onChange: (w: ParkingWindowDto) => void; onRemove: () => void }) {
  const { t } = useTranslation();
  const toggle = (d: number) => onChange({ ...w, days: w.days.includes(d) ? w.days.filter((x) => x !== d) : [...w.days, d] });
  const preset = (days: number[]) => onChange({ ...w, days });
  return (
    <div className="space-y-3 rounded-lg border p-3">
      <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('Days')}>
        {WEEKDAYS.map((d) => {
          const on = w.days.includes(d);
          return (
            <button
              key={d}
              type="button"
              aria-pressed={on}
              onClick={() => toggle(d)}
              className={cn('h-8 min-w-11 rounded-full border px-2.5 text-xs font-medium transition-colors', on ? 'border-primary bg-primary text-primary-foreground' : 'hover:bg-muted')}
            >
              {t(WEEKDAY_SHORT[d])}
            </button>
          );
        })}
      </div>
      <div className="flex flex-wrap gap-2 text-xs">
        <button type="button" className="text-primary hover:underline" onClick={() => preset([0, 1, 2, 3, 4, 5, 6])}>
          {t('Every day')}
        </button>
        <button type="button" className="text-primary hover:underline" onClick={() => preset([1, 2, 3, 4, 5])}>
          {t('Mon–Fri')}
        </button>
        <button type="button" className="text-primary hover:underline" onClick={() => preset([0, 6])}>
          {t('Weekend')}
        </button>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="space-y-1 text-xs">
          <span className="text-muted-foreground">{t('From')}</span>
          <Input type="time" className="h-9 w-32" value={formatMinutes(w.startMin)} onChange={(e) => onChange({ ...w, startMin: toMin(e.target.value) })} />
        </label>
        <label className="space-y-1 text-xs">
          <span className="text-muted-foreground">{t('To')}</span>
          <Input type="time" className="h-9 w-32" value={formatMinutes(w.endMin)} onChange={(e) => onChange({ ...w, endMin: toMin(e.target.value) })} />
        </label>
        {w.endMin <= w.startMin && <span className="pb-2 text-xs text-muted-foreground">{t('Ends the next morning')}</span>}
        <Button type="button" variant="ghost" size="icon-sm" className="ms-auto" onClick={onRemove} aria-label={t('Remove time window')}>
          <Trash2Icon />
        </Button>
      </div>
    </div>
  );
}

function ScheduleDialog({ rows, onClose }: { rows: ParkingRowDto[]; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const first = rows[0]?.schedule;
  const [enabled, setEnabled] = useState(first?.enabled ?? true);
  const [alarmAllAlerts, setAlarmAllAlerts] = useState(first?.alarmAllAlerts ?? true);
  const [windows, setWindows] = useState<ParkingWindowDto[]>(first?.windows.length ? first.windows : [{ days: [1, 2, 3, 4, 5], startMin: 22 * 60, endMin: 6 * 60 }]);
  const error = parkingScheduleError({ enabled, windows, alarmAllAlerts });
  const save = useMutation({
    mutationFn: () => api.put<ParkingRowDto[]>('/parking-mode', { objectIds: rows.map((r) => r.objectId), enabled, windows, alarmAllAlerts }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: QUERY_KEY });
      toast.success(enabled ? t('Parking mode saved') : t('Parking mode switched off'));
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{rows.length === 1 ? t('Parking mode: {{name}}', { name: rows[0].name }) : t('Parking mode for {{n}} vehicles', { n: rows.length })}</DialogTitle>
          <DialogDescription>{t('While armed, starting or moving the vehicle sounds a loud alarm on the web and in the VeeTrax app for everyone who can see it.')}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <label className="flex items-center justify-between gap-3 rounded-lg border p-3">
            <span>
              <span className="block text-sm font-medium">{t('Parking mode on')}</span>
              <span className="block text-xs text-muted-foreground">{t('Armed during the times below, every week')}</span>
            </span>
            <Switch checked={enabled} onCheckedChange={setEnabled} />
          </label>
          <div className={cn('space-y-3', !enabled && 'pointer-events-none opacity-50')}>
            {windows.map((w, i) => (
              <WindowEditor key={i} w={w} onChange={(n) => setWindows(windows.map((x, j) => (j === i ? n : x)))} onRemove={() => setWindows(windows.filter((_, j) => j !== i))} />
            ))}
            {windows.length < 10 && (
              <Button type="button" variant="outline" size="sm" onClick={() => setWindows([...windows, { days: [0, 6], startMin: 0, endMin: 0 }])}>
                <PlusIcon /> {t('Add time window')}
              </Button>
            )}
            <label className="flex items-center justify-between gap-3 rounded-lg border p-3">
              <span>
                <span className="block text-sm font-medium">{t('Alarm for every alert')}</span>
                <span className="block text-xs text-muted-foreground">{t('Off: only the parking breach sounds the alarm; other alerts notify as usual.')}</span>
              </span>
              <Switch checked={alarmAllAlerts} onCheckedChange={setAlarmAllAlerts} />
            </label>
          </div>
          {error && <p className="text-sm text-destructive">{t(error)}</p>}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button onClick={() => save.mutate()} disabled={!!error || save.isPending}>
            {save.isPending && <Spinner />} {t('Save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Parking mode (spy mode): weekly armed windows per vehicle; a breach or any alert while armed rings as an alarm. */
export function ParkingModePage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const canEdit = can('parking_mode', 'edit');
  const list = useQuery({ queryKey: QUERY_KEY, queryFn: ({ signal }) => api.get<ParkingRowDto[]>('/parking-mode', undefined, signal), refetchInterval: 60_000 });
  const [q, setQ] = useState('');
  const search = useDeferredValue(q.trim().toLowerCase());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<ParkingRowDto[] | null>(null);
  const rows = useMemo(
    () => (list.data ?? []).filter((r) => !search || `${r.name} ${r.plateNumber ?? ''}`.toLowerCase().includes(search)),
    [list.data, search],
  );
  const armed = (list.data ?? []).filter((r) => r.armedUntil).length;
  const toggle = (id: string) => setSelected((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <PageHeader
        title={t('Parking mode')}
        description={t('Arm vehicles at set times (for example overnight). Starting or moving an armed vehicle sounds a loud alarm, also through Do Not Disturb on phones.')}
        actions={
          canEdit && selected.size > 0 ? (
            <Button onClick={() => setEditing((list.data ?? []).filter((r) => selected.has(r.objectId)))}>
              <CalendarClockIcon /> {t('Set schedule for {{n}} selected', { n: selected.size })}
            </Button>
          ) : undefined
        }
      />
      <Card className="flex items-start gap-3 border-amber-500/40 bg-amber-500/5 p-3 text-sm">
        <BellRingIcon className="mt-0.5 size-4 shrink-0 text-amber-600" />
        <p>
          {t('Armed now: {{n}}.', { n: armed })} {t('Alarms ring in this browser while a VeeTrax tab is open. On phones, open the VeeTrax app once and allow alarms to override Do Not Disturb (More → Parking mode → Alarm on this phone).')}
        </p>
      </Card>
      <div className="relative max-w-sm">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Search vehicle or plate')} className="pl-8" aria-label={t('Search vehicle or plate')} />
      </div>
      <Card className="overflow-hidden p-0">
        {list.isPending ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : !rows.length ? (
          <EmptyState icon={ShieldOffIcon} title={t('No vehicles')} description={t('Vehicles you can see are listed here.')} />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                {canEdit && (
                  <TableHead className="w-10">
                    <Checkbox
                      checked={rows.length > 0 && rows.every((r) => selected.has(r.objectId))}
                      onCheckedChange={(on) => setSelected(on ? new Set(rows.map((r) => r.objectId)) : new Set())}
                      aria-label={t('Select all')}
                    />
                  </TableHead>
                )}
                <TableHead>{t('Vehicle')}</TableHead>
                <TableHead>{t('Schedule')}</TableHead>
                <TableHead>{t('Status')}</TableHead>
                <TableHead className="hidden md:table-cell">{t('Alarm for')}</TableHead>
                <TableHead className="w-16 text-right">{t('Edit')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.objectId}>
                  {canEdit && (
                    <TableCell>
                      <Checkbox checked={selected.has(r.objectId)} onCheckedChange={() => toggle(r.objectId)} aria-label={t('Select {{name}}', { name: r.name })} />
                    </TableCell>
                  )}
                  <TableCell>
                    <div className="font-medium">{r.name}</div>
                    {r.plateNumber && r.plateNumber !== r.name && <div className="text-xs text-muted-foreground">{r.plateNumber}</div>}
                  </TableCell>
                  <TableCell className="text-sm">
                    {r.schedule?.windows.length ? (
                      <div className={cn('space-y-0.5', !r.schedule.enabled && 'text-muted-foreground line-through')}>
                        {r.schedule.windows.map((w, i) => (
                          <div key={i} className="tabular-nums">
                            {windowLabel(w, t)}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <span className="text-muted-foreground">{t('Not set')}</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <StateBadge row={r} />
                  </TableCell>
                  <TableCell className="hidden text-sm text-muted-foreground md:table-cell">
                    {r.schedule ? (r.schedule.alarmAllAlerts ? t('Every alert') : t('Breach only')) : '—'}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button variant="ghost" size="icon-sm" disabled={!canEdit} onClick={() => setEditing([r])} aria-label={t('Schedule for {{name}}', { name: r.name })} title={t('Schedule')}>
                      <CalendarClockIcon />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
      {editing && (
        <ScheduleDialog
          rows={editing}
          onClose={() => {
            setEditing(null);
            setSelected(new Set());
          }}
        />
      )}
    </div>
  );
}

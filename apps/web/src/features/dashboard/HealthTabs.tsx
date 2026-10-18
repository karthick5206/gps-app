import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CLOCK_SKEW_LIMIT_SEC, type DashboardHealth, type VehicleHealthRow, type VehicleRemarkDto } from '@veetracer/shared';
import { MessageSquarePlusIcon, RefreshCwIcon, ShieldCheckIcon } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { FormError } from '@/components/form-error';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Field } from '@/components/ui/field';
import { Input, Textarea } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { useAuth } from '@/features/auth/auth-context';
import { DEVICE_STATUS_META, type ReportColumn, type Row } from '@/features/reports/report-columns';
import { ReportTable } from '@/features/reports/ReportTable';
import { api, errorMessage } from '@/lib/api';
import { formatDateTime, formatDuration } from '@/lib/format';
import { i18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { BarList } from './charts';

const DAY = 86_400;

function useHealth(inactiveAfterMin: number) {
  return useQuery({
    queryKey: ['dashboard-health', inactiveAfterMin],
    queryFn: ({ signal }) => api.get<DashboardHealth>('/dashboard/health', { inactiveAfterMin }, signal),
    refetchInterval: 120_000,
  });
}

const inMaintenance = (r: VehicleHealthRow) => r.maintenanceSince !== null;
const wrongClock = (r: VehicleHealthRow) => !inMaintenance(r) && r.clockSkewSec !== null && Math.abs(r.clockSkewSec) > CLOCK_SKEW_LIMIT_SEC;
/** Problem buckets leave out vehicles in maintenance (they have their own bucket). */
const issue = (status: VehicleHealthRow['status']) => (r: VehicleHealthRow) => r.status === status && !inMaintenance(r);
const fmtSkew = (sec: number | null) => (sec === null ? '—' : `${sec > 0 ? '+' : '−'}${formatDuration(Math.abs(sec))}`);

// ── Shared columns ────────────────────────────────────────────────────────────

const timeCol = (id: 'lastSeenAt' | 'lastFixTime', header: string): ReportColumn => ({
  id,
  header,
  value: (r) => (r[id] ? Date.parse(r[id] as string) : null),
  render: (r) => <span className="tabular-nums">{formatDateTime(r[id] as string | null)}</span>,
});

function baseColumns(onRemark: ((row: VehicleHealthRow) => void) | null): ReportColumn[] {
  return [
    { id: 'name', header: 'Vehicle', value: (r) => r.name as string, render: (r) => <span className="font-medium">{r.name as string}</span> },
    { id: 'plateNumber', header: 'Plate', value: (r) => (r.plateNumber as string) ?? null },
    {
      id: 'status',
      header: 'Status',
      value: (r) => r.status as string,
      render: (r) => {
        const m = DEVICE_STATUS_META[r.status as string];
        return <Badge variant={m?.variant ?? 'secondary'}>{m ? i18n.t(m.label) : (r.status as string)}</Badge>;
      },
    },
    { id: 'uniqueId', header: 'IMEI', value: (r) => (r.uniqueId as string) ?? null, render: (r) => <span className="font-mono text-xs">{(r.uniqueId as string) ?? '—'}</span> },
    timeCol('lastSeenAt', 'Last data'),
    timeCol('lastFixTime', 'Last GPS fix'),
    { id: 'inactiveSec', header: 'No data for', value: (r) => (r.inactiveSec as number) ?? null, numeric: true, format: (v) => formatDuration(v) },
    {
      id: 'remark',
      header: 'Remark',
      value: (r) => (r.remark as VehicleRemarkDto | null)?.note ?? null,
      render: (r) => {
        const remark = r.remark as VehicleRemarkDto | null;
        return (
          <div className="flex max-w-80 items-center gap-1.5">
            {remark ? (
              <span className="min-w-0 truncate text-xs" title={`${remark.note} — ${remark.createdByName ?? i18n.t('someone')}, ${formatDateTime(remark.createdAt)}`}>
                {remark.note}
              </span>
            ) : (
              <span className="text-xs text-muted-foreground">—</span>
            )}
            {onRemark && (
              <Button size="icon" variant="ghost" className="size-7 shrink-0" aria-label={i18n.t('Remarks for {{name}}', { name: r.name as string })} onClick={() => onRemark(r as unknown as VehicleHealthRow)}>
                <MessageSquarePlusIcon className="size-4" />
              </Button>
            )}
          </div>
        );
      },
    },
  ];
}

const extra = {
  skew: { id: 'clockSkewSec', header: 'Clock off by', value: (r: Row) => (r.clockSkewSec as number) ?? null, render: (r: Row) => <span className="font-medium text-warning tabular-nums">{fmtSkew(r.clockSkewSec as number | null)}</span> } as ReportColumn,
  km: { id: 'todayDistanceKm', header: 'Today (km)', value: (r: Row) => r.todayDistanceKm as number, numeric: true, format: (v: number) => v.toFixed(1) } as ReportColumn,
  battery: {
    id: 'batteryLevel',
    header: 'Battery',
    value: (r: Row) => (r.batteryLevel as number) ?? null,
    numeric: true,
    render: (r: Row) => (r.batteryLevel === null ? <span className="text-muted-foreground">—</span> : <span className={cn('tabular-nums', (r.batteryLevel as number) < 25 && 'font-medium text-destructive')}>{r.batteryLevel as number}%</span>),
  } as ReportColumn,
  volt: { id: 'extVoltage', header: 'Ext. V', value: (r: Row) => (r.extVoltage as number) ?? null, numeric: true, format: (v: number) => v.toFixed(2) } as ReportColumn,
  model: { id: 'model', header: 'Model', value: (r: Row) => (r.model as string) ?? null } as ReportColumn,
  sim: { id: 'simNumber', header: 'SIM', value: (r: Row) => (r.simNumber as string) ?? null } as ReportColumn,
};

// ── Remarks dialog ────────────────────────────────────────────────────────────

function RemarksDialog({ row, onClose }: { row: VehicleHealthRow | null; onClose: () => void }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const [note, setNote] = useState('');
  const history = useQuery({
    queryKey: ['vehicle-remarks', row?.objectId],
    queryFn: ({ signal }) => api.get<VehicleRemarkDto[]>('/dashboard/remarks', { objectId: row!.objectId }, signal),
    enabled: !!row,
  });
  const add = useMutation({
    mutationFn: () => api.post<VehicleRemarkDto>('/dashboard/remarks', { objectId: row!.objectId, note }),
    onSuccess: () => {
      setNote('');
      toast.success(t('Remark added'));
      queryClient.invalidateQueries({ queryKey: ['vehicle-remarks', row?.objectId] });
      queryClient.invalidateQueries({ queryKey: ['dashboard-health'] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const canAdd = can('objects', 'edit');
  return (
    <Dialog open={!!row} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {t('Remarks')} · {row?.name}
          </DialogTitle>
          <DialogDescription>{t('Support notes for this vehicle, e.g. "SIM recharged" or "device sent for repair".')}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          {canAdd && (
            <Field label={t('New remark')} htmlFor="remark-note">
              <Textarea id="remark-note" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder={t('What was checked or done?')} />
            </Field>
          )}
          <div className="max-h-64 space-y-2 overflow-y-auto">
            {history.isLoading && <Skeleton className="h-16" />}
            {history.data?.length === 0 && <p className="text-sm text-muted-foreground">{t('No remarks yet.')}</p>}
            {history.data?.map((r) => (
              <div key={r.id} className="rounded-lg border p-2.5">
                <p className="text-sm whitespace-pre-wrap">{r.note}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {r.createdByName ?? t('Unknown user')} · {formatDateTime(r.createdAt)}
                </p>
              </div>
            ))}
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('Close')}
          </Button>
          {canAdd && (
            <Button onClick={() => add.mutate()} disabled={!note.trim() || add.isPending}>
              {add.isPending && <Spinner />} {t('Add remark')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Chip filter ───────────────────────────────────────────────────────────────

interface Bucket {
  key: string;
  label: string;
  tone: 'success' | 'warning' | 'destructive' | 'muted' | 'secondary';
  test: (r: VehicleHealthRow) => boolean;
  columns: ReportColumn[];
  hint: string;
}

function BucketView({ buckets, rows, loading, defaultKey, header }: { buckets: Bucket[]; rows: VehicleHealthRow[] | undefined; loading: boolean; defaultKey: string; header?: ReactNode }) {
  const { t } = useTranslation();
  const [active, setActive] = useState(defaultKey);
  const bucket = buckets.find((b) => b.key === active) ?? buckets[0];
  const list = rows?.filter(bucket.test) ?? [];
  return (
    <div className="space-y-4">
      <div role="tablist" aria-label={t('Filter')} className="flex flex-wrap gap-2">
        {buckets.map((b) => {
          const n = rows?.filter(b.test).length;
          const on = b.key === bucket.key;
          return (
            <button
              key={b.key}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => setActive(b.key)}
              className={cn('flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40', on ? 'border-primary bg-accent font-medium' : 'hover:bg-accent/60')}
            >
              {b.label}
              <Badge variant={on ? b.tone : 'muted'}>{n === undefined ? '…' : n}</Badge>
            </button>
          );
        })}
      </div>
      {header}
      <p className="text-xs text-muted-foreground">{bucket.hint}</p>
      <Card className="overflow-hidden">
        {loading ? (
          <Skeleton className="h-64" />
        ) : list.length ? (
          <ReportTable key={bucket.key} columns={bucket.columns} rows={list as unknown as Row[]} />
        ) : (
          <EmptyState icon={ShieldCheckIcon} title={t('Nothing here')} description={t('No vehicles match this filter right now.')} />
        )}
      </Card>
    </div>
  );
}

function ThresholdBar({ value, onChange, fetching, onRefresh, generatedAt }: { value: number; onChange: (v: number) => void; fetching: boolean; onRefresh: () => void; generatedAt?: string }) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(String(value));
  const apply = () => {
    const n = Math.round(Number(draft));
    if (Number.isFinite(n) && n >= 5 && n <= 43_200) onChange(n);
    else setDraft(String(value));
  };
  return (
    <div className="flex flex-wrap items-end gap-3">
      <Field label={t('Inactive after (minutes)')} htmlFor="h-inactive" className="w-48">
        <Input id="h-inactive" type="number" min={5} max={43_200} value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={apply} onKeyDown={(e) => e.key === 'Enter' && apply()} />
      </Field>
      <Button variant="outline" onClick={onRefresh} disabled={fetching}>
        {fetching ? <Spinner /> : <RefreshCwIcon />} {t('Refresh')}
      </Button>
      {generatedAt && <p className="pb-2 text-xs text-muted-foreground">{t('Updated {{time}}', { time: formatDateTime(generatedAt) })}</p>}
    </div>
  );
}

// ── Criticality ───────────────────────────────────────────────────────────────

export function CriticalityTab() {
  const { t } = useTranslation();
  const [inactiveAfterMin, setInactive] = useState(1440);
  const [remarkFor, setRemarkFor] = useState<VehicleHealthRow | null>(null);
  const health = useHealth(inactiveAfterMin);
  const base = baseColumns(setRemarkFor);
  const [vehicle, plate, status, imei, lastSeen, lastFix, noData, remark] = base;
  const buckets: Bucket[] = [
    { key: 'INACTIVE', label: t('Inactive'), tone: 'destructive', test: issue('INACTIVE'), columns: [vehicle, plate, imei, lastSeen, noData, extra.sim, remark], hint: t('No data for longer than {{duration}}: check power, SIM balance or the device.', { duration: formatDuration(inactiveAfterMin * 60) }) },
    { key: 'NO_GPS', label: t('No GPS'), tone: 'warning', test: issue('NO_GPS'), columns: [vehicle, plate, imei, lastSeen, lastFix, extra.volt, remark], hint: t('Device is sending data but has no valid GPS fix for 6 hours: antenna, indoor parking or GPS fault.') },
    { key: 'WRONG_TIME', label: t('Wrong time zone'), tone: 'warning', test: wrongClock, columns: [vehicle, plate, imei, extra.skew, lastSeen, extra.model, remark], hint: t('Device clock differs from server time by more than 15 minutes: set the device time zone (e.g. Concox GMT,E,5,30#).') },
    { key: 'NEVER_CONNECTED', label: t('Never connected'), tone: 'muted', test: issue('NEVER_CONNECTED'), columns: [vehicle, plate, imei, extra.model, extra.sim, remark], hint: t('Device registered but no data has ever arrived: check server IP/port, APN and the IMEI entered.') },
    {
      key: 'MAINTENANCE',
      label: t('In maintenance'),
      tone: 'warning',
      test: inMaintenance,
      columns: [
        vehicle,
        plate,
        { id: 'maintenanceSince', header: 'Since', value: (r) => (r.maintenanceSince ? Date.parse(r.maintenanceSince as string) : null), render: (r) => <span className="tabular-nums">{formatDateTime(r.maintenanceSince as string)}</span> },
        { id: 'maintenanceNote', header: 'Note', value: (r) => (r.maintenanceNote as string) ?? null },
        lastSeen,
        remark,
      ],
      hint: t('Vehicles marked as in maintenance from the live map: alerts are paused until maintenance ends.'),
    },
    { key: 'NO_DEVICE', label: t('No device'), tone: 'secondary', test: (r) => r.status === 'NO_DEVICE', columns: [vehicle, plate, remark], hint: t('Vehicle has no tracker assigned.') },
    { key: 'ACTIVE', label: t('Active'), tone: 'success', test: (r) => r.status === 'ACTIVE', columns: [vehicle, plate, status, lastSeen, lastFix, extra.battery, remark], hint: t('Reporting normally.') },
  ];
  return (
    <div className="space-y-4">
      {health.isError && <FormError message={errorMessage(health.error)} />}
      <BucketView
        buckets={buckets}
        rows={health.data?.rows}
        loading={health.isLoading}
        defaultKey="INACTIVE"
        header={<ThresholdBar value={inactiveAfterMin} onChange={setInactive} fetching={health.isFetching} onRefresh={() => health.refetch()} generatedAt={health.data?.generatedAt} />}
      />
      <RemarksDialog row={remarkFor} onClose={() => setRemarkFor(null)} />
    </div>
  );
}

// ── Device health ─────────────────────────────────────────────────────────────

const BATTERY_BANDS = [
  { key: '0-25', label: 'Below 25%', test: (b: number) => b < 25 },
  { key: '25-50', label: '25–50%', test: (b: number) => b >= 25 && b < 50 },
  { key: '50-75', label: '50–75%', test: (b: number) => b >= 50 && b < 75 },
  { key: '75-100', label: '75–100%', test: (b: number) => b >= 75 },
];

export function DeviceHealthTab() {
  const { t } = useTranslation();
  const [remarkFor, setRemarkFor] = useState<VehicleHealthRow | null>(null);
  const health = useHealth(1440);
  const [vehicle, plate, , imei, lastSeen, , noData, remark] = baseColumns(setRemarkFor);
  const rows = health.data?.rows;
  const reporting = (r: VehicleHealthRow) => r.status === 'ACTIVE' || r.status === 'NO_GPS';
  const buckets: Bucket[] = [
    { key: 'IN24', label: t('Inactive > 24 h'), tone: 'warning', test: (r) => (r.inactiveSec ?? 0) > DAY, columns: [vehicle, plate, imei, lastSeen, noData, extra.battery, remark], hint: t('No data for more than a day.') },
    { key: 'IN72', label: t('Inactive > 3 days'), tone: 'destructive', test: (r) => (r.inactiveSec ?? 0) > 3 * DAY, columns: [vehicle, plate, imei, lastSeen, noData, extra.battery, remark], hint: t('No data for more than three days: likely removed, unpowered or SIM expired.') },
    { key: 'LOW_MOVE', label: t('Moved < 5 km today'), tone: 'secondary', test: (r) => reporting(r) && r.todayDistanceKm < 5, columns: [vehicle, plate, extra.km, lastSeen, extra.battery, remark], hint: t('Online vehicles that barely moved today (under-used or parked).') },
    { key: 'MOVE', label: t('Moved ≥ 5 km today'), tone: 'success', test: (r) => reporting(r) && r.todayDistanceKm >= 5, columns: [vehicle, plate, extra.km, lastSeen, extra.battery, remark], hint: t('Online vehicles in use today.') },
    { key: 'BAT_LOW', label: t('Battery < 25%'), tone: 'destructive', test: (r) => r.batteryLevel !== null && r.batteryLevel < 25, columns: [vehicle, plate, imei, extra.battery, extra.volt, lastSeen, remark], hint: t('Device backup battery low: check the vehicle power connection.') },
    { key: 'BAT_OK', label: t('Battery ≥ 25%'), tone: 'success', test: (r) => r.batteryLevel !== null && r.batteryLevel >= 25, columns: [vehicle, plate, imei, extra.battery, extra.volt, lastSeen], hint: t('Battery level reported and healthy.') },
  ];
  const inactiveRows = rows?.filter((r) => (r.inactiveSec ?? 0) > DAY && r.batteryLevel !== null) ?? [];
  return (
    <div className="space-y-4">
      {health.isError && <FormError message={errorMessage(health.error)} />}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="space-y-3 p-4">
          <h2 className="text-sm font-semibold">{t('Battery of all devices')}</h2>
          {rows ? (
            <BarList
              items={[
                ...BATTERY_BANDS.map((b) => ({ key: b.key, label: t(b.label), value: rows.filter((r) => r.batteryLevel !== null && b.test(r.batteryLevel)).length })),
                { key: 'unknown', label: t('Not reported'), value: rows.filter((r) => r.batteryLevel === null).length },
              ]}
              format={(v) => t('{{count}} vehicles', { count: v })}
              empty={t('No vehicles.')}
            />
          ) : (
            <Skeleton className="h-36" />
          )}
        </Card>
        <Card className="space-y-3 p-4">
          <h2 className="text-sm font-semibold">{t('Battery of inactive devices (no data > 24 h)')}</h2>
          {rows ? (
            <BarList
              items={BATTERY_BANDS.map((b) => ({ key: b.key, label: t(b.label), value: inactiveRows.filter((r) => b.test(r.batteryLevel!)).length }))}
              format={(v) => t('{{count}} vehicles', { count: v })}
              empty={t('No inactive devices with a known battery level.')}
              color="var(--destructive)"
            />
          ) : (
            <Skeleton className="h-36" />
          )}
        </Card>
      </div>
      <BucketView buckets={buckets} rows={rows} loading={health.isLoading} defaultKey="IN24" />
      <RemarksDialog row={remarkFor} onClose={() => setRemarkFor(null)} />
    </div>
  );
}

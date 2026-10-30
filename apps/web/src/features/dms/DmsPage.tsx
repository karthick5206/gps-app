import { useMutation, useQuery } from '@tanstack/react-query';
import { DMS_COLUMNS, dmsTotal, type DmsCounts, type DmsPeriod, type DmsSummaryDto } from '@veetracer/shared';
import { DownloadIcon, ScanEyeIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Combobox } from '@/components/ui/multi-select';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useAuth } from '@/features/auth/auth-context';
import { BarList, Donut } from '@/features/dashboard/charts';
import { named, useEntityOptions } from '@/features/masters/use-options';
import { api, downloadFile, errorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';

const dayKey = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);

/** DMS dashboard: driver-monitoring and harsh-driving events per vehicle, with type and day-by-day charts. */
export function DmsPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const vehicles = useEntityOptions<{ id: string; name: string }>('/objects', named);
  const [period, setPeriod] = useState<DmsPeriod>('today');
  const [from, setFrom] = useState(() => dayKey(new Date(Date.now() - 6 * 86_400_000)));
  const [to, setTo] = useState(() => dayKey(new Date()));
  const [objectId, setObjectId] = useState<string | null>(null);
  const params = { period, ...(period === 'custom' ? { from, to } : {}), ...(objectId ? { objectId } : {}) };
  const customOk = period !== 'custom' || (!!from && !!to && from <= to);
  const q = useQuery({
    queryKey: ['dms', params],
    queryFn: ({ signal }) => api.get<DmsSummaryDto>('/dms', params, signal),
    enabled: customOk,
  });
  const csv = useMutation({
    mutationFn: () => downloadFile(`/dms?${new URLSearchParams({ ...params, format: 'csv' })}`, 'dms.csv'),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const s = q.data;
  const total = s ? dmsTotal(s.totals) : 0;

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <PageHeader
        title={t('DMS dashboard')}
        description={t('Driver monitoring (cabin camera) and harsh driving events for each vehicle.')}
        actions={
          <>
            <Combobox className="w-56" value={objectId} onChange={setObjectId} options={vehicles.options} loading={vehicles.loading} placeholder={t('All vehicles')} />
            <Select value={period} onValueChange={(v) => setPeriod(v as DmsPeriod)}>
              <SelectTrigger className="w-36" aria-label={t('Period')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="today">{t('Today')}</SelectItem>
                <SelectItem value="week">{t('This week')}</SelectItem>
                <SelectItem value="month">{t('This month')}</SelectItem>
                <SelectItem value="custom">{t('Custom range')}</SelectItem>
              </SelectContent>
            </Select>
            {period === 'custom' && (
              <div className="flex items-center gap-1.5">
                <Input type="date" className="w-38" value={from} max={to} onChange={(e) => setFrom(e.target.value)} aria-label={t('From')} />
                <span className="text-muted-foreground">–</span>
                <Input type="date" className="w-38" value={to} min={from} max={dayKey(new Date())} onChange={(e) => setTo(e.target.value)} aria-label={t('To')} />
              </div>
            )}
            {can('dms', 'export') && (
              <Button variant="outline" onClick={() => csv.mutate()} disabled={!s?.rows.length || csv.isPending}>
                <DownloadIcon /> CSV
              </Button>
            )}
          </>
        }
      />

      {q.isError && <p className="text-sm text-destructive">{errorMessage(q.error)}</p>}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-8">
        {DMS_COLUMNS.map((c) => (
          <Card key={c.key} className="relative overflow-hidden p-3">
            <span className="absolute inset-y-0 left-0 w-1" style={{ backgroundColor: c.color }} />
            <div className="text-xs leading-tight text-muted-foreground">{t(c.label)}</div>
            <div className="mt-1 text-2xl font-bold tabular-nums">{s ? s.totals[c.key] : <Skeleton className="h-7 w-10" />}</div>
          </Card>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-5">
        <Card className="p-4 lg:col-span-3">
          <p className="mb-3 text-sm font-semibold">{t('Events per day')}</p>
          {s ? <DailyChart daily={s.daily} /> : <Skeleton className="h-48" />}
        </Card>
        <Card className="p-4 lg:col-span-2">
          {s ? (
            <Donut title={t('By event type')} centerLabel={t('events')} slices={DMS_COLUMNS.map((c) => ({ key: c.key, label: t(c.label), value: s.totals[c.key], color: c.color }))} />
          ) : (
            <Skeleton className="h-40" />
          )}
        </Card>
      </div>

      {!objectId && s && s.rows.length > 1 && (
        <Card className="p-4">
          <p className="mb-3 text-sm font-semibold">{t('Vehicles with the most events')}</p>
          <BarList items={s.rows.slice(0, 10).map((r) => ({ key: r.objectId, label: r.name, sub: r.plateNumber !== r.name ? r.plateNumber : null, value: r.total }))} format={(v) => String(v)} empty="" color="var(--destructive)" />
        </Card>
      )}

      <Card className="overflow-hidden p-0">
        {q.isPending && customOk ? (
          <Skeleton className="m-4 h-24" />
        ) : !s?.rows.length ? (
          <EmptyState icon={ScanEyeIcon} title={t('No DMS or harsh driving events in this period')} description={t('Events appear here when a dashcam with driver monitoring, or a tracker with harsh driving detection, reports them.')} />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="sticky left-0 bg-card">{t('Vehicle Number')}</TableHead>
                  {DMS_COLUMNS.map((c) => (
                    <TableHead key={c.key} className="text-right whitespace-nowrap">
                      {t(c.label)}
                    </TableHead>
                  ))}
                  <TableHead className="text-right">{t('Total')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {s.rows.map((r) => (
                  <TableRow key={r.objectId} className={cn(!objectId && 'cursor-pointer')} onClick={() => !objectId && setObjectId(r.objectId)} title={objectId ? undefined : t('Show this vehicle only')}>
                    <TableCell className="sticky left-0 bg-card font-medium whitespace-nowrap">
                      {r.plateNumber || r.name}
                      {r.plateNumber && r.plateNumber !== r.name && <span className="ml-1.5 text-xs text-muted-foreground">{r.name}</span>}
                    </TableCell>
                    <CountCells counts={r.counts} />
                    <TableCell className="text-right font-semibold tabular-nums">{r.total}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
              {s.rows.length > 1 && (
                <tfoot className="border-t bg-muted/50">
                  <TableRow>
                    <TableCell className="sticky left-0 bg-muted font-semibold">{t('Total')}</TableCell>
                    <CountCells counts={s.totals} />
                    <TableCell className="text-right font-bold tabular-nums">{total}</TableCell>
                  </TableRow>
                </tfoot>
              )}
            </Table>
          </div>
        )}
      </Card>
      <p className="text-xs text-muted-foreground">
        {t('Dashcams report yawning and eyes closing together as one fatigue alarm, so they share a column.')} {s && t('{{count}} vehicles checked.', { count: s.vehicles })}
      </p>
    </div>
  );
}

function CountCells({ counts }: { counts: DmsCounts }) {
  return DMS_COLUMNS.map((c) => (
    <TableCell key={c.key} className={cn('text-right tabular-nums', !counts[c.key] && 'text-muted-foreground/60')}>
      {counts[c.key]}
    </TableCell>
  ));
}

/** Stacked columns per day, one colour per event type. */
function DailyChart({ daily }: { daily: DmsSummaryDto['daily'] }) {
  const { t, i18n } = useTranslation();
  const max = Math.max(1, ...daily.map((d) => dmsTotal(d.counts)));
  const H = 160;
  const fmt = new Intl.DateTimeFormat(i18n.language, { day: 'numeric', month: 'short', timeZone: 'UTC' });
  const label = (day: string) => fmt.format(new Date(`${day}T00:00:00Z`));
  const every = Math.ceil(daily.length / 10);
  if (daily.every((d) => !dmsTotal(d.counts))) return <p className="py-14 text-center text-sm text-muted-foreground">{t('No events')}</p>;
  return (
    <div>
      <div className="flex items-end gap-1" style={{ height: H }} role="img" aria-label={t('Events per day')}>
        {daily.map((d) => {
          const sum = dmsTotal(d.counts);
          return (
            <div key={d.day} className="flex h-full min-w-0 flex-1 flex-col justify-end" title={`${label(d.day)}: ${sum}\n${DMS_COLUMNS.filter((c) => d.counts[c.key]).map((c) => `${t(c.label)}: ${d.counts[c.key]}`).join('\n')}`}>
              {sum > 0 && <div className="mb-0.5 text-center text-[10px] text-muted-foreground tabular-nums">{sum}</div>}
              <div className="flex flex-col-reverse overflow-hidden rounded-t" style={{ height: `${(sum / max) * (H - 16)}px` }}>
                {DMS_COLUMNS.map((c) => (d.counts[c.key] ? <div key={c.key} style={{ height: `${(d.counts[c.key] / sum) * 100}%`, backgroundColor: c.color }} /> : null))}
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-1 flex gap-1 border-t pt-1">
        {daily.map((d, i) => (
          <div key={d.day} className="min-w-0 flex-1 truncate text-center text-[10px] text-muted-foreground">
            {i % every === 0 ? label(d.day) : ''}
          </div>
        ))}
      </div>
    </div>
  );
}

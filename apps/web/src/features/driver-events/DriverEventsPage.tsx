import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  DRIVER_EVENT_STATUSES,
  DRIVER_EVENT_TYPES,
  type DriverDto,
  type DriverEventDto,
  type DriverEventStatsDto,
  type Paginated,
  type TrackedObjectDto,
} from '@veetracer/shared';
import { ChevronLeftIcon, ChevronRightIcon, DownloadIcon, GaugeIcon, ImageIcon, ScanFaceIcon, SettingsIcon, XIcon } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { FormError } from '@/components/form-error';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Combobox, type Option } from '@/components/ui/multi-select';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAuth } from '@/features/auth/auth-context';
import { AlertTypeIcon } from '@/features/alerts/alert-icons';
import { DateRangePicker, rangeFromPreset, type DateRangeValue } from '@/features/alerts/DateRangePicker';
import { named, useEntityOptions } from '@/features/masters/use-options';
import { api, buildQuery, downloadFile, errorMessage, type QueryParams } from '@/lib/api';
import { formatDateTime, relativeTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { neighbours, scoreTone, STATUS_LABEL } from './driver-event-utils';
import { DriverEventDetail, EventStatusBadge } from './DriverEventDetail';
import { DriverEventSettingsDialog } from './DriverEventSettingsDialog';
import { EventThumbnail } from './EventMedia';
import { eventLabel, eventSeverity } from './use-driver-events';

const ALL = '__all';
const PAGE_SIZE = 24;
const objectOption = (o: TrackedObjectDto): Option => ({ value: o.id, label: o.name, description: o.plateNumber ?? undefined });

function FilterSelect({ label, value, onChange, options }: { label: string; value: string | null; onChange: (v: string | null) => void; options: Option[] }) {
  const { t } = useTranslation();
  return (
    <Select value={value ?? ALL} onValueChange={(v) => onChange(v === ALL ? null : v)}>
      <SelectTrigger className="h-9 w-auto min-w-[8.5rem]" aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>{t('All {{label}}', { label: label.toLowerCase() })}</SelectItem>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function StatCard({ label, value, icon: Icon, children }: { label: string; value: number | string | null; icon: typeof GaugeIcon; children?: React.ReactNode }) {
  return (
    <Card className="gap-1 p-4">
      <div className="flex items-center justify-between text-sm text-muted-foreground">
        {label}
        <Icon className="size-4" aria-hidden />
      </div>
      <div className="text-2xl font-semibold tabular-nums">{value ?? <Skeleton className="h-8 w-12" />}</div>
      {children}
    </Card>
  );
}

/** One event: snapshot, type, vehicle, driver, time, place, speed, level, review status. */
function EventCard({ e, onOpen }: { e: DriverEventDto; onOpen: () => void }) {
  const { t } = useTranslation();
  return (
    <button type="button" onClick={onOpen} className="group flex flex-col overflow-hidden rounded-xl border bg-card text-left shadow-xs transition hover:border-primary/40 hover:shadow-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
      <EventThumbnail event={e} className="aspect-video w-full" />
      <div className="flex flex-1 flex-col gap-1.5 p-3">
        <div className="flex items-center gap-2">
          <AlertTypeIcon type={e.type} severity={eventSeverity(e.type)} size="sm" />
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{t(eventLabel(e.type))}</span>
          {e.level !== null && <span className="rounded bg-muted px-1.5 text-xs tabular-nums text-muted-foreground">{t('L{{level}}', { level: e.level })}</span>}
        </div>
        <p className="truncate text-sm">
          {e.objectName}
          {e.driverName && <span className="text-muted-foreground">{` · ${e.driverName}`}</span>}
        </p>
        <p className="truncate text-xs text-muted-foreground" title={e.address ?? undefined}>
          {e.address ?? (e.lat !== null ? `${e.lat.toFixed(5)}, ${e.lng?.toFixed(5)}` : t('No location'))}
        </p>
        <div className="mt-auto flex items-center gap-2 pt-1 text-xs text-muted-foreground">
          <span title={formatDateTime(e.occurredAt)}>{relativeTime(e.occurredAt)}</span>
          {e.speedKph !== null && <span className="tabular-nums">{`· ${Math.round(e.speedKph)} km/h`}</span>}
          <span className="flex-1" />
          <EventStatusBadge status={e.status} />
        </div>
      </div>
    </button>
  );
}

/** Drivers by safety score (lowest first) for the selected period. */
function DriversTab({ stats, onPick }: { stats: DriverEventStatsDto | undefined; onPick: (driverId: string) => void }) {
  const { t } = useTranslation();
  if (!stats) return <Skeleton className="h-64 w-full" />;
  if (!stats.drivers.length) return <EmptyState icon={GaugeIcon} title={t('No driver events in this period')} />;
  const tone = { good: 'bg-success', fair: 'bg-warning', poor: 'bg-destructive' } as const;
  return (
    <Card className="divide-y py-0">
      {stats.drivers.map((d) => (
        <button
          key={d.driverId ?? 'none'}
          type="button"
          disabled={!d.driverId}
          onClick={() => d.driverId && onPick(d.driverId)}
          className="flex w-full items-center gap-4 px-4 py-3 text-left text-sm enabled:hover:bg-accent/50"
        >
          <span className="min-w-0 flex-1 truncate font-medium">{d.driverName ?? <span className="text-muted-foreground">{t('No driver assigned')}</span>}</span>
          <span className="w-24 text-right tabular-nums text-muted-foreground">{t('{{count}} event(s)', { count: d.events })}</span>
          <span className="flex w-40 items-center gap-2">
            <span className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
              <span className={cn('block h-full rounded-full', tone[scoreTone(d.score)])} style={{ width: `${d.score}%` }} />
            </span>
            <span className="w-8 text-right font-semibold tabular-nums">{d.score}</span>
          </span>
        </button>
      ))}
    </Card>
  );
}

export function DriverEventsPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState<'events' | 'drivers'>('events');
  const [range, setRange] = useState<DateRangeValue>(() => rangeFromPreset('7d'));
  const [objectId, setObjectId] = useState<string | null>(params.get('objectId'));
  const [driverId, setDriverId] = useState<string | null>(params.get('driverId'));
  const [type, setType] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [photo, setPhoto] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [objectQ, setObjectQ] = useState('');
  const [driverQ, setDriverQ] = useState('');
  const objects = useEntityOptions<TrackedObjectDto>('/objects', objectOption, { q: objectQ, enabled: can('objects') });
  const drivers = useEntityOptions<DriverDto>('/drivers', named, { q: driverQ, enabled: can('drivers') });
  const detailId = params.get('event');

  useEffect(() => setPage(1), [range, objectId, driverId, type, status, photo]);

  const filters: QueryParams = {
    from: range.from.toISOString(),
    to: range.preset === 'custom' || range.preset === 'yesterday' ? range.to.toISOString() : undefined,
    objectId,
    driverId,
    type,
    status,
    hasPhoto: photo,
  };
  const list = useQuery({
    queryKey: ['driver-events', 'list', filters, page],
    queryFn: ({ signal }) => api.get<Paginated<DriverEventDto>>('/driver-events', { ...filters, page, pageSize: PAGE_SIZE }, signal),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });
  const stats = useQuery({
    queryKey: ['driver-events', 'stats', filters],
    queryFn: ({ signal }) => api.get<DriverEventStatsDto>('/driver-events/stats', { ...filters, hasPhoto: undefined }, signal),
    refetchInterval: 60_000,
  });
  const rows = list.data?.items ?? [];
  const total = list.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const ids = useMemo(() => rows.map((r) => r.id), [rows]);
  const { prev, next } = neighbours(ids, detailId);
  const openDetail = (id: string | null) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        if (id) n.set('event', id);
        else n.delete('event');
        return n;
      },
      { replace: true },
    );

  const [exporting, setExporting] = useState(false);
  const exportFile = async (format: 'CSV' | 'XLSX') => {
    setExporting(true);
    try {
      await downloadFile(`/driver-events${buildQuery({ ...filters, format })}`, `driver-events.${format.toLowerCase()}`);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setExporting(false);
    }
  };
  const hasFilters = !!(objectId || driverId || type || status || photo || range.preset !== '7d');
  const clear = () => {
    setRange(rangeFromPreset('7d'));
    setObjectId(null);
    setDriverId(null);
    setType(null);
    setStatus(null);
    setPhoto(null);
  };
  const s = stats.data;
  const typeOptions: Option[] = DRIVER_EVENT_TYPES.map((v) => ({ value: v, label: t(eventLabel(v)) }));

  return (
    <div className="flex w-full flex-col gap-5 p-4 sm:p-6">
      <PageHeader
        title={t('Driver events')}
        description={t('Driver behaviour events from dashcams (fatigue, phone, smoking, collision warnings, crashes) with cabin snapshots.')}
        actions={
          <>
            {can('driver_events', 'export') && (
              <>
                <Button variant="outline" onClick={() => exportFile('XLSX')} disabled={exporting}>
                  {exporting ? <Spinner /> : <DownloadIcon />}
                  {t('Excel')}
                </Button>
                <Button variant="outline" onClick={() => exportFile('CSV')} disabled={exporting}>
                  <DownloadIcon /> {t('CSV')}
                </Button>
              </>
            )}
            {can('settings', 'edit') && (
              <Button variant="outline" size="icon" onClick={() => setSettingsOpen(true)} aria-label={t('Driver event settings')}>
                <SettingsIcon />
              </Button>
            )}
          </>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label={t('Today')} value={s ? s.today : null} icon={ScanFaceIcon} />
        <StatCard label={t('Last 7 days')} value={s ? s.week : null} icon={GaugeIcon} />
        <StatCard label={t('With snapshot (period)')} value={s ? `${s.withPhoto} / ${s.total}` : null} icon={ImageIcon} />
        <Card className="gap-2 p-4">
          <div className="text-sm text-muted-foreground">{t('By type (period)')}</div>
          {!s ? (
            <Skeleton className="h-8 w-full" />
          ) : s.byType.length ? (
            <div className="flex flex-wrap gap-1.5">
              {s.byType.slice(0, 6).map((b) => (
                <button
                  key={b.type}
                  type="button"
                  onClick={() => setType(type === b.type ? null : b.type)}
                  className={cn('flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs hover:bg-accent', type === b.type && 'border-primary bg-primary/8')}
                  title={t(eventLabel(b.type))}
                >
                  <AlertTypeIcon type={b.type} severity={eventSeverity(b.type)} size="sm" className="size-4 [&_svg]:size-3" />
                  <span className="tabular-nums">{b.count}</span>
                </button>
              ))}
            </div>
          ) : (
            <span className="text-sm text-muted-foreground">{t('None')}</span>
          )}
        </Card>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <DateRangePicker value={range} onChange={setRange} />
        {can('objects') && (
          <div className="w-48">
            <Combobox value={objectId} onChange={setObjectId} options={objects.options} loading={objects.loading} onSearch={setObjectQ} placeholder={t('All vehicles')} searchPlaceholder={t('Search vehicles…')} />
          </div>
        )}
        {can('drivers') && (
          <div className="w-48">
            <Combobox value={driverId} onChange={setDriverId} options={drivers.options} loading={drivers.loading} onSearch={setDriverQ} placeholder={t('All drivers')} searchPlaceholder={t('Search drivers…')} />
          </div>
        )}
        <FilterSelect label={t('Types')} value={type} onChange={setType} options={typeOptions} />
        <FilterSelect label={t('Statuses')} value={status} onChange={setStatus} options={DRIVER_EVENT_STATUSES.map((v) => ({ value: v, label: t(STATUS_LABEL[v]) }))} />
        <FilterSelect
          label={t('Snapshots')}
          value={photo}
          onChange={setPhoto}
          options={[
            { value: 'true', label: t('With snapshot') },
            { value: 'false', label: t('Without snapshot') },
          ]}
        />
        {hasFilters && (
          <Button variant="ghost" size="sm" onClick={clear}>
            <XIcon /> {t('Clear')}
          </Button>
        )}
        {list.isFetching && !list.isPending && <Spinner className="text-muted-foreground" />}
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as 'events' | 'drivers')}>
        <TabsList>
          <TabsTrigger value="events">{t('Events')}</TabsTrigger>
          <TabsTrigger value="drivers">{t('Drivers')}</TabsTrigger>
        </TabsList>
        <TabsContent value="events" className="space-y-4 pt-3">
          {list.isError && <FormError message={errorMessage(list.error)} />}
          {list.isPending ? (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
              {Array.from({ length: 8 }, (_, i) => (
                <Skeleton key={i} className="aspect-[4/3] w-full rounded-xl" />
              ))}
            </div>
          ) : rows.length === 0 ? (
            <EmptyState icon={ScanFaceIcon} title={t('No driver events')} description={t('Events appear here when a dashcam reports fatigue, phone use, smoking, collision warnings or a crash.')} />
          ) : (
            <div className={cn('grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4', list.isPlaceholderData && 'opacity-60 transition-opacity')}>
              {rows.map((e) => (
                <EventCard key={e.id} e={e} onOpen={() => openDetail(e.id)} />
              ))}
            </div>
          )}
          {total > PAGE_SIZE && (
            <div className="flex items-center justify-end gap-2 text-sm text-muted-foreground">
              <span>{t('Page {{page}} of {{count}}', { page, count: pageCount })}</span>
              <Button size="icon" variant="outline" disabled={page <= 1} onClick={() => setPage(page - 1)} aria-label={t('Previous page')}>
                <ChevronLeftIcon />
              </Button>
              <Button size="icon" variant="outline" disabled={page >= pageCount} onClick={() => setPage(page + 1)} aria-label={t('Next page')}>
                <ChevronRightIcon />
              </Button>
            </div>
          )}
        </TabsContent>
        <TabsContent value="drivers" className="pt-3">
          {stats.isError && <FormError message={errorMessage(stats.error)} />}
          <DriversTab
            stats={s}
            onPick={(id) => {
              setDriverId(id);
              setTab('events');
            }}
          />
        </TabsContent>
      </Tabs>

      <DriverEventDetail eventId={detailId} initial={rows.find((r) => r.id === detailId) ?? null} onClose={() => openDetail(null)} onNavigate={openDetail} prevId={prev} nextId={next} />
      <DriverEventSettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </div>
  );
}

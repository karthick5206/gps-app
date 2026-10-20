import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ALERT_TYPE_MAP, MOVEMENT_STATUSES, STATUS_META, type AlertTypeCode, type ComplianceSummary, type DashboardOverview, type MovementStatus } from '@veetracer/shared';
import { BellRingIcon, FileClockIcon, FileXIcon, GaugeIcon, RadioTowerIcon, RouteIcon, SigmaIcon, TruckIcon, WrenchIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router';
import { FormError } from '@/components/form-error';
import { Card } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/features/auth/auth-context';
import { liveStore } from '@/features/live/live-store';
import { api, errorMessage } from '@/lib/api';
import { formatDuration } from '@/lib/format';
import { statusColor } from '@/lib/status-tokens';
import { cn } from '@/lib/utils';
import { BarList, Donut, type Slice } from './charts';
import { CountUp } from './CountUp';
import { IoCards } from './IoCards';

const overviewKey = (top: number) => ['dashboard-overview', top] as const;
/** Live batches trigger an overview refetch at most this often. */
const LIVE_REFRESH_MS = 10_000;

function useLiveRefresh() {
  const queryClient = useQueryClient();
  useEffect(() => {
    let last = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = liveStore.subscribe((e) => {
      if (e.type !== 'batch' || timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        last = Date.now();
        queryClient.invalidateQueries({ queryKey: ['dashboard-overview'] });
      }, Math.max(0, LIVE_REFRESH_MS - (Date.now() - last)));
    });
    return () => {
      clearTimeout(timer);
      unsubscribe();
    };
  }, [queryClient]);
}

function StatCard({
  label,
  value,
  total,
  status,
  icon: Icon,
  to,
  suffix,
  hint,
  decimals = 0,
}: {
  label: string;
  value: number | undefined;
  total?: number;
  status?: MovementStatus;
  icon?: typeof TruckIcon;
  to?: string;
  suffix?: string;
  hint?: string;
  decimals?: number;
}) {
  const { t } = useTranslation();
  const pct = total && value !== undefined ? Math.round((value / total) * 100) : null;
  const body = (
    <Card className={cn('group relative h-full overflow-hidden p-4 transition-[box-shadow,border-color]', to && 'hover:border-primary/40 hover:shadow-md')}>
      {status && <span className="absolute inset-x-0 top-0 h-1" style={{ backgroundColor: statusColor(status) }} />}
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
          {status && <span className="size-2.5 rounded-full" style={{ backgroundColor: statusColor(status) }} />}
          {label}
        </p>
        {Icon && <Icon className="size-4 text-muted-foreground" />}
      </div>
      <div className="mt-3 flex items-end justify-between gap-2">
        {value === undefined ? (
          <Skeleton className="h-8 w-16" />
        ) : (
          <p className="text-3xl font-semibold tracking-tight">
            {decimals ? value.toLocaleString(undefined, { maximumFractionDigits: decimals }) : <CountUp value={value} />}
            {suffix && <span className="ml-1 text-base font-medium text-muted-foreground">{suffix}</span>}
          </p>
        )}
        {pct !== null && <p className="pb-1 text-xs text-muted-foreground tabular-nums">{pct}%</p>}
      </div>
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </Card>
  );
  return to ? (
    <Link to={to} className="rounded-xl focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-none" aria-label={`${label}: ${value ?? t('loading')}`}>
      {body}
    </Link>
  ) : (
    body
  );
}

const km = (v: number) => `${v.toLocaleString(undefined, { maximumFractionDigits: 1 })} km`;
const GEOFENCE_FALLBACK = ['#0f766e', '#2563eb', '#d97706', '#9333ea', '#dc2626', '#0891b2', '#65a30d'];

/** Documents expiring / expired and services due (Documents & Service page). */
function ComplianceCards() {
  const { t } = useTranslation();
  const q = useQuery({
    queryKey: ['compliance-summary'],
    queryFn: ({ signal }) => api.get<ComplianceSummary>('/documents/summary', undefined, signal),
    staleTime: 5 * 60_000,
  });
  const c = q.data;
  if (q.isError) return null;
  return (
    <section aria-labelledby="compliance" className="space-y-3">
      <h2 id="compliance" className="text-sm font-semibold text-muted-foreground">
        {t('Documents & service')}
      </h2>
      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        <StatCard label={t('Documents expiring this month')} value={c?.documentsExpiringThisMonth} icon={FileClockIcon} hint={c ? t('{{count}} within their reminder window', { count: c.documentsExpiring }) : undefined} to="/masters/documents" />
        <StatCard label={t('Documents expired')} value={c?.documentsExpired} icon={FileXIcon} to="/masters/documents" />
        <StatCard label={t('Services due soon')} value={c?.servicesDueSoon} icon={WrenchIcon} to="/masters/documents?tab=service" />
        <StatCard label={t('Services overdue')} value={c?.servicesOverdue} icon={WrenchIcon} to="/masters/documents?tab=service" />
      </div>
    </section>
  );
}

export function OverviewTab() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const navigate = useNavigate();
  const canMap = can('live_map');
  const [top, setTop] = useState(5);
  const query = useQuery({
    queryKey: overviewKey(top),
    queryFn: ({ signal }) => api.get<DashboardOverview>('/dashboard/overview', { top }, signal),
    refetchInterval: 60_000,
  });
  useLiveRefresh();
  const d = query.data;
  const s = (k: MovementStatus) => d?.byStatus[k] ?? 0;
  const toLive = canMap ? (key: string) => navigate(`/live?status=${key}`) : undefined;

  const statusSlices: Slice[] = MOVEMENT_STATUSES.map((k) => ({ key: k, label: t(STATUS_META[k].label), value: s(k), color: statusColor(k) }));
  const activitySlices: Slice[] = [
    { key: 'RUNNING', label: t('Moving'), value: s('RUNNING') + s('OVERSPEED'), color: statusColor('RUNNING') },
    { key: 'IDLE', label: t('Idle (engine on)'), value: s('IDLE'), color: statusColor('IDLE') },
    { key: 'OFF', label: t('Parked'), value: s('OFF'), color: statusColor('OFF') },
    { key: 'OFFLINE', label: t('Offline / no data'), value: s('OFFLINE') + s('NO_DATA'), color: statusColor('OFFLINE') },
  ];
  const geofenceSlices: Slice[] = d
    ? [
        ...d.geofences.slice(0, 7).map((g, i) => ({ key: g.geofenceId, label: g.name, value: g.vehicles, color: g.color ?? GEOFENCE_FALLBACK[i % GEOFENCE_FALLBACK.length] })),
        ...(d.geofences.length > 7 ? [{ key: 'more', label: t('{{count}} more geofences', { count: d.geofences.length - 7 }), value: d.geofences.slice(7).reduce((a, g) => a + g.vehicles, 0), color: 'var(--muted-foreground)' }] : []),
        { key: 'outside', label: t('Outside all geofences'), value: Math.max(0, d.total - d.vehiclesInsideGeofences), color: 'var(--border)' },
      ]
    : [];

  return (
    <div className="space-y-6">
      {query.isError && <FormError message={errorMessage(query.error)} />}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3 xl:grid-cols-6">
        <StatCard label={t('Vehicles')} value={d?.total} icon={TruckIcon} to={canMap ? '/live' : undefined} />
        <StatCard label={t('Online now')} value={d?.devicesOnline} total={d?.total} icon={RadioTowerIcon} />
        <StatCard label={t('Distance today')} value={d?.todayDistanceKm} suffix="km" decimals={1} icon={RouteIcon} hint={t('Since midnight')} />
        <StatCard label={t('Trips today')} value={d?.todayTrips} icon={GaugeIcon} />
        <StatCard label={t('Alerts today')} value={d?.todayAlerts.total} icon={BellRingIcon} hint={d ? t('{{count}} critical', { count: d.todayAlerts.critical }) : undefined} to={can('alerts') ? '/alerts' : undefined} />
        <StatCard label={t('Fleet odometer')} value={d?.totalOdometerKm} suffix="km" icon={SigmaIcon} hint={t('Tracked distance + offsets')} />
      </div>

      <section aria-labelledby="by-status" className="space-y-3">
        <h2 id="by-status" className="text-sm font-semibold text-muted-foreground">
          {t('By status')}
        </h2>
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
          {MOVEMENT_STATUSES.map((k) => (
            <StatCard key={k} status={k} label={t(STATUS_META[k].label)} value={d ? s(k) : undefined} total={d?.total} to={canMap ? `/live?status=${k}` : undefined} />
          ))}
        </div>
      </section>

      {d?.io && <IoCards io={d.io} />}

      {can('documents') && <ComplianceCards />}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="p-4">{d ? <Donut title={t('Status distribution')} slices={statusSlices} centerLabel={t('vehicles')} onSelect={toLive} /> : <Skeleton className="h-36" />}</Card>
        <Card className="p-4">{d ? <Donut title={t('Moving vs idle')} slices={activitySlices} centerLabel={t('vehicles')} onSelect={toLive} /> : <Skeleton className="h-36" />}</Card>
        <Card className="p-4">{d ? <Donut title={t('Vehicles by geofence')} slices={geofenceSlices} centerLabel={t('vehicles')} /> : <Skeleton className="h-36" />}</Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {(['top', 'bottom'] as const).map((which) => (
          <Card key={which} className="space-y-3 p-4">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold">{which === 'top' ? t('Most distance today') : t('Least distance today')}</h2>
              {which === 'top' && (
                <Select value={String(top)} onValueChange={(v) => setTop(Number(v))}>
                  <SelectTrigger className="h-8 w-24" aria-label={t('Vehicles to show')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {[5, 10, 20].map((n) => (
                      <SelectItem key={n} value={String(n)}>
                        {t('Top {{n}}', { n })}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
            {d ? (
              <BarList
                items={d[which].map((v) => ({ key: v.objectId, label: v.name, sub: `${v.plateNumber ?? ''}${v.runningSec ? ` · ${t('{{duration}} moving', { duration: formatDuration(v.runningSec) })}` : ''}`, value: v.distanceKm }))}
                format={km}
                empty={t('No vehicles with a device yet.')}
                color={which === 'top' ? 'var(--primary)' : 'var(--muted-foreground)'}
              />
            ) : (
              <Skeleton className="h-40" />
            )}
          </Card>
        ))}
        <Card className="space-y-3 p-4">
          <h2 className="text-sm font-semibold">{t('Alerts today by type')}</h2>
          {d ? (
            <BarList
              items={d.todayAlerts.byType.map((a) => ({ key: a.type, label: t(ALERT_TYPE_MAP[a.type as AlertTypeCode]?.label ?? a.type), value: a.count }))}
              format={(v) => v.toLocaleString()}
              empty={t('No alerts today.')}
              color="var(--warning)"
            />
          ) : (
            <Skeleton className="h-40" />
          )}
        </Card>
      </div>
    </div>
  );
}

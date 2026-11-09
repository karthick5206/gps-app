/**
 * Overview tab, uiRefresh design (flag ON). Same queries, keys, params and polling as the classic OverviewTab
 * (overview + documents summary); only the presentation differs. Every link points at a destination the classic
 * tab already uses.
 */
import { useQuery } from '@tanstack/react-query';
import { ALERT_TYPE_MAP, MOVEMENT_STATUSES, STATUS_META, type AlertTypeCode, type DashboardOverview, type MovementStatus } from '@veetracer/shared';
import {
  BellRingIcon,
  CircleCheckIcon,
  FileClockIcon,
  FileXIcon,
  GaugeIcon,
  MapPinnedIcon,
  RadioTowerIcon,
  RouteIcon,
  SigmaIcon,
  SirenIcon,
  TruckIcon,
  WrenchIcon,
  type LucideIcon,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { FormError } from '@/components/form-error';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/features/auth/auth-context';
import { sharePct } from '@/features/live/StatusCards';
import { api, errorMessage } from '@/lib/api';
import { formatDuration } from '@/lib/format';
import { statusColor, statusTextColor } from '@/lib/status-tokens';
import { cn } from '@/lib/utils';
import type { Slice } from '../charts';
import { GetStartedCard } from '../GetStartedCard';
import { IoCards } from '../IoCards';
import { complianceQuery, GEOFENCE_FALLBACK, km, overviewKey, useLiveRefresh } from '../OverviewTab';
import { DonutR, RankList } from './charts';
import { KpiCard, Panel, STATUS_ICON, tint } from './kit';

/** Wraps children in a Link when there is a destination, otherwise a plain element with the same look. */
function MaybeLink({ to, className, children, label }: { to?: string; className: string; children: ReactNode; label?: string }) {
  return to ? (
    <Link to={to} aria-label={label} className={cn(className, 'focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none')}>
      {children}
    </Link>
  ) : (
    <div className={className}>{children}</div>
  );
}

// ── Needs attention ───────────────────────────────────────────────────────────

interface AttentionItem {
  key: string;
  count: number;
  label: string;
  icon: LucideIcon;
  color: string;
  to?: string;
}

/** Actionable counts the page already has; hidden when everything is zero. */
function NeedsAttention({ items }: { items: AttentionItem[] }) {
  const { t } = useTranslation();
  const live = items.filter((i) => i.count > 0);
  if (!live.length) return null;
  const total = live.reduce((s, i) => s + i.count, 0);
  return (
    <section aria-labelledby="needs-attention" className="flex flex-col gap-2.5 rounded-xl border border-l-4 border-l-[var(--destructive)] bg-card px-4 py-3 shadow-xs sm:flex-row sm:items-center sm:gap-4">
      <h2 id="needs-attention" className="flex shrink-0 items-center gap-2 text-sm font-semibold">
        <SirenIcon className="size-4 text-[var(--destructive-fg)]" aria-hidden />
        {t('Needs attention')}
        <span className="rounded-full bg-[var(--destructive-soft)] px-2 py-0.5 text-xs font-semibold text-[var(--destructive-fg)] tabular-nums">{total.toLocaleString()}</span>
      </h2>
      <ul className="flex flex-wrap gap-2">
        {live.map((i) => (
          <li key={i.key}>
            <MaybeLink
              to={i.to}
              className={cn('flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[13px]', i.to && 'hover:bg-accent')}
              label={`${i.count.toLocaleString()} ${i.label}`}
            >
              <i.icon className="size-3.5 shrink-0" style={{ color: i.color }} aria-hidden />
              <span className="font-semibold tabular-nums">{i.count.toLocaleString()}</span>
              <span className="text-muted-foreground">{i.label}</span>
            </MaybeLink>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ── Fleet status (one widget: bar + six tiles + moving/idle summary) ─────────

function FleetStatus({ d, canMap }: { d: DashboardOverview | undefined; canMap: boolean }) {
  const { t } = useTranslation();
  const s = (k: MovementStatus) => d?.byStatus[k] ?? 0;
  const total = d?.total ?? 0;
  const activity = [
    { key: 'RUNNING', label: t('Moving'), value: s('RUNNING') + s('OVERSPEED'), color: statusColor('RUNNING') },
    { key: 'IDLE', label: t('Idle (engine on)'), value: s('IDLE'), color: statusColor('IDLE') },
    { key: 'OFF', label: t('Parked'), value: s('OFF'), color: statusColor('OFF') },
    { key: 'OFFLINE', label: t('Offline / no data'), value: s('OFFLINE') + s('NO_DATA'), color: statusColor('OFFLINE') },
  ];
  const activityTotal = activity.reduce((a, x) => a + x.value, 0);
  return (
    <Panel
      id="by-status"
      title={t('Fleet status now')}
      subtitle={d ? (canMap ? t('{{count}} vehicles · select a status to open the live map', { count: total }) : t('{{count}} vehicles', { count: total })) : undefined}
      className="h-full"
    >
      {!d ? (
        <div className="space-y-3">
          <Skeleton className="h-3 w-full" />
          <div className="grid grid-cols-3 gap-2 xl:grid-cols-6">
            {MOVEMENT_STATUSES.map((k) => (
              <Skeleton key={k} className="h-20" />
            ))}
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div
            className="flex h-3 w-full gap-0.5 overflow-hidden rounded-full bg-muted"
            role="img"
            aria-label={`${t('Fleet status now')}: ${MOVEMENT_STATUSES.map((k) => `${t(STATUS_META[k].label)} ${s(k)}`).join(', ')}`}
          >
            {MOVEMENT_STATUSES.map((k) => (s(k) ? <span key={k} style={{ flex: s(k), backgroundColor: statusColor(k) }} title={`${t(STATUS_META[k].label)}: ${s(k)}`} /> : null))}
          </div>
          <ul className="grid grid-cols-3 gap-2 sm:gap-3">
            {MOVEMENT_STATUSES.map((k) => {
              const Icon = STATUS_ICON[k];
              const label = t(STATUS_META[k].label);
              const v = s(k);
              return (
                <li key={k} className="min-w-0">
                  <MaybeLink
                    to={canMap ? `/live?status=${k}` : undefined}
                    label={`${label}: ${v}`}
                    className={cn('relative flex h-full min-w-0 flex-col gap-0.5 overflow-hidden rounded-lg border bg-card py-2 pr-2 pl-3 sm:py-3 sm:pr-3 sm:pl-4', canMap && 'hover:shadow-sm motion-safe:transition-shadow')}
                  >
                    <span className="absolute inset-y-0 left-0 w-1" style={{ backgroundColor: statusColor(k) }} aria-hidden />
                    <span className="text-[11px] leading-tight font-semibold sm:text-[13px]" style={{ color: statusTextColor(k) }}>
                      {label}
                    </span>
                    <span className="flex items-center justify-between gap-1">
                      <span className="text-xl leading-tight font-semibold tabular-nums sm:text-2xl">{v.toLocaleString()}</span>
                      <span className="flex size-6 shrink-0 items-center justify-center rounded-md sm:size-7" style={{ backgroundColor: tint(statusColor(k), 16), color: statusTextColor(k) }} aria-hidden>
                        <Icon className="size-3.5" />
                      </span>
                    </span>
                    <span className="hidden h-1 overflow-hidden rounded-full bg-muted sm:mt-1 sm:block" aria-hidden>
                      <span className="block h-full rounded-full" style={{ width: `${v && total ? Math.max((v / total) * 100, 2) : 0}%`, backgroundColor: statusColor(k) }} />
                    </span>
                    <span className="text-[11px] text-muted-foreground tabular-nums sm:text-xs">{t('{{pct}}% of fleet', { pct: sharePct(v, total) })}</span>
                  </MaybeLink>
                </li>
              );
            })}
          </ul>
          <div className="border-t pt-2.5 sm:pt-3">
            <p className="mb-2 text-xs font-medium text-muted-foreground">{t('Moving vs idle')}</p>
            <ul className="grid gap-x-4 gap-y-0 sm:grid-cols-2">
              {activity.map((a) => {
                const pct = activityTotal ? Math.round((a.value / activityTotal) * 100) : 0;
                return (
                  <li key={a.key} className="min-w-0">
                    <MaybeLink to={canMap ? `/live?status=${a.key}` : undefined} label={`${a.label}: ${a.value}`} className={cn('flex items-center gap-2 rounded-md px-1.5 py-1 text-sm', canMap && 'hover:bg-accent')}>
                      <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: a.color }} aria-hidden />
                      <span className="min-w-0 flex-1 break-words">{a.label}</span>
                      <span className="font-semibold tabular-nums">{a.value.toLocaleString()}</span>
                      <span className="w-9 text-right text-xs text-muted-foreground tabular-nums">{pct}%</span>
                    </MaybeLink>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      )}
    </Panel>
  );
}

// ── Compliance (compact) ──────────────────────────────────────────────────────

function Compliance({ c }: { c: ReturnType<typeof useCompliance>['data'] }) {
  const { t } = useTranslation();
  const cells: { key: string; label: string; value: number | undefined; to: string; icon: LucideIcon; tone: 'warning' | 'destructive' }[] = [
    { key: 'exp-month', label: t('Documents expiring this month'), value: c?.documentsExpiringThisMonth, to: '/masters/documents', icon: FileClockIcon, tone: 'warning' },
    { key: 'expired', label: t('Documents expired'), value: c?.documentsExpired, to: '/masters/documents', icon: FileXIcon, tone: 'destructive' },
    { key: 'due', label: t('Services due soon'), value: c?.servicesDueSoon, to: '/masters/documents?tab=service', icon: WrenchIcon, tone: 'warning' },
    { key: 'overdue', label: t('Services overdue'), value: c?.servicesOverdue, to: '/masters/documents?tab=service', icon: WrenchIcon, tone: 'destructive' },
  ];
  const allClear = !!c && cells.every((x) => !x.value);
  return (
    <Panel
      id="compliance"
      title={t('Documents & service')}
      subtitle={c ? t('{{count}} documents within their reminder window', { count: c.documentsExpiring }) : undefined}
      action={
        allClear ? (
          <span className="flex items-center gap-1 text-xs font-medium text-[var(--success-fg)]">
            <CircleCheckIcon className="size-3.5" aria-hidden /> {t('All clear')}
          </span>
        ) : undefined
      }
    >
      <ul className="grid grid-cols-2 gap-2">
        {cells.map((x) => {
          const hot = !!x.value;
          return (
            <li key={x.key} className="min-w-0">
              <Link
                to={x.to}
                aria-label={`${x.label}: ${x.value ?? t('loading')}`}
                className="flex h-full min-w-0 flex-col gap-0.5 rounded-lg border px-3 py-2 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                style={hot ? { backgroundColor: `var(--${x.tone}-soft)`, borderColor: 'transparent' } : undefined}
              >
                <span className="flex items-center gap-1.5">
                  <x.icon className="size-3.5 shrink-0" style={{ color: hot ? `var(--${x.tone}-fg)` : 'var(--muted-foreground)' }} aria-hidden />
                  {x.value === undefined ? <Skeleton className="h-6 w-8" /> : <span className="text-lg leading-6 font-semibold tabular-nums" style={hot ? { color: `var(--${x.tone}-fg)` } : undefined}>{x.value.toLocaleString()}</span>}
                </span>
                <span className="text-xs leading-snug text-muted-foreground">{x.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

function useCompliance(enabled: boolean) {
  return useQuery({ ...complianceQuery, enabled });
}

// ── Page ──────────────────────────────────────────────────────────────────────

export function OverviewRefresh() {
  const { t } = useTranslation();
  const { can, me } = useAuth();
  const personal = !!me && me.company.accountType !== 'BUSINESS';
  const canMap = can('live_map');
  const canDocs = can('documents');
  const [top, setTop] = useState(5);
  // Identical to the classic tab: same key, params and 60 s polling.
  const query = useQuery({
    queryKey: overviewKey(top),
    queryFn: ({ signal }) => api.get<DashboardOverview>('/dashboard/overview', { top }, signal),
    refetchInterval: 60_000,
  });
  useLiveRefresh();
  const compliance = useCompliance(canDocs);
  const c = canDocs && !compliance.isError ? compliance.data : undefined;
  const showCompliance = canDocs && !compliance.isError;
  const d = query.data;
  const s = (k: MovementStatus) => d?.byStatus[k] ?? 0;

  const attention: AttentionItem[] = d
    ? [
        { key: 'critical', count: d.todayAlerts.critical, label: t('critical alerts today'), icon: BellRingIcon, color: 'var(--destructive-fg)', to: can('alerts') ? '/alerts' : undefined },
        { key: 'overspeed', count: s('OVERSPEED'), label: t('overspeeding now'), icon: STATUS_ICON.OVERSPEED, color: statusTextColor('OVERSPEED'), to: canMap ? '/live?status=OVERSPEED' : undefined },
        { key: 'offline', count: s('OFFLINE'), label: t('offline'), icon: STATUS_ICON.OFFLINE, color: statusTextColor('OFFLINE'), to: canMap ? '/live?status=OFFLINE' : undefined },
        { key: 'nodata', count: s('NO_DATA'), label: t('with no data'), icon: STATUS_ICON.NO_DATA, color: statusTextColor('NO_DATA'), to: canMap ? '/live?status=NO_DATA' : undefined },
        ...(c
          ? [
              { key: 'doc-expired', count: c.documentsExpired, label: t('documents expired'), icon: FileXIcon, color: 'var(--destructive-fg)', to: '/masters/documents' },
              { key: 'svc-overdue', count: c.servicesOverdue, label: t('services overdue'), icon: WrenchIcon, color: 'var(--destructive-fg)', to: '/masters/documents?tab=service' },
              { key: 'doc-month', count: c.documentsExpiringThisMonth, label: t('documents expiring this month'), icon: FileClockIcon, color: 'var(--warning-fg)', to: '/masters/documents' },
            ]
          : []),
      ]
    : [];

  const geofenceSlices: Slice[] = d
    ? [
        ...d.geofences.slice(0, 7).map((g, i) => ({ key: g.geofenceId, label: g.name, value: g.vehicles, color: g.color ?? GEOFENCE_FALLBACK[i % GEOFENCE_FALLBACK.length] })),
        ...(d.geofences.length > 7 ? [{ key: 'more', label: t('{{count}} more geofences', { count: d.geofences.length - 7 }), value: d.geofences.slice(7).reduce((a, g) => a + g.vehicles, 0), color: 'var(--muted-foreground)' }] : []),
        { key: 'outside', label: t('Outside all geofences'), value: Math.max(0, d.total - d.vehiclesInsideGeofences), color: 'var(--border)' },
      ]
    : [];

  const onlinePct = d && d.total ? Math.round((d.devicesOnline / d.total) * 100) : null;

  return (
    <div className="space-y-4 sm:space-y-5">
      {query.isError && <FormError message={errorMessage(query.error)} />}
      {personal && d && d.total === 0 && <GetStartedCard />}

      <NeedsAttention items={attention} />

      <div className="grid grid-cols-2 gap-3 sm:gap-4 md:grid-cols-3 xl:grid-cols-6">
        <KpiCard label={t('Vehicles')} value={d?.total} icon={TruckIcon} to={canMap ? '/live' : undefined} sub={d ? t('{{count}} online now', { count: d.devicesOnline }) : ''} definition={t('All vehicles and tracked objects you have access to, with or without a tracker.')} />
        <KpiCard
          label={t('Online now')}
          value={d?.devicesOnline}
          icon={RadioTowerIcon}
          extra={onlinePct !== null ? <span className="ml-auto text-xs font-medium text-muted-foreground tabular-nums">{onlinePct}%</span> : undefined}
          sub={d ? t('of {{count}} vehicles', { count: d.total }) : ''}
          definition={t('Vehicles with a tracker whose status is not Offline or No data. The percentage is of all vehicles.')}
        />
        <KpiCard label={t('Distance today')} value={d?.todayDistanceKm} unit="km" decimals={1} icon={RouteIcon} sub={t('Since midnight')} definition={t('Distance recorded by VeeTrax since midnight (company time zone), all vehicles.')} />
        <KpiCard label={t('Trips today')} value={d?.todayTrips} icon={GaugeIcon} sub={t('Completed trips')} definition={t('Trips today counts completed trips since midnight (company time zone). A trip still in progress is counted when it ends.')} />
        <KpiCard
          label={t('Alerts today')}
          value={d?.todayAlerts.total}
          icon={BellRingIcon}
          to={can('alerts') ? '/alerts' : undefined}
          sub={d ? t('{{count}} critical', { count: d.todayAlerts.critical }) : ''}
          subTone={d && d.todayAlerts.critical > 0 ? 'destructive' : 'muted'}
          definition={t('All alerts raised since midnight (company time zone). Critical counts the alerts with Critical severity.')}
        />
        <KpiCard label={t('Fleet odometer')} value={d?.totalOdometerKm} unit="km" icon={SigmaIcon} sub={t('Tracked distance + offsets')} definition={t('Total distance tracked by VeeTrax for all vehicles, plus each vehicle’s odometer offset.')} />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="min-w-0 lg:col-span-2">
          <FleetStatus d={d} canMap={canMap} />
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          {showCompliance && <Compliance c={c} />}
          <Panel id="geofences" title={t('Vehicles by geofence')} subtitle={d ? t('{{count}} inside a geofence now', { count: d.vehiclesInsideGeofences }) : undefined} className="flex-1">
            {d ? <DonutR title={t('Vehicles by geofence')} slices={geofenceSlices} centerLabel={t('vehicles')} emptyText={t('No vehicles yet.')} emptyIcon={MapPinnedIcon} /> : <Skeleton className="h-32" />}
          </Panel>
        </div>
      </div>

      {d?.io && <IoCards io={d.io} />}

      <div className="grid gap-4 md:grid-cols-2">
        {(['top', 'bottom'] as const).map((which) => (
          <Panel
            key={which}
            id={`dist-${which}`}
            title={which === 'top' ? t('Most distance today') : t('Least distance today')}
            action={
              which === 'top' ? (
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
              ) : undefined
            }
          >
            {d ? (
              <RankList
                items={d[which].map((v) => ({ key: v.objectId, label: v.name, sub: `${v.plateNumber ?? ''}${v.runningSec ? ` · ${t('{{duration}} moving', { duration: formatDuration(v.runningSec) })}` : ''}`, value: v.distanceKm }))}
                format={km}
                empty={t('No vehicles with a device yet.')}
                emptyIcon={TruckIcon}
                color={which === 'top' ? 'var(--primary)' : 'var(--muted-foreground)'}
              />
            ) : (
              <Skeleton className="h-40" />
            )}
          </Panel>
        ))}
        <Panel id="alerts-by-type" title={t('Alerts today by type')} className="md:col-span-2">
          {d ? (
            <RankList
              items={d.todayAlerts.byType.map((a) => ({ key: a.type, label: t(ALERT_TYPE_MAP[a.type as AlertTypeCode]?.label ?? a.type), value: a.count }))}
              format={(v) => v.toLocaleString()}
              empty={t('No alerts today.')}
              emptyIcon={CircleCheckIcon}
              color="var(--warning)"
              columns
            />
          ) : (
            <Skeleton className="h-40" />
          )}
        </Panel>
      </div>
    </div>
  );
}

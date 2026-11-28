import { useQuery } from '@tanstack/react-query';
import { BATTERY_STATUS_META, type DashboardFleetHealth } from '@veetracer/shared';
import { BatteryWarningIcon, FuelIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/features/auth/auth-context';
import { api } from '@/lib/api';
import { formatDuration } from '@/lib/format';
import { Panel } from './refresh/kit';

const VARIANT = { ok: 'success', warn: 'warning', bad: 'destructive', muted: 'muted' } as const;
const inr = (v: number) => `₹${Math.round(v).toLocaleString('en-IN')}`;

function reportLink(type: 'BATTERY_HEALTH' | 'IDLE_COST', from: string, to: string, objectId?: string, name?: string) {
  const q = new URLSearchParams({ type, from, to, run: '1' });
  if (objectId) q.set('vehicle', objectId);
  if (name) q.set('vehicleName', name);
  return `/reports?${q}`;
}

/** GET /dashboard/fleet-health (the server keeps it 30 min; heavy for big fleets). */
export function useFleetHealth(enabled = true) {
  return useQuery({
    queryKey: ['dashboard', 'fleet-health'],
    queryFn: ({ signal }) => api.get<DashboardFleetHealth>('/dashboard/fleet-health', undefined, signal),
    staleTime: 10 * 60_000,
    refetchInterval: 30 * 60_000,
    retry: false,
    enabled,
  });
}

/**
 * Dashboard "Vehicle health & fuel waste": batteries needing attention (last 14 days, from the tracker voltage) and idle
 * cost this month in rupees, each with its short list and a link to the full report.
 */
export function FleetHealthPanel({ className }: { className?: string }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const q = useFleetHealth();
  const d = q.data;
  const canReports = can('reports');
  if (q.isError) return null;
  const big = 'text-2xl font-semibold tabular-nums';
  return (
    <Panel id="fleet-health" title={t('Vehicle health & fuel waste')} subtitle={t('Battery from the last 14 days of tracker voltage · idle cost this month')} className={className}>
      {!d ? (
        <Skeleton className="m-4 h-40" />
      ) : (
        <div className="grid gap-4 p-4 pt-3 sm:p-5 sm:pt-3 md:grid-cols-2">
          <div className="min-w-0 space-y-3">
            <div className="flex items-start gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
                <BatteryWarningIcon className="size-5" aria-hidden />
              </span>
              <div className="min-w-0">
                <div className="text-sm text-muted-foreground">{t('Batteries needing attention')}</div>
                <div className={big}>
                  <span className={d.battery.action ? 'text-destructive-fg' : undefined}>{d.battery.action}</span>
                  <span className="ms-2 text-sm font-normal text-muted-foreground">{t('{{count}} weak · {{good}} good', { count: d.battery.weak, good: d.battery.good })}</span>
                </div>
              </div>
            </div>
            {d.battery.list.length ? (
              <ul className="divide-y rounded-lg border text-sm">
                {d.battery.list.map((r) => {
                  const m = BATTERY_STATUS_META[r.status];
                  const row = (
                    <>
                      <span className="min-w-0 truncate font-medium">{r.plateNumber || r.objectName}</span>
                      <span className="ms-auto flex shrink-0 items-center gap-2">
                        {r.restV !== null && <span className="text-xs text-muted-foreground tabular-nums">{`${r.restV.toFixed(1)} V`}</span>}
                        <Badge variant={VARIANT[m.tone]}>{t(m.label)}</Badge>
                      </span>
                    </>
                  );
                  return (
                    <li key={r.objectId} title={t(m.advice)}>
                      {canReports ? (
                        <Link to={reportLink('BATTERY_HEALTH', d.batteryFrom, d.batteryTo, r.objectId, r.objectName)} className="flex items-center gap-2 px-3 py-2 hover:bg-accent">
                          {row}
                        </Link>
                      ) : (
                        <div className="flex items-center gap-2 px-3 py-2">{row}</div>
                      )}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">{d.battery.vehicles - d.battery.noData > 0 ? t('All batteries look fine.') : t('No tracker has sent the battery voltage yet.')}</p>
            )}
            {canReports && (
              <Link to={reportLink('BATTERY_HEALTH', d.batteryFrom, d.batteryTo)} className="inline-block text-sm font-medium text-primary hover:underline">
                {t('Open battery health report')}
              </Link>
            )}
          </div>

          <div className="min-w-0 space-y-3">
            <div className="flex items-start gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
                <FuelIcon className="size-5" aria-hidden />
              </span>
              <div className="min-w-0">
                <div className="text-sm text-muted-foreground">{t('Idle cost this month')}</div>
                <div className={big}>
                  {inr(d.idle.rupees)}
                  <span className="ms-2 text-sm font-normal text-muted-foreground">{t('{{l}} L fuel · {{time}} idle', { l: Math.round(d.idle.litres).toLocaleString('en-IN'), time: formatDuration(d.idle.idleSec) })}</span>
                </div>
              </div>
            </div>
            {d.idle.top.length ? (
              <ul className="divide-y rounded-lg border text-sm">
                {d.idle.top.map((r) => {
                  const row = (
                    <>
                      <span className="min-w-0 truncate font-medium">{r.plateNumber || r.objectName}</span>
                      <span className="ms-auto shrink-0 text-xs text-muted-foreground tabular-nums">{formatDuration(r.idleSec)}</span>
                      <span className="w-20 shrink-0 text-right font-semibold tabular-nums">{inr(r.rupees)}</span>
                    </>
                  );
                  return (
                    <li key={r.objectId}>
                      {canReports ? (
                        <Link to={reportLink('IDLE_COST', d.monthFrom, d.monthTo, r.objectId, r.objectName)} className="flex items-center gap-3 px-3 py-2 hover:bg-accent">
                          {row}
                        </Link>
                      ) : (
                        <div className="flex items-center gap-3 px-3 py-2">{row}</div>
                      )}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">{t('No idling recorded this month.')}</p>
            )}
            {canReports && (
              <Link to={reportLink('IDLE_COST', d.monthFrom, d.monthTo)} className="inline-block text-sm font-medium text-primary hover:underline">
                {t('Open idle cost report')}
              </Link>
            )}
          </div>
        </div>
      )}
    </Panel>
  );
}

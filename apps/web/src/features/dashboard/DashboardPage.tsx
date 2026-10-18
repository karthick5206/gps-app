import { useQuery, useQueryClient } from '@tanstack/react-query';
import { MOVEMENT_STATUSES, STATUS_META, type DashboardSummary, type MovementStatus } from '@veetracer/shared';
import { ArrowRightIcon, MapIcon, RadioTowerIcon, TruckIcon } from 'lucide-react';
import { useEffect } from 'react';
import { Link } from 'react-router';
import { FormError } from '@/components/form-error';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/features/auth/auth-context';
import { liveStore } from '@/features/live/live-store';
import { api, errorMessage } from '@/lib/api';
import { statusColor } from '@/lib/status-tokens';
import { cn } from '@/lib/utils';
import { CountUp } from './CountUp';

const SUMMARY_KEY = ['dashboard-summary'] as const;
/** Live batches trigger a summary refetch at most this often. */
const LIVE_REFRESH_MS = 5000;

function useLiveSummaryRefresh() {
  const queryClient = useQueryClient();
  useEffect(() => {
    let last = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = liveStore.subscribe((e) => {
      if (e.type !== 'batch' || timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        last = Date.now();
        queryClient.invalidateQueries({ queryKey: SUMMARY_KEY });
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
}: {
  label: string;
  value: number | undefined;
  total?: number;
  status?: MovementStatus;
  icon?: typeof TruckIcon;
  to?: string;
}) {
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
        {value === undefined ? <Skeleton className="h-8 w-16" /> : <p className="text-3xl font-semibold tracking-tight"><CountUp value={value} /></p>}
        {pct !== null && <p className="pb-1 text-xs text-muted-foreground tabular-nums">{pct}%</p>}
      </div>
    </Card>
  );
  return to ? (
    <Link to={to} className="rounded-xl focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-none" aria-label={`${label}: ${value ?? 'loading'}`}>
      {body}
    </Link>
  ) : (
    body
  );
}

export function DashboardPage() {
  const { can } = useAuth();
  const canMap = can('live_map');
  const summary = useQuery({
    queryKey: SUMMARY_KEY,
    queryFn: ({ signal }) => api.get<DashboardSummary>('/dashboard/summary', undefined, signal),
    refetchInterval: 60_000,
  });
  useLiveSummaryRefresh();
  const data = summary.data;

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 p-4 sm:p-6">
      <PageHeader
        title="Dashboard"
        description="Fleet status right now. Counts update automatically."
        actions={
          canMap && (
            <Button asChild>
              <Link to="/live">
                <MapIcon /> Open live map <ArrowRightIcon />
              </Link>
            </Button>
          )
        }
      />
      {summary.isError && <FormError message={errorMessage(summary.error)} />}

      <div className="grid gap-4 sm:grid-cols-2">
        <StatCard label="Total objects" value={data?.total} icon={TruckIcon} to={canMap ? '/live' : undefined} />
        <StatCard label="Devices online" value={data?.devicesOnline} total={data?.total} icon={RadioTowerIcon} />
      </div>

      <section aria-labelledby="by-status" className="space-y-3">
        <h2 id="by-status" className="text-sm font-semibold text-muted-foreground">
          By status
        </h2>
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
          {MOVEMENT_STATUSES.map((s) => (
            <StatCard
              key={s}
              status={s}
              label={STATUS_META[s].label}
              value={data ? (data.byStatus[s] ?? 0) : undefined}
              total={data?.total}
              to={canMap ? `/live?status=${s}` : undefined}
            />
          ))}
        </div>
      </section>
    </div>
  );
}

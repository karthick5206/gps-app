import type { TransportDirection } from '@veetracer/shared';
import { ChevronLeftIcon, ChevronRightIcon, WaypointsIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAuth } from '@/features/auth/auth-context';
import { NotFoundPage } from '@/features/errors/ErrorPages';
import { shiftDay } from '@/features/planned-trips/trip-format';
import { getReportTimeZone, todayInZone } from '@/features/reports/report-time';
import { cn } from '@/lib/utils';
import { DIRECTION_LABEL } from '../dispatch/e3-format';
import { DirectionBadge } from '../dispatch/e3-ui';
import { ComparePanel, COMPARE_MAX } from './ComparePanel';
import { OptimisePanel, type OptimiseState } from './OptimisePanel';
import { accessLabel, emptyWeights, type WeightDraft } from './planner-format';
import { CapabilityChip, PlanStatusBadge } from './planner-ui';
import { PLANNING_MENU, planPath, plannerErrorMessage, plannerFlagOn, useCapabilities, usePlans, type StartedPlan } from './use-planner';

/**
 * Transport → Route planning (menu etms_planning; E4 WP 4.5, doc 17 P10, doc 07 §5). Optimise (date, direction,
 * sites, shifts, vehicles, explicit weights → one job per shift with progress / cancel), the plans of the day, and a
 * metrics-only comparison. Review, manual edits and publish are on the plan page. Shown only with the web flag
 * `etmsRouting` and when the API reports routing enabled.
 */
export function PlanningPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const tz = getReportTimeZone();
  const today = todayInZone(tz);
  const flag = plannerFlagOn();
  const caps = useCapabilities(flag);
  const [tab, setTab] = useState('optimise');
  const [opt, setOpt] = useState<OptimiseState>({ day: today, direction: 'IN', siteIds: [], shiftIds: [], vehicleIds: [], weights: emptyWeights(), timeLimitS: 30, branchId: null });
  const [started, setStarted] = useState<StartedPlan[]>([]);
  const [compare, setCompare] = useState<string[]>([]);
  const [compareWeights, setCompareWeights] = useState<WeightDraft | null>(null);
  const day = opt.day;
  const direction = opt.direction;
  const plans = usePlans({ planDate: day, direction });

  if (!flag) return <NotFoundPage />;
  const access = caps.data?.access;
  const canPlan = can(PLANNING_MENU, 'create') && (access?.canPlan ?? false) && !access?.support;
  const canDelete = can(PLANNING_MENU, 'delete') && (access?.canDelete ?? false) && !access?.support;

  const setDay = (d: string) => {
    setOpt((s) => ({ ...s, day: d, vehicleIds: [] }));
    setCompare([]);
  };
  const setDirection = (d: TransportDirection) => {
    setOpt((s) => ({ ...s, direction: d }));
    setCompare([]);
  };
  const toggleCompare = (id: string, on: boolean) => setCompare((c) => (on ? (c.includes(id) || c.length >= COMPARE_MAX ? c : [...c, id]) : c.filter((x) => x !== id)));
  const visible = (plans.data ?? []).filter((p) => p.status !== 'CANCELLED');
  const discarded = (plans.data ?? []).length - visible.length;

  return (
    <div className="flex w-full min-w-0 flex-col gap-3 p-4 sm:p-6">
      <PageHeader
        title={t('Route planning')}
        description={t('Optimise the day’s bookings into routes, review and adjust them, compare plans and publish one to dispatch.')}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <CapabilityChip caps={caps.data} />
            {access && <Badge variant="outline">{t(accessLabel(access))}</Badge>}
          </div>
        }
      />

      {caps.isPending ? (
        <Skeleton className="h-96 w-full rounded-xl" />
      ) : caps.isError ? (
        <Card className="p-4">
          <p role="alert" className="text-sm text-destructive-fg">
            {plannerErrorMessage(caps.error, t)}
          </p>
        </Card>
      ) : !caps.data?.enabled ? (
        <EmptyState icon={WaypointsIcon} title={t('Route planning is off')} description={t('Route planning is switched off for this company. Trips are planned on the dispatch board.')} action={<Button asChild variant="outline"><Link to="/transport/dispatch">{t('Open the dispatch board')}</Link></Button>} />
      ) : (
        <>
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
            <div className="flex items-center gap-1">
              <Button variant="outline" size="icon" onClick={() => setDay(shiftDay(day, -1))} aria-label={t('Previous day')}>
                <ChevronLeftIcon />
              </Button>
              <Input type="date" value={day} onChange={(e) => e.target.value && setDay(e.target.value)} className="h-9 min-w-0 flex-1 sm:w-40 sm:flex-none" aria-label={t('Service date')} />
              <Button variant="outline" size="icon" onClick={() => setDay(shiftDay(day, 1))} aria-label={t('Next day')}>
                <ChevronRightIcon />
              </Button>
            </div>
            <div className="inline-flex rounded-lg border bg-muted p-[3px]" role="group" aria-label={t('Direction')}>
              {(['IN', 'OUT'] as const).map((d) => (
                <button key={d} type="button" aria-pressed={direction === d} onClick={() => setDirection(d)} className={cn('h-8 flex-1 rounded-md px-3 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring', direction === d ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground')}>
                  {t(DIRECTION_LABEL[d])}
                </button>
              ))}
            </div>
          </div>

          <Tabs value={tab} onValueChange={setTab} className="flex min-w-0 flex-col gap-3">
            <TabsList className="grid w-full grid-cols-3 sm:w-auto sm:max-w-md">
              <TabsTrigger value="optimise" className="min-w-0 px-1 text-xs sm:text-sm">
                {t('Optimise')}
              </TabsTrigger>
              <TabsTrigger value="plans" className="min-w-0 px-1 text-xs sm:text-sm">
                {t('Plans')} <span className="tabular-nums">({visible.length})</span>
              </TabsTrigger>
              <TabsTrigger value="compare" className="min-w-0 px-1 text-xs sm:text-sm">
                {t('Compare')} {compare.length > 0 && <span className="tabular-nums">({compare.length})</span>}
              </TabsTrigger>
            </TabsList>

            <TabsContent value="optimise" className="min-w-0">
              <OptimisePanel caps={caps.data} state={opt} setState={setOpt} started={started} setStarted={setStarted} canPlan={canPlan} tz={tz} />
            </TabsContent>

            <TabsContent value="plans" className="min-w-0">
              {plans.isPending ? (
                <Skeleton className="h-48 w-full rounded-xl" />
              ) : plans.isError ? (
                <p role="alert" className="text-sm text-destructive-fg">
                  {plannerErrorMessage(plans.error, t)}
                </p>
              ) : visible.length === 0 ? (
                <EmptyState icon={WaypointsIcon} title={t('No plans for this day and direction')} description={t('Start one under Optimise.')} />
              ) : (
                <Card className="min-w-0 gap-0 p-0">
                  <ul className="divide-y">
                    {visible.map((p) => {
                      const ticked = compare.includes(p.id);
                      return (
                        <li key={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 p-3">
                          <Checkbox id={`cmp-${p.id}`} checked={ticked} disabled={!ticked && compare.length >= COMPARE_MAX} onCheckedChange={(v) => toggleCompare(p.id, v === true)} aria-label={t('Compare {{name}}', { name: p.name })} />
                          <div className="grid min-w-0 flex-1 gap-0.5">
                            <Link to={planPath(p.id)} className="break-words font-medium text-primary hover:underline">
                              {p.name}
                            </Link>
                            <span className="text-xs text-muted-foreground">
                              {t('{{s}} stops · {{a}} vehicles · {{u}} unassigned · version {{v}}', { s: p.stops, a: p.assignments, u: p.unassigned, v: p.version })}
                            </span>
                          </div>
                          <div className="flex flex-wrap items-center gap-1">
                            {p.direction && <DirectionBadge direction={p.direction} />}
                            <PlanStatusBadge status={p.status} />
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </Card>
              )}
              {discarded > 0 && <p className="mt-2 text-xs text-muted-foreground">{t('{{n}} discarded plan(s) hidden.', { n: discarded })}</p>}
              {compare.length >= 2 && (
                <Button className="mt-3" onClick={() => setTab('compare')}>
                  {t('Compare {{n}} plans', { n: compare.length })}
                </Button>
              )}
            </TabsContent>

            <TabsContent value="compare" className="min-w-0">
              <ComparePanel ids={compare} summaries={plans.data ?? []} weights={compareWeights ?? opt.weights} setWeights={setCompareWeights} canDelete={canDelete} onClear={() => setCompare([])} />
            </TabsContent>
          </Tabs>
        </>
      )}
    </div>
  );
}

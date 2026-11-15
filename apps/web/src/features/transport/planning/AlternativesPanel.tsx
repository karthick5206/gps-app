import type { RoutePlanMetricsDto } from '@veetracer/shared';
import { AwardIcon, CheckIcon, InfoIcon } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip } from '@/components/ui/tooltip';
import { E4_COMPARE_ROWS, METRIC_HELP, e4Best, e4Text, excludedLines } from './plan-compare';
import { ROUTING_STRATEGY_INFO } from './plan-strategy';
import { isEditablePlan, PLAN_STATUS_META } from './planner-format';
import { EtaFootnote, JobProgress } from './planner-ui';
import { planPath, plannerErrorMessage, useAlternatives, useCompare, useDiscardPlan, usePlan } from './use-planner';

/**
 * E4 WP-W compare table with the WP-A metrics (rows = metrics with a help tooltip from the shared definitions,
 * columns = plans; a phone gets one card per plan). "Best" marks the best value of a row (none when all tie).
 */
export function MetricsCompareTable({ plans, nameOf, action }: { plans: RoutePlanMetricsDto[]; nameOf?: (id: string) => string; action?: (p: RoutePlanMetricsDto) => ReactNode }) {
  const { t } = useTranslation();
  const best = e4Best(plans);
  const name = (p: RoutePlanMetricsDto) => nameOf?.(p.planId) ?? p.name;
  const label = (row: (typeof E4_COMPARE_ROWS)[number]) => (
    <span className="inline-flex items-center gap-1">
      {t(row.label)}
      <Tooltip content={t(METRIC_HELP[row.help])}>
        <button type="button" className="rounded-full text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring" aria-label={`${t(row.label)}: ${t(METRIC_HELP[row.help])}`}>
          <InfoIcon className="size-3.5" aria-hidden />
        </button>
      </Tooltip>
    </span>
  );
  const cell = (p: RoutePlanMetricsDto, i: number, row: (typeof E4_COMPARE_ROWS)[number]) => (
    <span className="inline-flex min-w-0 flex-wrap items-center justify-end gap-1 md:justify-start">
      <span className="tabular-nums">{e4Text(p, row.key, t)}</span>
      {best[row.key].includes(i) && (
        <Badge variant="success">
          <AwardIcon aria-hidden /> {t('Best')}
        </Badge>
      )}
      {row.key === 'excluded' &&
        excludedLines(p, t).map((l) => (
          <span key={l} className="block basis-full text-xs text-muted-foreground">
            {l}
          </span>
        ))}
    </span>
  );
  const strategy = (p: RoutePlanMetricsDto) => (p.strategy ? <Badge variant="outline">{t(ROUTING_STRATEGY_INFO[p.strategy].label)}</Badge> : null);
  return (
    <>
      <Card className="hidden min-w-0 overflow-hidden p-0 md:block">
        <table className="w-full table-fixed text-sm">
          <caption className="sr-only">{t('Plan comparison')}</caption>
          <thead>
            <tr className="border-b bg-muted/50 text-left">
              <th scope="col" className="w-44 p-2 font-medium">
                {t('Metric')}
              </th>
              {plans.map((p) => (
                <th key={p.planId} scope="col" className="p-2 align-top font-medium">
                  <Link to={planPath(p.planId)} className="line-clamp-2 break-words text-primary hover:underline">
                    {name(p)}
                  </Link>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {strategy(p)}
                    <Badge variant={PLAN_STATUS_META[p.status].tone}>{t(PLAN_STATUS_META[p.status].label)}</Badge>
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {E4_COMPARE_ROWS.map((row) => (
              <tr key={row.key} className="border-b last:border-0">
                <th scope="row" className="p-2 text-left font-normal text-muted-foreground">
                  {label(row)}
                </th>
                {plans.map((p, i) => (
                  <td key={p.planId} className="p-2 align-top">
                    {cell(p, i, row)}
                  </td>
                ))}
              </tr>
            ))}
            {action && (
              <tr>
                <th scope="row" className="p-2" />
                {plans.map((p) => (
                  <td key={p.planId} className="p-2 align-top">
                    {action(p)}
                  </td>
                ))}
              </tr>
            )}
          </tbody>
        </table>
      </Card>
      <div className="grid gap-3 md:hidden">
        {plans.map((p, i) => (
          <Card key={p.planId} className="min-w-0 gap-2 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Link to={planPath(p.planId)} className="min-w-0 basis-full break-words font-medium text-primary hover:underline">
                {name(p)}
              </Link>
              {strategy(p)}
              <Badge variant={PLAN_STATUS_META[p.status].tone}>{t(PLAN_STATUS_META[p.status].label)}</Badge>
            </div>
            <dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm">
              {E4_COMPARE_ROWS.map((row) => (
                <div key={row.key} className="contents">
                  <dt className="text-muted-foreground">{label(row)}</dt>
                  <dd className="flex min-w-0 justify-end text-right">{cell(p, i, row)}</dd>
                </div>
              ))}
            </dl>
            {action?.(p)}
          </Card>
        ))}
      </div>
    </>
  );
}

/**
 * Alternatives of a plan (E4 WP-A siblings): each strategy's plan with its job progress, then — once two or more are
 * ready — the metrics compare with "Use this plan" (keep it, discard the other alternatives and the source draft).
 */
export function AlternativesPanel({ planId, canDelete, canPlan }: { planId: string; canDelete: boolean; canPlan: boolean }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const alts = useAlternatives(planId);
  const sourceId = alts.data?.sourcePlanId ?? null;
  const source = usePlan(sourceId);
  const discard = useDiscardPlan();
  const [keep, setKeep] = useState<string | null>(null);
  const list = alts.data?.alternatives ?? [];
  // The source joins the comparison only once it has routes (an un-optimised source draft has nothing to compare).
  const sourceReady = !!source.data && source.data.status !== 'CANCELLED' && source.data.stops.some((s) => s.assignmentId);
  const ready = [...(sourceReady && sourceId ? [sourceId] : []), ...list.filter((a) => a.status === 'PLANNED' || a.status === 'PUBLISHED').map((a) => a.planId)];
  const cmp = useCompare(ready);
  const editable = [...list.map((a) => ({ id: a.planId, version: a.version, status: a.status })), ...(source.data ? [{ id: source.data.id, version: source.data.version, status: source.data.status }] : [])].filter((p) => isEditablePlan(p.status as never));
  const others = (k: string) => editable.filter((p) => p.id !== k);

  if (alts.isPending) return <Skeleton className="h-32 w-full rounded-xl" />;
  if (alts.isError) return <p role="alert" className="text-sm text-destructive-fg">{plannerErrorMessage(alts.error, t)}</p>;
  if (!list.length) return <p className="text-sm text-muted-foreground">{t('No alternatives for this plan yet.')}</p>;

  const keepPlan = async (k: string) => {
    let n = 0;
    let failed = 0;
    for (const p of others(k)) {
      try {
        await discard.mutateAsync({ id: p.id, version: p.version });
        n++;
      } catch (e) {
        failed++;
        toast.error(plannerErrorMessage(e, t));
      }
    }
    setKeep(null);
    void alts.refetch();
    if (failed) {
      // Partial failure: say so and stay here (the list shows what is left), never claim success.
      toast.warning(t('{{n}} plan(s) discarded; {{failed}} could not be discarded. Check the list and try again.', { n, failed }));
      return;
    }
    toast.success(t('Plan kept; {{n}} other plan(s) discarded.', { n }));
    void navigate(planPath(k));
  };

  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3">
      <ul className="grid grid-cols-[minmax(0,1fr)] gap-2" aria-label={t('Alternatives')}>
        {list.map((a) => {
          const label = a.strategy ? t(ROUTING_STRATEGY_INFO[a.strategy].label) : a.name;
          return (
            <li key={a.planId} className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2 rounded-lg border p-3">
              {a.job ? (
                <JobProgress jobId={a.job.jobId} planId={a.planId} label={label} canCancel={canPlan} />
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  <Link to={planPath(a.planId)} className="min-w-0 flex-1 truncate text-sm font-medium text-primary hover:underline">
                    {label}
                  </Link>
                  <Badge variant={PLAN_STATUS_META[a.status as keyof typeof PLAN_STATUS_META]?.tone ?? 'neutral'}>{t(PLAN_STATUS_META[a.status as keyof typeof PLAN_STATUS_META]?.label ?? a.status)}</Badge>
                  {a.status === 'DRAFT' && <span className="basis-full text-xs text-muted-foreground">{t('Not optimised yet: the optimiser was busy. Open the plan and optimise it.')}</span>}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {ready.length >= 2 ? (
        cmp.isPending ? (
          <Skeleton className="h-48 w-full rounded-xl" />
        ) : cmp.isError ? (
          <p role="alert" className="text-sm text-destructive-fg">
            {plannerErrorMessage(cmp.error, t)}
          </p>
        ) : (
          <>
            <MetricsCompareTable
              plans={cmp.data?.plans ?? []}
              action={(p) =>
                canDelete && isEditablePlan(p.status) ? (
                  <Button size="sm" variant="outline" className="h-auto min-h-8 max-w-full py-1 text-left whitespace-normal" onClick={() => setKeep(p.planId)}>
                    <CheckIcon /> {t('Use this plan')}
                  </Button>
                ) : null
              }
            />
            <EtaFootnote />
          </>
        )
      ) : (
        <p className="text-sm text-muted-foreground">{t('The comparison shows once two alternatives are ready.')}</p>
      )}
      <ConfirmDialog
        open={!!keep}
        onOpenChange={(o) => !o && setKeep(null)}
        title={t('Use this plan?')}
        description={keep ? t('The other {{n}} plan(s) of this comparison are discarded. Their history is kept; nothing is published.', { n: others(keep).length }) : ''}
        confirmLabel={t('Use this plan')}
        pending={discard.isPending}
        onConfirm={() => keep && void keepPlan(keep)}
      />
    </div>
  );
}

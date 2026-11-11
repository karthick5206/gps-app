import type { RoutePlanSummaryDto } from '@veetracer/shared';
import { AwardIcon, ExternalLinkIcon, Trash2Icon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { SimpleSelect } from '../dispatch/e3-ui';
import { bestOf, COMPARE_ROWS, completeWeights, deltaPercent, isEditablePlan, metricsFromCompare, metricText, metricValue, planMetrics, weightedScores, WEIGHT_LABEL, type WeightDraft } from './planner-format';
import { EtaFootnote, PlanStatusBadge, WeightsEditor } from './planner-ui';
import { planPath, plannerErrorMessage, useCompare, useDiscardPlan, usePlansDetail } from './use-planner';

export const COMPARE_MAX = 4; // ROUTE_PLAN_COMPARE_MAX is 5; four columns still fit a laptop screen

/**
 * Compare plans on metrics only (07 §5): rows = metrics, columns = plans (cards on a phone, no sideways scroll). A
 * "Best" marker only where better is unambiguous; an overall result only once the user sets weights here.
 */
export function ComparePanel({ ids, summaries, weights, setWeights, canDelete, onClear }: { ids: string[]; summaries: RoutePlanSummaryDto[]; weights: WeightDraft; setWeights: (w: WeightDraft) => void; canDelete: boolean; onClear: () => void }) {
  const { t } = useTranslation();
  // Metrics from GET /compare (metrics only); ride times and ETA quality from the plan details of the same version.
  const results = usePlansDetail(ids);
  const cmp = useCompare(ids);
  const discard = useDiscardPlan();
  const [baseline, setBaseline] = useState<string>(ids[0] ?? '');
  const [discardOthers, setDiscardOthers] = useState<string | null>(null);
  const plans = results.map((r) => r.data).filter((p): p is NonNullable<typeof p> => !!p);
  const metrics = useMemo(
    () =>
      plans.map((p) => {
        const own = planMetrics(p);
        const dto = cmp.data?.plans.find((m) => m.planId === p.id && m.version === p.version);
        return dto ? metricsFromCompare(dto, own) : own;
      }),
    [plans, cmp.data],
  );
  const w = completeWeights(weights);
  const scored = weightedScores(metrics, w);
  const baseIdx = Math.max(0, plans.findIndex((p) => p.id === baseline));

  if (ids.length < 2) return <p className="text-sm text-muted-foreground">{t('Tick two to four plans under Plans to compare them here.')}</p>;
  if (results.some((r) => r.isPending) || cmp.isPending) return <Skeleton className="h-72 w-full rounded-xl" />;
  const failed = results.find((r) => r.isError) ?? (cmp.isError ? cmp : undefined);

  const name = (id: string) => summaries.find((s) => s.id === id)?.name ?? plans.find((p) => p.id === id)?.name ?? id;
  const others = (keep: string) => plans.filter((p) => p.id !== keep && isEditablePlan(p.status));

  const doDiscardOthers = async (keep: string) => {
    let n = 0;
    for (const p of others(keep)) {
      try {
        await discard.mutateAsync({ id: p.id, version: p.version });
        n++;
      } catch (e) {
        toast.error(plannerErrorMessage(e, t));
      }
    }
    setDiscardOthers(null);
    if (n) toast.success(t('{{n}} plan(s) discarded.', { n }));
  };

  const cell = (i: number, key: (typeof COMPARE_ROWS)[number]['key'], best: number[]) => {
    const m = metrics[i];
    const v = metricValue(m, key);
    const d = i !== baseIdx ? deltaPercent(v, metricValue(metrics[baseIdx], key)) : null;
    return (
      <span className="inline-flex min-w-0 flex-wrap items-center justify-end gap-1 md:justify-start">
        <span className="tabular-nums">{metricText(m, key, t)}</span>
        {d && <span className="text-xs text-muted-foreground tabular-nums">({d})</span>}
        {best.includes(i) && (
          <Badge variant="success">
            <AwardIcon aria-hidden /> {t('Best')}
          </Badge>
        )}
      </span>
    );
  };

  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4">
      {failed && <p role="alert" className="text-sm text-destructive-fg">{plannerErrorMessage(failed.error, t)}</p>}
      <div className="flex flex-wrap items-end gap-2">
        <div className="grid w-full min-w-0 gap-1 sm:w-auto sm:max-w-xs sm:flex-1">
          <span className="text-xs text-muted-foreground" id="cmp-base">
            {t('Baseline')}
          </span>
          <SimpleSelect value={plans[baseIdx]?.id ?? ''} onChange={setBaseline} label={t('Baseline')} className="min-w-0 [&>span]:min-w-0 [&>span]:truncate" options={plans.map((p) => ({ value: p.id, label: p.name }))} />
        </div>
        <Button variant="ghost" size="sm" onClick={onClear}>
          {t('Clear selection')}
        </Button>
      </div>

      {/* Desktop / tablet: matrix. */}
      <Card className="hidden min-w-0 overflow-hidden p-0 md:block">
        <table className="w-full table-fixed text-sm">
          <caption className="sr-only">{t('Plan comparison')}</caption>
          <thead>
            <tr className="border-b bg-muted/50 text-left">
              <th scope="col" className="w-40 p-2 font-medium">
                {t('Metric')}
              </th>
              {plans.map((p, i) => (
                <th key={p.id} scope="col" className="p-2 align-top font-medium">
                  <Link to={planPath(p.id)} className="line-clamp-2 break-words text-primary hover:underline">
                    {p.name}
                  </Link>
                  <div className="mt-1 flex flex-wrap gap-1">
                    <PlanStatusBadge status={p.status} />
                    {i === baseIdx && <Badge variant="outline">{t('Baseline')}</Badge>}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {COMPARE_ROWS.map((row) => {
              const best = bestOf(metrics.map((m) => metricValue(m, row.key)), row.best);
              return (
                <tr key={row.key} className="border-b last:border-0">
                  <th scope="row" className="p-2 text-left font-normal text-muted-foreground">
                    {t(row.label)}
                  </th>
                  {plans.map((p, i) => (
                    <td key={p.id} className="p-2 align-top">
                      {cell(i, row.key, best)}
                    </td>
                  ))}
                </tr>
              );
            })}
            {scored.winner !== null && (
              <tr className="bg-muted/30">
                <th scope="row" className="p-2 text-left font-medium">
                  {t('Weighted score (lower is better)')}
                </th>
                {plans.map((p, i) => (
                  <td key={p.id} className="p-2 tabular-nums">
                    {scored.scores[i]} {scored.winner === i && <Badge variant="success">{t('Best by your weights')}</Badge>}
                  </td>
                ))}
              </tr>
            )}
          </tbody>
        </table>
      </Card>

      {/* Phone: one card per plan, metrics as a list. */}
      <div className="grid gap-3 md:hidden">
        {plans.map((p, i) => (
          <Card key={p.id} className="min-w-0 gap-2 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Link to={planPath(p.id)} className="min-w-0 basis-full break-words font-medium text-primary hover:underline">
                {p.name}
              </Link>
              <PlanStatusBadge status={p.status} />
              {i === baseIdx && <Badge variant="outline">{t('Baseline')}</Badge>}
            </div>
            <dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm">
              {COMPARE_ROWS.map((row) => {
                const best = bestOf(metrics.map((m) => metricValue(m, row.key)), row.best);
                return (
                  <div key={row.key} className="contents">
                    <dt className="text-muted-foreground">{t(row.label)}</dt>
                    <dd className="flex min-w-0 justify-end text-right">{cell(i, row.key, best)}</dd>
                  </div>
                );
              })}
              {scored.winner !== null && (
                <div className="contents">
                  <dt className="font-medium">{t('Weighted score (lower is better)')}</dt>
                  <dd className="text-right tabular-nums">
                    {scored.scores[i]} {scored.winner === i && <Badge variant="success">{t('Best by your weights')}</Badge>}
                  </dd>
                </div>
              )}
            </dl>
          </Card>
        ))}
      </div>
      <EtaFootnote />

      <Card className="min-w-0 gap-3 p-4">
        <WeightsEditor idPrefix="cmp-w" value={weights} onChange={setWeights} />
        {!w && <p className="text-sm text-muted-foreground">{t('No overall result: set the weights above to rank the plans. Each row marks a best value only where better is clear.')}</p>}
        {w && scored.missing.length > 0 && (
          <p className="text-sm text-warning-fg">{t('No overall result: some plans have no engine numbers for {{what}}.', { what: scored.missing.map((k) => t(WEIGHT_LABEL[k])).join(', ') })}</p>
        )}
        {w && scored.winner === null && !scored.missing.length && <p className="text-sm text-muted-foreground">{t('The weighted scores tie: no single best plan.')}</p>}
      </Card>

      <div className="flex flex-wrap gap-2">
        {plans.map((p) => (
          <div key={p.id} className="flex min-w-0 flex-wrap gap-2">
            <Button asChild size="sm" variant="outline" className="h-auto min-h-8 max-w-full py-1 text-left whitespace-normal">
              <Link to={planPath(p.id)}>
                <ExternalLinkIcon /> {t('Review & publish {{name}}', { name: p.name })}
              </Link>
            </Button>
            {canDelete && others(p.id).length > 0 && (
              <Button size="sm" variant="ghost" className="h-auto min-h-8 max-w-full py-1 text-left whitespace-normal" onClick={() => setDiscardOthers(p.id)}>
                <Trash2Icon /> {t('Keep this, discard the others')}
              </Button>
            )}
          </div>
        ))}
      </div>

      <ConfirmDialog
        open={!!discardOthers}
        onOpenChange={(o) => !o && setDiscardOthers(null)}
        title={t('Discard the other plans?')}
        description={discardOthers ? t('{{n}} plan(s) other than “{{name}}” will be discarded. Their history is kept; nothing is published.', { n: others(discardOthers).length, name: name(discardOthers) }) : ''}
        confirmLabel={t('Discard')}
        destructive
        pending={discard.isPending}
        onConfirm={() => discardOthers && void doDiscardOthers(discardOthers)}
      />
      <span className={cn('sr-only')} aria-live="polite">
        {scored.winner !== null ? t('Best by your weights: {{name}}', { name: plans[scored.winner]?.name ?? '' }) : ''}
      </span>
    </div>
  );
}

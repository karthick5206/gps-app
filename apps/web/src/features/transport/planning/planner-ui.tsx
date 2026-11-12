import type { RoutePlanStatus, RoutePlanStopViolation, RoutingCapabilities } from '@veetracer/shared';
import { NO_LIVE_TRAFFIC_NOTICE } from '@veetracer/shared';
import { CircleAlertIcon, CircleStopIcon, RouteIcon, RouteOffIcon } from 'lucide-react';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import {
  capabilityView,
  ETA_QUALITY_META,
  formatDuration,
  formatKm,
  JOB_PHASE_LABEL,
  jobOutcome,
  steadyProgress,
  PLAN_STATUS_META,
  unassignedReason,
  VIOLATION_LABEL,
  WEIGHT_KEYS,
  WEIGHT_HINT,
  WEIGHT_LABEL,
  WEIGHT_MAX,
  WEIGHT_MIN,
  parseWeight,
  type EtaQuality,
  type PlanMetrics,
  type SteadyProgress,
  type WeightDraft,
  type WeightKey,
} from './planner-format';
import { plannerErrorMessage, useCancelJob, useJob, usePlan } from './use-planner';
import { planPath } from './planner-client';

export function PlanStatusBadge({ status }: { status: RoutePlanStatus }) {
  const { t } = useTranslation();
  const m = PLAN_STATUS_META[status];
  return <Badge variant={m.tone}>{t(m.label)}</Badge>;
}

export function EtaQualityBadge({ quality }: { quality: EtaQuality }) {
  const { t } = useTranslation();
  const m = ETA_QUALITY_META[quality];
  return (
    <Badge variant={m.tone} title={t(m.hint)}>
      {t(m.label)}
    </Badge>
  );
}

/** Routing health (text + icon, never colour alone). */
export function CapabilityChip({ caps }: { caps: RoutingCapabilities | undefined }) {
  const { t } = useTranslation();
  const v = capabilityView(caps);
  const Icon = v.canOptimise ? RouteIcon : RouteOffIcon;
  return (
    <Badge variant={v.tone} title={v.detail ? t(v.detail) : t(NO_LIVE_TRAFFIC_NOTICE)}>
      <Icon aria-hidden /> {t(v.label)}
    </Badge>
  );
}

/** The always-on ETA footnote (07 §5). */
export function EtaFootnote({ className }: { className?: string }) {
  const { t } = useTranslation();
  return <p className={cn('text-xs text-muted-foreground', className)}>{t('Times are road estimates from the routing engine: uncalibrated, no live traffic.')}</p>;
}

/** Progress of one optimisation job with cancel; the failure reason as text (incl. "routing unavailable"). */
export function JobProgress({ jobId, planId, label, canCancel }: { jobId: string; planId: string | null; label: string; canCancel: boolean }) {
  const { t } = useTranslation();
  const job = useJob(jobId);
  const cancel = useCancelJob();
  const j = job.data;
  // T2-L2: once a job left passengers unassigned, the plan (when known) gives the passenger counts.
  const unassigned = !!(j?.state === 'succeeded' && (j.result as { unassigned?: unknown[] } | undefined)?.unassigned?.length);
  const plan = usePlan(unassigned && planId ? planId : null);
  // T2-O1: the bar never moves backwards on a retry (the worker restarts its count); the retry is labelled.
  const steady = useRef<SteadyProgress | null>(null);
  if (!j) return <p className="text-sm text-muted-foreground">{job.isError ? plannerErrorMessage(job.error, t) : t('Loading…')}</p>;
  steady.current = steadyProgress(steady.current, j);
  const shown = steady.current;
  const outcome = jobOutcome(j, plan.data);
  const active = j.state === 'queued' || j.state === 'running';
  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2" data-testid="job-progress">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{label}</span>
        <Badge variant={outcome.tone}>{t(outcome.label)}</Badge>
      </div>
      {active && (
        <>
          <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>
              {j.phase ? t(JOB_PHASE_LABEL[j.phase] ?? j.phase) : t('Waiting for a worker')}
              {shown.retrying ? ` · ${t('retrying (attempt {{n}} of {{max}}); progress continues from the earlier attempt', { n: j.attempts, max: j.maxAttempts })}` : ''}
              {j.cancelRequested ? ` · ${t('cancelling…')}` : ''}
            </span>
            <span className="tabular-nums">{shown.value} %</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label={t('Optimisation progress')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={shown.value}>
            <div className="h-full rounded-full bg-primary transition-[width] motion-reduce:transition-none" style={{ width: `${shown.value}%` }} />
          </div>
          {canCancel && (
            <Button size="sm" variant="outline" className="justify-self-start" disabled={j.cancelRequested || cancel.isPending} onClick={() => cancel.mutate(j.jobId)}>
              <CircleStopIcon /> {t('Cancel optimisation')}
            </Button>
          )}
        </>
      )}
      {j.state === 'failed' && (
        <p role="alert" className="flex items-start gap-1.5 text-sm text-destructive-fg">
          <CircleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
          {plannerErrorMessage(Object.assign(new Error(j.error?.message ?? ''), { code: j.error?.code ?? null }), t)}
        </p>
      )}
      {outcome.detail && (
        <p role="status" className="flex items-start gap-1.5 text-sm text-warning-fg">
          <CircleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
          {t(outcome.detail, outcome.vars)}
        </p>
      )}
      {j.state === 'cancelled' && <p className="text-sm text-muted-foreground">{t('Optimisation cancelled. The plan is kept as a draft.')}</p>}
      {(j.state === 'succeeded' || j.state === 'cancelled') && planId && (
        <Button asChild size="sm" variant={j.state === 'succeeded' ? 'default' : 'outline'} className="justify-self-start">
          <Link to={planPath(planId)}>{t('Review plan')}</Link>
        </Button>
      )}
      {cancel.isError && <p className="text-sm text-destructive-fg">{plannerErrorMessage(cancel.error, t)}</p>}
    </div>
  );
}

/** Explicit solver weights (P6): the four the API takes; every one must be set (0 = ignore), nothing is assumed. */
export function WeightsEditor({ value, onChange, idPrefix, disabled, showErrors }: { value: WeightDraft; onChange: (w: WeightDraft) => void; idPrefix: string; disabled?: boolean; showErrors?: boolean }) {
  const { t } = useTranslation();
  return (
    <fieldset className="grid min-w-0 gap-2" disabled={disabled}>
      <legend className="mb-1 text-sm font-medium">{t('Objective weights')}</legend>
      <p className="text-xs text-muted-foreground">{t('Set all four weights (0 ignores one; at least one of distance, driving or route length above 0). Nothing is assumed.')}</p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {WEIGHT_KEYS.map((k) => (
          <WeightInput key={k} id={`${idPrefix}-${k}`} k={k} value={value[k]} invalid={!!showErrors && value[k] === null} onChange={(n) => onChange({ ...value, [k]: n })} />
        ))}
      </div>
    </fieldset>
  );
}

function WeightInput({ id, k, value, invalid, onChange }: { id: string; k: WeightKey; value: number | null; invalid: boolean; onChange: (n: number | null) => void }) {
  const { t } = useTranslation();
  const [text, setText] = useState(value === null ? '' : String(value));
  // Follow outside changes (another form prefilled) without fighting the user's typing ("0." stays "0.").
  if ((value === null ? '' : String(value)) !== text && parseWeight(text, k) !== value) setText(value === null ? '' : String(value));
  return (
    <div className="grid min-w-0 gap-1 rounded-md border bg-card px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={id} className="min-w-0 text-sm">
          {t(WEIGHT_LABEL[k])}
        </label>
        <Input
          id={id}
          type="text"
          inputMode="decimal"
          value={text}
          placeholder="—"
          aria-invalid={invalid || undefined}
          aria-describedby={`${id}-hint`}
          onChange={(e) => {
            setText(e.target.value);
            onChange(parseWeight(e.target.value, k));
          }}
          className="h-8 w-24 shrink-0 text-right tabular-nums"
        />
      </div>
      <p id={`${id}-hint`} className="text-xs text-muted-foreground">
        {t(WEIGHT_HINT[k])} {t('Range {{min}}–{{max}}.', { min: WEIGHT_MIN, max: WEIGHT_MAX[k].toLocaleString() })}
      </p>
    </div>
  );
}

/** Plan metrics as a definition list (vehicles, km, time, longest ride, warnings, unassigned). */
export function MetricsGrid({ m }: { m: PlanMetrics }) {
  const { t } = useTranslation();
  const items: [string, string, boolean?][] = [
    [t('Vehicles used'), t('{{used}} of {{total}}', { used: m.vehiclesUsed, total: m.vehiclesTotal })],
    [t('Distance'), formatKm(m.distanceM)],
    [t('Drive time'), formatDuration(m.driveS, t)],
    [t('Longest ride'), formatDuration(m.maxRideS, t)],
    [t('Warnings'), String(m.violations), m.violations > 0],
    [t('Unassigned'), `${m.unassigned} / ${m.passengers}`, m.unassigned > 0],
  ];
  return (
    <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
      {items.map(([label, v, warn]) => (
        <div key={label} className="rounded-lg border bg-card px-3 py-2">
          <dt className="text-xs text-muted-foreground">{label}</dt>
          <dd className={cn('text-base font-semibold tabular-nums', warn && 'text-warning-fg')}>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function UnassignedReasonText({ code }: { code: string | null }) {
  const { t } = useTranslation();
  return <>{t(unassignedReason(code))}</>;
}

export function ViolationList({ violations, labelOf }: { violations: readonly RoutePlanStopViolation[]; labelOf: (stopId: string, ref: string) => string }) {
  const { t } = useTranslation();
  if (!violations.length) return <p className="text-sm text-success-fg">{t('No warnings: every stop is within its window, seats and ride limit.')}</p>;
  return (
    <ul className="grid gap-1 text-sm" aria-label={t('Warnings')}>
      {violations.map((v) => (
        <li key={`${v.stopId}|${v.kind}`} className="flex items-start gap-1.5">
          <CircleAlertIcon className="mt-0.5 size-4 shrink-0 text-warning-fg" aria-hidden />
          <span>
            <span className="font-medium">{labelOf(v.stopId, v.ref)}</span> — {t(VIOLATION_LABEL[v.kind] ?? v.kind)}
          </span>
        </li>
      ))}
    </ul>
  );
}

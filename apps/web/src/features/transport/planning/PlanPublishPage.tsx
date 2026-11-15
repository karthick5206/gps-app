import type { PublishRoutePlanResult } from '@veetracer/shared';
import { ROUTE_PLAN_OVERRIDE_REASON_MAX, ROUTE_PLAN_OVERRIDE_REASON_MIN } from '@veetracer/shared';
import { ArrowLeftIcon, CircleAlertIcon, ExternalLinkIcon, RefreshCwIcon, SendIcon } from 'lucide-react';
import { useEffect, useReducer, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';
import { toast } from 'sonner';
import { FormError } from '@/components/form-error';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Field } from '@/components/ui/field';
import { Textarea } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { useAuth } from '@/features/auth/auth-context';
import { NotFoundPage } from '@/features/errors/ErrorPages';
import { getReportTimeZone } from '@/features/reports/report-time';
import { e3ErrorText } from '../dispatch/e3-format';
import { transportTripPath } from '../dispatch/use-e3';
import { initialReviewFlow, reviewFlow, reviewGate, reviewPublishState, reviewUnassignedReason, selectableRoutes } from './plan-review';
import { acknowledgedFingerprint, formatDuration, formatKm, isEditablePlan, planClock, plannerErrorText, VIOLATION_LABEL, warningsAcknowledged } from './planner-format';
import { EtaFootnote, PlanStatusBadge } from './planner-ui';
import { RoutingOffState } from './RoutingOffState';
import { createKeyStore, newKey, PLANNING_MENU, planPath, plannerErrorMessage, plannerErrorOf, plannerFlagOn, publishRouteErrors, useCapabilities, usePlan, usePublishReviewed, useReview } from './use-planner';

/**
 * E4 WP-W review & publish (doc 18 §6a step 4): choose the routes to publish (published ones are excluded), read the
 * server's review (vehicles, drivers, exact stop order with ETAs, km / time, occupancy, manual changes, passengers left
 * out with reasons, warnings to acknowledge, blocking errors), confirm, publish with `assignmentIds` + `reviewHash`. Any
 * change after the review (PLAN_REVIEW_STALE …) reloads it and needs a fresh confirmation. The rest of a partly
 * published plan stays editable on the plan page.
 */
export function PlanPublishPage() {
  const { id = '' } = useParams();
  const { t } = useTranslation();
  const { can } = useAuth();
  const tz = getReportTimeZone();
  const flag = plannerFlagOn();
  const caps = useCapabilities(flag);
  const q = usePlan(flag ? id : null);
  const plan = q.data;
  const [picked, setPicked] = useState<string[] | null>(null);
  const routes = plan ? selectableRoutes(plan) : [];
  const selection = (picked ?? routes.map((a) => a.id)).filter((x) => routes.some((a) => a.id === x));
  const review = useReview(plan && isEditablePlan(plan.status) ? plan.id : null, selection, selection.length > 0);
  const [keys] = useState(() => createKeyStore(newKey));
  const publish = usePublishReviewed(id, keys);
  const [flow, dispatch] = useReducer(reviewFlow, initialReviewFlow);
  // D-L3: the warning fingerprint the user acknowledged (a reload with other warnings un-ticks the box).
  const [ackedFingerprint, setAckedFingerprint] = useState<string | null>(null);
  const [overrideOn, setOverrideOn] = useState(false);
  const [overrideReason, setOverrideReason] = useState('');
  const [published, setPublished] = useState<PublishRoutePlanResult | null>(null);
  const hash = review.data?.reviewHash;
  useEffect(() => {
    if (!hash) return;
    dispatch({ type: 'loaded', hash });
    // A different review (reload, stale answer, other selection) needs the override decided again, like the warnings.
    setOverrideOn(false);
    setOverrideReason('');
  }, [hash]);

  const access = caps.data?.access;
  const canPublish = can(PLANNING_MENU, 'command') && (access?.canPublish ?? false) && !access?.support;

  if (!flag) return <NotFoundPage />;
  if (caps.data && !caps.data.enabled) {
    return (
      <div className="p-4 sm:p-6">
        <RoutingOffState reason={caps.data.offReason} />
      </div>
    );
  }
  const back = (
    <Button asChild variant="ghost" size="sm" className="justify-self-start self-start">
      <Link to={planPath(id)}>
        <ArrowLeftIcon /> {t('Back to the plan')}
      </Link>
    </Button>
  );
  if (q.isPending) return <div className="p-4 sm:p-6"><Skeleton className="h-96 w-full rounded-xl" /></div>;
  if (q.isError || !plan) {
    return (
      <div className="grid gap-3 p-4 sm:p-6">
        {back}
        <FormError message={plannerErrorMessage(q.error, t)} />
      </div>
    );
  }

  const r = review.data;
  const gate = r ? reviewGate(r) : null;
  const ackWarnings = gate ? warningsAcknowledged(ackedFingerprint, gate) : false;
  const state = r ? reviewPublishState(r, { confirmedHash: flow.confirmedHash, acknowledged: ackWarnings, overrideOn, reason: overrideReason }) : null;
  const routeNo = (aid: string) => plan.assignments.findIndex((a) => a.id === aid) + 1;
  const clock = (s: number | null) => (s === null ? null : planClock(r?.planStartAt ?? plan.planStartAt, s, tz));
  const codeText = (code: string, message: string) => {
    const own = plannerErrorText(code) ?? e3ErrorText(code);
    return own ? t(own) : message || code;
  };
  const stopName = (s: { passengerName: string | null; name: string | null; ref: string; stopKind: string | null; profileId: string | null }) => {
    const what = s.stopKind === 'DROP' ? t('Drop') : s.stopKind === 'PICKUP' ? t('Pickup') : '';
    if (s.profileId) return `${what} · ${s.passengerName ?? s.ref}`;
    return s.name ?? s.ref;
  };
  const issueText = (i: NonNullable<typeof gate>['hard'][number]) => {
    const at = clock(i.etaS);
    const from = i.window ? clock(i.window[0]) : null;
    const to = i.window ? clock(i.window[1]) : null;
    const when = at && from && to ? ` (${t('arrives {{eta}}, window {{from}}–{{to}}', { eta: at, from, to })})` : '';
    const stop = r?.routes.flatMap((x) => x.stops).find((s) => s.stopId === i.stopId);
    return `${t('Route {{n}} · {{vehicle}}', { n: routeNo(i.assignmentId), vehicle: i.vehicleLabel })} · ${stop ? stopName(stop) : i.ref} — ${t(VIOLATION_LABEL[i.kind] ?? i.kind)}${when}`;
  };

  const doPublish = () => {
    if (!state?.body) return;
    dispatch({ type: 'publish' });
    publish.mutate(state.body, {
      onSuccess: (res) => {
        dispatch({ type: 'success' });
        setPublished(res);
        setPicked(null);
        toast.success(t('Published: {{n}} trip(s) created in dispatch.', { n: res.trips.length }));
      },
      onError: (err) => {
        const { code } = plannerErrorOf(err);
        dispatch({ type: 'error', code });
        setAckedFingerprint(null);
        void review.refetch();
        void q.refetch();
      },
    });
  };
  const toggle = (aid: string, on: boolean) => {
    dispatch({ type: 'selection' });
    setPicked(on ? [...selection, aid] : selection.filter((x) => x !== aid));
  };

  return (
    <div className="flex w-full min-w-0 flex-col gap-3 p-4 sm:p-6">
      {back}
      <PageHeader breadcrumb={false} title={t('Review & publish')} description={<span className="flex flex-wrap items-center gap-1.5">{plan.name} <PlanStatusBadge status={plan.status} /></span>} />

      {published && (
        <Card className="gap-2 border-success/40 p-3" role="status">
          <h2 className="text-sm font-semibold">{t('Published to dispatch')}</h2>
          <ul className="grid gap-1 text-sm">
            {published.trips.map((tr) => {
              const a = plan.assignments.find((x) => x.id === tr.assignmentId);
              return (
                <li key={tr.transportTripId}>
                  <Link to={transportTripPath(tr.transportTripId)} className="inline-flex items-center gap-1 text-primary hover:underline">
                    <ExternalLinkIcon className="size-3.5" aria-hidden /> {t('Route {{n}} · {{vehicle}}', { n: routeNo(tr.assignmentId), vehicle: a?.vehicleLabel ?? '' })}
                  </Link>
                </li>
              );
            })}
          </ul>
          <div className="flex flex-wrap gap-2">
            <Button asChild size="sm" variant="outline">
              <Link to="/transport/dispatch">{t('Open the dispatch board')}</Link>
            </Button>
            {routes.length > 0 && (
              <Button asChild size="sm" variant="outline">
                <Link to={planPath(plan.id)}>{t('Edit the remaining routes')}</Link>
              </Button>
            )}
          </div>
        </Card>
      )}

      {plan.status === 'OPTIMIZING' ? (
        <p role="status" className="text-sm text-muted-foreground">{t('This plan is being optimised. Review and publish it when the optimisation has finished.')}</p>
      ) : !isEditablePlan(plan.status) ? (
        <p className="text-sm text-muted-foreground">{t('This plan is published or discarded; nothing is left to publish.')}</p>
      ) : routes.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('No unpublished route with passengers is left to publish.')}</p>
      ) : (
        <>
          <Card className="min-w-0 gap-2 p-3">
            <h2 className="text-sm font-semibold">{t('Routes to publish')}</h2>
            <ul className="grid gap-1.5 sm:grid-cols-2">
              {routes.map((a) => (
                <li key={a.id} className="flex items-start gap-2 text-sm">
                  <Checkbox id={`pub-${a.id}`} checked={selection.includes(a.id)} onCheckedChange={(v) => toggle(a.id, v === true)} className="mt-0.5" />
                  <label htmlFor={`pub-${a.id}`} className="min-w-0 break-words">
                    {t('Route {{n}} · {{vehicle}}', { n: routeNo(a.id), vehicle: a.vehicleName ?? a.vehicleLabel })}
                  </label>
                </li>
              ))}
            </ul>
            {plan.assignments.some((a) => a.published) && <p className="text-xs text-muted-foreground">{t('Published routes are not listed: they are already trips.')}</p>}
          </Card>

          {flow.notice === 'stale' && (
            <p role="alert" className="flex items-start gap-1.5 rounded-md border border-warning/40 bg-warning-soft p-3 text-sm text-warning-fg">
              <RefreshCwIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
              {t('The plan changed after your review. The review was reloaded; check it and confirm again.')}
            </p>
          )}

          {selection.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('Choose at least one route.')}</p>
          ) : review.isPending ? (
            <Skeleton className="h-64 w-full rounded-xl" />
          ) : review.isError || !r || !gate || !state ? (
            <FormError message={plannerErrorMessage(review.error, t)} />
          ) : (
            <>
              {r.routes.map((rt) => {
                const errs = gate.routeErrors.filter((e) => e.assignmentId === rt.assignmentId);
                const ch = r.manualChanges.routes.find((c) => c.assignmentId === rt.assignmentId);
                return (
                  <Card key={rt.assignmentId} className="min-w-0 gap-2 p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="min-w-0 flex-1 text-sm font-semibold break-words">{t('Route {{n}} · {{vehicle}}', { n: routeNo(rt.assignmentId), vehicle: rt.vehicleName ? `${rt.vehicleName}${rt.plateNumber ? ` · ${rt.plateNumber}` : ''}` : rt.vehicleLabel })}</h2>
                      <Badge variant="outline">{rt.seats === null ? t('{{n}} seats used · seats not set', { n: rt.passengers }) : t('{{used}} / {{capacity}} seats', { used: Math.round(rt.occupancy * rt.seats), capacity: rt.seats })}</Badge>
                      {ch && (ch.addedStopIds.length > 0 || ch.removedStopIds.length > 0 || ch.reordered || ch.vehicleChanged || ch.driverChanged) && <Badge variant="warning">{t('Changed by hand')}</Badge>}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {rt.driverName ? t('Driver: {{name}}', { name: rt.driverName }) : t('No driver')} · {rt.distanceM !== null && rt.durationS !== null ? t('{{km}} · {{time}} drive', { km: formatKm(rt.distanceM), time: formatDuration(rt.durationS, t) }) : t('No engine distance or time yet')}
                    </p>
                    {errs.map((e) => (
                      <p key={e.code} role="alert" className="flex items-start gap-1 text-sm font-medium text-destructive-fg">
                        <CircleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
                        {t('Blocks publishing: {{what}}', { what: codeText(e.code, e.message) })}
                      </p>
                    ))}
                    <ol className="divide-y rounded-md border text-sm" aria-label={t('Stops of route {{n}}', { n: routeNo(rt.assignmentId) })}>
                      {rt.stops.map((s, k) => (
                        <li key={s.stopId} className="flex flex-wrap items-center gap-2 p-2">
                          <span className="w-6 shrink-0 text-xs tabular-nums text-muted-foreground">{k + 1}.</span>
                          <span className="min-w-0 flex-1 break-words">{stopName(s)}</span>
                          <span className="text-xs tabular-nums">{clock(s.etaS) ?? t('No engine time')}</span>
                        </li>
                      ))}
                    </ol>
                  </Card>
                );
              })}
              <EtaFootnote />

              {r.unassigned.length > 0 && (
                <Card className="min-w-0 gap-1 p-3 text-sm">
                  <h2 className="font-semibold">{t('Passengers left out ({{n}})', { n: r.unassigned.length })}</h2>
                  <p className="text-xs text-muted-foreground">{t('They stay in the dispatch queue.')}</p>
                  <ul className="grid gap-0.5">
                    {Object.entries(r.unassigned.reduce<Record<string, number>>((m, u) => ({ ...m, [u.reason]: (m[u.reason] ?? 0) + 1 }), {})).map(([reason, n]) => (
                      <li key={reason}>
                        {t(reviewUnassignedReason(reason))}: <span className="tabular-nums">{n}</span>
                      </li>
                    ))}
                  </ul>
                </Card>
              )}

              {gate.hard.length > 0 && (
                <section className="grid gap-1.5 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-sm text-destructive-fg" aria-labelledby="publish-hard-title">
                  <h3 id="publish-hard-title" className="flex items-center gap-1.5 font-semibold">
                    <CircleAlertIcon className="size-4" aria-hidden /> {t('Hard violations (block publishing)')}
                  </h3>
                  <ul className="grid gap-0.5">
                    {gate.hard.map((i) => (
                      <li key={`${i.stopId}:${i.kind}`}>{issueText(i)}</li>
                    ))}
                  </ul>
                  <p>{t('These must be fixed before publishing. Edit the routes (move or reorder stops) or re-optimise the plan.')}</p>
                  {gate.canOverride && gate.blocking.length === 0 && (
                    <div className="grid gap-2 border-t border-destructive/30 pt-2">
                      <label className="flex items-start gap-2">
                        <Checkbox checked={overrideOn} onCheckedChange={(v) => setOverrideOn(v === true)} className="mt-0.5" />
                        <span>{t('Override the arrival-window violations (authorised)')}</span>
                      </label>
                      {overrideOn && (
                        <Field label={t('Reason for the override (recorded in the audit log)')} htmlFor="publish-override-reason" required hint={t('At least {{n}} characters, in words.', { n: ROUTE_PLAN_OVERRIDE_REASON_MIN })}>
                          <Textarea id="publish-override-reason" value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)} maxLength={ROUTE_PLAN_OVERRIDE_REASON_MAX} rows={3} required aria-required />
                        </Field>
                      )}
                    </div>
                  )}
                </section>
              )}
              {gate.soft.length > 0 && (
                <section className="grid gap-1.5 rounded-md border border-warning/40 bg-warning-soft p-2 text-sm text-warning-fg" aria-labelledby="publish-soft-title">
                  <h3 id="publish-soft-title" className="font-semibold">{t('Warnings')}</h3>
                  <ul className="grid gap-0.5">
                    {gate.soft.map((i) => (
                      <li key={`${i.stopId}:${i.kind}`}>{issueText(i)}</li>
                    ))}
                  </ul>
                  <label className="flex items-start gap-2">
                    <Checkbox checked={ackWarnings} onCheckedChange={(v) => setAckedFingerprint(acknowledgedFingerprint(v === true, gate))} className="mt-0.5" />
                    <span>{t('I have checked these {{n}} warning(s) and want to publish.', { n: gate.soft.length })}</span>
                  </label>
                </section>
              )}

              <Card className="min-w-0 gap-2 p-3">
                <label className="flex items-start gap-2 text-sm">
                  <Checkbox checked={state.confirmed} disabled={state.blocked} onCheckedChange={(v) => dispatch({ type: 'confirm', hash: r.reviewHash, on: v === true })} className="mt-0.5" />
                  <span>{t('I checked the vehicles, drivers and stop order above. Publish {{n}} route(s) as trips.', { n: r.assignmentIds.length })}</span>
                </label>
                {state.blocked && <p className="text-sm text-destructive-fg">{t('Fix the blocking errors above on the plan page, then come back.')}</p>}
                {publish.isError && <FormError message={plannerErrorMessage(publish.error, t)} />}
                {publishRouteErrors(publish.error).length > 0 && (
                  <ul className="grid gap-1 text-sm text-destructive-fg" aria-label={t('Routes that cannot be published')}>
                    {publishRouteErrors(publish.error).map((e) => (
                      <li key={e.assignmentId + e.code}>
                        <span className="font-medium">{t('Route {{n}} · {{vehicle}}', { n: routeNo(e.assignmentId), vehicle: e.vehicleLabel })}</span>: {codeText(e.code, e.message)}
                      </li>
                    ))}
                  </ul>
                )}
                {canPublish ? (
                  <Button className="justify-self-start" onClick={doPublish} disabled={publish.isPending || !state.allowed || review.isFetching}>
                    {publish.isPending ? <Spinner /> : <SendIcon />} {t('Publish {{n}} route(s)', { n: r.assignmentIds.length })}
                  </Button>
                ) : (
                  <p className="text-sm text-muted-foreground">{t('Publishing needs the Route planning → command permission.')}</p>
                )}
              </Card>
            </>
          )}
        </>
      )}
    </div>
  );
}

import type { PublishRoutePlanResult, RoutePlanStopViolation } from '@veetracer/shared';
import { ROUTE_PLAN_OVERRIDE_REASON_MAX, ROUTE_PLAN_OVERRIDE_REASON_MIN } from '@veetracer/shared';
import {
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowRightLeftIcon,
  ArrowUpIcon,
  CarFrontIcon,
  CircleAlertIcon,
  CrosshairIcon,
  ExternalLinkIcon,
  HistoryIcon,
  LockIcon,
  LockOpenIcon,
  PinIcon,
  PinOffIcon,
  RefreshCwIcon,
  SendIcon,
  Trash2Icon,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { FormError } from '@/components/form-error';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Textarea } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { useAuth } from '@/features/auth/auth-context';
import { NotFoundPage } from '@/features/errors/ErrorPages';
import { getReportTimeZone } from '@/features/reports/report-time';
import { cn } from '@/lib/utils';
import { DIRECTION_LABEL, e3ErrorText } from '../dispatch/e3-format';
import { SimpleSelect } from '../dispatch/e3-ui';
import { transportTripPath } from '../dispatch/use-e3';
import { PlanMap } from './PlanMap';
import { MaxRideOverrideFields } from './MaxRideFields';
import { canOverrideMaxRide, maxRideSummary, overrideDraftOf, overrideRequest, type MaxRideOverrideDraft } from './max-ride';
import {
  canShiftStop,
  capabilityView,
  completeWeights,
  engineEta,
  reoptimiseDefaults,
  routeDriveSummary,
  timeLimitOptions,
  formatDuration,
  formatKm,
  isEditablePlan,
  mapPoints,
  mergeViolations,
  publishable,
  planClock,
  publishGate,
  publishGateState,
  movePassenger,
  changedRoutes,
  planMetrics,
  routeLines,
  routeLoad,
  routesOf,
  routeStops,
  shiftStop,
  stopEta,
  stopLabel,
  activeJobId,
  unassignedPassengers,
  vehicleColor,
  VIOLATION_LABEL,
  plannerErrorText,
  type PlannerPlan,
  type PlannerStop,
  type WeightDraft,
} from './planner-format';
import { CapabilityChip, EtaFootnote, EtaQualityBadge, JobProgress, MetricsGrid, PlanStatusBadge, UnassignedReasonText, ViolationList, WeightsEditor } from './planner-ui';
import {
  createKeyStore,
  newKey,
  PLANNING_MENU,
  PLANNING_PATH,
  plannerErrorMessage,
  plannerErrorOf,
  publishRouteErrors,
  plannerFlagOn,
  useCapabilities,
  useDiscardPlan,
  usePlan,
  usePlanEdit,
  usePlanHistory,
  usePlanOpenJobs,
  usePlannerVehicles,
  usePublishPlan,
  useReoptimise,
  type PlanEdit,
} from './use-planner';

const CHANGE_LABEL: Record<string, string> = {
  CREATED: 'Created',
  EDITED: 'Edited',
  OPTIMIZED: 'Optimised',
  RESEQUENCED: 'Stops re-ordered',
  RECALCULATED: 'Recalculated',
  PUBLISHED: 'Published',
  CANCELLED: 'Discarded',
  ERASED: 'Passenger data erased',
};

/**
 * One plan (E4 WP 4.5): metrics, routes with their stops, unassigned passengers with reasons, the map (consent-allowed
 * points only), explicit edits (move passenger, up / down, change vehicle, pin) with re-validation and version-conflict
 * handling, re-optimise, publish with confirmation (→ links to the E3 trips) and discard.
 */
export function PlanReviewPage() {
  const { id = '' } = useParams();
  const { t } = useTranslation();
  const { can } = useAuth();
  const navigate = useNavigate();
  const tz = getReportTimeZone();
  const flag = plannerFlagOn();
  const caps = useCapabilities(flag);
  const q = usePlan(flag ? id : null);
  const plan = q.data;
  const edit = usePlanEdit(plan);
  // Idempotency-Keys for this page's keyed actions (publish, re-optimise): a retry replays, a 4xx frees the key.
  const [keys] = useState(() => createKeyStore(newKey));
  const publish = usePublishPlan(plan, keys);
  const discard = useDiscardPlan();
  const reopt = useReoptimise(plan, keys);
  const history = useState(false);
  const [showHistory, setShowHistory] = history;
  const hist = usePlanHistory(plan?.id ?? null, showHistory);
  const [jobId, setJobId] = useState<string | null>(null);
  // After a reload (or a job started in another tab) the page finds the plan's running job on the server.
  const openJobs = usePlanOpenJobs(plan?.id ?? null, plan?.status === 'OPTIMIZING' && !jobId);
  const [focus, setFocus] = useState<number | null>(null);
  const [lastCheck, setLastCheck] = useState<RoutePlanStopViolation[] | null>(null);
  const [conflict, setConflict] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [moveReq, setMoveReq] = useState<PlannerStop | null>(null);
  const [vehicleReq, setVehicleReq] = useState<string | null>(null);
  const [publishOpen, setPublishOpen] = useState(false);
  const [ackWarnings, setAckWarnings] = useState(false);
  // Decision 5: authorised override of arrival-window violations (reason recorded and audited by the server).
  const [overrideOn, setOverrideOn] = useState(false);
  const [overrideReason, setOverrideReason] = useState('');
  const [published, setPublished] = useState<PublishRoutePlanResult | null>(null);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [reoptOpen, setReoptOpen] = useState(false);
  const [reoptWeights, setReoptWeights] = useState<WeightDraft | null>(null);
  const [reoptLimit, setReoptLimit] = useState<number | null>(null);
  // Owner decision 1: per-plan max-ride override in the re-optimise dialog (null = start from the plan's own).
  const [reoptRide, setReoptRide] = useState<MaxRideOverrideDraft | null>(null);
  const [reoptTouched, setReoptTouched] = useState(false);
  // K1 / K2: keyboard focus survives an edit (the clicked button is disabled while it runs) and a dialog opened from
  // a button returns focus to it. Buttons carry data-focus-key; the first focusable key of the list wins.
  const pendingFocus = useRef<string[] | null>(null);
  const dialogReturn = useRef<string[] | null>(null);
  useEffect(() => {
    if (!pendingFocus.current || edit.isPending) return;
    if (focusKey(pendingFocus.current)) pendingFocus.current = null;
  });
  const [degraded, setDegraded] = useState<string | null>(null);

  const metrics = useMemo(() => (plan ? planMetrics(plan, lastCheck ?? undefined) : null), [plan, lastCheck]);
  const access = caps.data?.access;
  const support = !!access?.support;
  const editable = !!plan && isEditablePlan(plan.status) && plan.editable !== false;
  const canEdit = editable && can(PLANNING_MENU, 'edit') && (access?.canEdit ?? false) && !support;
  // B3: DRAFT or PLANNED with at least one route that has passengers and no blocking violation; the server decides the rest.
  const canPublish = !!plan && publishable(plan, lastCheck ?? undefined) && can(PLANNING_MENU, 'command') && (access?.canPublish ?? false) && !support;
  const canDiscard = editable && can(PLANNING_MENU, 'delete') && (access?.canDelete ?? false) && !support;
  const canReopt = editable && can(PLANNING_MENU, 'create') && (access?.canPlan ?? false) && !support && capabilityView(caps.data).canOptimise;
  const health = capabilityView(caps.data);

  if (!flag) return <NotFoundPage />;
  if (q.isPending) return <div className="p-4 sm:p-6"><Skeleton className="h-96 w-full rounded-xl" /></div>;
  if (q.isError || !plan || !metrics) {
    return (
      <div className="grid gap-3 p-4 sm:p-6">
        <Button asChild variant="ghost" size="sm" className="justify-self-start">
          <Link to={PLANNING_PATH}>
            <ArrowLeftIcon /> {t('Route planning')}
          </Link>
        </Button>
        <FormError message={plannerErrorMessage(q.error, t)} />
      </div>
    );
  }

  const announce = (msg: string) => {
    setAnnouncement('');
    requestAnimationFrame(() => setAnnouncement(msg));
  };
  const violations = mergeViolations(plan.violations ?? [], lastCheck ?? []);
  const violationsOf = (stopId: string) => violations.filter((v) => v.stopId === stopId);
  const stopById = new Map(plan.stops.map((s) => [s.id, s]));
  const labelOf = (stopId: string, ref: string) => {
    const s = stopById.get(stopId);
    return s ? stopLabel(s, t) : ref;
  };
  // Decision 5: the server's publish classification (hard blocks, soft needs the acknowledgement, override if authorised).
  const gate = publishGate(plan);
  const gateState = publishGateState(gate, { acknowledged: ackWarnings, overrideOn: overrideOn && gate.canOverride, reason: overrideReason });
  const routeNo = (assignmentId: string) => plan.assignments.findIndex((a) => a.id === assignmentId) + 1;
  const issueText = (i: (typeof gate.hard)[number]) => {
    // Times only from the routing engine (never another source), as everywhere on the page.
    const engine = engineEta(plan.assignments.find((a) => a.id === i.assignmentId)?.eta ?? null);
    const at = engine ? planClock(plan.planStartAt, i.etaS, tz) : null;
    const from = i.window ? planClock(plan.planStartAt, i.window[0], tz) : null;
    const to = i.window ? planClock(plan.planStartAt, i.window[1], tz) : null;
    const when = at && from && to ? ` (${t('arrives {{eta}}, window {{from}}–{{to}}', { eta: at, from, to })})` : '';
    const route = routeNo(i.assignmentId) > 0 ? `${t('Route {{n}} · {{vehicle}}', { n: routeNo(i.assignmentId), vehicle: i.vehicleLabel })} · ` : '';
    return `${route}${labelOf(i.stopId, i.ref)} — ${t(VIOLATION_LABEL[i.kind] ?? i.kind)}${when}`;
  };
  const { points, hidden } = mapPoints(plan, plan.precise);
  const lines = routeLines(plan);
  const nonEngine = plan.assignments.some((a) => a.eta && !engineEta(a.eta));
  const unassigned = unassignedPassengers(plan.stops, plan.direction);
  const routes = routesOf(plan);
  const busy = edit.isPending || plan.status === 'OPTIMIZING';
  const activeJob = activeJobId(plan, jobId, openJobs.data);

  const runEdit = (e: PlanEdit, ok: string, focusAfter?: string[]) => {
    setEditError(null);
    const active = typeof document !== 'undefined' ? document.activeElement?.getAttribute('data-focus-key') : null;
    pendingFocus.current = focusAfter ?? (active ? [active] : null);
    edit.mutate(e, {
      onSuccess: (r) => {
        setConflict(false);
        setLastCheck(r.violations);
        setDegraded(r.degraded ?? null);
        const msg = r.violations.length ? t('{{ok}} Re-checked: {{n}} warning(s).', { ok, n: r.violations.length }) : t('{{ok}} Re-checked: no warnings.', { ok });
        announce(msg);
        if (r.violations.length) toast.warning(msg);
        else toast.success(msg);
      },
      onError: (err) => {
        const k = plannerErrorOf(err).kind;
        if (k === 'conflict') setConflict(true);
        setEditError(plannerErrorMessage(err, t));
        announce(plannerErrorMessage(err, t));
      },
    });
  };
  const reorder = (stop: PlannerStop, delta: -1 | 1) => {
    const next = changedRoutes(routes, shiftStop(routes, stop.id, delta));
    if (!next.length) return;
    const dir = delta < 0 ? 'up' : 'down';
    runEdit({ kind: 'sequence', assignments: next }, delta < 0 ? t('{{name}} moved up.', { name: stopLabel(stop, t) }) : t('{{name}} moved down.', { name: stopLabel(stop, t) }), [`${stop.id}:${dir}`, `${stop.id}:${dir === 'up' ? 'down' : 'up'}`, `${stop.id}:pin`]);
  };
  const openMove = (s: PlannerStop) => {
    dialogReturn.current = [`${s.id}:move`, `${s.id}:pin`];
    setMoveReq(s);
  };
  const openVehicle = (aid: string) => {
    dialogReturn.current = [`route:${aid}:vehicle`, `route:${aid}:lock`];
    setVehicleReq(aid);
  };
  // Radix returns focus to a DialogTrigger only; these dialogs open from state, so focus goes back by key.
  const returnFocus = (e: Event) => {
    e.preventDefault();
    const keys = dialogReturn.current;
    dialogReturn.current = null;
    if (keys && !pendingFocus.current) focusKey(keys);
  };
  const moveTo = (stop: PlannerStop, assignmentId: string) => {
    setMoveReq(null);
    const idx = plan.assignments.findIndex((a) => a.id === assignmentId);
    const ok = t('{{name}} moved to route {{n}}.', { name: stopLabel(stop, t), n: idx + 1 });
    // A booking moves with both ends (POST move-passenger); a generic stop through the sequence.
    const back = [`${stop.id}:move`, `${stop.id}:pin`];
    if (stop.bookingId) return runEdit({ kind: 'move', bookingId: stop.bookingId, toAssignmentId: assignmentId }, ok, back);
    const next = changedRoutes(routes, movePassenger(routes, plan.stops, stop.id, assignmentId));
    if (next.length) runEdit({ kind: 'sequence', assignments: next }, ok, back);
  };
  const doPublish = () => {
    // Key per (plan, version) from the page's key store: a retry replays; a refusal (4xx) frees it (usePublishPlan).
    publish.mutate(gateState.body, {
      onSuccess: (r) => {
        setPublished(r);
        setPublishOpen(false);
        const msg = t('Published: {{n}} trip(s) created in dispatch.', { n: r.trips.length });
        announce(msg);
        toast.success(msg);
      },
      onError: (err) => {
        if (plannerErrorOf(err).kind === 'conflict') setConflict(true);
      },
    });
  };
  // T2-L4: the plan's stored weights (options.weights) and a time limit within the API range.
  const reoptDefaults = reoptimiseDefaults(plan);
  const weightsForReopt = reoptWeights ?? reoptDefaults.weights;
  const limitForReopt = reoptLimit ?? reoptDefaults.timeLimitS;
  const rideForReopt = reoptRide ?? overrideDraftOf(plan);
  const rideRequest = canOverrideMaxRide(caps.data) ? overrideRequest(rideForReopt, plan.maxRide?.override) : ({ ok: true, value: undefined } as const);

  return (
    <div className="flex w-full min-w-0 flex-col gap-3 p-4 sm:p-6">
      <Button asChild variant="ghost" size="sm" className="justify-self-start self-start">
        <Link to={PLANNING_PATH}>
          <ArrowLeftIcon /> {t('Route planning')}
        </Link>
      </Button>
      <PageHeader
        breadcrumb={false}
        title={plan.name}
        description={
          <span className="flex flex-wrap items-center gap-1.5">
            <PlanStatusBadge status={plan.status} />
            {plan.direction && <Badge variant="outline">{t(DIRECTION_LABEL[plan.direction])}</Badge>}
            <Badge variant="outline">{t('Version {{v}}', { v: plan.version })}</Badge>
            <EtaQualityBadge quality={metrics.etaQuality} />
            <CapabilityChip caps={caps.data} />
          </span>
        }
        actions={
          <div className="flex flex-wrap gap-2">
            {canReopt && (
              <Button variant="outline" size="sm" disabled={busy || reopt.isPending} onClick={() => setReoptOpen(true)}>
                <RefreshCwIcon /> {t('Re-optimise')}
              </Button>
            )}
            {canDiscard && (
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => setDiscardOpen(true)}>
                <Trash2Icon /> {t('Discard')}
              </Button>
            )}
            {canPublish && (
              <Button
                size="sm"
                disabled={busy}
                onClick={() => {
                  publish.reset();
                  setAckWarnings(false);
                  setOverrideOn(false);
                  setOverrideReason('');
                  setPublishOpen(true);
                }}
              >
                <SendIcon /> {t('Publish…')}
              </Button>
            )}
          </div>
        }
      />

      {!health.canOptimise && health.detail && (
        <p role="status" className="rounded-md border border-warning/40 bg-warning-soft p-3 text-sm text-warning-fg">
          {t(health.detail)} {lines.length > 0 && t('Times below are from the last engine run.')}
        </p>
      )}
      {nonEngine && (
        <p role="status" className="rounded-md border border-warning/40 bg-warning-soft p-3 text-sm text-warning-fg">
          {t('Some routes have times that did not come from the routing engine. They are hidden; re-optimise when routing is back.')}
        </p>
      )}
      {conflict && (
        <div role="alert" className="flex flex-wrap items-center gap-2 rounded-md border border-destructive/40 bg-destructive-soft p-3 text-sm text-destructive-fg">
          <CircleAlertIcon className="size-4 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1">{t('Someone changed this plan meanwhile. The latest version (v{{v}}) is shown; check it and redo your change.', { v: plan.version })}</span>
          <Button size="sm" variant="outline" onClick={() => setConflict(false)}>
            {t('OK')}
          </Button>
        </div>
      )}
      {editError && !conflict && <FormError message={editError} />}
      {degraded && (
        <p role="status" className="rounded-md border border-warning/40 bg-warning-soft p-3 text-sm text-warning-fg">
          {t('Routing unavailable: the changed routes could not be re-timed, so they show no times. Nothing was estimated.')}
        </p>
      )}

      {activeJob && (
        <Card className="p-3">
          <JobProgress jobId={activeJob} planId={null} label={t('Optimising this plan')} canCancel={canReopt || can(PLANNING_MENU, 'create')} />
        </Card>
      )}

      {published && (
        <Card className="gap-2 border-success/40 p-3" role="status">
          <h2 className="text-sm font-semibold">{t('Published to dispatch')}</h2>
          <ul className="grid gap-1 text-sm">
            {published.trips.map((tr) => {
              const idx = plan.assignments.findIndex((a) => a.id === tr.assignmentId);
              const a = plan.assignments[idx];
              return (
                <li key={tr.transportTripId}>
                  <Link to={transportTripPath(tr.transportTripId)} className="inline-flex items-center gap-1 text-primary hover:underline">
                    <ExternalLinkIcon className="size-3.5" aria-hidden /> {t('Route {{n}} · {{vehicle}}', { n: idx + 1, vehicle: a?.vehicleLabel ?? '' })}
                  </Link>
                </li>
              );
            })}
          </ul>
          <Button asChild size="sm" variant="outline" className="justify-self-start">
            <Link to="/transport/dispatch">{t('Open the dispatch board')}</Link>
          </Button>
        </Card>
      )}

      {/* Decision 5: a plan published with an authorised override shows it (reason and what was overridden). */}
      {plan.publishDecision?.override && (
        <Card className="gap-1 border-warning/40 p-3 text-sm" role="note" aria-labelledby="publish-override-title">
          <h2 id="publish-override-title" className="font-semibold">{t('Published with an authorised override')}</h2>
          <p>{t('{{n}} arrival-window violation(s) overridden.', { n: plan.publishDecision.override.violations.length })}</p>
          <p className="whitespace-pre-wrap break-words">“{plan.publishDecision.override.reason}”</p>
        </Card>
      )}

      <MetricsGrid m={metrics} />
      <p className="text-sm text-muted-foreground">
        <span className="font-medium text-foreground">{t('Maximum ride time')}:</span> {maxRideSummary(plan.maxRide, t)}
      </p>
      <EtaFootnote />

      <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="grid min-w-0 content-start gap-3">
          {plan.assignments.map((a, i) => {
            const stops = routeStops(plan.stops, a.id);
            const load = routeLoad(stops, plan.direction);
            const over = a.capacity !== null && load > a.capacity;
            const vehicle = a.vehicleName ? `${a.vehicleName}${a.plateNumber ? ` · ${a.plateNumber}` : ''}` : a.vehicleLabel;
            return (
              <Card key={a.id} className="min-w-0 gap-2 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="size-3 shrink-0 rounded-full" style={{ background: vehicleColor(i) }} aria-hidden />
                  <h2 className="min-w-0 flex-1 text-sm font-semibold break-words">{t('Route {{n}} · {{vehicle}}', { n: i + 1, vehicle })}</h2>
                  {a.locked && (
                    <Badge variant="info">
                      <LockIcon aria-hidden /> {t('Locked')}
                    </Badge>
                  )}
                  <Badge variant={over ? 'destructive' : 'outline'}>{a.capacity === null ? t('{{n}} seats used · seats not set', { n: load }) : t('{{used}} / {{capacity}} seats', { used: load, capacity: a.capacity })}</Badge>
                </div>
                {a.driverName && <p className="text-xs text-muted-foreground">{t('Driver: {{name}}', { name: a.driverName })}</p>}
                <p className="text-xs text-muted-foreground">
                  {(() => {
                    // T2-L1: engine numbers only when the engine produced both (not "— · — drive" after an edit while it was down).
                    const d = routeDriveSummary(a, stops.length);
                    return d.kind === 'engine' ? t('{{km}} · {{time}} drive', { km: formatKm(d.distanceM), time: formatDuration(d.durationS, t) }) : d.kind === 'pending' ? t('No engine distance or time yet') : t('No stops on this route');
                  })()}
                </p>
                <div className="flex flex-wrap gap-1.5">
                  <Button size="sm" variant="ghost" aria-pressed={focus === i} onClick={() => setFocus(focus === i ? null : i)}>
                    <CrosshairIcon /> {focus === i ? t('Show all routes') : t('Show on map')}
                  </Button>
                  {canEdit && (
                    <>
                      <Button size="sm" variant="ghost" data-focus-key={`route:${a.id}:vehicle`} disabled={busy || a.locked} onClick={() => openVehicle(a.id)}>
                        <CarFrontIcon /> {t('Change vehicle')}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-pressed={a.locked}
                        data-focus-key={`route:${a.id}:lock`}
                        disabled={busy}
                        onClick={() => runEdit({ kind: 'lock', assignmentId: a.id, locked: !a.locked }, a.locked ? t('Route {{n}} unlocked.', { n: i + 1 }) : t('Route {{n}} locked: re-optimising keeps its stops and order.', { n: i + 1 }))}
                      >
                        {a.locked ? <LockOpenIcon /> : <LockIcon />} {a.locked ? t('Unlock route') : t('Lock route')}
                      </Button>
                    </>
                  )}
                  {a.transportTripId && (
                    <Button asChild size="sm" variant="outline">
                      <Link to={transportTripPath(a.transportTripId)}>
                        <ExternalLinkIcon /> {t('Open trip')}
                      </Link>
                    </Button>
                  )}
                </div>
                {stops.length > 0 && (
                  <ol className="divide-y rounded-md border" aria-label={t('Stops of route {{n}}', { n: i + 1 })}>
                    {stops.map((s, k) => {
                      const eta = stopEta(s, a, plan.planStartAt, tz);
                      const warn = violationsOf(s.id);
                      return (
                        <li key={s.id} className="grid gap-1 p-2">
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                            <span className="flex size-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white" style={{ background: vehicleColor(i) }} aria-hidden>
                              {k + 1}
                            </span>
                            <span className="min-w-0 flex-1 text-sm break-words">
                              <span className="sr-only">{t('Stop {{n}}:', { n: k + 1 })} </span>
                              {stopLabel(s, t)}
                            </span>
                            {s.pinned && (
                              <Badge variant="info">
                                <PinIcon aria-hidden /> {t('Pinned')}
                              </Badge>
                            )}
                            <span className="basis-full ps-8 text-xs">
                              {eta.at ? (
                                <>
                                  <span className="font-medium tabular-nums">{eta.at}</span> <span className="text-muted-foreground">· {t(eta.note)}</span>
                                </>
                              ) : (
                                <span className="text-muted-foreground">{t(eta.note)}</span>
                              )}
                            </span>
                          </div>
                          {warn.length > 0 && (
                            <p className="flex items-start gap-1 text-xs text-warning-fg">
                              <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                              {warn.map((v) => t(VIOLATION_LABEL[v.kind] ?? v.kind)).join(' · ')}
                            </p>
                          )}
                          {canEdit && (
                            <div className="flex flex-wrap gap-1">
                              <Button size="icon-sm" variant="outline" data-focus-key={`${s.id}:up`} disabled={busy || !canShiftStop(stops, k, -1) || a.locked} onClick={() => reorder(s, -1)} aria-label={t('Move {{name}} up', { name: stopLabel(s, t) })}>
                                <ArrowUpIcon />
                              </Button>
                              <Button size="icon-sm" variant="outline" data-focus-key={`${s.id}:down`} disabled={busy || !canShiftStop(stops, k, 1) || a.locked} onClick={() => reorder(s, 1)} aria-label={t('Move {{name}} down', { name: stopLabel(s, t) })}>
                                <ArrowDownIcon />
                              </Button>
                              <Button size="sm" variant="outline" data-focus-key={`${s.id}:move`} disabled={busy || s.pinned || a.locked || plan.assignments.length < 2} onClick={() => openMove(s)}>
                                <ArrowRightLeftIcon /> {t('Move to…')}
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                aria-pressed={!!s.pinned}
                                data-focus-key={`${s.id}:pin`}
                                disabled={busy}
                                onClick={() => runEdit({ kind: 'pin', stopId: s.id, pinned: !s.pinned }, s.pinned ? t('{{name}} unpinned.', { name: stopLabel(s, t) }) : t('{{name}} pinned to this vehicle. Re-optimising keeps it on this vehicle; its place in the order may change.', { name: stopLabel(s, t) }))}
                              >
                                {s.pinned ? <PinOffIcon /> : <PinIcon />} {s.pinned ? t('Unpin') : t('Pin')}
                              </Button>
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ol>
                )}
              </Card>
            );
          })}

          <Card className="min-w-0 gap-2 p-3">
            <h2 className="text-sm font-semibold">
              {t('Unassigned passengers')} <span className="tabular-nums text-muted-foreground">({unassigned.length})</span>
            </h2>
            {unassigned.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('Every passenger has a seat on a route.')}</p>
            ) : (
              <ul className="divide-y rounded-md border">
                {unassigned.map((s) => (
                  <li key={s.id} className="flex flex-wrap items-center gap-2 p-2">
                    <div className="grid min-w-0 flex-1 gap-0.5">
                      <span className="text-sm break-words">{stopLabel(s, t)}</span>
                      <span className="text-xs text-warning-fg">
                        <UnassignedReasonText code={s.unassignedReason} />
                      </span>
                    </div>
                    {canEdit && plan.assignments.length > 0 && (
                      <Button size="sm" variant="outline" disabled={busy} onClick={() => setMoveReq(s)}>
                        <ArrowRightLeftIcon /> {t('Add to route…')}
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card className="min-w-0 gap-2 p-3">
            <h2 className="text-sm font-semibold">{lastCheck ? t('Re-check after your last change') : t('Warnings')}</h2>
            <ViolationList violations={violations} labelOf={labelOf} />
          </Card>
        </div>

        <div className="grid min-w-0 content-start gap-2 lg:sticky lg:top-4 lg:self-start">
          <PlanMap lines={lines} points={points} depot={plan.depot} focus={focus} className="h-[320px] sm:h-[420px] lg:h-[560px]" label={t('Map of the routes of {{name}}', { name: plan.name })} />
          <p className="text-xs text-muted-foreground">
            {hidden > 0 ? t('{{n}} passenger point(s) are not on the map (no transport consent or outside your branches); the lists still show them.', { n: hidden }) : t('Only points you may see are drawn; routes follow the engine’s road geometry.')}
            {!plan.precise ? ` ${t('Points are approximate (about 11 m) for your role.')}` : ''}
          </p>
          <Button size="sm" variant="ghost" className="justify-self-start" aria-expanded={showHistory} onClick={() => setShowHistory((v) => !v)}>
            <HistoryIcon /> {showHistory ? t('Hide history') : t('Show history')}
          </Button>
          {showHistory && (
            <Card className="min-w-0 gap-1 p-3">
              {hist.isPending ? (
                <Spinner />
              ) : (
                <ol className="grid gap-1 text-sm">
                  {(hist.data ?? []).map((v) => (
                    <li key={v.version} className="flex flex-wrap gap-2">
                      <span className="tabular-nums text-muted-foreground">v{v.version}</span>
                      <span className="min-w-0 flex-1">{t(CHANGE_LABEL[v.changeType] ?? v.changeType)}</span>
                      <time className="text-xs text-muted-foreground" dateTime={v.createdAt}>
                        {new Date(v.createdAt).toLocaleString()}
                      </time>
                    </li>
                  ))}
                </ol>
              )}
            </Card>
          )}
        </div>
      </div>

      <div aria-live="polite" className="sr-only">
        {announcement}
      </div>

      {/* Move a passenger to another route (pickup and drop move together). */}
      <MoveDialog
        stop={moveReq}
        plan={plan}
        onClose={() => setMoveReq(null)}
        onPick={(aid) => moveReq && moveTo(moveReq, aid)}
        onCloseAutoFocus={returnFocus}
      />

      {vehicleReq && (
        <VehicleDialog
          plan={plan}
          assignmentId={vehicleReq}
          onClose={() => {
            setVehicleReq(null);
            const keys = dialogReturn.current;
            dialogReturn.current = null;
            if (keys) requestAnimationFrame(() => focusKey(keys));
          }}
          onCloseAutoFocus={returnFocus}
          onPick={(v) => {
            const idx = plan.assignments.findIndex((a) => a.id === vehicleReq);
            runEdit({ kind: 'vehicle', assignmentId: vehicleReq, objectId: v.objectId }, t('Route {{n}} now uses {{vehicle}}.', { n: idx + 1, vehicle: v.name }), [`route:${vehicleReq}:vehicle`, `route:${vehicleReq}:lock`]);
            setVehicleReq(null);
          }}
        />
      )}

      {/* Publish → confirmation. */}
      <Dialog open={publishOpen} onOpenChange={(o) => !publish.isPending && setPublishOpen(o)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('Publish this plan?')}</DialogTitle>
            <DialogDescription>{t('Each route with passengers becomes a trip on the dispatch board, with its vehicle and seats. The plan then becomes read-only.')}</DialogDescription>
          </DialogHeader>
          <DialogBody className="grid gap-3 text-sm">
            <ul className="grid gap-1">
              <li>{t('{{n}} trip(s) will be created.', { n: metrics.vehiclesUsed })}</li>
              <li>{t('{{n}} passenger(s) seated.', { n: metrics.passengers - metrics.unassigned })}</li>
              {metrics.unassigned > 0 && <li className="text-warning-fg">{t('{{n}} unassigned passenger(s) stay in the dispatch queue.', { n: metrics.unassigned })}</li>}
            </ul>
            {/* Decision 5: hard violations block publishing (the server refuses them too). */}
            {gate.hard.length > 0 && (
              <section className="grid gap-1.5 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-destructive-fg" aria-labelledby="publish-hard-title">
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
                        <Textarea
                          id="publish-override-reason"
                          value={overrideReason}
                          onChange={(e) => setOverrideReason(e.target.value)}
                          maxLength={ROUTE_PLAN_OVERRIDE_REASON_MAX}
                          rows={3}
                          required
                          aria-required
                        />
                      </Field>
                    )}
                  </div>
                )}
              </section>
            )}
            {/* Soft warnings: publishable after an explicit acknowledgement of exactly this set. */}
            {gate.soft.length > 0 && (
              <section className="grid gap-1.5 rounded-md border border-warning/40 bg-warning-soft p-2 text-warning-fg" aria-labelledby="publish-soft-title">
                <h3 id="publish-soft-title" className="font-semibold">{t('Warnings')}</h3>
                <ul className="grid gap-0.5">
                  {gate.soft.map((i) => (
                    <li key={`${i.stopId}:${i.kind}`}>{issueText(i)}</li>
                  ))}
                </ul>
                <label className="flex items-start gap-2">
                  <Checkbox checked={ackWarnings} onCheckedChange={(v) => setAckWarnings(v === true)} className="mt-0.5" />
                  <span>{t('I have checked these {{n}} warning(s) and want to publish.', { n: gate.soft.length })}</span>
                </label>
              </section>
            )}
            <EtaFootnote />
            {publish.isError && <FormError message={plannerErrorMessage(publish.error, t)} />}
            {publishRouteErrors(publish.error).length > 0 && (
              <ul className="grid gap-1 text-sm text-destructive-fg" aria-label={t('Routes that cannot be published')}>
                {publishRouteErrors(publish.error).map((r) => {
                  const idx = plan.assignments.findIndex((a) => a.id === r.assignmentId);
                  return (
                    <li key={r.assignmentId + r.code}>
                      <span className="font-medium">{t('Route {{n}} · {{vehicle}}', { n: idx + 1, vehicle: r.vehicleLabel })}</span>: {plannerErrorText(r.code) ? t(plannerErrorText(r.code) as string) : e3ErrorText(r.code) ? t(e3ErrorText(r.code) as string) : r.message}
                    </li>
                  );
                })}
              </ul>
            )}
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPublishOpen(false)} disabled={publish.isPending}>
              {t('Back')}
            </Button>
            <Button onClick={doPublish} disabled={publish.isPending || !gateState.allowed || metrics.vehiclesUsed === 0}>
              {publish.isPending ? <Spinner /> : <SendIcon />} {t('Publish')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={discardOpen}
        onOpenChange={setDiscardOpen}
        title={t('Discard this plan?')}
        description={t('The plan is marked discarded and can no longer change. Its history is kept; nothing is published.')}
        confirmLabel={t('Discard')}
        destructive
        pending={discard.isPending}
        onConfirm={() =>
          discard.mutate(
            { id: plan.id, version: plan.version },
            {
              onSuccess: () => {
                setDiscardOpen(false);
                toast.success(t('Plan discarded.'));
                void navigate(PLANNING_PATH);
              },
              onError: (err) => {
                setDiscardOpen(false);
                if (plannerErrorOf(err).kind === 'conflict') setConflict(true);
                toast.error(plannerErrorMessage(err, t));
              },
            },
          )
        }
      />

      <Dialog open={reoptOpen} onOpenChange={(o) => !reopt.isPending && setReoptOpen(o)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('Re-optimise this plan')}</DialogTitle>
            <DialogDescription>{t('Pinned stops stay on their vehicle and locked routes keep their stops and order; everything else may change. A new version is saved.')}</DialogDescription>
          </DialogHeader>
          <DialogBody className="grid gap-3">
            <WeightsEditor idPrefix="re-w" showErrors value={weightsForReopt} onChange={setReoptWeights} />
            <Field label={t('Time limit per plan')} htmlFor="re-limit">
              <SimpleSelect id="re-limit" value={String(limitForReopt)} onChange={(v) => setReoptLimit(Number(v))} options={timeLimitOptions(caps.data?.limits.optimizeTimeLimitS).map((n) => ({ value: String(n), label: t('{{n}} seconds', { n }) }))} />
            </Field>
            <MaxRideOverrideFields idPrefix="re-ride" caps={caps.data} value={rideForReopt} onChange={setReoptRide} showErrors={reoptTouched} hadOverride={!!plan.maxRide?.override} />
            {reopt.isError && <FormError message={plannerErrorMessage(reopt.error, t)} />}
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReoptOpen(false)} disabled={reopt.isPending}>
              {t('Back')}
            </Button>
            <Button
              disabled={reopt.isPending || !completeWeights(weightsForReopt)}
              onClick={() => {
                const w = completeWeights(weightsForReopt);
                setReoptTouched(true);
                if (!w || !rideRequest.ok) return;
                reopt.mutate(
                  { weights: w, timeLimitS: limitForReopt, ...(rideRequest.value !== undefined ? { maxRideOverride: rideRequest.value } : {}) },
                  {
                    onSuccess: (job) => {
                      setJobId(job.jobId);
                      setReoptOpen(false);
                      setReoptRide(null);
                      setReoptTouched(false);
                      setLastCheck(null);
                    },
                    onError: (err) => plannerErrorOf(err).kind === 'conflict' && setConflict(true),
                  },
                );
              }}
            >
              {reopt.isPending ? <Spinner /> : <RefreshCwIcon />} {t('Start')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Focus the first enabled element of the page with one of these data-focus-key values (K1 / K2). */
function focusKey(keys: readonly string[]): boolean {
  if (typeof document === 'undefined') return false;
  for (const k of keys) {
    const el = document.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(k)}"]`);
    if (el && !(el as HTMLButtonElement).disabled) {
      el.focus();
      return true;
    }
  }
  return false;
}

function MoveDialog({ stop, plan, onClose, onPick, onCloseAutoFocus }: { stop: PlannerStop | null; plan: PlannerPlan; onClose: () => void; onPick: (assignmentId: string) => void; onCloseAutoFocus?: (e: Event) => void }) {
  const { t } = useTranslation();
  const [target, setTarget] = useState<string>('');
  const options = plan.assignments.filter((a) => a.id !== stop?.assignmentId).map((a) => {
    const i = plan.assignments.indexOf(a);
    const load = routeLoad(routeStops(plan.stops, a.id), plan.direction);
    return { value: a.id, label: `${t('Route {{n}} · {{vehicle}}', { n: i + 1, vehicle: a.vehicleLabel })} — ${a.capacity === null ? t('seats not set') : t('{{used}} / {{capacity}} seats', { used: load, capacity: a.capacity })}` };
  });
  const chosen = target && options.some((o) => o.value === target) ? target : (options[0]?.value ?? '');
  return (
    <Dialog open={!!stop} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md" onCloseAutoFocus={onCloseAutoFocus}>
        <DialogHeader>
          <DialogTitle>{t('Move passenger')}</DialogTitle>
          <DialogDescription>{stop ? t('{{name}}: pickup and drop move together. The plan is re-checked after the move.', { name: stopLabel(stop, t) }) : ''}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <Field label={t('To route')}>
            <SimpleSelect value={chosen} onChange={setTarget} options={options} label={t('To route')} />
          </Field>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('Back')}
          </Button>
          <Button disabled={!chosen} onClick={() => onPick(chosen)}>
            {t('Move')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function VehicleDialog({ plan, assignmentId, onClose, onPick, onCloseAutoFocus }: { plan: PlannerPlan; assignmentId: string; onClose: () => void; onPick: (v: { objectId: string; name: string; seats: number | null }) => void; onCloseAutoFocus?: (e: Event) => void }) {
  const { t } = useTranslation();
  const fleet = usePlannerVehicles(plan.planDate, plan.direction ?? 'IN');
  const [value, setValue] = useState('');
  const a = plan.assignments.find((x) => x.id === assignmentId);
  const load = routeLoad(routeStops(plan.stops, assignmentId), plan.direction);
  const inPlan = new Set(plan.assignments.map((x) => x.objectId));
  const list = (fleet.data?.vehicles ?? []).filter((v) => v.seats !== null && !inPlan.has(v.objectId));
  const chosen = list.find((v) => v.objectId === value);
  const tooSmall = !!chosen && (chosen.seats ?? 0) < load;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md" onCloseAutoFocus={onCloseAutoFocus}>
        <DialogHeader>
          <DialogTitle>{t('Change vehicle')}</DialogTitle>
          <DialogDescription>{a ? t('{{vehicle}} carries {{n}} passenger(s) on this route.', { vehicle: a.vehicleLabel, n: load }) : ''}</DialogDescription>
        </DialogHeader>
        <DialogBody className="grid gap-2">
          {fleet.isPending ? (
            <Spinner />
          ) : list.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('No other vehicle with seats is free for this plan.')}</p>
          ) : (
            <Field label={t('Vehicle')} error={tooSmall ? t('This vehicle has fewer seats than the passengers on the route.') : undefined}>
              <SimpleSelect value={value} onChange={setValue} label={t('Vehicle')} options={[{ value: '', label: t('Choose a vehicle') }, ...list.map((v) => ({ value: v.objectId, label: `${v.name}${v.plateNumber ? ` · ${v.plateNumber}` : ''} — ${t('{{n}} seats', { n: v.seats ?? 0 })}` }))]} />
            </Field>
          )}
          {fleet.isError && <FormError message={plannerErrorMessage(fleet.error, t)} />}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('Back')}
          </Button>
          <Button disabled={!chosen || tooSmall} className={cn(tooSmall && 'opacity-60')} onClick={() => chosen && onPick({ objectId: chosen.objectId, name: chosen.name, seats: chosen.seats })}>
            {t('Change vehicle')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

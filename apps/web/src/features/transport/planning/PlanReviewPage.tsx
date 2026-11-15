import type { RoutePlanRouteViolation, RoutePlanStopViolation } from '@veetracer/shared';
import {
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowRightLeftIcon,
  ArrowUpIcon,
  CarFrontIcon,
  CircleAlertIcon,
  CrosshairIcon,
  ExternalLinkIcon,
  GitCompareIcon,
  GripVerticalIcon,
  HistoryIcon,
  ListChecksIcon,
  LockIcon,
  LockOpenIcon,
  MousePointerClickIcon,
  PinIcon,
  PinOffIcon,
  PlusIcon,
  Redo2Icon,
  RefreshCwIcon,
  SendIcon,
  TimerResetIcon,
  Trash2Icon,
  Undo2Icon,
  UserMinusIcon,
  XIcon,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { FormError } from '@/components/form-error';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { useAuth } from '@/features/auth/auth-context';
import { NotFoundPage } from '@/features/errors/ErrorPages';
import { RoutingOffState } from './RoutingOffState';
import { getReportTimeZone } from '@/features/reports/report-time';
import { cn } from '@/lib/utils';
import { DIRECTION_LABEL } from '../dispatch/e3-format';
import { SimpleSelect } from '../dispatch/e3-ui';
import { transportTripPath } from '../dispatch/use-e3';
import { PlanMap } from './PlanMap';
import { MaxRideOverrideFields } from './MaxRideFields';
import { AlternativesPanel } from './AlternativesPanel';
import { canOverrideMaxRide, maxRideSummary, overrideDraftOf, overrideRequest, type MaxRideOverrideDraft } from './max-ride';
import {
  canShiftStop,
  stopPinnedToRoute,
  capabilityView,
  engineEta,
  routeDriveSummary,
  timeLimitOptions,
  timeLimitWithin,
  defaultTimeLimit,
  formatDuration,
  formatKm,
  isEditablePlan,
  mapPoints,
  mergeViolations,
  planMetrics,
  routeLines,
  routeLoad,
  routesOf,
  routeStops,
  shiftStop,
  changedRoutes,
  movePassenger,
  stopEta,
  stopLabel,
  activeJobId,
  unassignedPassengers,
  vehicleColor,
  VIOLATION_LABEL,
  ADD_BOOKING_REFUSAL_LABEL,
  type PlannerPlan,
  type PlannerStop,
} from './planner-format';
import { afterEdit, afterRestore, afterRestoreConflict, canDrag, cursorFromHistory, dropToEdit, redoTarget, routeIssues, undoTarget, type DropTarget, type PlanEdit, type UndoCursor } from './plan-workspace';
import { alternativesError, maxRideCapS, preferencesDraftOf, preferencesRequest, runFields, strategyDraftOf, toggleStrategy, type PreferencesDraft, type StrategyDraft } from './plan-strategy';
import { AlternativesPicker, PreferencesFields, StrategyPicker } from './plan-strategy-ui';
import { selectableRoutes } from './plan-review';
import { AddBookingDialog, ChangesPanel, DriverPicker, RouteIssuesView } from './plan-workspace-ui';
import { CapabilityChip, EtaFootnote, EtaQualityBadge, JobProgress, MetricsGrid, PlanStatusBadge, UnassignedReasonText, ViolationList } from './planner-ui';
import {
  createKeyStore,
  newKey,
  PLANNING_MENU,
  PLANNING_PATH,
  planPublishPath,
  plannerErrorBody,
  plannerErrorMessage,
  plannerErrorOf,
  plannerFlagOn,
  useCapabilities,
  useDiscardPlan,
  useGenerateAlternatives,
  usePlan,
  usePlanEdit,
  usePlanHistory,
  usePlanOpenJobs,
  usePlannerVehicles,
  useReoptimise,
  useReview,
} from './use-planner';
import type { RoutingStrategy } from '@veetracer/shared';

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
 * The plan workspace (E4 WP 4.5 + WP-W): metrics, route cards with their stops, unassigned passengers with reasons, the
 * map (consent-allowed points only; click a stop to select it), explicit edits — drag and drop between and within
 * route cards with keyboard equivalents (up / down, Move to…, select + "Move selected here"), remove from route,
 * add / remove booking, driver, pin passenger, lock route, recalculate, undo / redo (restore of the previous / next
 * version) — each re-checked by the server, re-optimise (strategy, preferences, alternatives) and discard. Publishing
 * goes through the review screen (selected routes, reviewHash). Published routes are read-only.
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
  // Idempotency-Keys for this page's keyed actions (re-optimise, alternatives): a retry replays, a 4xx frees the key.
  const [keys] = useState(() => createKeyStore(newKey));
  const discard = useDiscardPlan();
  const reopt = useReoptimise(plan, keys);
  const genAlt = useGenerateAlternatives(plan, keys);
  const access = caps.data?.access;
  const support = !!access?.support;
  const editable = !!plan && isEditablePlan(plan.status) && plan.editable !== false;
  const canEdit = editable && can(PLANNING_MENU, 'edit') && (access?.canEdit ?? false) && !support;
  const [showHistory, setShowHistory] = useState(false);
  // Undo / redo needs the version history (snapshots of route membership) whenever the user may edit.
  const hist = usePlanHistory(plan?.id ?? null, showHistory || canEdit);
  const [cursor, setCursor] = useState<UndoCursor | null>(null);
  useEffect(() => {
    if (!plan || !hist.data || (cursor && cursor.head === plan.version)) return;
    if (!hist.data.some((v) => v.version === plan.version)) return; // wait for the history of this version
    setCursor(cursorFromHistory(hist.data, plan));
  }, [plan, hist.data, cursor]);
  const [showChanges, setShowChanges] = useState(false);
  const changes = useReview(plan?.id ?? null, null, showChanges);
  const [jobId, setJobId] = useState<string | null>(null);
  // After a reload (or a job started in another tab) the page finds the plan's running job on the server.
  const openJobs = usePlanOpenJobs(plan?.id ?? null, plan?.status === 'OPTIMIZING' && !jobId);
  const [focus, setFocus] = useState<number | null>(null);
  const [last, setLast] = useState<{ violations: RoutePlanStopViolation[]; routeViolations?: RoutePlanRouteViolation[] } | null>(null);
  const [conflict, setConflict] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [moveReq, setMoveReq] = useState<PlannerStop | null>(null);
  const [vehicleReq, setVehicleReq] = useState<string | null>(null);
  const [removeReq, setRemoveReq] = useState<PlannerStop | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [over, setOver] = useState<DropTarget | null>(null);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [showAlts, setShowAlts] = useState(false);
  const [reoptOpen, setReoptOpen] = useState(false);
  const [reoptMode, setReoptMode] = useState<'single' | 'alternatives'>('single');
  const [reoptStrategy, setReoptStrategy] = useState<StrategyDraft | null>(null);
  const [reoptPrefs, setReoptPrefs] = useState<PreferencesDraft | null>(null);
  const [reoptAlts, setReoptAlts] = useState<RoutingStrategy[]>(['BALANCED', 'FEWER_VEHICLES', 'COMFORT']);
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

  const metrics = useMemo(() => (plan ? planMetrics(plan, last?.violations) : null), [plan, last]);
  const canPublish = !!plan && editable && selectableRoutes(plan).length > 0 && can(PLANNING_MENU, 'command') && (access?.canPublish ?? false) && !support;
  const canDiscard = editable && can(PLANNING_MENU, 'delete') && (access?.canDelete ?? false) && !support;
  const canReopt = editable && can(PLANNING_MENU, 'create') && (access?.canPlan ?? false) && !support && capabilityView(caps.data).canOptimise;
  const health = capabilityView(caps.data);

  if (!flag) return <NotFoundPage />;
  // v1.16: switched off (the plan routes answer 404 then): say so instead of "not found".
  if (caps.data && !caps.data.enabled) {
    return (
      <div className="p-4 sm:p-6">
        <RoutingOffState reason={caps.data.offReason} />
      </div>
    );
  }
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
  const violations = mergeViolations(plan.violations ?? [], last?.violations ?? []);
  const violationsOf = (stopId: string) => violations.filter((v) => v.stopId === stopId);
  const stopById = new Map(plan.stops.map((s) => [s.id, s]));
  const labelOf = (stopId: string, ref: string) => {
    const s = stopById.get(stopId);
    return s ? stopLabel(s, t) : ref;
  };
  const issues = routeIssues(plan, last);
  const changed = new Set((showChanges ? (changes.data?.manualChanges.routes ?? []) : []).filter((r) => r.addedStopIds.length || r.removedStopIds.length || r.reordered || r.vehicleChanged || r.driverChanged).map((r) => r.assignmentId));
  const { points, hidden } = mapPoints(plan, plan.precise);
  const lines = routeLines(plan);
  const nonEngine = plan.assignments.some((a) => a.eta && !engineEta(a.eta));
  const unassigned = unassignedPassengers(plan.stops, plan.direction);
  const routes = routesOf(plan);
  const busy = edit.isPending || plan.status === 'OPTIMIZING';
  const activeJob = activeJobId(plan, jobId, openJobs.data);
  const sel = selected ? (stopById.get(selected) ?? null) : null;
  // Only while the cursor describes this very version: after a reload (another user's edit, a job) the history of the
  // new version may not be in yet, and a restore of an old version would silently revert the other change.
  const cursorFresh = !!cursor && cursor.head === plan.version;
  const undoV = canEdit && cursorFresh ? undoTarget(cursor) : null;
  const redoV = canEdit && cursorFresh ? redoTarget(cursor) : null;

  const runEdit = (e: PlanEdit, ok: string, focusAfter?: string[], restoreDelta?: -1 | 1) => {
    setEditError(null);
    const active = typeof document !== 'undefined' ? document.activeElement?.getAttribute('data-focus-key') : null;
    pendingFocus.current = focusAfter ?? (active ? [active] : null);
    edit.mutate(e, {
      onSuccess: (r) => {
        setConflict(false);
        setLast({ violations: r.violations, routeViolations: r.routeViolations });
        setDegraded(r.degraded ?? null);
        setCursor((c) => (restoreDelta && c ? afterRestore(c, restoreDelta, r.plan) : afterEdit(c, r.plan)));
        const blocking = (r.routeViolations ?? []).length;
        const n = r.violations.length + blocking;
        const msg = n ? t('{{ok}} Re-checked: {{n}} warning(s).', { ok, n }) : t('{{ok}} Re-checked: no warnings.', { ok });
        announce(msg);
        if (n) toast.warning(msg);
        else toast.success(msg);
      },
      onError: (err) => {
        const { kind, code } = plannerErrorOf(err);
        if (kind === 'conflict') setConflict(true);
        if (code === 'PLAN_RESTORE_CONFLICT' && restoreDelta) setCursor((c) => (c ? afterRestoreConflict(c, restoreDelta) : c));
        let msg = plannerErrorMessage(err, t);
        if (code === 'BOOKING_NOT_PLANNABLE') {
          const reason = plannerErrorBody(err)?.reason;
          if (typeof reason === 'string') msg = `${msg} ${t(ADD_BOOKING_REFUSAL_LABEL[reason] ?? reason)}`;
        }
        setEditError(msg);
        announce(msg);
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
    const k = dialogReturn.current;
    dialogReturn.current = null;
    if (k && !pendingFocus.current) focusKey(k);
  };
  const routeNo = (aid: string | null) => (aid ? plan.assignments.findIndex((a) => a.id === aid) + 1 : 0);
  const moveTo = (stop: PlannerStop, assignmentId: string) => {
    setMoveReq(null);
    const ok = t('{{name}} moved to route {{n}}.', { name: stopLabel(stop, t), n: routeNo(assignmentId) });
    // A booking moves with both ends (POST move-passenger); a generic stop through the sequence.
    const back = [`${stop.id}:move`, `${stop.id}:pin`];
    if (stop.bookingId) return runEdit({ kind: 'move', bookingId: stop.bookingId, toAssignmentId: assignmentId }, ok, back);
    const next = changedRoutes(routes, movePassenger(routes, plan.stops, stop.id, assignmentId));
    if (next.length) runEdit({ kind: 'sequence', assignments: next }, ok, back);
  };
  /** Drag and drop, "Move selected here" and "Remove from route" share one mapping (plan-workspace dropToEdit). */
  const dropAt = (stopId: string, target: DropTarget) => {
    setDragId(null);
    setOver(null);
    const s = stopById.get(stopId);
    if (!s) return;
    const r = dropToEdit(plan, stopId, target);
    if (!r.ok) {
      toast.error(t(r.reason));
      announce(t(r.reason));
      return;
    }
    const ok = target.assignmentId === null ? t('{{name}} removed from its route.', { name: stopLabel(s, t) }) : target.assignmentId === s.assignmentId ? t('{{name}} moved within route {{n}}.', { name: stopLabel(s, t), n: routeNo(target.assignmentId) }) : t('{{name}} moved to route {{n}}.', { name: stopLabel(s, t), n: routeNo(target.assignmentId) });
    runEdit(r.edit, ok);
  };
  const dragProps = (s: PlannerStop, target: { assignmentId: string | null; index: number }, enabled: boolean) =>
    enabled
      ? {
          draggable: true,
          onDragStart: (e: DragEvent<HTMLElement>) => {
            e.dataTransfer.setData('text/plain', s.id);
            e.dataTransfer.effectAllowed = 'move';
            setDragId(s.id);
          },
          onDragEnd: () => {
            setDragId(null);
            setOver(null);
          },
          onDragOver: (e: DragEvent<HTMLElement>) => {
            if (!dragId) return;
            e.preventDefault();
            e.stopPropagation();
            const box = e.currentTarget.getBoundingClientRect();
            const before = target.assignmentId === null ? null : e.clientY < box.top + box.height / 2 ? target.index : target.index + 1;
            if (over?.assignmentId !== target.assignmentId || over?.before !== before) setOver({ assignmentId: target.assignmentId, before });
          },
          onDrop: (e: DragEvent<HTMLElement>) => {
            e.preventDefault();
            e.stopPropagation();
            const sid = dragId ?? e.dataTransfer.getData('text/plain');
            if (sid) dropAt(sid, over && over.assignmentId === target.assignmentId ? over : { assignmentId: target.assignmentId, before: null });
          },
        }
      : {};
  const zoneProps = (assignmentId: string | null, enabled: boolean) =>
    enabled
      ? {
          onDragOver: (e: DragEvent<HTMLElement>) => {
            if (!dragId) return;
            e.preventDefault();
            if (over?.assignmentId !== assignmentId || over?.before !== null) setOver({ assignmentId, before: null });
          },
          onDrop: (e: DragEvent<HTMLElement>) => {
            e.preventDefault();
            const sid = dragId ?? e.dataTransfer.getData('text/plain');
            if (sid) dropAt(sid, { assignmentId, before: null });
          },
        }
      : {};
  const selectStop = (sid: string | null) => {
    setSelected(sid);
    if (sid) requestAnimationFrame(() => document.getElementById(`stop-${sid}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
  };
  const togglePin = (s: PlannerStop) => {
    const pinned = s.bookingId ? stopPinnedToRoute(plan.stops, s) : !!s.pinned;
    const msg = pinned ? t('{{name}} unpinned.', { name: stopLabel(s, t) }) : t('{{name}} pinned to this vehicle. Re-optimising and edits keep it on this vehicle; its place in the order may change.', { name: stopLabel(s, t) });
    // A passenger is pinned with both ends (PATCH bookings/:id/pin); a generic stop on its own.
    runEdit(s.bookingId ? { kind: 'pinBooking', bookingId: s.bookingId, pinned: !pinned } : { kind: 'pin', stopId: s.id, pinned: !pinned }, msg);
  };
  const removeFromRoute = (s: PlannerStop) => dropAt(s.id, { assignmentId: null, before: null });

  // Re-optimise dialog: strategy (primary) / Advanced weights / preferences / alternatives (E4 WP-A).
  const strategyForReopt = reoptStrategy ?? strategyDraftOf(plan);
  const prefsForReopt = reoptPrefs ?? preferencesDraftOf(plan.preferences);
  // E4 review L7: never a value above the API maximum (the select offers only allowed values).
  const limitForReopt = timeLimitWithin(reoptLimit ?? defaultTimeLimit(caps.data?.limits.optimizeTimeLimitS), caps.data?.limits.optimizeTimeLimitS);
  const rideForReopt = reoptRide ?? overrideDraftOf(plan);
  const rideRequest = canOverrideMaxRide(caps.data) ? overrideRequest(rideForReopt, plan.maxRide?.override) : ({ ok: true, value: undefined } as const);
  const overrideS = rideRequest.ok ? (rideRequest.value === undefined ? (plan.maxRide?.override?.maxRideS ?? null) : (rideRequest.value?.maxRideS ?? null)) : null;
  const capS = maxRideCapS(plan.maxRide?.policyS ?? access?.maxRidePolicyS ?? null, overrideS);
  const canEditLocks = can(PLANNING_MENU, 'edit') && (access?.canEdit ?? false);
  const reoptAlternatives = reoptMode === 'alternatives';
  const reoptRun = runFields({ ...strategyForReopt, useWeights: strategyForReopt.useWeights && !reoptAlternatives });
  const reoptPrefsReq = preferencesRequest(prefsForReopt, { capS, preserve: !reoptAlternatives, canEditLocks });
  const reoptAltError = reoptAlternatives ? alternativesError(reoptAlts) : null;
  const startReopt = () => {
    setReoptTouched(true);
    if (!reoptRun.ok || !reoptPrefsReq.ok || !rideRequest.ok || reoptAltError) return;
    const done = () => {
      setReoptOpen(false);
      setReoptRide(null);
      setReoptTouched(false);
      setLast(null);
    };
    if (reoptAlternatives) {
      genAlt.mutate(
        { strategies: reoptAlts, timeLimitS: limitForReopt, ...(reoptPrefsReq.value ? { preferences: reoptPrefsReq.value } : {}) },
        {
          onSuccess: () => {
            done();
            setShowAlts(true);
            toast.success(t('Alternatives started.'));
          },
          onError: (err) => plannerErrorOf(err).kind === 'conflict' && setConflict(true),
        },
      );
      return;
    }
    reopt.mutate(
      { strategy: reoptRun.value.strategy, weights: reoptRun.value.weights ?? null, timeLimitS: limitForReopt, ...(reoptPrefsReq.value ? { preferences: reoptPrefsReq.value } : {}), ...(rideRequest.value !== undefined ? { maxRideOverride: rideRequest.value } : {}) },
      {
        onSuccess: (job) => {
          setJobId(job.jobId);
          done();
        },
        onError: (err) => plannerErrorOf(err).kind === 'conflict' && setConflict(true),
      },
    );
  };

  const stopRow = (s: PlannerStop, k: number, list: PlannerStop[], a: PlannerPlan['assignments'][number], i: number) => {
    const eta = stopEta(s, a, plan.planStartAt, tz);
    const warn = violationsOf(s.id);
    const editRoute = canEdit && !a.published;
    const draggableNow = editRoute && !busy && canDrag(plan, s);
    const isOver = over?.assignmentId === a.id && over.before === k && dragId !== s.id;
    const isSel = selected === s.id;
    const pinnedNow = s.bookingId ? stopPinnedToRoute(plan.stops, s) : !!s.pinned;
    return (
      <li key={s.id} id={`stop-${s.id}`} className={cn('grid gap-1 p-2', isOver && 'border-t-2 border-t-primary', isSel && 'bg-primary/10 ring-2 ring-primary ring-inset', dragId === s.id && 'opacity-50')} {...dragProps(s, { assignmentId: a.id, index: k }, draggableNow)}>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {draggableNow && <GripVerticalIcon className="size-4 shrink-0 cursor-grab text-muted-foreground" aria-hidden />}
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
        {editRoute && (
          <div className="flex flex-wrap gap-1">
            <Button size="icon-sm" variant="outline" data-focus-key={`${s.id}:up`} disabled={busy || !canShiftStop(list, k, -1) || a.locked} onClick={() => reorder(s, -1)} aria-label={t('Move {{name}} up', { name: stopLabel(s, t) })}>
              <ArrowUpIcon />
            </Button>
            <Button size="icon-sm" variant="outline" data-focus-key={`${s.id}:down`} disabled={busy || !canShiftStop(list, k, 1) || a.locked} onClick={() => reorder(s, 1)} aria-label={t('Move {{name}} down', { name: stopLabel(s, t) })}>
              <ArrowDownIcon />
            </Button>
            <Button size="sm" variant="outline" data-focus-key={`${s.id}:move`} disabled={busy || stopPinnedToRoute(plan.stops, s) || a.locked || plan.assignments.length < 2} onClick={() => openMove(s)}>
              <ArrowRightLeftIcon /> {t('Move to…')}
            </Button>
            <Button size="sm" variant="ghost" aria-pressed={isSel} onClick={() => selectStop(isSel ? null : s.id)}>
              <MousePointerClickIcon /> {isSel ? t('Selected') : t('Select')}
            </Button>
            <Button size="sm" variant="ghost" aria-pressed={pinnedNow} data-focus-key={`${s.id}:pin`} disabled={busy} onClick={() => togglePin(s)}>
              {pinnedNow ? <PinOffIcon /> : <PinIcon />} {pinnedNow ? t('Unpin') : t('Pin')}
            </Button>
            <Button size="icon-sm" variant="ghost" disabled={busy || pinnedNow || a.locked} onClick={() => removeFromRoute(s)} aria-label={t('Remove {{name}} from the route', { name: stopLabel(s, t) })} title={t('Remove from route')}>
              <UserMinusIcon />
            </Button>
          </div>
        )}
      </li>
    );
  };

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
            {canEdit && (
              <>
                <Button variant="outline" size="sm" disabled={busy || undoV === null} onClick={() => undoV !== null && runEdit({ kind: 'restore', version: undoV }, t('Undone: version {{v}} restored.', { v: undoV }), undefined, -1)}>
                  <Undo2Icon /> {t('Undo')}
                </Button>
                <Button variant="outline" size="sm" disabled={busy || redoV === null} onClick={() => redoV !== null && runEdit({ kind: 'restore', version: redoV }, t('Redone: version {{v}} restored.', { v: redoV }), undefined, 1)}>
                  <Redo2Icon /> {t('Redo')}
                </Button>
                <Button variant="outline" size="sm" disabled={busy} onClick={() => runEdit({ kind: 'recalculate' }, t('Times recalculated.'))}>
                  <TimerResetIcon /> {t('Recalculate')}
                </Button>
                <Button variant="outline" size="sm" disabled={busy} onClick={() => setAddOpen(true)}>
                  <PlusIcon /> {t('Add booking')}
                </Button>
              </>
            )}
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
            {canPublish && !busy && (
              <Button asChild size="sm">
                <Link to={planPublishPath(plan.id)}>
                  <SendIcon /> {t('Review & publish…')}
                </Link>
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

      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="ghost" aria-expanded={showChanges} onClick={() => setShowChanges((v) => !v)}>
          <ListChecksIcon /> {showChanges ? t('Hide changes') : t('Show changes')}
        </Button>
        {(plan.alternativeOf || showAlts) && (
          <Button size="sm" variant="ghost" aria-expanded={showAlts} onClick={() => setShowAlts((v) => !v)}>
            <GitCompareIcon /> {showAlts ? t('Hide alternatives') : t('Show alternatives')}
          </Button>
        )}
      </div>
      {showChanges && (
        <Card className="min-w-0 gap-2 p-3">
          <h2 className="text-sm font-semibold">{t('Manual changes')}</h2>
          <ChangesPanel plan={plan} />
        </Card>
      )}
      {showAlts && (
        <Card className="min-w-0 gap-2 p-3">
          <h2 className="text-sm font-semibold">{t('Alternatives')}</h2>
          <AlternativesPanel planId={plan.id} canDelete={canDiscard} canPlan={canReopt} />
        </Card>
      )}

      {canEdit && sel && (
        <div role="status" className="sticky top-2 z-10 flex flex-wrap items-center gap-2 rounded-md border border-primary/40 bg-card p-2 text-sm shadow-sm">
          <span className="min-w-0 flex-1 break-words">{t('Selected: {{name}}. Use “Move selected here” on a route.', { name: stopLabel(sel, t) })}</span>
          {sel.assignmentId && (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => removeFromRoute(sel)}>
              <UserMinusIcon /> {t('Remove from route')}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => setSelected(null)} aria-label={t('Clear selection')}>
            <XIcon />
          </Button>
        </div>
      )}
      {canEdit && <p className="text-xs text-muted-foreground">{t('Drag a passenger to another route or to a new place in its route, or use the buttons. Every change is re-checked.')}</p>}

      <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="grid min-w-0 content-start gap-3">
          {plan.assignments.map((a, i) => {
            const stops = routeStops(plan.stops, a.id);
            const load = routeLoad(stops, plan.direction);
            const over_ = a.capacity !== null && load > a.capacity;
            const vehicle = a.vehicleName ? `${a.vehicleName}${a.plateNumber ? ` · ${a.plateNumber}` : ''}` : a.vehicleLabel;
            const editRoute = canEdit && !a.published;
            const dropOk = editRoute && !a.locked && !!dragId;
            return (
              <Card key={a.id} className={cn('min-w-0 gap-2 p-3', dropOk && over?.assignmentId === a.id && 'ring-2 ring-primary')} {...zoneProps(a.id, editRoute && !a.locked)}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="size-3 shrink-0 rounded-full" style={{ background: vehicleColor(i) }} aria-hidden />
                  <h2 className="min-w-0 flex-1 text-sm font-semibold break-words">{t('Route {{n}} · {{vehicle}}', { n: i + 1, vehicle })}</h2>
                  {a.published && <Badge variant="success">{t('Published')}</Badge>}
                  {changed.has(a.id) && <Badge variant="warning">{t('Changed')}</Badge>}
                  {a.locked && (
                    <Badge variant="info">
                      <LockIcon aria-hidden /> {t('Locked')}
                    </Badge>
                  )}
                  <Badge variant={over_ ? 'destructive' : 'outline'}>{a.capacity === null ? t('{{n}} seats used · seats not set', { n: load }) : t('{{used}} / {{capacity}} seats', { used: load, capacity: a.capacity })}</Badge>
                </div>
                {editRoute ? (
                  <DriverPicker id={`driver-${a.id}`} driverId={a.driverId} driverName={a.driverName} disabled={busy || a.locked} onChange={(driverId, name) => runEdit({ kind: 'driver', assignmentId: a.id, driverId }, driverId ? t('Route {{n}}: driver {{name}}.', { n: i + 1, name }) : t('Route {{n}}: no driver.', { n: i + 1 }))} />
                ) : (
                  a.driverName && <p className="text-xs text-muted-foreground">{t('Driver: {{name}}', { name: a.driverName })}</p>
                )}
                <p className="text-xs text-muted-foreground">
                  {(() => {
                    // T2-L1: engine numbers only when the engine produced both (not "— · — drive" after an edit while it was down).
                    const d = routeDriveSummary(a, stops.length);
                    return d.kind === 'engine' ? t('{{km}} · {{time}} drive', { km: formatKm(d.distanceM), time: formatDuration(d.durationS, t) }) : d.kind === 'pending' ? t('No engine distance or time yet') : t('No stops on this route');
                  })()}
                </p>
                {a.published && <p className="text-xs text-muted-foreground">{t('This route is published: it is read-only here. Change it on the dispatch board.')}</p>}
                <RouteIssuesView issues={issues.get(a.id)} />
                <div className="flex flex-wrap gap-1.5">
                  <Button size="sm" variant="ghost" aria-pressed={focus === i} onClick={() => setFocus(focus === i ? null : i)}>
                    <CrosshairIcon /> {focus === i ? t('Show all routes') : t('Show on map')}
                  </Button>
                  {editRoute && (
                    <>
                      {sel && sel.assignmentId !== a.id && (
                        <Button size="sm" variant="outline" disabled={busy || a.locked} onClick={() => dropAt(sel.id, { assignmentId: a.id, before: null })}>
                          <ArrowRightLeftIcon /> {t('Move selected here')}
                        </Button>
                      )}
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
                {stops.length > 0 ? (
                  <ol className="divide-y rounded-md border" aria-label={t('Stops of route {{n}}', { n: i + 1 })}>
                    {stops.map((s, k) => stopRow(s, k, stops, a, i))}
                  </ol>
                ) : (
                  dropOk && <p className="rounded-md border border-dashed p-3 text-center text-xs text-muted-foreground">{t('Drop here')}</p>
                )}
              </Card>
            );
          })}

          <Card className={cn('min-w-0 gap-2 p-3', canEdit && dragId && over?.assignmentId === null && 'ring-2 ring-primary')} {...zoneProps(null, canEdit)}>
            <h2 className="text-sm font-semibold">
              {t('Unassigned passengers')} <span className="tabular-nums text-muted-foreground">({unassigned.length})</span>
            </h2>
            {canEdit && dragId && <p className="text-xs text-muted-foreground">{t('Drop here to take a passenger off its route.')}</p>}
            {unassigned.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('Every passenger has a seat on a route.')}</p>
            ) : (
              <ul className="divide-y rounded-md border">
                {unassigned.map((s, k) => {
                  const isSel = selected === s.id;
                  return (
                    <li key={s.id} id={`stop-${s.id}`} className={cn('flex flex-wrap items-center gap-2 p-2', isSel && 'bg-primary/10 ring-2 ring-primary ring-inset')} {...dragProps(s, { assignmentId: null, index: k }, canEdit && !busy)}>
                      {canEdit && <GripVerticalIcon className="size-4 shrink-0 cursor-grab text-muted-foreground" aria-hidden />}
                      <div className="grid min-w-0 flex-1 gap-0.5">
                        <span className="text-sm break-words">{stopLabel(s, t)}</span>
                        <span className="text-xs text-warning-fg">
                          <UnassignedReasonText code={s.unassignedReason} />
                        </span>
                      </div>
                      {canEdit && (
                        <div className="flex flex-wrap gap-1">
                          {plan.assignments.length > 0 && (
                            <Button size="sm" variant="outline" disabled={busy} onClick={() => setMoveReq(s)}>
                              <ArrowRightLeftIcon /> {t('Add to route…')}
                            </Button>
                          )}
                          <Button size="sm" variant="ghost" aria-pressed={isSel} onClick={() => selectStop(isSel ? null : s.id)}>
                            <MousePointerClickIcon /> {isSel ? t('Selected') : t('Select')}
                          </Button>
                          {s.bookingId && (
                            <Button size="icon-sm" variant="ghost" disabled={busy} onClick={() => setRemoveReq(s)} aria-label={t('Remove {{name}} from the plan', { name: stopLabel(s, t) })} title={t('Remove booking from plan')}>
                              <Trash2Icon />
                            </Button>
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          <Card className="min-w-0 gap-2 p-3">
            <h2 className="text-sm font-semibold">{last ? t('Re-check after your last change') : t('Warnings')}</h2>
            <ViolationList violations={violations} labelOf={labelOf} />
          </Card>
        </div>

        <div className="grid min-w-0 content-start gap-2 lg:sticky lg:top-4 lg:self-start">
          <PlanMap lines={lines} points={points} depot={plan.depot} focus={focus} selected={selected} onSelect={(sid) => selectStop(sid)} className="h-[320px] sm:h-[420px] lg:h-[560px]" label={t('Map of the routes of {{name}}', { name: plan.name })} />
          <p className="text-xs text-muted-foreground">
            {hidden > 0 ? t('{{n}} passenger point(s) are not on the map (no transport consent or outside your branches); the lists still show them.', { n: hidden }) : t('Only points you may see are drawn; routes follow the engine’s road geometry.')}
            {!plan.precise ? ` ${t('Points are approximate (about 11 m) for your role.')}` : ''} {t('Click a stop on the map to select it in the list.')}
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
      <MoveDialog stop={moveReq} plan={plan} onClose={() => setMoveReq(null)} onPick={(aid) => moveReq && moveTo(moveReq, aid)} onCloseAutoFocus={returnFocus} />

      {vehicleReq && (
        <VehicleDialog
          plan={plan}
          assignmentId={vehicleReq}
          onClose={() => {
            setVehicleReq(null);
            const k = dialogReturn.current;
            dialogReturn.current = null;
            if (k) requestAnimationFrame(() => focusKey(k));
          }}
          onCloseAutoFocus={returnFocus}
          onPick={(v) => {
            runEdit({ kind: 'vehicle', assignmentId: vehicleReq, objectId: v.objectId }, t('Route {{n}} now uses {{vehicle}}.', { n: routeNo(vehicleReq), vehicle: v.name }), [`route:${vehicleReq}:vehicle`, `route:${vehicleReq}:lock`]);
            setVehicleReq(null);
          }}
        />
      )}

      <AddBookingDialog
        plan={plan}
        open={addOpen}
        pending={busy}
        onClose={() => setAddOpen(false)}
        onAdd={(bookingId) => {
          setAddOpen(false);
          runEdit({ kind: 'addBooking', bookingId }, t('Booking added to the plan (no route yet).'));
        }}
      />

      <ConfirmDialog
        open={!!removeReq}
        onOpenChange={(o) => !o && setRemoveReq(null)}
        title={t('Remove booking from plan?')}
        description={removeReq ? t('{{name}} leaves this plan. The booking stays open in the dispatch queue.', { name: stopLabel(removeReq, t) }) : ''}
        confirmLabel={t('Remove')}
        destructive
        pending={edit.isPending}
        onConfirm={() => {
          const s = removeReq;
          setRemoveReq(null);
          if (s?.bookingId) runEdit({ kind: 'removeBooking', bookingId: s.bookingId }, t('{{name}} removed from the plan.', { name: stopLabel(s, t) }));
        }}
      />

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

      <Dialog open={reoptOpen} onOpenChange={(o) => !reopt.isPending && !genAlt.isPending && setReoptOpen(o)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t('Re-optimise this plan')}</DialogTitle>
            <DialogDescription>{t('Pinned stops stay on their vehicle and locked routes keep their stops and order; everything else may change. A new version is saved.')}</DialogDescription>
          </DialogHeader>
          <DialogBody className="grid gap-3">
            <div className="inline-flex rounded-lg border bg-muted p-[3px] sm:max-w-md" role="group" aria-label={t('What to make')}>
              {(['single', 'alternatives'] as const).map((m) => (
                <button key={m} type="button" aria-pressed={reoptMode === m} onClick={() => setReoptMode(m)} className={cn('h-8 min-w-0 flex-1 rounded-md px-2 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring', reoptMode === m ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground')}>
                  {m === 'single' ? t('Re-optimise this plan') : t('Generate alternatives')}
                </button>
              ))}
            </div>
            {reoptAlternatives ? (
              <AlternativesPicker idPrefix="re-alt" value={reoptAlts} onChange={(s, on) => setReoptAlts((x) => toggleStrategy(x, s, on))} error={reoptTouched ? reoptAltError : null} />
            ) : (
              <StrategyPicker idPrefix="re" showErrors={reoptTouched} value={strategyForReopt} onChange={setReoptStrategy} />
            )}
            <PreferencesFields idPrefix="re-pref" value={prefsForReopt} onChange={setReoptPrefs} capS={capS} preserve={!reoptAlternatives} canEditLocks={canEditLocks} capped={reoptPrefsReq.ok && reoptPrefsReq.capped} errors={reoptTouched && !reoptPrefsReq.ok ? reoptPrefsReq.errors : undefined} />
            <Field label={t('Time limit per plan')} htmlFor="re-limit">
              <SimpleSelect id="re-limit" value={String(limitForReopt)} onChange={(v) => setReoptLimit(Number(v))} options={timeLimitOptions(caps.data?.limits.optimizeTimeLimitS).map((n) => ({ value: String(n), label: t('{{n}} seconds', { n }) }))} />
            </Field>
            {!reoptAlternatives && <MaxRideOverrideFields idPrefix="re-ride" caps={caps.data} value={rideForReopt} onChange={setReoptRide} showErrors={reoptTouched} hadOverride={!!plan.maxRide?.override} />}
            {reoptTouched && !reoptRun.ok && <FormError message={t(reoptRun.errors[0])} />}
            {reopt.isError && <FormError message={plannerErrorMessage(reopt.error, t)} />}
            {genAlt.isError && <FormError message={plannerErrorMessage(genAlt.error, t)} />}
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReoptOpen(false)} disabled={reopt.isPending || genAlt.isPending}>
              {t('Back')}
            </Button>
            <Button disabled={reopt.isPending || genAlt.isPending} onClick={startReopt}>
              {reopt.isPending || genAlt.isPending ? <Spinner /> : <RefreshCwIcon />} {t('Start')}
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
  const options = plan.assignments
    .filter((a) => a.id !== stop?.assignmentId && !a.published && !a.locked)
    .map((a) => {
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
          {options.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('No other route can take this passenger (published or locked).')}</p>
          ) : (
            <Field label={t('To route')}>
              <SimpleSelect value={chosen} onChange={setTarget} options={options} label={t('To route')} />
            </Field>
          )}
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
              <SimpleSelect value={value} onChange={setValue} label={t('Vehicle')} placeholder={t('Choose a vehicle')} options={list.map((v) => ({ value: v.objectId, label: `${v.name}${v.plateNumber ? ` · ${v.plateNumber}` : ''} — ${t('{{n}} seats', { n: v.seats ?? 0 })}` }))} />
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

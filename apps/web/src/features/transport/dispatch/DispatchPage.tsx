import type { DriverDto, TransportBookingDto, TransportDirection, TransportTripSummaryDto } from '@veetracer/shared';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronLeftIcon, ChevronRightIcon, ClipboardListIcon, CopyIcon, EyeIcon, FileClockIcon, PlayIcon, PlusIcon, RouteIcon, SendIcon, Trash2Icon, UserPlusIcon, UsersIcon, XIcon, ZapIcon } from 'lucide-react';
import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { FormError } from '@/components/form-error';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Combobox, type Option } from '@/components/ui/multi-select';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAuth } from '@/features/auth/auth-context';
import { named, useEntityOptions } from '@/features/masters/use-options';
import { shiftDay } from '@/features/planned-trips/trip-format';
import { getReportTimeZone, todayInZone } from '@/features/reports/report-time';
import { api, ApiError } from '@/lib/api';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Switch } from '@/components/ui/switch';
import { useTransportSettings, useUpdateTransportSettings } from '../use-agreements';
import { learnCutoffMin } from './adhoc-booking';
import { GroupBookingDialog } from './GroupBookingDialog';
import { NewBookingDialog } from './BookingDialogs';
import { cn } from '@/lib/utils';
import {
  addNewTrip,
  addReassign,
  addRemove,
  addToNewTrip,
  addToTrip,
  buildChangeSet,
  defaultPlacement,
  diffDraft,
  draftBookingIds,
  draftChangeCount,
  emptyDraft,
  idempotencyFor,
  isDraftEmpty,
  rebaseDraft,
  type DispatchDraft,
  type DraftBooking,
  type IdempotencySlot,
} from './dispatch-draft';
import { allocateRoutes, largestSeats, routeGroups, type RouteGroup } from './auto-allocate';
import { ChangeSetDetailDialog } from './ChangeSetDetailDialog';
import { copyDay, type CopyBooking, type CopyResult, type SourceTrip } from './copy-day';
import { CandidatesPanel, DraftReview, DraftTray, QueuePanel, TripsPanel, type PanelCtx } from './dispatch-panels';
import { DIRECTION_LABEL, isEditableTrip, newUuid } from './e3-format';
import { ConnectionChip, e3ErrorMessage, RoutingChip, SimpleSelect } from './e3-ui';
import { ReasonDialog } from './ReasonDialog';
import { locatedStops } from './TransportMap';
import {
  TRIPS_ENDPOINT,
  useBookingPolicy,
  fetchDispatchBoard,
  fetchTransportTrip,
  SHIFTS_ENDPOINT,
  transportTripPath,
  useBookingCommand,
  useDiscardServerDraft,
  useDispatchBoard,
  usePublishChangeSet,
  usePublishServerDraft,
  useSaveServerDraft,
  useTransportTripLive,
} from './use-e3';

const desktopQuery = typeof window !== 'undefined' ? window.matchMedia('(min-width: 1024px)') : null;
function useIsDesktop(): boolean {
  return useSyncExternalStore(
    (cb) => {
      desktopQuery?.addEventListener('change', cb);
      return () => desktopQuery?.removeEventListener('change', cb);
    },
    () => desktopQuery?.matches ?? true,
  );
}

const ALL = '__all';

function toDraftBooking(b: TransportBookingDto): DraftBooking {
  return { id: b.id, name: b.passenger.displayName, pickup: b.pickup, drop: b.drop, windowStart: b.windowStart, windowEnd: b.windowEnd, seats: b.passengerCount };
}

function toAllocBooking(b: TransportBookingDto): CopyBooking {
  return { ...toDraftBooking(b), shiftId: b.shiftId, groupId: b.groupId ?? null, profileId: b.passenger.id };
}

/** Roster tab: a commute for a shift (generated from the roster or added by the desk); everything else is ad-hoc. */
const isRoster = (b: TransportBookingDto) => !!b.shiftId && b.journey !== 'POINT_TO_POINT';

/** Waiting bookings that can be seated now (approved, with points and consent). */
const seatable = (b: TransportBookingDto) => b.status === 'PENDING_ASSIGNMENT' && !b.needsLocation && !b.pointsHidden;

/** What Auto-allocate / Copy yesterday did, for the summary dialog. */
interface PlanSummary {
  title: string;
  trips: { label: string; driver: string | null; names: string[]; seats: number; capacity: number }[];
  notes: { text: string; names: string[] }[];
}

/**
 * Transport → Dispatch (menu etms_dispatch, doc 07 §4, 12 WP 3.4–3.5). Queue of bookings waiting for a seat, candidates
 * for the selection (seats; road ETA only when routing answers, labelled as an estimate), trips with occupancy and
 * idle vehicles. Every assignment is an explicit, keyboard-reachable action that lands in a draft; the draft is
 * reviewed and published as one change set (Idempotency-Key + expectedVersions) or discarded. No drag and drop (P6).
 */
export function DispatchPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const qc = useQueryClient();
  const tz = getReportTimeZone();
  const today = todayInZone(tz);
  const desktop = useIsDesktop();
  const [day, setDay] = useState(today);
  const [direction, setDirection] = useState<TransportDirection>('IN');
  const [shiftId, setShiftId] = useState<string>(ALL);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [drafts, setDrafts] = useState<Record<string, DispatchDraft>>({});
  const [detailId, setDetailId] = useState<string | null>(null);
  const [tab, setTab] = useState('queue');
  const [reviewOpen, setReviewOpen] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [conflict, setConflict] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [removeReq, setRemoveReq] = useState<{ trip: TransportTripSummaryDto; p: { id: string; bookingId: string; name: string; seats: number } } | null>(null);
  const [reassignReq, setReassignReq] = useState<{ trip: TransportTripSummaryDto; kind: 'VEHICLE' | 'DRIVER' } | null>(null);
  const [busy, setBusy] = useState(false);
  const [planSummary, setPlanSummary] = useState<PlanSummary | null>(null);
  const [routesByKey, setRoutesByKey] = useState<Record<string, RouteGroup[] | null>>({});
  const [announcement, setAnnouncement] = useState('');
  const slot = useRef<IdempotencySlot | null>(null);
  const draftKeys = useRef<Record<string, string>>({});

  useTransportTripLive();
  const shifts = useEntityOptions<{ id: string; name: string }>(SHIFTS_ENDPOINT, named);
  const board = useDispatchBoard({ serviceDate: day, direction, shiftId: shiftId === ALL ? null : shiftId });
  const [mode, setMode] = useState<'roster' | 'adhoc'>('roster');
  // Roster = shift commutes (from the roster or added for a shift); Ad-hoc = point-to-point / no-shift rides.
  const data = useMemo(() => (board.data ? { ...board.data, queue: board.data.queue.filter((b) => isRoster(b) === (mode === 'roster')) } : undefined), [board.data, mode]);
  const rawQueue = board.data?.queue ?? [];
  const [newOpen, setNewOpen] = useState(false);
  const [groupOpen, setGroupOpen] = useState(false);
  const [copyPick, setCopyPick] = useState<string | null>(null);
  const policy = useBookingPolicy();
  const cutoffMin = policy.data?.cutoffMin ?? learnCutoffMin(rawQueue);
  const trips = data?.trips ?? [];
  const RUNNING = ['EN_ROUTE', 'AT_STOP', 'IN_PROGRESS'];
  const scheduledTrips = trips.filter((x) => x.plannedTripStatus === 'SCHEDULED' && !!x.publishedAt && !x.cancelledAt);
  const startedCount = trips.filter((x) => RUNNING.includes(x.derivedState)).length;
  const doneCount = trips.filter((x) => x.derivedState === 'COMPLETED' || x.derivedState === 'INCOMPLETE').length;
  /** ▶ Start: the same command as the trip page (POST /transport/trips/:id/start), one by one. */
  const startTrips = async (list: TransportTripSummaryDto[]) => {
    setBusy(true);
    let ok = 0;
    for (const x of list) {
      try {
        await api.post(`${TRIPS_ENDPOINT}/${x.id}/start`, { clientEventId: newUuid(), expectedVersion: x.version });
        ok++;
      } catch (e) {
        toast.error(`${x.vehicleName ?? x.name}: ${e3ErrorMessage(e, t)}`);
      }
    }
    setBusy(false);
    if (ok) toast.success(t('{{n}} trip(s) started', { n: ok }));
    void board.refetch();
  };
  const key = `${day}|${direction}`;
  const draft = drafts[key] ?? emptyDraft(day, direction);
  const setDraft = useCallback((fn: (d: DispatchDraft) => DispatchDraft) => setDrafts((all) => ({ ...all, [key]: fn(all[key] ?? emptyDraft(day, direction)) })), [key, day, direction]);
  const routes = routesByKey[key] ?? null;
  const setRoutes = useCallback((v: RouteGroup[] | null | ((r: RouteGroup[] | null) => RouteGroup[] | null)) => setRoutesByKey((all) => ({ ...all, [key]: typeof v === "function" ? v(all[key] ?? null) : v })), [key]);
  const canPlan = can('etms_dispatch', 'command');
  const publish = usePublishChangeSet();
  const saveServer = useSaveServerDraft();
  const publishServer = usePublishServerDraft();
  const discardServer = useDiscardServerDraft();
  const approveCmd = useBookingCommand();
  const announce = (msg: string) => {
    setAnnouncement('');
    requestAnimationFrame(() => setAnnouncement(msg));
  };

  const changeDay = (d: string) => {
    setDay(d);
    setSelected(new Set());
  };
  const changeDirection = (d: TransportDirection) => {
    setDirection(d);
    setSelected(new Set());
  };

  /** Selected bookings that can be seated now; tells the user about the rest. */
  const takeSelection = (): DraftBooking[] => {
    if (!data) return [];
    const inDraft = draftBookingIds(draft);
    const chosen = data.queue.filter((b) => selected.has(b.id));
    const ok = chosen.filter((b) => b.status === 'PENDING_ASSIGNMENT' && !b.needsLocation && !b.pointsHidden && !inDraft.has(b.id));
    if (ok.length < chosen.length) toast.warning(t('{{n}} booking(s) left out: they need approval or a pickup / drop point.', { n: chosen.length - ok.length }));
    return ok.map(toDraftBooking);
  };
  const done = (msg: string) => {
    setSelected(new Set());
    announce(msg);
    toast.success(msg);
    if (!desktop) setTab('draft');
  };

  const assignToTrip = async (trip: TransportTripSummaryDto) => {
    const list = takeSelection();
    if (!list.length) return;
    setBusy(true);
    try {
      const detail = await fetchTransportTrip(qc, trip.id);
      const seqs: Record<string, NonNullable<ReturnType<typeof defaultPlacement>>> = {};
      for (const b of list) {
        // A pickup far from every stop gets its own new stop (ADD_STOP on publish); otherwise the nearest stops.
        const s = defaultPlacement(locatedStops(detail.stops), b, direction);
        if (s) seqs[b.id] = s;
      }
      setDraft((d) => addToTrip(d, { id: trip.id, version: trip.version }, list, seqs));
      const added = Object.values(seqs).filter((s) => s.newStop).length;
      done(
        added
          ? t('{{n}} passenger(s) added to {{trip}} in the draft, {{s}} with a new stop. Check the stops before publishing.', { n: Object.keys(seqs).length, trip: trip.vehicleName ?? trip.name, s: added })
          : t('{{n}} passenger(s) added to {{trip}} in the draft. Check the pickup stops before publishing.', { n: Object.keys(seqs).length, trip: trip.vehicleName ?? trip.name }),
      );
    } catch (e) {
      toast.error(e3ErrorMessage(e, t));
    } finally {
      setBusy(false);
    }
  };
  const assignToVehicle = (v: { objectId: string; label: string; seats: number | null }) => {
    if (v.seats === null) {
      toast.error(t("Set the vehicle's passenger seats first (Vehicle seats)."));
      return;
    }
    const list = takeSelection();
    if (!list.length) return;
    const shiftOf = data?.queue.find((b) => b.id === list[0].id)?.shiftId ?? null;
    setDraft((d) => addNewTrip(d, { objectId: v.objectId, label: v.label, seats: v.seats! }, list, { shiftId: shiftId === ALL ? shiftOf : shiftId }));
    done(t('New trip on {{vehicle}} with {{n}} passenger(s) in the draft.', { vehicle: v.label, n: list.length }));
  };
  const assignToDraftTrip = (tempId: string) => {
    const list = takeSelection();
    if (!list.length) return;
    setDraft((d) => addToNewTrip(d, tempId, list));
    done(t('{{n}} passenger(s) added to the new trip in the draft.', { n: list.length }));
  };

  // ───────── Auto-allocate / Copy yesterday: proposals go into the draft only ─────────

  const vehicleLabel = (v: { name: string; plateNumber: string | null }) => `${v.name}${v.plateNumber ? ` · ${v.plateNumber}` : ''}`;
  /** Vehicle uses already in the draft (so a proposal never double-books a vehicle). */
  const draftTaken = (d: DispatchDraft) =>
    d.newTrips.map((n) => ({ objectId: n.objectId, startMs: Math.min(n.startMs, ...n.bookingIds.map((id) => Date.parse(d.bookings[id]?.windowStart ?? '') || n.startMs)), endMs: Math.max(n.startMs + 1, ...n.bookingIds.map((id) => Date.parse(d.bookings[id]?.windowEnd ?? '') || n.startMs)) }));
  /** The bookings a proposal may use: the ticked ones, else every waiting one not yet in the draft. */
  const proposalPool = (): TransportBookingDto[] => {
    if (!data) return [];
    const inDraft = draftBookingIds(draft);
    const free = data.queue.filter((b) => !inDraft.has(b.id));
    const ticked = free.filter((b) => selected.has(b.id));
    return ticked.length ? ticked : free;
  };
  /** Vehicles Allocate / Copy may use: BLOCK drops vehicles with document issues; WARN puts compliant ones first. */
  const allocVehicles = () => {
    const mode = data?.complianceMode ?? 'WARN';
    const issues = (v: { compliance?: unknown[] }) => (mode === 'OFF' ? 0 : (v.compliance?.length ?? 0));
    return (data?.vehicles ?? [])
      .filter((v) => mode !== 'BLOCK' || issues(v) === 0)
      .sort((x, y) => Number(issues(x) > 0) - Number(issues(y) > 0))
      .map((v) => ({ objectId: v.objectId, label: vehicleLabel(v), seats: v.seats, busy: v.busy }));
  };

  /** Step 1 · Routing: group the waiting people into routes by where they live (shown as groups in the waiting list). */
  const makeRoutes = () => {
    if (!data) return;
    const pool = proposalPool();
    const ok = pool.filter(seatable);
    if (!ok.length) {
      toast.info(pool.length ? t('Nobody can be routed yet: the waiting bookings need approval or a pickup / drop point.') : t('Nobody is waiting for a seat.'));
      return;
    }
    const max = largestSeats(allocVehicles()) || 6;
    const r = routeGroups(ok.map(toAllocBooking), direction, max);
    setRoutes(r.routes);
    setSelected(new Set());
    const msg = t('{{n}} route(s) made from {{p}} people (up to {{max}} seats each). Move people between routes if needed, then Allocate vehicles.', { n: r.routes.length, p: ok.length, max });
    announce(msg);
    toast.success(msg);
    if (r.unplaced.length) toast.warning(t('{{n}} without a pickup or drop point were left out.', { n: r.unplaced.length }));
    if (!desktop) setTab('queue');
  };
  const moveToRoute = (bookingId: string, routeId: string | null) =>
    setRoutes((rs) => {
      if (!rs) return rs;
      const b = rs.flatMap((r) => r.bookings).find((x) => x.id === bookingId) ?? (data?.queue.find((x) => x.id === bookingId) ? toAllocBooking(data.queue.find((x) => x.id === bookingId)!) : null);
      if (!b) return rs;
      return rs.map((r) => {
        const without = r.bookings.filter((x) => x.id !== bookingId);
        const list = r.id === routeId ? [...without, b] : without;
        return { ...r, bookings: list, seats: list.reduce((s, x) => s + x.seats, 0) };
      });
    });

  /** Step 2 · Allocate vehicles: each route gets a vehicle by seat capacity (Routing runs first when no routes exist). */
  const autoAllocateNow = () => {
    if (!data) return;
    const inDraft = draftBookingIds(draft);
    const waitingIds = new Set(data.queue.filter((b) => seatable(b) && !inDraft.has(b.id)).map((b) => b.id));
    let current = (routes ?? []).map((r) => ({ ...r, bookings: r.bookings.filter((b) => waitingIds.has(b.id)) })).filter((r) => r.bookings.length);
    const notReady = proposalPool().filter((b) => !seatable(b));
    if (!current.length) {
      const ok = proposalPool().filter(seatable);
      if (!ok.length) {
        toast.info(notReady.length ? t('Nobody can be seated yet: the waiting bookings need approval or a pickup / drop point.') : t('Nobody is waiting for a seat.'));
        return;
      }
      current = routeGroups(ok.map(toAllocBooking), direction, largestSeats(allocVehicles()) || 6).routes;
    }
    current = current.map((r) => ({ ...r, seats: r.bookings.reduce((s, b) => s + b.seats, 0) }));
    const r = allocateRoutes(current, allocVehicles(), draftTaken(draft), direction);
    setDraft((d) => r.trips.reduce((acc, trip) => addNewTrip(acc, trip.vehicle, trip.bookings, { ordered: true, shiftId: trip.shiftId }), d));
    setSelected(new Set());
    setRoutes(null);
    const noVehicle = r.unplaced.filter((u) => u.reason === 'NO_VEHICLE').map((u) => u.booking.name);
    const noPoints = r.unplaced.filter((u) => u.reason === 'NO_POINTS').map((u) => u.booking.name);
    setPlanSummary({
      title: t('Vehicles allocated: {{trips}} trip(s), {{n}} passenger(s) seated', { trips: r.trips.length, n: r.trips.reduce((s, x) => s + x.bookings.length, 0) }),
      trips: r.trips.map((x) => ({ label: x.vehicle.label, driver: null, names: x.bookings.map((b) => b.name), seats: x.bookings.reduce((s, b) => s + b.seats, 0), capacity: x.vehicle.seats })),
      notes: [
        { text: t('No free vehicle with enough seats: still waiting'), names: noVehicle },
        { text: t('No pickup or drop point: still waiting'), names: noPoints },
        { text: t('Need approval or a point first: left out'), names: notReady.map((b) => b.passenger.displayName) },
      ].filter((n) => n.names.length),
    });
    if (!desktop) setTab('trips');
  };

  const copyFrom = async (from: string) => {
    if (!data) return;
    setBusy(true);
    try {
      const prev = await fetchDispatchBoard(qc, { serviceDate: from, direction, shiftId: shiftId === ALL ? null : shiftId });
      const live = prev.trips.filter((x) => x.derivedState !== 'CANCELLED');
      if (!live.length) {
        toast.info(t('No trips on {{date}} to copy.', { date: from }));
        return;
      }
      const details = await Promise.all(live.map((x) => fetchTransportTrip(qc, x.id)));
      const source: SourceTrip[] = details.map((x) => ({
        id: x.id,
        name: x.name,
        objectId: x.objectId,
        vehicleName: x.vehicleName,
        driverId: x.driverId,
        driverName: x.driverName,
        shiftId: x.shiftId,
        plannedStart: x.plannedStart,
        cancelled: x.derivedState === 'CANCELLED',
        passengers: x.passengers.map((p) => ({ profileId: p.passenger.id, name: p.passenger.displayName, pickupSeq: p.pickupSeq, dropSeq: p.dropSeq, cancelled: p.status === 'CANCELLED' })),
      }));
      const inDraft = draftBookingIds(draft);
      const waiting = data.queue.filter((b) => seatable(b) && !inDraft.has(b.id)).map(toAllocBooking);
      const r = copyDay(source, waiting, allocVehicles(), draftTaken(draft), direction, Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000));
      setDraft((d) => r.trips.reduce((acc, x) => addNewTrip(acc, x.vehicle, x.bookings, { ordered: true, shiftId: x.shiftId, startMs: x.startMs, driverId: x.driver?.id ?? null, driverLabel: x.driver?.label ?? null }), d));
      setSelected(new Set());
      const skippedText: Record<CopyResult['skipped'][number]['reason'], string> = {
        NO_VEHICLE: t('vehicle not available'),
        NO_SEATS: t('seats not set'),
        BUSY: t('vehicle busy at that time'),
        NOBODY_WAITING: t('nobody waiting today'),
      };
      setPlanSummary({
        title: t('Copied from {{date}}: {{trips}} trip(s), {{n}} passenger(s) seated', { date: from, trips: r.trips.length, n: r.trips.reduce((s, x) => s + x.bookings.length, 0) }),
        trips: r.trips.map((x) => ({ label: x.vehicle.label, driver: x.driver?.label || null, names: x.bookings.map((b) => b.name), seats: x.bookings.reduce((s, b) => s + b.seats, 0), capacity: x.vehicle.seats })),
        notes: [
          { text: t('Rode yesterday, not waiting today (absent, on leave, already seated or not approved)'), names: r.notWaiting },
          { text: t('Did not fit the vehicle today: still waiting'), names: r.overflow },
          { text: t('Trips not copied'), names: r.skipped.map((s) => `${s.name} (${skippedText[s.reason]})`) },
          { text: t('Waiting today but not on yesterday’s trips: use Auto-allocate or assign by hand'), names: waiting.filter((b) => !r.trips.some((x) => x.bookings.some((y) => y.id === b.id))).map((b) => b.name) },
        ].filter((n) => n.names.length),
      });
      if (!desktop) setTab('trips');
    } catch (e) {
      toast.error(e3ErrorMessage(e, t));
    } finally {
      setBusy(false);
    }
  };

  const rows = useMemo(() => (data ? diffDraft(draft, data.trips) : []), [draft, data]);
  const count = draftChangeCount(draft);

  const doPublish = () => {
    const body = buildChangeSet(draft, reason);
    slot.current = idempotencyFor(slot.current, body, newUuid);
    setPublishError(null);
    publish.mutate(
      { body, key: slot.current.key },
      {
        onSuccess: (r) => {
          slot.current = null;
          setDraft(() => emptyDraft(day, direction));
          setReviewOpen(false);
          setReason('');
          setConflict(false);
          const msg = t('Published: {{trips}} trip(s), {{bookings}} booking(s) changed.', { trips: r.trips.length, bookings: r.bookings.length });
          announce(msg);
          toast.success(msg);
          for (const w of r.warnings) toast.warning(w);
        },
        onError: (e) => {
          // The server refused (409 / 403 / 400): nothing was published, so the next attempt may get a new key.
          if (e instanceof ApiError && e.status < 500) slot.current = null;
          if (e instanceof ApiError && e.code === 'VERSION_CONFLICT') setConflict(true);
          setPublishError(e3ErrorMessage(e, t));
        },
      },
    );
  };
  const rebase = async () => {
    const fresh = await board.refetch();
    if (!fresh.data) return;
    const r = rebaseDraft(draft, { queueIds: fresh.data.queue.map((b) => b.id), trips: fresh.data.trips.map((x) => ({ id: x.id, version: x.version, editable: isEditableTrip(x.derivedState) })) });
    setDraft(() => r.draft);
    setConflict(false);
    setPublishError(null);
    toast.info(r.dropped ? t('Board reloaded. {{n}} change(s) no longer applied and were dropped; review again.', { n: r.dropped }) : t('Board reloaded with the latest versions; review again.'));
  };
  const saveAsServerDraft = () =>
    saveServer.mutate(buildChangeSet(draft, reason), {
      onSuccess: () => {
        setDraft(() => emptyDraft(day, direction));
        setReviewOpen(false);
        toast.success(t('Saved as a draft on the server. Publish it from "Saved drafts".'));
      },
      onError: (e) => setPublishError(e3ErrorMessage(e, t)),
    });

  const ctx: PanelCtx | null = data
    ? {
        board: data,
        tz,
        day,
        draft,
        setDraft,
        selected,
        setSelected,
        canPlan,
        assignToTrip: (trip) => void assignToTrip(trip),
        assignToVehicle,
        assignToDraftTrip,
        requestRemove: (trip, p) => setRemoveReq({ trip, p }),
        requestReassign: (trip, kind) => setReassignReq({ trip, kind }),
        approve: (b) => approveCmd.mutate({ kind: 'approve', id: b.id, version: b.version }, { onSuccess: () => toast.success(t('Booking approved')), onError: (e) => toast.error(e3ErrorMessage(e, t)) }),
        busy: busy || approveCmd.isPending,
        routes,
        moveToRoute,
        startTrip: (trip) => void startTrips([trip]),
      }
    : null;

  const draftBar = canPlan && (
    <Card className="gap-2 p-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">
          {t('Draft')} <Badge variant={count ? 'info' : 'muted'}>{t('{{n}} change(s)', { n: count })}</Badge>
        </h2>
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" disabled={isDraftEmpty(draft)} onClick={() => setDiscardOpen(true)}>
            <Trash2Icon /> {t('Discard')}
          </Button>
          <Button
            size="sm"
            disabled={isDraftEmpty(draft)}
            onClick={() => {
              setPublishError(null);
              setReviewOpen(true);
            }}
          >
            <SendIcon /> {t('Review & publish')}
          </Button>
        </div>
      </div>
      {ctx && <DraftTray ctx={ctx} />}
    </Card>
  );

  const serverDrafts = data && data.drafts.length > 0 && (
    <Card className="gap-2 p-3">
      <h2 className="flex items-center gap-2 text-sm font-semibold">
        <FileClockIcon className="size-4" aria-hidden /> {t('Saved drafts')} <span className="text-muted-foreground tabular-nums">({data.drafts.length})</span>
      </h2>
      <ul className="divide-y text-sm">
        {data.drafts.map((d) => (
          <li key={d.id} className="flex flex-wrap items-center gap-2 py-2">
            <span className="min-w-0 flex-1">
              {t('{{n}} change(s), {{p}} passenger(s)', { n: d.changeCount, p: d.passengerCount })}
              {d.sourceTripId && (
                <>
                  {' · '}
                  <Link to={transportTripPath(d.sourceTripId)} className="text-primary hover:underline">
                    {t('repeat of a trip')}
                  </Link>
                </>
              )}
            </span>
            <Button size="sm" variant="ghost" onClick={() => setDetailId(d.id)} aria-label={t('Details of the saved draft')}>
              <EyeIcon /> {t('Details')}
            </Button>
            {canPlan && (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={publishServer.isPending}
                  onClick={() => {
                    draftKeys.current[d.id] ??= newUuid();
                    publishServer.mutate(
                      { id: d.id, key: draftKeys.current[d.id] },
                      {
                        onSuccess: (r) => {
                          delete draftKeys.current[d.id];
                          toast.success(t('Published: {{trips}} trip(s), {{bookings}} booking(s) changed.', { trips: r.trips.length, bookings: r.bookings.length }));
                        },
                        onError: (e) => {
                          if (e instanceof ApiError && e.status < 500) delete draftKeys.current[d.id];
                          toast.error(e3ErrorMessage(e, t));
                        },
                      },
                    );
                  }}
                >
                  <SendIcon /> {t('Publish')}
                </Button>
                <Button size="sm" variant="ghost" disabled={discardServer.isPending} onClick={() => discardServer.mutate(d.id, { onSuccess: () => toast.success(t('Draft discarded')), onError: (e) => toast.error(e3ErrorMessage(e, t)) })}>
                  <Trash2Icon /> {t('Discard')}
                </Button>
              </>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );

  const detailDialog = <ChangeSetDetailDialog id={detailId} tz={data?.timeZone} onOpenChange={(o) => !o && setDetailId(null)} />;

  const pane = 'flex min-h-0 min-w-0 flex-col gap-3 overflow-y-auto';

  return (
    <div className="flex h-full w-full min-w-0 flex-col gap-3 p-4 sm:p-6">
      <PageHeader
        title={t('Daily transport')}
        description={t('Choose the date, shift and direction: route the riders, allocate vehicles, publish and start the trips.')}
        actions={
          canPlan && mode === 'adhoc' ? (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => setNewOpen(true)}>
                <PlusIcon /> {t('New ad-hoc booking')}
              </Button>
              <Button size="sm" variant="outline" onClick={() => setGroupOpen(true)}>
                <UsersIcon /> {t('Group ride')}
              </Button>
            </div>
          ) : undefined
        }
      />
      <div className="inline-flex w-full max-w-xs rounded-lg border bg-muted p-[3px] sm:w-auto" role="tablist" aria-label={t('Roster or ad-hoc')}>
        {(['roster', 'adhoc'] as const).map((m) => (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={mode === m}
            onClick={() => {
              setMode(m);
              setSelected(new Set());
            }}
            className={cn('h-8 flex-1 rounded-md px-4 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring', mode === m ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground')}
          >
            {m === 'roster' ? t('Roster') : t('Ad-hoc')} <span className="tabular-nums text-muted-foreground">({rawQueue.filter((b) => isRoster(b) === (m === 'roster')).length})</span>
          </button>
        ))}
      </div>
      {detailDialog}

      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <div className="flex items-center gap-1">
          <Button variant="outline" size="icon" onClick={() => changeDay(shiftDay(day, -1))} aria-label={t('Previous day')}>
            <ChevronLeftIcon />
          </Button>
          <Input type="date" value={day} onChange={(e) => e.target.value && changeDay(e.target.value)} className="h-9 min-w-0 flex-1 sm:w-40 sm:flex-none" aria-label={t('Service date')} />
          <Button variant="outline" size="icon" onClick={() => changeDay(shiftDay(day, 1))} aria-label={t('Next day')}>
            <ChevronRightIcon />
          </Button>
          {day !== today && (
            <Button variant="ghost" size="sm" onClick={() => changeDay(today)}>
              {t('Today')}
            </Button>
          )}
        </div>
        <div className="inline-flex rounded-lg border bg-muted p-[3px]" role="group" aria-label={t('Direction')}>
          {(['IN', 'OUT'] as const).map((d) => (
            <button
              key={d}
              type="button"
              aria-pressed={direction === d}
              onClick={() => changeDirection(d)}
              className={cn('h-8 flex-1 rounded-md px-3 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring', direction === d ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground')}
            >
              {t(DIRECTION_LABEL[d])}
            </button>
          ))}
        </div>
        <SimpleSelect value={shiftId} onChange={setShiftId} label={t('Shift')} className="sm:w-48" options={[{ value: ALL, label: t('All shifts') }, ...shifts.options.map((o: Option) => ({ value: o.value, label: o.label }))]} />
        <div className="flex flex-wrap items-center gap-2">
          <ConnectionChip />
          {data && <RoutingChip available={data.routingAvailable} />}
          {board.isFetching && !board.isPending && <Spinner className="text-muted-foreground" />}
        </div>
        {canPlan && data && (
          <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
            <Button size="sm" variant={routes ? 'outline' : 'default'} onClick={makeRoutes} disabled={busy} title={t('Step 1: group the waiting people (or the ticked ones) into routes by where they live. Nothing is saved.')}>
              <RouteIcon /> {selected.size ? t('Routing {{n}} ticked', { n: selected.size }) : t('Routing')}
            </Button>
            {routes && (
              <Button size="sm" variant="ghost" onClick={() => setRoutes(null)} title={t('Clear the routes')}>
                <XIcon /> {t('Clear routes')}
              </Button>
            )}
            <Button size="sm" variant={routes ? 'default' : 'outline'} onClick={autoAllocateNow} disabled={busy} title={t('Step 2: give each route a vehicle by seat capacity. Goes into the draft; nothing is published until Review & publish.')}>
              <ZapIcon /> {t('Allocate vehicles')}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="outline" disabled={busy} title={t('Same vehicles, drivers and people as on another day, for those waiting now. Goes into the draft; nothing is published.')}>
                  {busy ? <Spinner /> : <CopyIcon />} {t('Copy from…')}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => void copyFrom(shiftDay(day, -1))}>{t('Yesterday ({{date}})', { date: shiftDay(day, -1) })}</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void copyFrom(shiftDay(day, -7))}>{t('Same day last week ({{date}})', { date: shiftDay(day, -7) })}</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setCopyPick(shiftDay(day, -1))}>{t('Choose a day…')}</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            {mode === 'roster' && (
              <Button size="sm" variant="outline" onClick={() => setNewOpen(true)} title={t('Book an employee who is not on the roster for this day')}>
                <UserPlusIcon /> {t('Add employee')}
              </Button>
            )}
            <AutoStartToggle />
            {scheduledTrips.length > 0 && (
              <Button size="sm" variant="outline" onClick={() => void startTrips(scheduledTrips)} disabled={busy}>
                <PlayIcon /> {t('Start all ({{n}})', { n: scheduledTrips.length })}
              </Button>
            )}
          </div>
        )}
      </div>

      {data && (
        <ol className="grid grid-cols-2 gap-2 sm:grid-cols-5" aria-label={t('Progress for this day')}>
          {(
            [
              ['1', t('Riders waiting'), data.queue.length, null],
              ['2', t('Routes'), routes ? routes.length : '—', routes ? t('routed') : t('press Routing')],
              ['3', t('Vehicles'), draft.newTrips.length + data.trips.length, draft.newTrips.length ? t('{{n}} in draft', { n: draft.newTrips.length }) : null],
              ['4', t('Started'), `${startedCount} / ${data.trips.length}`, null],
              ['5', t('Done'), doneCount, null],
            ] as const
          ).map(([n, label, v, hint]) => (
            <li key={n} className="flex items-center gap-2 rounded-lg border bg-card px-3 py-2">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">{n}</span>
              <span className="min-w-0">
                <span className="block text-xs text-muted-foreground">{label}</span>
                <span className="text-lg font-semibold tabular-nums">{v}</span>
                {hint && <span className="ml-1 text-xs text-muted-foreground">{hint}</span>}
              </span>
            </li>
          ))}
        </ol>
      )}

      {board.isError && <FormError message={e3ErrorMessage(board.error, t)} />}
      {board.isPending || !ctx ? (
        <Skeleton className="h-96 w-full rounded-xl" />
      ) : desktop ? (
        <div className="flex min-w-0 flex-col gap-4">
          {/* Riders waiting: one table grouped by shift (or by route after Routing), like Schedules. */}
          <QueuePanel ctx={ctx} variant="table" />
          <div className="grid min-h-[420px] grid-cols-[minmax(0,1fr)_minmax(20rem,28rem)] gap-4">
            <div className={cn(pane, 'max-h-[calc(100dvh-12rem)]')}>
              {draftBar}
              {serverDrafts}
              {/* Manual assignment helper: only while riders are ticked. */}
              {selected.size > 0 && <CandidatesPanel ctx={ctx} />}
            </div>
            <div className={cn(pane, 'max-h-[calc(100dvh-12rem)]')}>
              <TripsPanel ctx={ctx} />
            </div>
          </div>
        </div>
      ) : (
        <Tabs value={tab} onValueChange={setTab} className="flex min-w-0 flex-col gap-3">
          <TabsList className="sticky top-0 z-10 grid w-full grid-cols-4">
            <TabsTrigger value="queue" className="min-w-0 px-1 text-xs sm:text-sm">
              {t('Queue')} <span className="tabular-nums">({ctx.board.queue.length})</span>
            </TabsTrigger>
            <TabsTrigger value="assign" className="min-w-0 px-1 text-xs sm:text-sm">
              {t('Assign')}
            </TabsTrigger>
            <TabsTrigger value="trips" className="min-w-0 px-1 text-xs sm:text-sm">
              {t('Trips')}
            </TabsTrigger>
            <TabsTrigger value="draft" className="min-w-0 px-1 text-xs sm:text-sm">
              {t('Draft')} {count > 0 && <span className="tabular-nums">({count})</span>}
            </TabsTrigger>
          </TabsList>
          <TabsContent value="queue" className="min-w-0">
            <QueuePanel ctx={ctx} onFind={() => setTab('assign')} />
          </TabsContent>
          <TabsContent value="assign" className="min-w-0">
            <CandidatesPanel ctx={ctx} />
          </TabsContent>
          <TabsContent value="trips" className="min-w-0">
            <TripsPanel ctx={ctx} />
          </TabsContent>
          <TabsContent value="draft" className="flex min-w-0 flex-col gap-3">
            {draftBar || <p className="text-sm text-muted-foreground">{t('You can view the board; publishing needs the Dispatch → command permission.')}</p>}
            {serverDrafts}
          </TabsContent>
        </Tabs>
      )}

      <div aria-live="polite" className="sr-only">
        {announcement}
      </div>

      {/* Review → publish */}
      <Dialog open={reviewOpen} onOpenChange={(o) => !publish.isPending && setReviewOpen(o)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t('Review changes')}</DialogTitle>
            <DialogDescription>
              {t('{{date}} · {{direction}} · published together: either every change applies or none.', { date: day, direction: t(DIRECTION_LABEL[direction]) })}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-3">
            {publishError && (
              <div role="alert" className="grid gap-2">
                <FormError message={publishError} />
                {conflict && (
                  <Button variant="outline" size="sm" className="justify-self-start" onClick={() => void rebase()} disabled={board.isFetching}>
                    {t('Reload the board and keep my changes')}
                  </Button>
                )}
              </div>
            )}
            <DraftReview rows={rows} />
            {rows.some((r) => r.overCapacity) && <p className="text-sm text-destructive-fg">{t('A trip would have more passengers than seats. Fix it before publishing.')}</p>}
            <Field label={t('Reason (optional)')} htmlFor="cs-reason">
              <Input id="cs-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReviewOpen(false)} disabled={publish.isPending}>
              {t('Back')}
            </Button>
            <Button variant="outline" onClick={saveAsServerDraft} disabled={publish.isPending || saveServer.isPending || isDraftEmpty(draft)}>
              {saveServer.isPending ? <Spinner /> : <ClipboardListIcon />} {t('Save as draft')}
            </Button>
            <Button onClick={doPublish} disabled={publish.isPending || conflict || isDraftEmpty(draft) || rows.some((r) => r.overCapacity)}>
              {publish.isPending ? <Spinner /> : <SendIcon />} {t('Publish')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* What Auto-allocate / Copy yesterday put into the draft */}
      <Dialog open={!!planSummary} onOpenChange={(o) => !o && setPlanSummary(null)}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>{planSummary?.title}</DialogTitle>
            <DialogDescription>{t('Added to the draft only. Move, reorder or remove people on the trip cards, then Review & publish.')}</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-3 text-sm">
            {planSummary?.trips.length ? (
              <ul className="divide-y rounded-lg border">
                {planSummary.trips.map((x, i) => (
                  <li key={i} className="p-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium">
                        {x.label}
                        {x.driver && <span className="font-normal text-muted-foreground"> · {x.driver}</span>}
                      </span>
                      <span className="text-xs tabular-nums text-muted-foreground">{t('{{n}} / {{cap}} seats', { n: x.seats, cap: x.capacity })}</span>
                    </div>
                    <p className="text-xs text-muted-foreground">{x.names.map((nm, k) => `${k + 1}. ${nm}`).join('  ')}</p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-muted-foreground">{t('No trip could be proposed.')}</p>
            )}
            {planSummary?.notes.map((note) => (
              <div key={note.text} className="rounded-lg border border-warning/50 bg-warning/10 p-2.5">
                <p className="font-medium">
                  {note.text} ({note.names.length})
                </p>
                <p className="text-xs text-muted-foreground">{note.names.join(', ')}</p>
              </div>
            ))}
          </DialogBody>
          <DialogFooter>
            <Button onClick={() => setPlanSummary(null)}>{t('OK')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <NewBookingDialog open={newOpen} onOpenChange={setNewOpen} day={day} cutoffMin={cutoffMin} />
      <GroupBookingDialog open={groupOpen} onOpenChange={setGroupOpen} day={day} cutoffMin={cutoffMin} />
      <Dialog open={!!copyPick} onOpenChange={(o) => !o && setCopyPick(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('Copy from a day')}</DialogTitle>
            <DialogDescription>{t('Same vehicles, drivers and people as on that day, for those waiting on {{date}}.', { date: day })}</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <Field label={t('Copy from')} htmlFor="copy-from">
              <Input id="copy-from" type="date" value={copyPick ?? ''} max={shiftDay(day, -1)} onChange={(e) => setCopyPick(e.target.value)} />
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCopyPick(null)}>
              {t('Back')}
            </Button>
            <Button
              disabled={!copyPick || copyPick >= day}
              onClick={() => {
                const from = copyPick!;
                setCopyPick(null);
                void copyFrom(from);
              }}
            >
              <CopyIcon /> {t('Copy')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={discardOpen}
        onOpenChange={setDiscardOpen}
        title={t('Discard the draft?')}
        description={t('{{n}} pending change(s) will be thrown away. Nothing was published.', { n: count })}
        confirmLabel={t('Discard')}
        destructive
        onConfirm={() => {
          setDraft(() => emptyDraft(day, direction));
          slot.current = null;
          setDiscardOpen(false);
          announce(t('Draft discarded'));
        }}
      />

      <ReasonDialog
        open={!!removeReq}
        onOpenChange={(o) => !o && setRemoveReq(null)}
        title={t('Unassign passenger?')}
        description={removeReq ? t('{{name}} goes back to the queue when the draft is published.', { name: removeReq.p.name }) : undefined}
        label={t('Reason')}
        confirmLabel={t('Add to draft')}
        onConfirm={(r) => {
          if (!removeReq) return;
          setDraft((d) => addRemove(d, { passengerTripId: removeReq.p.id, tripId: removeReq.trip.id, bookingId: removeReq.p.bookingId, name: removeReq.p.name, seats: removeReq.p.seats, reason: r }, removeReq.trip.version));
          announce(t('{{name}} will be unassigned when you publish.', { name: removeReq.p.name }));
          setRemoveReq(null);
        }}
      />

      {reassignReq && data && <ReassignDialog req={reassignReq} vehicles={data.vehicles} onClose={() => setReassignReq(null)} onPick={(targetId, label, seats) => {
        setDraft((d) => addReassign(d, { tripId: reassignReq.trip.id, kind: reassignReq.kind, targetId, label, ...(reassignReq.kind === 'VEHICLE' ? { seats } : {}) }, reassignReq.trip.version));
        announce(reassignReq.kind === 'VEHICLE' ? t('Vehicle change added to the draft.') : t('Driver change added to the draft.'));
        setReassignReq(null);
      }} />}
    </div>
  );
}

function ReassignDialog({
  req,
  vehicles,
  onClose,
  onPick,
}: {
  req: { trip: TransportTripSummaryDto; kind: 'VEHICLE' | 'DRIVER' };
  vehicles: { objectId: string; name: string; plateNumber: string | null; seats: number | null }[];
  onClose: () => void;
  onPick: (targetId: string | null, label: string, seats: number | null) => void;
}) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const [value, setValue] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const drivers = useEntityOptions<DriverDto>('/drivers', named, { q, enabled: req.kind === 'DRIVER' && can('drivers') });
  const vehicleOptions: Option[] = vehicles
    .filter((v) => v.objectId !== req.trip.objectId)
    .map((v) => ({ value: v.objectId, label: `${v.name}${v.plateNumber ? ` · ${v.plateNumber}` : ''} — ${v.seats === null ? t('Seats not set') : t('{{n}} seats', { n: v.seats })}` }));
  const chosenVehicle = vehicles.find((v) => v.objectId === value);
  const tooSmall = req.kind === 'VEHICLE' && chosenVehicle && (chosenVehicle.seats === null || chosenVehicle.seats < req.trip.occupiedSeats);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{req.kind === 'VEHICLE' ? t('Change vehicle') : t('Change driver')}</DialogTitle>
          <DialogDescription>{req.trip.vehicleName ?? req.trip.name}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-3">
          {req.kind === 'VEHICLE' ? (
            <Field label={t('Vehicle')} error={tooSmall ? t('This vehicle has fewer seats than the passengers on the trip.') : undefined}>
              <Combobox value={value} onChange={setValue} options={vehicleOptions} placeholder={t('Choose a vehicle')} searchPlaceholder={t('Search name or plate…')} emptyText={t('No vehicles found')} />
            </Field>
          ) : (
            <Field label={t('Driver')} hint={t('Leave empty to remove the driver.')}>
              <Combobox value={value} onChange={setValue} options={drivers.options} loading={drivers.loading} onSearch={setQ} placeholder={t('No driver')} searchPlaceholder={t('Search drivers…')} emptyText={t('No drivers found')} />
            </Field>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('Back')}
          </Button>
          <Button
            disabled={(req.kind === 'VEHICLE' && (!value || !!tooSmall))}
            onClick={() => {
              if (req.kind === 'VEHICLE' && chosenVehicle) onPick(chosenVehicle.objectId, chosenVehicle.name, chosenVehicle.seats);
              else if (req.kind === 'DRIVER') onPick(value, drivers.options.find((o) => o.value === value)?.label ?? t('No driver'), null);
            }}
          >
            {t('Add to draft')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Transport settings "Start trips automatically" (etms.autoStart), shown to those who may change transport settings. */
function AutoStartToggle() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const allowed = can('etms_settings', 'edit');
  const settings = useTransportSettings(allowed);
  const update = useUpdateTransportSettings();
  if (!allowed || !settings.data) return null;
  const on = settings.data.autoStart === true;
  return (
    <label className="inline-flex h-8 items-center gap-2 rounded-md border bg-card px-2 text-sm" title={t('On: published trips start by themselves at their planned time. Trips also start when the vehicle reaches the first pickup (GPS), on or off.')}>
      <Switch
        checked={on}
        disabled={update.isPending}
        onCheckedChange={(v) =>
          update.mutate(
            { autoStart: v },
            { onSuccess: () => toast.success(v ? t('Trips now start automatically at their planned time') : t('Trips start when the driver or you press Start (or by GPS)')), onError: (e) => toast.error(e3ErrorMessage(e, t)) },
          )
        }
        aria-label={t('Auto-start')}
      />
      {t('Auto-start')}
    </label>
  );
}

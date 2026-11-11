import type { DriverDto, TransportBookingDto, TransportDirection, TransportTripSummaryDto } from '@veetracer/shared';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronLeftIcon, ChevronRightIcon, ClipboardListIcon, FileClockIcon, SendIcon, Trash2Icon } from 'lucide-react';
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
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/utils';
import {
  addNewTrip,
  addReassign,
  addRemove,
  addToNewTrip,
  addToTrip,
  buildChangeSet,
  defaultSeqs,
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
import { CandidatesPanel, DraftReview, DraftTray, QueuePanel, TripsPanel, type PanelCtx } from './dispatch-panels';
import { DIRECTION_LABEL, isEditableTrip, newUuid } from './e3-format';
import { ConnectionChip, e3ErrorMessage, RoutingChip, SimpleSelect } from './e3-ui';
import { ReasonDialog } from './ReasonDialog';
import {
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
  const [tab, setTab] = useState('queue');
  const [reviewOpen, setReviewOpen] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [conflict, setConflict] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [removeReq, setRemoveReq] = useState<{ trip: TransportTripSummaryDto; p: { id: string; bookingId: string; name: string; seats: number } } | null>(null);
  const [reassignReq, setReassignReq] = useState<{ trip: TransportTripSummaryDto; kind: 'VEHICLE' | 'DRIVER' } | null>(null);
  const [busy, setBusy] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const slot = useRef<IdempotencySlot | null>(null);
  const draftKeys = useRef<Record<string, string>>({});

  useTransportTripLive();
  const shifts = useEntityOptions<{ id: string; name: string }>(SHIFTS_ENDPOINT, named);
  const board = useDispatchBoard({ serviceDate: day, direction, shiftId: shiftId === ALL ? null : shiftId });
  const data = board.data;
  const key = `${day}|${direction}`;
  const draft = drafts[key] ?? emptyDraft(day, direction);
  const setDraft = useCallback((fn: (d: DispatchDraft) => DispatchDraft) => setDrafts((all) => ({ ...all, [key]: fn(all[key] ?? emptyDraft(day, direction)) })), [key, day, direction]);
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
    const ok = chosen.filter((b) => b.status === 'PENDING_ASSIGNMENT' && !b.needsLocation && !inDraft.has(b.id));
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
      const seqs: Record<string, { pickupSeq: number; dropSeq: number }> = {};
      for (const b of list) {
        const s = defaultSeqs(detail.stops, b);
        if (s) seqs[b.id] = s;
      }
      setDraft((d) => addToTrip(d, { id: trip.id, version: trip.version }, list, seqs));
      done(t('{{n}} passenger(s) added to {{trip}} in the draft. Check the pickup stops before publishing.', { n: Object.keys(seqs).length, trip: trip.vehicleName ?? trip.name }));
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

  const pane = 'flex min-h-0 min-w-0 flex-col gap-3 overflow-y-auto';

  return (
    <div className="flex h-full w-full min-w-0 flex-col gap-3 p-4 sm:p-6">
      <PageHeader title={t('Dispatch')} description={t('Seat waiting passengers on trips, then publish the changes together.')} />

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
      </div>

      {data && (
        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {(
            [
              ['Waiting', data.counts.queued],
              ['Assigned', data.counts.assigned],
              ['Trips', data.counts.trips],
              ['Seats used', `${data.counts.occupied} / ${data.counts.seats}`],
            ] as const
          ).map(([label, v]) => (
            <div key={label} className="rounded-lg border bg-card px-3 py-2">
              <dt className="text-xs text-muted-foreground">{t(label)}</dt>
              <dd className="text-lg font-semibold tabular-nums">{v}</dd>
            </div>
          ))}
        </dl>
      )}

      {board.isError && <FormError message={e3ErrorMessage(board.error, t)} />}
      {board.isPending || !ctx ? (
        <Skeleton className="h-96 w-full rounded-xl" />
      ) : desktop ? (
        <div className="grid min-h-[560px] flex-1 grid-cols-[minmax(17rem,21rem)_minmax(0,1fr)_minmax(19rem,25rem)] gap-4">
          <div className={cn(pane, 'max-h-[calc(100dvh-16rem)]')}>
            <QueuePanel ctx={ctx} />
          </div>
          <div className={cn(pane, 'max-h-[calc(100dvh-16rem)]')}>
            {draftBar}
            {serverDrafts}
            <CandidatesPanel ctx={ctx} />
          </div>
          <div className={cn(pane, 'max-h-[calc(100dvh-16rem)]')}>
            <TripsPanel ctx={ctx} />
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

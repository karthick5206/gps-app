import { complianceText } from '@veetracer/shared';
import type { DriverDto, DispatchBoardDto, DispatchCandidateDto, DispatchVehicleDto, TransportBookingDto, TransportTripSummaryDto } from '@veetracer/shared';
import { ArrowRightLeftIcon, BusIcon, FileDownIcon, PlayIcon, CarFrontIcon, CheckIcon, ChevronDownIcon, ChevronUpIcon, CircleAlertIcon, ExternalLinkIcon, InboxIcon, MoreHorizontalIcon, PlusIcon, SearchIcon, Undo2Icon, UserMinusIcon, UserRoundIcon } from 'lucide-react';
import { Fragment, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Link } from 'react-router';
import { FormError } from '@/components/form-error';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { EmptyState } from '@/components/ui/empty-state';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { formatClock, fromZonedWall, toZonedWall } from '@/features/planned-trips/trip-format';
import { useAuth } from '@/features/auth/auth-context';
import { named, useEntityOptions } from '@/features/masters/use-options';
import { Combobox } from '@/components/ui/multi-select';
import { cn } from '@/lib/utils';
import {
  diffDraft,
  draftBookingIds,
  moveInNewTrip,
  moveToNewTrip,
  newTripOrder,
  newTripSeats,
  setAddNewDropStop,
  setAddNewPickupStop,
  setAddSeqs,
  setNewTripDriver,
  setNewTripTiming,
  setNewTripVehicle,
  undoReassign,
  undoRemove,
  withoutBookings,
  type DispatchDraft,
  type DraftDiffRow,
} from './dispatch-draft';
import { routeText } from './adhoc-booking';
import type { RouteGroup } from './auto-allocate';
import type { EscortWarning } from './night-safety';
import { AfterCutoffBadge, GroupBadge, JourneyBadge } from './adhoc-ui';
import { groupIdOf, groupSelection, groupSizes, purposeOf } from './group-booking';
import { candidateReason, isEditableTrip, straightLineLabel } from './e3-format';
import { BookingStatusBadge, e3ErrorMessage, EtaText, OccupancyBar, PassengerOutcomeBadge, TripStateBadge } from './e3-ui';
import { fetchTransportTrip, transportTripPath, useCandidates, useTransportTrip } from './use-e3';
import { downloadTripSheetsPdf, toSheet, tripSheetsCsv } from './trip-sheet';

export interface PanelCtx {
  board: DispatchBoardDto;
  tz: string | undefined;
  day: string;
  draft: DispatchDraft;
  setDraft: (fn: (d: DispatchDraft) => DispatchDraft) => void;
  selected: Set<string>;
  setSelected: (s: Set<string>) => void;
  canPlan: boolean;
  /** Seat the selected bookings. */
  assignToTrip: (trip: TransportTripSummaryDto) => void;
  assignToVehicle: (v: { objectId: string; label: string; seats: number | null }) => void;
  assignToDraftTrip: (tempId: string) => void;
  /** Ask for a reason and unassign a seated passenger. */
  requestRemove: (trip: TransportTripSummaryDto, p: { id: string; bookingId: string; name: string; seats: number }) => void;
  requestReassign: (trip: TransportTripSummaryDto, kind: 'VEHICLE' | 'DRIVER') => void;
  /** ▶ Start a published, scheduled trip now. */
  startTrip?: (trip: TransportTripSummaryDto) => void;
  /** Night-safety escort warnings of the draft's new trips. */
  escort?: EscortWarning[];
  approve: (b: TransportBookingDto) => void;
  /** Routes made by the Routing button (the waiting list is grouped by them); null before Routing. */
  routes?: RouteGroup[] | null;
  /** Move one waiting booking to another route (null = out of every route). */
  moveToRoute?: (bookingId: string, routeId: string | null) => void;
  busy: boolean;
}

// A withheld personal point (no active routing consent, E2 M3) cannot be assigned either: the server refuses CONSENT_REQUIRED.
const assignable = (b: TransportBookingDto) => b.status === 'PENDING_ASSIGNMENT' && !b.needsLocation && !b.pointsHidden;

// ───────────────────────────── Queue ─────────────────────────────

export function QueuePanel({ ctx, onFind, variant = 'cards' }: { ctx: PanelCtx; onFind?: () => void; variant?: 'cards' | 'table' }) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const inDraft = useMemo(() => draftBookingIds(ctx.draft), [ctx.draft]);
  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? ctx.board.queue.filter((b) => b.passenger.displayName.toLowerCase().includes(s) || b.passenger.employeeCode.toLowerCase().includes(s)) : ctx.board.queue;
  }, [ctx.board.queue, q]);
  const clock = (iso: string) => formatClock(iso, ctx.tz, ctx.day);
  const toggle = (id: string, on: boolean) => {
    const n = new Set(ctx.selected);
    if (on) n.add(id);
    else n.delete(id);
    ctx.setSelected(n);
  };
  const free = rows.filter((b) => assignable(b) && !inDraft.has(b.id));
  // WP 3.9 wave 2 (D-A8): a group ride's bookings can be selected together to put them on one new trip.
  const sizes = useMemo(() => groupSizes(ctx.board.queue), [ctx.board.queue]);
  const selectGroup = (g: string) => {
    const ids = groupSelection(ctx.board.queue, g, inDraft);
    const n = new Set(ctx.selected);
    const all = ids.length > 0 && ids.every((id) => n.has(id));
    for (const id of ids) {
      if (all) n.delete(id);
      else n.add(id);
    }
    ctx.setSelected(n);
  };
  const allSelected = free.length > 0 && free.every((b) => ctx.selected.has(b.id));
  const selectMany = (ids: string[], on: boolean) => {
    const n = new Set(ctx.selected);
    for (const id of ids) {
      if (on) n.add(id);
      else n.delete(id);
    }
    ctx.setSelected(n);
  };
  // Sections: the routes made by Routing (with "Not in a route" last), else one per shift and time window.
  const sections = useMemo(() => {
    const make = (key: string, label: string, list: TransportBookingDto[]) => ({
      key,
      label,
      rows: list,
      seats: list.reduce((s, b) => s + b.passengerCount, 0),
      selectable: list.filter((b) => assignable(b) && !inDraft.has(b.id)).map((b) => b.id),
    });
    const routes = ctx.routes ?? [];
    if (routes.length) {
      const routeOf = new Map(routes.flatMap((r) => r.bookings.map((b) => [b.id, r.id] as const)));
      const out = routes.map((r) => make(r.id, r.label, r.bookings.map((x) => rows.find((b) => b.id === x.id)).filter((b): b is TransportBookingDto => !!b)));
      const rest = rows.filter((b) => !routeOf.has(b.id));
      if (rest.length) out.push(make('none', t('Not in a route'), rest));
      return out.filter((s) => s.rows.length);
    }
    const byKey = new Map<string, TransportBookingDto[]>();
    for (const b of [...rows].sort((a, c) => a.windowStart.localeCompare(c.windowStart) || a.passenger.displayName.localeCompare(c.passenger.displayName))) {
      const k = `${b.shiftId ?? 'adhoc'}|${b.windowStart}|${b.windowEnd}`;
      const l = byKey.get(k);
      if (l) l.push(b);
      else byKey.set(k, [b]);
    }
    return [...byKey.entries()].map(([k, list]) => make(k, `${list[0].shiftName ?? t('One-off')} · ${clock(list[0].windowStart)}–${clock(list[0].windowEnd)}`, list));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, ctx.routes, inDraft, t]);
  return (
    <section aria-labelledby="queue-h" className="flex min-h-0 min-w-0 flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <h2 id="queue-h" className="text-sm font-semibold">
          {t('Riders waiting')} <span className="text-muted-foreground tabular-nums">({ctx.board.queue.length})</span>
        </h2>
        {ctx.canPlan && free.length > 0 && (
          <Button size="sm" variant="ghost" onClick={() => ctx.setSelected(allSelected ? new Set() : new Set(free.map((b) => b.id)))}>
            {allSelected ? t('Select none') : t('Select all')}
          </Button>
        )}
      </div>
      <div className="relative">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Search passenger…')} aria-label={t('Search the queue')} className="h-9 pl-8" />
      </div>
      {rows.length === 0 ? (
        <EmptyState icon={InboxIcon} title={ctx.board.queue.length ? t('No match') : t('Everyone has a seat')} description={ctx.board.queue.length ? undefined : t('No booking of this day and direction is waiting for a seat.')} className="py-8" />
      ) : variant === 'table' ? (
        <div className="max-h-[42dvh] overflow-auto rounded-lg border bg-card">
          <table className="w-full text-sm" aria-label={t('Bookings waiting for a seat')}>
            <thead className="sticky top-0 z-[2] bg-muted text-xs text-muted-foreground uppercase">
              <tr>
                {ctx.canPlan && <th className="w-9 px-2 py-2" />}
                <th className="px-2 py-2 text-left font-medium">{t('Passenger')}</th>
                <th className="px-2 py-2 text-left font-medium">{t('Shift')}</th>
                <th className="px-2 py-2 text-left font-medium">{t('Direction')}</th>
                <th className="hidden px-2 py-2 text-left font-medium lg:table-cell">{t('Pickup → destination')}</th>
                <th className="px-2 py-2 text-left font-medium">{t('Window')}</th>
                <th className="px-2 py-2 text-left font-medium">{t('Status')}</th>
                {!!ctx.routes?.length && <th className="px-2 py-2 text-left font-medium">{t('Route')}</th>}
              </tr>
            </thead>
            <tbody>
              {sections.map((sec) => (
                <Fragment key={sec.key}>
                  <tr className="bg-accent/60">
                    {ctx.canPlan && (
                      <td className="px-2 py-1.5">
                        {sec.selectable.length > 0 && <Checkbox checked={sec.selectable.every((id) => ctx.selected.has(id))} onCheckedChange={(v) => selectMany(sec.selectable, !!v)} aria-label={t('Select everyone in {{group}}', { group: sec.label })} />}
                      </td>
                    )}
                    <td colSpan={20} className="px-2 py-1.5 text-sm font-semibold text-primary">
                      {sec.label}
                      <span className="ml-2 text-xs font-normal text-muted-foreground">{t('{{n}} people · {{s}} seats', { n: sec.rows.length, s: sec.seats })}</span>
                    </td>
                  </tr>
                  {sec.rows.map((b, i) => {
                    const drafted = inDraft.has(b.id);
                    const ok = assignable(b);
                    return (
                      <tr key={b.id} className={cn('border-t', ctx.selected.has(b.id) && 'bg-primary/5', drafted && 'opacity-60')}>
                        {ctx.canPlan && (
                          <td className="px-2 py-1.5">
                            <Checkbox disabled={!ok || drafted} checked={ctx.selected.has(b.id)} onCheckedChange={(v) => toggle(b.id, !!v)} aria-label={t('Select {{name}}', { name: b.passenger.displayName })} />
                          </td>
                        )}
                        <td className="px-2 py-1.5">
                          <span className="flex items-start gap-2">
                            <span className="w-5 shrink-0 pt-px text-right text-xs text-muted-foreground tabular-nums">{i + 1}.</span>
                            <span className="min-w-0">
                              <span className="block font-medium">{b.passenger.displayName}</span>
                              <span className="font-mono text-xs text-muted-foreground">{b.passenger.employeeCode}</span>
                            </span>
                          </span>
                        </td>
                        <td className="px-2 py-1.5 text-xs">{b.shiftName ?? t('One-off')}</td>
                        <td className="px-2 py-1.5 text-xs">{b.journey === 'POINT_TO_POINT' ? t('Point-to-point') : b.direction === 'OUT' ? t('Logout') : t('Login')}</td>
                        <td className="hidden max-w-72 truncate px-2 py-1.5 text-xs text-muted-foreground lg:table-cell">{routeText(b, t)}</td>
                        <td className="px-2 py-1.5 text-xs tabular-nums">
                          {clock(b.windowStart)}–{clock(b.windowEnd)}
                        </td>
                        <td className="px-2 py-1.5">
                          <span className="flex flex-wrap items-center gap-1">
                            {drafted ? <Badge variant="info">{t('In draft')}</Badge> : b.status === 'PENDING_ASSIGNMENT' ? <Badge variant="outline">{t('Waiting')}</Badge> : <BookingStatusBadge status={b.status} />}
                            {b.needsLocation && <Badge variant="warning">{t('Needs location')}</Badge>}
                            {b.pointsHidden === 'CONSENT_REQUIRED' && <Badge variant="warning">{t('No routing consent')}</Badge>}
                            {groupIdOf(b) && <GroupBadge size={sizes.get(groupIdOf(b)!) ?? 1} purpose={purposeOf(b)} />}
                            {(b.status === 'REQUESTED' || b.status === 'WAITLISTED') && b.allowedActions.includes('approve') && (
                              <Button size="sm" variant="outline" className="h-7" onClick={() => ctx.approve(b)} disabled={ctx.busy}>
                                <CheckIcon /> {t('Approve')}
                              </Button>
                            )}
                          </span>
                        </td>
                        {!!ctx.routes?.length && (
                          <td className="px-2 py-1.5">
                            {ctx.canPlan && ctx.moveToRoute && !drafted && (
                              <select
                                className="h-7 max-w-36 rounded-md border border-input bg-card px-1.5 text-xs focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                                value={ctx.routes.find((r) => r.bookings.some((x) => x.id === b.id))?.id ?? ''}
                                onChange={(e) => ctx.moveToRoute!(b.id, e.target.value || null)}
                                aria-label={t('Route of {{name}}', { name: b.passenger.displayName })}
                              >
                                <option value="">{t('Not in a route')}</option>
                                {ctx.routes.map((r) => (
                                  <option key={r.id} value={r.id}>
                                    {r.label.split(' · ')[0]}
                                  </option>
                                ))}
                              </select>
                            )}
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <ul className="flex min-h-0 flex-col gap-2 overflow-y-auto pr-0.5" aria-label={t('Bookings waiting for a seat')}>
          {sections.map((sec) => (
            <Fragment key={sec.key}>
              <li className="sticky top-0 z-[1] flex items-center gap-2 rounded-md bg-accent px-2 py-1.5 text-xs font-semibold text-primary">
                {ctx.canPlan && sec.selectable.length > 0 && (
                  <Checkbox checked={sec.selectable.every((id) => ctx.selected.has(id))} onCheckedChange={(v) => selectMany(sec.selectable, !!v)} aria-label={t("Select everyone in {{group}}", { group: sec.label })} />
                )}
                <span className="min-w-0 flex-1 truncate">{sec.label}</span>
                <span className="shrink-0 font-normal text-muted-foreground tabular-nums">{t("{{n}} people · {{s}} seats", { n: sec.rows.length, s: sec.seats })}</span>
              </li>
              {sec.rows.map((b) => {
            const drafted = inDraft.has(b.id);
            const ok = assignable(b);
            return (
              <li key={b.id}>
                <div className={cn('flex items-start gap-2 rounded-lg border bg-card p-2.5', ctx.selected.has(b.id) && 'border-primary bg-primary/5', drafted && 'opacity-70')}>
                  {ctx.canPlan && (
                    <Checkbox className="mt-0.5" disabled={!ok || drafted} checked={ctx.selected.has(b.id)} onCheckedChange={(v) => toggle(b.id, !!v)} aria-label={t('Select {{name}}', { name: b.passenger.displayName })} />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-sm font-medium">{b.passenger.displayName}</span>
                      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                        {clock(b.windowStart)}–{clock(b.windowEnd)}
                      </span>
                    </div>
                    <p className="truncate text-xs text-muted-foreground">
                      {routeText(b, t)}
                      {b.passengerCount > 1 && ` · ${t('{{n}} seats', { n: b.passengerCount })}`}
                      {b.shiftName && ` · ${b.shiftName}`}
                    </p>
                    <div className="mt-1 flex flex-wrap items-center gap-1">
                      {b.status !== 'PENDING_ASSIGNMENT' && <BookingStatusBadge status={b.status} />}
                      {/* WP 3.9: optional reads, so an older board DTO without the fields renders as before. */}
                      {b.journey === 'POINT_TO_POINT' && <JourneyBadge journey="POINT_TO_POINT" />}
                      {b.afterCutoff === true && <AfterCutoffBadge reason={b.lateReason ?? null} />}
                      {groupIdOf(b) &&
                        (ctx.canPlan ? (
                          <GroupBadge
                            size={sizes.get(groupIdOf(b)!) ?? 1}
                            purpose={purposeOf(b)}
                            active={groupSelection(ctx.board.queue, groupIdOf(b)!, inDraft).some((id) => ctx.selected.has(id))}
                            onClick={() => selectGroup(groupIdOf(b)!)}
                            selectLabel
                          />
                        ) : (
                          <GroupBadge size={sizes.get(groupIdOf(b)!) ?? 1} purpose={purposeOf(b)} />
                        ))}
                      {b.needsLocation && <Badge variant="warning">{t('Needs location')}</Badge>}
                      {b.pointsHidden === 'CONSENT_REQUIRED' && <Badge variant="warning">{t('No routing consent')}</Badge>}
                      {drafted && <Badge variant="info">{t('In draft')}</Badge>}
                      {ctx.canPlan && !!ctx.routes?.length && ctx.moveToRoute && !drafted && (
                        <select
                          className="h-7 max-w-40 rounded-md border border-input bg-card px-1.5 text-xs focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                          value={ctx.routes.find((r) => r.bookings.some((x) => x.id === b.id))?.id ?? ''}
                          onChange={(e) => ctx.moveToRoute!(b.id, e.target.value || null)}
                          aria-label={t('Route of {{name}}', { name: b.passenger.displayName })}
                        >
                          <option value="">{t('Not in a route')}</option>
                          {ctx.routes.map((r) => (
                            <option key={r.id} value={r.id}>
                              {r.label.split(' · ')[0]}
                            </option>
                          ))}
                        </select>
                      )}
                      {(b.status === 'REQUESTED' || b.status === 'WAITLISTED') && b.allowedActions.includes('approve') && (
                        <Button size="sm" variant="outline" className="h-7" onClick={() => ctx.approve(b)} disabled={ctx.busy}>
                          <CheckIcon /> {t('Approve')}
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              </li>
            );
              })}
            </Fragment>
          ))}
        </ul>
      )}
      {ctx.canPlan && ctx.selected.size > 0 && onFind && (
        <Button onClick={onFind} className="mt-1">
          {t('Find a vehicle for {{n}}', { n: ctx.selected.size })}
        </Button>
      )}
    </section>
  );
}

// ───────────────────────────── Candidates ─────────────────────────────

function CandidateCard({ c, ctx, seatsNeeded, diff }: { c: DispatchCandidateDto; ctx: PanelCtx; seatsNeeded: number; diff: Map<string, DraftDiffRow> }) {
  const { t } = useTranslation();
  const trip = c.tripId ? ctx.board.trips.find((x) => x.id === c.tripId) : undefined;
  const used = c.seatCapacity === null ? 0 : c.seatCapacity - c.freeSeats;
  const pending = c.tripId ? (diff.get(c.tripId)?.after ?? used) : used;
  const straight = straightLineLabel(c.straightM, t);
  return (
    <li>
      <Card className="gap-2 p-3">
        <div className="flex items-start gap-2">
          <span className={cn('mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full', c.kind === 'TRIP' ? 'bg-primary/12 text-primary' : 'bg-muted text-muted-foreground')} aria-hidden>
            {c.kind === 'TRIP' ? <BusIcon className="size-4" /> : <CarFrontIcon className="size-4" />}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">
              {c.vehicleName}
              {c.plateNumber && <span className="text-muted-foreground"> · {c.plateNumber}</span>}
            </p>
            <p className="truncate text-xs text-muted-foreground">{c.kind === 'TRIP' ? (trip?.name ?? t('Published trip')) : t('Idle vehicle · new trip')}</p>
          </div>
          <Badge variant={c.feasible ? 'success' : 'muted'}>{c.feasible ? t('Fits') : t('Blocked')}</Badge>
        </div>
        <OccupancyBar used={pending} capacity={c.seatCapacity} after={pending + seatsNeeded} />
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
          {c.nearestStop && (
            <>
              <dt className="text-muted-foreground">{t('Nearest stop')}</dt>
              <dd className="truncate">{c.nearestStop.label}</dd>
            </>
          )}
          {straight && (
            <>
              <dt className="text-muted-foreground">{t('Distance')}</dt>
              <dd>{straight}</dd>
            </>
          )}
          <dt className="text-muted-foreground">{t('ETA to pickup')}</dt>
          <dd>
            <EtaText eta={c.eta} tz={ctx.tz} day={ctx.day} />
          </dd>
        </dl>
        {c.reasons.length > 0 && (
          <ul className="flex flex-wrap gap-1" aria-label={t('Why not')}>
            {c.reasons.map((r) => (
              <li key={r}>
                <Badge variant="warning">
                  <CircleAlertIcon aria-hidden /> {t(candidateReason(r))}
                </Badge>
              </li>
            ))}
          </ul>
        )}
        {ctx.canPlan && (
          <Button
            size="sm"
            variant={c.feasible ? 'default' : 'outline'}
            disabled={!c.feasible || ctx.busy}
            onClick={() => (c.kind === 'TRIP' && trip ? ctx.assignToTrip(trip) : ctx.assignToVehicle({ objectId: c.objectId, label: c.vehicleName, seats: c.seatCapacity }))}
          >
            <PlusIcon /> {c.kind === 'TRIP' ? t('Add to this trip (draft)') : t('New trip with this vehicle (draft)')}
          </Button>
        )}
      </Card>
    </li>
  );
}

/** Ranked trips / vehicles for the selected bookings (POST /dispatch/candidates). No ETA is ever invented. */
export function CandidatesPanel({ ctx }: { ctx: PanelCtx }) {
  const { t } = useTranslation();
  const ids = useMemo(() => [...ctx.selected], [ctx.selected]);
  const cands = useCandidates(ids);
  const diff = useMemo(() => new Map(diffDraft(ctx.draft, ctx.board.trips).map((r) => [r.key, r])), [ctx.draft, ctx.board.trips]);
  const data = cands.data;
  return (
    <section aria-labelledby="cand-h" className="flex min-h-0 min-w-0 flex-col gap-2">
      <h2 id="cand-h" className="text-sm font-semibold">
        {t('Assign')}
        {ids.length > 0 && <span className="font-normal text-muted-foreground"> · {t('{{n}} selected', { n: ids.length })}</span>}
      </h2>
      {ids.length === 0 ? (
        <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">{t('Select bookings in the queue to see the trips and vehicles that can take them. You can also use "Assign selected here" on any trip or vehicle.')}</p>
      ) : cands.isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : cands.isError ? (
        <>
          <FormError message={e3ErrorMessage(cands.error, t)} />
          <p className="text-xs text-muted-foreground">{t('Candidates are unavailable. Assign manually from the trips and vehicles list.')}</p>
        </>
      ) : data ? (
        <>
          {data.degraded === 'ROUTING_UNAVAILABLE' && (
            <div role="status" className="flex gap-2 rounded-lg border border-warning/40 bg-warning-soft p-2.5 text-xs text-warning-fg">
              <CircleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span>{t('Routing is unavailable: no ETAs. Candidates are ranked by free seats and straight-line distance only. Manual assignment still works.')}</span>
            </div>
          )}
          <p className="text-xs text-muted-foreground">{t('{{n}} seat(s) needed. Road ETAs are estimates without live traffic.', { n: data.seatsNeeded })}</p>
          {data.candidates.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('No trip or idle vehicle found. Set vehicle seats or free a vehicle.')}</p>
          ) : (
            <ul className="flex min-h-0 flex-col gap-2 overflow-y-auto pr-0.5">
              {data.candidates.map((c) => (
                <CandidateCard key={`${c.kind}-${c.tripId ?? c.objectId}`} c={c} ctx={ctx} seatsNeeded={data.seatsNeeded} diff={diff} />
              ))}
            </ul>
          )}
        </>
      ) : null}
    </section>
  );
}

// ───────────────────────────── Trips & vehicles ─────────────────────────────

function Manifest({ trip, ctx }: { trip: TransportTripSummaryDto; ctx: PanelCtx }) {
  const { t } = useTranslation();
  const detail = useTransportTrip(trip.id);
  const removed = new Set(ctx.draft.removes.map((r) => r.passengerTripId));
  if (detail.isPending) return <Skeleton className="h-16 w-full" />;
  if (detail.isError) return <FormError message={e3ErrorMessage(detail.error, t)} />;
  const list = detail.data.passengers.filter((p) => p.status !== 'CANCELLED');
  if (!list.length) return <p className="text-xs text-muted-foreground">{t('No passengers yet.')}</p>;
  const editable = isEditableTrip(trip.derivedState);
  return (
    <ul className="divide-y rounded-md border text-sm">
      {list.map((p) => (
        <li key={p.id} className="flex items-center gap-2 px-2 py-1.5">
          <span className="min-w-0 flex-1 truncate">
            {p.passenger.displayName}
            <span className="text-xs text-muted-foreground">
              {' '}
              · {t('stop {{n}}', { n: p.pickupSeq + 1 })}
            </span>
          </span>
          {removed.has(p.id) ? <Badge variant="destructive">{t('Removing')}</Badge> : <PassengerOutcomeBadge passenger={p} />}
          {ctx.canPlan && editable && p.status === 'PENDING' && !removed.has(p.id) && (
            <Button size="icon-sm" variant="ghost" onClick={() => ctx.requestRemove(trip, { id: p.id, bookingId: p.bookingId, name: p.passenger.displayName, seats: p.seats })} aria-label={t('Unassign {{name}}', { name: p.passenger.displayName })}>
              <UserMinusIcon />
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}

function TripCard({ trip, ctx, diff }: { trip: TransportTripSummaryDto; ctx: PanelCtx; diff?: DraftDiffRow }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const editable = isEditableTrip(trip.derivedState);
  const clock = (iso: string | null) => formatClock(iso, ctx.tz, ctx.day);
  const pc = trip.passengerCounts;
  const sheets = useTripSheets(ctx);
  return (
    <li>
      <Card className={cn('gap-2 p-3', diff && 'border-info/60')}>
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <Link to={transportTripPath(trip.id)} className="block truncate text-sm font-medium hover:underline">
              {trip.vehicleName ?? t('No vehicle')}
              {trip.plateNumber && <span className="text-muted-foreground"> · {trip.plateNumber}</span>}
            </Link>
            <p className="truncate text-xs text-muted-foreground">
              {clock(trip.plannedStart)} · {trip.name}
              {trip.driverName && ` · ${trip.driverName}`}
            </p>
          </div>
          <TripStateBadge state={trip.derivedState} />
          {ctx.canPlan && ctx.startTrip && trip.plannedTripStatus === 'SCHEDULED' && !!trip.publishedAt && !trip.cancelledAt && (
            <Button size="sm" variant="outline" className="h-8" disabled={ctx.busy} onClick={() => ctx.startTrip!(trip)} title={t('Start this trip now')}>
              <PlayIcon /> {t('Start')}
            </Button>
          )}
          {trip.derivedState !== 'CANCELLED' && (
            <Button size="icon-sm" variant="ghost" disabled={sheets.busy} onClick={() => void sheets.run([trip], 'pdf')} aria-label={t('Trip sheet (PDF) for {{name}}', { name: trip.vehicleName ?? trip.name })} title={t('Trip sheet (PDF)')}>
              <FileDownIcon />
            </Button>
          )}
          {ctx.canPlan && editable && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="icon-sm" variant="ghost" aria-label={t('Actions for {{name}}', { name: trip.vehicleName ?? trip.name })}>
                  <MoreHorizontalIcon />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => ctx.requestReassign(trip, 'VEHICLE')}>
                  <BusIcon /> {t('Change vehicle…')}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => ctx.requestReassign(trip, 'DRIVER')}>
                  <UserRoundIcon /> {t('Change driver…')}
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link to={transportTripPath(trip.id)}>
                    <ExternalLinkIcon /> {t('Open trip')}
                  </Link>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
        <OccupancyBar used={trip.occupiedSeats} capacity={diff?.capacity ?? trip.seatCapacity} after={diff?.after} />
        <p className="text-xs text-muted-foreground">
          {t('{{b}} boarded · {{w}} waiting · {{n}} no-show', { b: pc.boarded + pc.dropped, w: pc.pending, n: pc.noShow })}
        </p>
        {diff && (diff.added.length > 0 || diff.removed.length > 0 || diff.notes.length > 0) && (
          <p className="text-xs text-info-fg">
            {t('Draft')}: {[...diff.added.map((n) => `+${n}`), ...diff.removed.map((n) => `−${n}`), ...diff.notes.map((x) => `${x.kind === 'VEHICLE' ? t('Vehicle') : t('Driver')} → ${x.label}`)].join(', ')}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          {ctx.canPlan && editable && ctx.selected.size > 0 && (
            <Button size="sm" onClick={() => ctx.assignToTrip(trip)} disabled={ctx.busy}>
              <PlusIcon /> {t('Assign selected here')}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => setOpen(!open)} aria-expanded={open}>
            {open ? <ChevronUpIcon /> : <ChevronDownIcon />} {t('Passengers')}
          </Button>
        </div>
        {open && <Manifest trip={trip} ctx={ctx} />}
      </Card>
    </li>
  );
}

function DraftTripCard({ tempId, ctx, diff }: { tempId: string; ctx: PanelCtx; diff?: DraftDiffRow }) {
  const { t } = useTranslation();
  const n = ctx.draft.newTrips.find((x) => x.tempId === tempId);
  if (!n) return null;
  const wall = toZonedWall(n.startMs, ctx.tz);
  const order = newTripOrder(n, ctx.draft.bookings, ctx.draft.direction);
  const others = ctx.draft.newTrips.filter((x) => x.tempId !== tempId);
  return (
    <li>
      <Card className="gap-2 border-dashed border-info/70 p-3">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{n.label}</p>
            <p className="text-xs text-muted-foreground">{t('New door-to-door trip (not published)')}</p>
          </div>
          <Badge variant="info">{t('Draft')}</Badge>
        </div>
        <OccupancyBar used={0} capacity={n.seats} after={diff?.after ?? 0} />
        <div className="grid grid-cols-2 gap-2">
          <Field label={t('Start')} htmlFor={`start-${tempId}`}>
            <Input
              id={`start-${tempId}`}
              type="datetime-local"
              value={wall}
              onChange={(e) => {
                const ms = fromZonedWall(e.target.value, ctx.tz);
                if (Number.isFinite(ms)) ctx.setDraft((d) => setNewTripTiming(d, tempId, ms, n.gapMin));
              }}
              className="h-8 text-xs"
            />
          </Field>
          <Field label={t('Minutes between stops')} htmlFor={`gap-${tempId}`}>
            <Input
              id={`gap-${tempId}`}
              type="number"
              min={1}
              max={120}
              value={n.gapMin}
              onChange={(e) => {
                const g = Math.max(1, Math.min(120, Math.round(Number(e.target.value) || 1)));
                ctx.setDraft((d) => setNewTripTiming(d, tempId, n.startMs, g));
              }}
              className="h-8 text-xs"
            />
          </Field>
        </div>
        <p className="text-xs text-muted-foreground">{t('Planned stop times are spaced evenly from the start; they are a plan, not a road estimate.')}</p>
        {ctx.escort?.filter((w) => w.tempId === tempId).map((w) => (
          <p key={w.tempId} className="rounded-md border border-warning/50 bg-warning/10 px-2 py-1 text-xs">
            {w.end === 'FIRST_PICKUP' ? t('Night: {{name}} is first pickup alone at {{time}}. Escort or reorder.', { name: w.passenger, time: w.time }) : t('Night: {{name}} is last drop alone at {{time}}. Escort or reorder.', { name: w.passenger, time: w.time })}
          </p>
        ))}
        {ctx.canPlan && <DraftTripVehicleDriver tempId={tempId} ctx={ctx} />}
        <ol className="grid gap-1" aria-label={ctx.draft.direction === 'OUT' ? t('Drop order') : t('Pickup order')}>
          {order.map((id, i) => {
            const name = ctx.draft.bookings[id]?.name ?? id;
            return (
              <li key={id} className="flex items-center gap-1 rounded-md border bg-card px-1.5 py-1 text-sm">
                <span className="w-5 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{i + 1}.</span>
                <span className="min-w-0 flex-1 truncate">{name}</span>
                {ctx.canPlan && (
                  <>
                    <Button size="icon-sm" variant="ghost" disabled={i === 0} onClick={() => ctx.setDraft((d) => moveInNewTrip(d, tempId, id, -1))} aria-label={t('Move {{name}} up', { name })}>
                      <ChevronUpIcon />
                    </Button>
                    <Button size="icon-sm" variant="ghost" disabled={i === order.length - 1} onClick={() => ctx.setDraft((d) => moveInNewTrip(d, tempId, id, 1))} aria-label={t('Move {{name}} down', { name })}>
                      <ChevronDownIcon />
                    </Button>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button size="icon-sm" variant="ghost" aria-label={t('More for {{name}}', { name })}>
                          <MoreHorizontalIcon />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {others.map((o) => {
                          const free = o.seats - newTripSeats(o, ctx.draft.bookings);
                          const need = ctx.draft.bookings[id]?.seats ?? 1;
                          return (
                            <DropdownMenuItem key={o.tempId} disabled={free < need} onSelect={() => ctx.setDraft((d) => moveToNewTrip(d, [id], o.tempId))}>
                              <ArrowRightLeftIcon /> {t('Move to {{vehicle}} ({{n}} free)', { vehicle: o.label, n: free })}
                            </DropdownMenuItem>
                          );
                        })}
                        <DropdownMenuItem variant="destructive" onSelect={() => ctx.setDraft((d) => withoutBookings(d, [id]))}>
                          <UserMinusIcon /> {t('Remove (back to waiting)')}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </>
                )}
              </li>
            );
          })}
        </ol>
        {ctx.canPlan && ctx.selected.size > 0 && (
          <Button size="sm" onClick={() => ctx.assignToDraftTrip(tempId)} disabled={ctx.busy} className="justify-self-start">
            <PlusIcon /> {t('Assign selected here')}
          </Button>
        )}
      </Card>
    </li>
  );
}

/** Vehicle and driver of a new trip in the draft (free vehicles with enough seats; drivers when the role may see them). */
function DraftTripVehicleDriver({ tempId, ctx }: { tempId: string; ctx: PanelCtx }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const [q, setQ] = useState('');
  const drivers = useEntityOptions<DriverDto>('/drivers', named, { q, enabled: can('drivers') });
  const n = ctx.draft.newTrips.find((x) => x.tempId === tempId);
  if (!n) return null;
  const need = newTripSeats(n, ctx.draft.bookings);
  const usedElsewhere = new Set(ctx.draft.newTrips.filter((x) => x.tempId !== tempId).map((x) => x.objectId));
  const vehicles = ctx.board.vehicles.filter((v) => v.objectId === n.objectId || (v.seats !== null && v.seats >= need && !usedElsewhere.has(v.objectId)));
  const sel = 'h-8 w-full min-w-0 rounded-md border border-input bg-card px-2 text-xs focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none';
  return (
    <div className="grid grid-cols-2 gap-2">
      <label className="grid gap-0.5 text-xs">
        <span className="text-muted-foreground">{t('Vehicle')}</span>
        <select
          className={sel}
          value={n.objectId}
          onChange={(e) => {
            const v = ctx.board.vehicles.find((x) => x.objectId === e.target.value);
            if (v && v.seats !== null) ctx.setDraft((d) => setNewTripVehicle(d, tempId, { objectId: v.objectId, label: v.plateNumber ? `${v.name} · ${v.plateNumber}` : v.name, seats: v.seats! }));
          }}
        >
          {vehicles.map((v) => (
            <option key={v.objectId} value={v.objectId}>
              {v.name} — {t('{{n}} seats', { n: v.seats ?? 0 })}
              {ctx.board.complianceMode !== 'OFF' && v.compliance?.length ? ` ⚠ ${complianceText(v.compliance)}` : ''}
            </option>
          ))}
        </select>
      </label>
      {can('drivers') ? (
        <div className="grid gap-0.5 text-xs">
          <span className="text-muted-foreground">{t('Driver')}</span>
          <Combobox
            value={n.driverId ?? null}
            onChange={(id) => ctx.setDraft((d) => setNewTripDriver(d, tempId, id ? { id, label: drivers.options.find((o) => o.value === id)?.label ?? '' } : null))}
            options={n.driverId && !drivers.options.some((o) => o.value === n.driverId) ? [{ value: n.driverId, label: n.driverLabel ?? '' }, ...drivers.options] : drivers.options}
            loading={drivers.loading}
            onSearch={setQ}
            placeholder={t('No driver')}
            searchPlaceholder={t('Search drivers…')}
            emptyText={t('No drivers found')}
          />
        </div>
      ) : (
        n.driverLabel && <p className="self-end text-xs text-muted-foreground">{t('Driver')}: {n.driverLabel}</p>
      )}
    </div>
  );
}

function VehicleRow({ v, ctx }: { v: DispatchVehicleDto; ctx: PanelCtx }) {
  const { t } = useTranslation();
  const clock = (iso: string) => formatClock(iso, ctx.tz, ctx.day);
  return (
    <li className="flex items-start gap-2 rounded-lg border bg-card p-2.5">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">
          {v.name}
          {v.plateNumber && <span className="text-muted-foreground"> · {v.plateNumber}</span>}
        </p>
        <p className="truncate text-xs text-muted-foreground">
          {v.seats === null ? t('Seats not set') : t('{{n}} seats', { n: v.seats })}
          {ctx.board.complianceMode !== 'OFF' && !!v.compliance?.length && (
            <span className={cn('ml-1 font-medium', ctx.board.complianceMode === 'BLOCK' ? 'text-destructive-fg' : 'text-warning-fg')} title={complianceText(v.compliance)}>
              {' · ⚠ '}
              {complianceText(v.compliance)}
            </span>
          )}
          {v.busy.length > 0 ? ` · ${t('Busy')} ${v.busy.map((b) => `${clock(b.plannedStart)}–${clock(b.plannedEnd)}`).join(', ')}` : ` · ${t('Free all day')}`}
        </p>
      </div>
      {ctx.canPlan && ctx.selected.size > 0 && (
        <Button size="sm" variant="outline" disabled={v.seats === null || ctx.busy} onClick={() => ctx.assignToVehicle({ objectId: v.objectId, label: v.name, seats: v.seats })} title={v.seats === null ? t("Set the vehicle's passenger seats first (Vehicle seats).") : undefined}>
          <PlusIcon /> {t('New trip')}
        </Button>
      )}
    </li>
  );
}

function downloadText(text: string, filename: string, type = 'text/csv;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Trip sheets of published trips: PDF (one page per trip) or one CSV for Excel. */
function useTripSheets(ctx: PanelCtx) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { me } = useAuth();
  const [busy, setBusy] = useState(false);
  const direction = ctx.draft.direction === 'OUT' ? 'From site (logout)' : 'To site (login)';
  const run = async (trips: TransportTripSummaryDto[], kind: 'pdf' | 'csv') => {
    const live = trips.filter((x) => x.derivedState !== 'CANCELLED');
    if (!live.length) {
      toast.info(t('No published trips to print. Publish the draft first.'));
      return;
    }
    setBusy(true);
    try {
      const details = await Promise.all(live.map((x) => fetchTransportTrip(qc, x.id)));
      const sheets = details.map((d) => toSheet(d, (iso) => formatClock(iso, ctx.tz, ctx.day)));
      const base = live.length === 1 ? `trip-sheet-${ctx.day}-${(live[0].vehicleName ?? live[0].name).replace(/[^\w-]+/g, '_')}` : `trip-sheets-${ctx.day}-${ctx.draft.direction}`;
      if (kind === 'csv') downloadText(tripSheetsCsv(sheets, { date: ctx.day, direction }), `${base}.csv`);
      else await downloadTripSheetsPdf(sheets, { company: me?.company.name ?? '', date: ctx.day, direction, printedAt: new Date().toLocaleString() }, `${base}.pdf`);
    } catch (e) {
      toast.error(e3ErrorMessage(e, t));
    } finally {
      setBusy(false);
    }
  };
  return { run, busy };
}

export function TripsPanel({ ctx }: { ctx: PanelCtx }) {
  const { t } = useTranslation();
  // Collapsed by default: open when a vehicle is needed (Allocate vehicles and the trip cards use them anyway).
  const [showVehicles, setShowVehicles] = useState(false);
  const diff = useMemo(() => new Map(diffDraft(ctx.draft, ctx.board.trips).map((r) => [r.key, r])), [ctx.draft, ctx.board.trips]);
  const trips = useMemo(() => [...ctx.board.trips].sort((a, b) => (a.plannedStart ?? '').localeCompare(b.plannedStart ?? '')), [ctx.board.trips]);
  const sheets = useTripSheets(ctx);
  return (
    <section aria-labelledby="trips-h" className="flex min-h-0 min-w-0 flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <h2 id="trips-h" className="text-sm font-semibold">
          {t('Trips')} <span className="text-muted-foreground tabular-nums">({trips.length + ctx.draft.newTrips.length})</span>
        </h2>
        {trips.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline" disabled={sheets.busy}>
                <FileDownIcon /> {t('Trip sheets')}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => void sheets.run(trips, 'pdf')}>
                <FileDownIcon /> {t('All trips (PDF, one page per trip)')}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void sheets.run(trips, 'csv')}>
                <FileDownIcon /> {t('All trips (Excel / CSV)')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      <ul className="flex flex-col gap-2">
        {ctx.draft.newTrips.map((n) => (
          <DraftTripCard key={n.tempId} tempId={n.tempId} ctx={ctx} diff={diff.get(n.tempId)} />
        ))}
        {trips.map((trip) => (
          <TripCard key={trip.id} trip={trip} ctx={ctx} diff={diff.get(trip.id)} />
        ))}
      </ul>
      {trips.length === 0 && ctx.draft.newTrips.length === 0 && <p className="text-sm text-muted-foreground">{t('No trips on this day yet.')}</p>}
      <div className="mt-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold">
          {t('Vehicles')} <span className="text-muted-foreground tabular-nums">({ctx.board.vehicles.length})</span>
        </h2>
        <Button size="sm" variant="ghost" onClick={() => setShowVehicles(!showVehicles)} aria-expanded={showVehicles}>
          {showVehicles ? <ChevronUpIcon /> : <ChevronDownIcon />} {showVehicles ? t('Hide') : t('Show')}
        </Button>
      </div>
      {showVehicles && (
        <ul className="flex flex-col gap-2">
          {ctx.board.vehicles.map((v) => (
            <VehicleRow key={v.objectId} v={v} ctx={ctx} />
          ))}
        </ul>
      )}
    </section>
  );
}

// ───────────────────────────── Draft tray ─────────────────────────────

function AddStops({ tripId, bookingId, ctx }: { tripId: string; bookingId: string; ctx: PanelCtx }) {
  const { t } = useTranslation();
  const detail = useTransportTrip(tripId);
  const add = ctx.draft.adds.find((a) => a.bookingId === bookingId);
  if (!add || !detail.data) return null;
  const stops = [...detail.data.stops].sort((a, b) => a.seq - b.seq);
  const sel = 'h-8 min-w-0 rounded-md border border-input bg-card px-2 text-xs focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none';
  // "new:<afterSeq>" = a new stop at the passenger's own point (server ADD_STOP), placed after that stop.
  const pickValue = add.newStop?.end === 'PICKUP' ? `new:${add.newStop.afterSeq}` : String(add.pickupSeq);
  const dropValue = add.newStop?.end === 'DROP' ? `new:${add.newStop.afterSeq}` : String(add.dropSeq);
  const pickupAfter = add.newStop?.end === 'PICKUP' ? add.newStop.afterSeq : add.pickupSeq;
  return (
    <div className="mt-1 grid grid-cols-2 gap-2">
      <label className="grid gap-0.5 text-xs">
        <span className="text-muted-foreground">{t('Pickup stop')}</span>
        <select
          className={sel}
          value={pickValue}
          onChange={(e) => {
            const v = e.target.value;
            if (v.startsWith('new:')) ctx.setDraft((d) => setAddNewPickupStop(d, bookingId, Number(v.slice(4))));
            else ctx.setDraft((d) => setAddSeqs(d, bookingId, Number(v), Math.max(add.dropSeq, Number(v) + 1)));
          }}
        >
          {stops.slice(0, -1).map((s) => (
            <option key={s.seq} value={s.seq}>
              {s.seq + 1}. {s.name}
            </option>
          ))}
          <optgroup label={t('New stop at the passenger’s pickup')}>
            <option value="new:-1">{t('New stop before {{n}}. {{name}}', { n: 1, name: stops[0]?.name ?? '' })}</option>
            {stops.slice(0, -1).map((s) => (
              <option key={`new-${s.seq}`} value={`new:${s.seq}`}>
                {t('New stop after {{n}}. {{name}}', { n: s.seq + 1, name: s.name })}
              </option>
            ))}
          </optgroup>
        </select>
      </label>
      <label className="grid gap-0.5 text-xs">
        <span className="text-muted-foreground">{t('Drop stop')}</span>
        <select
          className={sel}
          value={dropValue}
          onChange={(e) => {
            const v = e.target.value;
            if (v.startsWith('new:')) ctx.setDraft((d) => setAddNewDropStop(d, bookingId, Number(v.slice(4))));
            else ctx.setDraft((d) => (add.newStop?.end === 'PICKUP' ? { ...d, adds: d.adds.map((a) => (a.bookingId === bookingId ? { ...a, dropSeq: Number(v) } : a)) } : setAddSeqs(d, bookingId, add.pickupSeq, Number(v))));
          }}
        >
          {stops
            .filter((s) => s.seq > pickupAfter)
            .map((s) => (
              <option key={s.seq} value={s.seq}>
                {s.seq + 1}. {s.name}
              </option>
            ))}
          {add.newStop?.end !== 'PICKUP' && (
            <optgroup label={t('New stop at the passenger’s drop')}>
              {stops
                .filter((s) => s.seq >= add.pickupSeq)
                .map((s) => (
                  <option key={`new-${s.seq}`} value={`new:${s.seq}`}>
                    {t('New stop after {{n}}. {{name}}', { n: s.seq + 1, name: s.name })}
                  </option>
                ))}
            </optgroup>
          )}
        </select>
      </label>
      {add.newStop && <p className="col-span-2 text-xs text-muted-foreground">{t('A new stop is added at the passenger’s own point when you publish (checked for seats, overlap and consent).')}</p>}
    </div>
  );
}

/** Pending changes, with undo per change. */
export function DraftTray({ ctx }: { ctx: PanelCtx }) {
  const { t } = useTranslation();
  const rows = diffDraft(ctx.draft, ctx.board.trips);
  if (!rows.length) return <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">{t('No pending changes. Assignments you make collect here until you publish them.')}</p>;
  return (
    <ul className="flex flex-col gap-2" aria-label={t('Pending changes')}>
      {rows.map((r) => (
        <li key={r.key} className={cn('rounded-lg border p-2.5', r.overCapacity && 'border-destructive/60')}>
          <div className="flex items-center justify-between gap-2">
            <span className="min-w-0 truncate text-sm font-medium">
              {r.label} {r.isNew && <Badge variant="info">{t('New trip')}</Badge>}
            </span>
            <span className={cn('shrink-0 text-xs tabular-nums', r.overCapacity && 'font-medium text-destructive-fg')}>{r.capacity === null ? `${r.before} → ${r.after}` : `${r.before} → ${r.after} / ${r.capacity}`}</span>
          </div>
          {r.overCapacity && <p className="text-xs text-destructive-fg">{t('More passengers than seats: publishing will be refused.')}</p>}
          <ul className="mt-1 grid gap-1 text-xs">
            {!r.isNew &&
              ctx.draft.adds
                .filter((a) => a.tripId === r.key)
                .map((a) => (
                  <li key={a.bookingId} className="rounded-md bg-muted/50 p-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate">+ {ctx.draft.bookings[a.bookingId]?.name}</span>
                      <Button size="sm" variant="ghost" className="h-7" onClick={() => ctx.setDraft((d) => withoutBookings(d, [a.bookingId]))}>
                        <Undo2Icon /> {t('Undo')}
                      </Button>
                    </div>
                    <AddStops tripId={a.tripId} bookingId={a.bookingId} ctx={ctx} />
                  </li>
                ))}
            {r.isNew && <li className="text-muted-foreground">+ {r.added.join(', ')}</li>}
            {ctx.draft.removes
              .filter((x) => x.tripId === r.key)
              .map((x) => (
                <li key={x.passengerTripId} className="flex items-center justify-between gap-2">
                  <span className="truncate">
                    − {x.name} <span className="text-muted-foreground">({x.reason})</span>
                  </span>
                  <Button size="sm" variant="ghost" className="h-7" onClick={() => ctx.setDraft((d) => undoRemove(d, x.passengerTripId))}>
                    <Undo2Icon /> {t('Undo')}
                  </Button>
                </li>
              ))}
            {ctx.draft.reassigns
              .filter((x) => x.tripId === r.key)
              .map((x) => (
                <li key={x.kind} className="flex items-center justify-between gap-2">
                  <span className="truncate">
                    {x.kind === 'VEHICLE' ? t('Vehicle') : t('Driver')} → {x.label}
                  </span>
                  <Button size="sm" variant="ghost" className="h-7" onClick={() => ctx.setDraft((d) => undoReassign(d, x.tripId, x.kind))}>
                    <Undo2Icon /> {t('Undo')}
                  </Button>
                </li>
              ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}

/** Review table of the draft (before / after seats and names per trip). */
export function DraftReview({ rows }: { rows: DraftDiffRow[] }) {
  const { t } = useTranslation();
  return (
    <ul className="divide-y rounded-lg border text-sm">
      {rows.map((r) => (
        <li key={r.key} className="grid gap-1 p-2.5">
          <div className="flex items-center justify-between gap-2">
            <span className="min-w-0 truncate font-medium">
              {r.label} {r.isNew && <Badge variant="info">{t('New trip')}</Badge>}
            </span>
            <span className={cn('shrink-0 tabular-nums', r.overCapacity && 'font-medium text-destructive-fg')}>
              {t('Seats')} {r.before} → {r.after}
              {r.capacity !== null && ` / ${r.capacity}`}
            </span>
          </div>
          {r.added.length > 0 && (
            <p className="text-xs">
              <span className="text-success-fg">{t('Add')}:</span> {r.added.join(', ')}
            </p>
          )}
          {r.removed.length > 0 && (
            <p className="text-xs">
              <span className="text-destructive-fg">{t('Remove')}:</span> {r.removed.join(', ')}
            </p>
          )}
          {r.notes.map((x) => (
            <p key={x.kind} className="text-xs">
              {x.kind === 'VEHICLE' ? t('Vehicle') : t('Driver')} → {x.label}
            </p>
          ))}
        </li>
      ))}
    </ul>
  );
}

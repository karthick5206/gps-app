import type { DispatchRequestStatus, TransportBookingDto } from '@veetracer/shared';
import { DISPATCH_REQUEST_STATUSES } from '@veetracer/shared';
import { ArrowLeftIcon, CheckIcon, CircleAlertIcon, RadioTowerIcon, RefreshCwIcon, SearchIcon, XIcon } from 'lucide-react';
import { useEffect, useMemo, useReducer, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { FormError } from '@/components/form-error';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Combobox } from '@/components/ui/multi-select';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useAuth } from '@/features/auth/auth-context';
import { formatClock } from '@/features/planned-trips/trip-format';
import { getReportTimeZone, todayInZone } from '@/features/reports/report-time';
import { errorMessage } from '@/lib/api';
import { storage } from '@/lib/storage';
import { cn } from '@/lib/utils';
import { routeText } from '../dispatch/adhoc-booking';
import { newUuid } from '../dispatch/e3-format';
import { SimpleSelect } from '../dispatch/e3-ui';
import { transportTripPath, useBookings } from '../dispatch/use-e3';
import {
  addedText,
  chosenAlternative,
  chosenOption,
  decideFlow,
  DISPATCH_STATUS_META,
  DISPATCH_TARGET_LABEL,
  DISPATCH_TRIGGER_LABEL,
  initialDecide,
  needsDispatcher,
  proposalActionable,
  proposalsOf,
  reasonText,
  statusCounts,
} from './live-dispatch';
import { liveSwitch, RIDE_SERVICE_LABEL } from './pooling-format';
import { HeldBadge, poolingErrorText, RideBadge } from './pooling-ui';
import { liveErrorCode, useLiveDecide, useLiveRequests, usePoolingSettings } from './use-pooling';

const ALL = '__all';
const DISMISSED_KEY = 'vt.etms.live.dismissed';

/** Proposals the dispatcher rejected on this browser (the API has no reject yet): hidden from the proposals lane. */
function useDismissed(): [Set<string>, (id: string) => void] {
  const [ids, setIds] = useState<Set<string>>(() => {
    try {
      const raw = storage.get(DISMISSED_KEY);
      return new Set(raw ? (JSON.parse(raw) as string[]) : []);
    } catch {
      return new Set();
    }
  });
  const add = (id: string) =>
    setIds((s) => {
      const n = new Set(s).add(id);
      try {
        storage.set(DISMISSED_KEY, JSON.stringify([...n].slice(-200)));
      } catch {
        /* per-browser convenience only */
      }
      return n;
    });
  return [ids, add];
}

function SwitchWarning({ state }: { state: ReturnType<typeof liveSwitch> }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  if (state === 'on') return null;
  return (
    <div role="alert" className="flex flex-wrap items-start gap-2 rounded-md border border-warning/40 bg-warning-soft p-3 text-sm text-warning-fg">
      <CircleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="grid min-w-0 flex-1 gap-1">
        <span className="font-medium">{state === 'off-server' ? t('Live dispatch is switched off on this server.') : t('Live dispatch is switched off for your company.')}</span>
        <span>{t('New bookings are not offered to vehicles automatically and “Find a vehicle” is not available. The decision log below still shows earlier decisions.')}</span>
        {state === 'off' && can('etms_settings') && (
          <Link to="/transport/settings#etms-pooling" className="w-fit font-medium underline">
            {t('Transport settings → Pooling and live dispatch')}
          </Link>
        )}
      </div>
    </div>
  );
}

/**
 * Live dispatch (doc 20 §5–7, under the dispatch board): "Find a vehicle" for one waiting booking (ranked feasible
 * options, dry run first, then apply with an Idempotency-Key), proposals waiting for the dispatcher (delay / breakdown /
 * started trips, P4/P5/P8) and the live decision log with reasons. The server checks every rule again on apply.
 */
export function LiveDispatchPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const tz = getReportTimeZone();
  const today = todayInZone(tz);
  const [params, setParams] = useSearchParams();
  const [day, setDay] = useState(today);
  const [bookingId, setBookingId] = useState<string | null>(params.get('booking'));
  const [q, setQ] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>(ALL);
  const [flow, dispatch] = useReducer(decideFlow, initialDecide);
  const [dismissed, dismiss] = useDismissed();
  const settings = usePoolingSettings();
  const sw = liveSwitch(settings.data);
  const canCommand = can('etms_dispatch', 'command');
  const decide = useLiveDecide();
  const waiting = useBookings({ serviceDate: day, bookingStatus: 'PENDING_ASSIGNMENT', q: q.trim() || undefined, sort: 'windowStart', order: 'asc', page: 1, pageSize: 200 });
  const rows = useMemo(() => waiting.data?.items ?? [], [waiting.data]);
  const requests = useLiveRequests({ limit: 100, ...(statusFilter === ALL ? {} : { status: statusFilter as DispatchRequestStatus }) });
  const allRequests = useLiveRequests({ status: 'PROPOSED', limit: 100 });
  const log = requests.data ?? [];
  const proposals = proposalsOf(allRequests.data ?? [], dismissed);
  const counts = statusCounts(log);
  const booking: TransportBookingDto | null = rows.find((b) => b.id === bookingId) ?? null;
  const nameOf = (id: string | null) => (id ? (rows.find((b) => b.id === id)?.passenger.displayName ?? `#${id.slice(0, 8)}`) : '—');
  const clock = (iso: string | null | undefined) => formatClock(iso, tz);
  const disabled = sw !== 'on' || !canCommand;

  // A new booking choice restarts the flow (and keeps the URL shareable).
  useEffect(() => {
    dispatch({ type: 'reset' });
    if (bookingId) setParams({ booking: bookingId }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookingId]);

  const find = (id: string) => {
    dispatch({ type: 'find', bookingId: id });
    decide.mutate(
      { input: { bookingId: id } },
      {
        onSuccess: (d) => dispatch({ type: 'found', decision: d }),
        onError: (e) => dispatch({ type: 'failed', code: liveErrorCode(e), message: poolingErrorText(e, t) }),
      },
    );
  };
  const apply = () => {
    const next = decideFlow(flow, { type: 'apply', newKey: newUuid });
    if (next.step !== 'applying') return;
    dispatch({ type: 'apply', newKey: () => next.key });
    decide.mutate(
      { input: { bookingId: next.bookingId, apply: true, optionId: next.chosen }, key: next.key },
      {
        onSuccess: (d) => {
          dispatch({ type: 'applied', decision: d });
          toast.success(t('Seat assigned. The trip and the people on it are notified.'));
        },
        onError: (e) => dispatch({ type: 'failed', code: liveErrorCode(e), message: poolingErrorText(e, t) }),
      },
    );
  };
  const decision = flow.step === 'options' || flow.step === 'applying' || flow.step === 'applied' || flow.step === 'error' ? flow.decision : null;
  const chosen = chosenOption(flow);

  return (
    <div className="flex w-full min-w-0 flex-col gap-4 p-4 sm:p-6">
      <Button asChild variant="ghost" size="sm" className="justify-self-start self-start">
        <Link to="/transport/dispatch">
          <ArrowLeftIcon /> {t('Daily transport')}
        </Link>
      </Button>
      <PageHeader
        title={t('Live dispatch')}
        description={t('Find a vehicle for a waiting booking, approve proposals and see why each live decision was made.')}
        actions={
          <Badge variant={sw === 'on' ? 'success' : 'muted'}>
            <RadioTowerIcon aria-hidden /> {sw === 'on' ? t('Live dispatch on') : t('Live dispatch off')}
          </Badge>
        }
      />
      {settings.isSuccess && !settings.data && <FormError message={t('This server does not offer live dispatch yet.')} />}
      {settings.data && <SwitchWarning state={sw} />}

      <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Card className="min-w-0 gap-3 p-4" aria-labelledby="live-find-h">
          <h2 id="live-find-h" className="text-sm font-semibold">
            {t('Find a vehicle')}
          </h2>
          <div className="grid gap-3 sm:grid-cols-[10rem_minmax(0,1fr)]">
            <Field label={t('Service date')} htmlFor="live-day">
              <Input id="live-day" type="date" value={day} onChange={(e) => e.target.value && setDay(e.target.value)} className="h-9" />
            </Field>
            <Field label={t('Booking waiting for a seat')} htmlFor="live-booking">
              <Combobox
                id="live-booking"
                value={bookingId}
                onChange={(id) => setBookingId(id)}
                options={rows.map((b) => ({ value: b.id, label: `${b.passenger.displayName} · ${clock(b.windowStart)}–${clock(b.windowEnd)}` }))}
                selectedOption={bookingId && !booking ? { value: bookingId, label: `#${bookingId.slice(0, 8)}` } : undefined}
                loading={waiting.isFetching}
                onSearch={setQ}
                placeholder={t('Choose a booking')}
                searchPlaceholder={t('Search passenger…')}
                emptyText={waiting.isError ? errorMessage(waiting.error) : t('No booking is waiting for a seat on this day')}
              />
            </Field>
          </div>
          {booking && (
            <div className="grid gap-1 rounded-md border p-2 text-sm">
              <span className="font-medium">{booking.passenger.displayName}</span>
              <span className="truncate text-xs text-muted-foreground" title={routeText(booking, t)}>
                {routeText(booking, t)}
              </span>
              <span className="flex flex-wrap items-center gap-1 text-xs">
                <span className="tabular-nums">
                  {clock(booking.windowStart)}–{clock(booking.windowEnd)}
                </span>
                <RideBadge b={booking} />
                {booking.holdFromPlanning && <HeldBadge reason={booking.holdReason} />}
              </span>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => bookingId && find(bookingId)} disabled={!bookingId || disabled || flow.step === 'finding' || flow.step === 'applying'}>
              {flow.step === 'finding' ? <Spinner /> : <SearchIcon />} {decision ? t('Find options again') : t('Find options')}
            </Button>
            {flow.step !== 'idle' && (
              <Button variant="ghost" onClick={() => dispatch({ type: 'reset' })} disabled={flow.step === 'applying'}>
                <XIcon /> {t('Clear')}
              </Button>
            )}
          </div>
          {!canCommand && <p className="text-xs text-muted-foreground">{t('Finding and applying needs the Dispatch → command permission.')}</p>}

          {decision && (
            <div className="grid gap-2">
              {decision.options.length === 0 ? (
                <div role="status" className="grid gap-1 rounded-md bg-muted p-2 text-sm">
                  <span className="font-medium">{t('No vehicle can take this booking within its limits.')}</span>
                  {decision.reasons.length > 0 && <span className="text-xs text-muted-foreground">{decision.reasons.map((r) => t(reasonText(r))).join(' · ')}</span>}
                  <span className="text-xs text-muted-foreground">{t('The booking stays in the queue; seat it on the dispatch board.')}</span>
                </div>
              ) : (
                <ul className="grid gap-2" role="radiogroup" aria-label={t('Options')}>
                  {decision.options.map((o, i) => {
                    const sel = (flow.step === 'options' || flow.step === 'error' || flow.step === 'applying') && flow.chosen === o.optionId;
                    return (
                      <li key={o.optionId}>
                        <button
                          type="button"
                          role="radio"
                          aria-checked={sel}
                          disabled={flow.step === 'applying' || flow.step === 'applied'}
                          onClick={() => dispatch({ type: 'choose', optionId: o.optionId })}
                          className={cn('grid w-full gap-1 rounded-lg border bg-card p-2.5 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring', sel && 'border-primary bg-primary/5')}
                        >
                          <span className="flex flex-wrap items-center gap-2">
                            <span className="font-medium">
                              {i + 1}. {o.vehicleName ?? `#${o.objectId.slice(0, 8)}`}
                            </span>
                            <Badge variant="outline">{t(DISPATCH_TARGET_LABEL[o.target])}</Badge>
                            <Badge variant={o.servedAs === 'PRIVATE' ? 'info' : 'muted'}>{t(RIDE_SERVICE_LABEL[o.servedAs])}</Badge>
                            {needsDispatcher(o) && <Badge variant="warning">{t('Needs your approval')}</Badge>}
                            {i === 0 && <Badge variant="success">{t('Best')}</Badge>}
                          </span>
                          <span className="text-xs text-muted-foreground tabular-nums">
                            {t('Pickup {{p}} · drop {{d}} · {{added}} for the vehicle · {{n}} passenger(s) affected', { p: clock(o.pickupEta), d: clock(o.dropEta), added: addedText(o.addedS), n: o.affectedPassengers })}
                          </span>
                          <span className="text-xs text-muted-foreground">{o.kind === 'NEW_TRIP' ? t('New trip on an idle vehicle') : t('Added to an existing trip; committed times of others do not change')}{o.engine === 'FALLBACK' ? ` · ${t('found without the optimiser')}` : ''}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
              {chosen && flow.step !== 'applied' && (
                <div className="grid gap-1">
                  {chosen.target === 'ACTIVE' && <p className="text-xs text-warning-fg">{t('The trip has started: the driver must acknowledge the new route.')}</p>}
                  <Button onClick={apply} disabled={disabled || flow.step === 'applying'} className="justify-self-start">
                    {flow.step === 'applying' ? <Spinner /> : <CheckIcon />} {flow.step === 'error' ? t('Try again') : t('Apply this option')}
                  </Button>
                </div>
              )}
              {flow.step === 'applied' && (
                <p role="status" className="flex flex-wrap items-center gap-2 rounded-md bg-success-soft p-2 text-sm text-success-fg">
                  <CheckIcon className="size-4" aria-hidden /> {t('Applied.')}
                  {chosen?.tripId && (
                    <Link to={transportTripPath(chosen.tripId)} className="font-medium underline">
                      {t('Open trip')}
                    </Link>
                  )}
                </p>
              )}
            </div>
          )}
          {flow.step === 'error' && <FormError message={flow.message} />}
        </Card>

        <Card className="min-w-0 gap-3 p-4" aria-labelledby="live-prop-h">
          <h2 id="live-prop-h" className="flex items-center gap-2 text-sm font-semibold">
            {t('Proposals to approve')} <Badge variant={proposals.length ? 'warning' : 'muted'}>{proposals.length}</Badge>
          </h2>
          <p className="text-xs text-muted-foreground">{t('Delays, breakdowns and changes to started trips are proposed, never applied on their own. Boarded passengers of a broken-down vehicle are always your decision.')}</p>
          {allRequests.isPending ? (
            <Skeleton className="h-24 w-full" />
          ) : proposals.length === 0 ? (
            <EmptyState icon={RadioTowerIcon} title={t('Nothing to approve')} className="py-6" />
          ) : (
            <ul className="grid gap-2">
              {proposals.map((p) => {
                const alt = chosenAlternative(p);
                const actionable = proposalActionable(p);
                return (
                  <li key={p.id} className="grid gap-1 rounded-lg border p-2.5 text-sm">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{nameOf(p.bookingId)}</span>
                      <Badge variant="outline">{t(DISPATCH_TRIGGER_LABEL[p.trigger])}</Badge>
                      {p.reasons.map((r) => (
                        <Badge key={r} variant={r === 'ONBOARD_TRANSFER' ? 'destructive' : 'muted'}>
                          {t(reasonText(r))}
                        </Badge>
                      ))}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {alt ? t('Proposed: {{target}} · {{added}}', { target: t(DISPATCH_TARGET_LABEL[alt.target]), added: addedText(alt.addedS) }) : t('{{n}} option(s) considered', { n: p.alternatives.length })} · {clock(p.createdAt)}
                    </span>
                    <span className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        disabled={disabled || !actionable}
                        onClick={() => {
                          if (!p.bookingId) return;
                          setBookingId(p.bookingId);
                          setTimeout(() => find(p.bookingId!), 0);
                        }}
                        title={actionable ? undefined : t('The booking no longer waits for a seat.')}
                      >
                        <CheckIcon /> {t('Review and approve')}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          dismiss(p.id);
                          toast.info(t('Proposal rejected. The booking stays in the queue.'));
                        }}
                      >
                        <XIcon /> {t('Reject')}
                      </Button>
                      {p.tripId && (
                        <Button size="sm" variant="ghost" asChild>
                          <Link to={transportTripPath(p.tripId)}>{t('Open trip')}</Link>
                        </Button>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          <p className="text-xs text-muted-foreground">{t('Approving asks for fresh options and applies the one you choose. Rejecting hides the proposal on this browser; the booking stays waiting.')}</p>
        </Card>
      </div>

      <Card className="min-w-0 gap-3 p-4" aria-labelledby="live-log-h">
        <div className="flex flex-wrap items-center gap-2">
          <h2 id="live-log-h" className="min-w-0 flex-1 text-sm font-semibold">
            {t('Live decisions')}
          </h2>
          <SimpleSelect
            value={statusFilter}
            onChange={setStatusFilter}
            label={t('Status')}
            className="w-48"
            options={[{ value: ALL, label: t('All statuses') }, ...DISPATCH_REQUEST_STATUSES.map((s) => ({ value: s, label: `${t(DISPATCH_STATUS_META[s].label)}${statusFilter === ALL ? ` (${counts[s]})` : ''}` }))]}
          />
          <Button size="icon-sm" variant="ghost" onClick={() => void requests.refetch()} aria-label={t('Refresh')}>
            {requests.isFetching ? <Spinner /> : <RefreshCwIcon />}
          </Button>
        </div>
        {requests.isError && <FormError message={errorMessage(requests.error)} />}
        {requests.isPending ? (
          <Skeleton className="h-40 w-full" />
        ) : log.length === 0 ? (
          <EmptyState icon={RadioTowerIcon} title={t('No live decisions yet')} description={t('Decisions appear here when bookings are offered to vehicles or you use “Find a vehicle”.')} className="py-6" />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('Time')}</TableHead>
                  <TableHead>{t('Trigger')}</TableHead>
                  <TableHead>{t('Booking')}</TableHead>
                  <TableHead>{t('Status')}</TableHead>
                  <TableHead>{t('Chosen option')}</TableHead>
                  <TableHead>{t('Options')}</TableHead>
                  <TableHead>{t('Reasons')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {log.map((r) => {
                  const meta = DISPATCH_STATUS_META[r.status];
                  const alt = chosenAlternative(r);
                  return (
                    <TableRow key={r.id}>
                      <TableCell className="text-xs tabular-nums whitespace-nowrap">
                        {clock(r.createdAt)}
                        {r.durationMs !== null && <span className="block text-muted-foreground">{t('{{n}} ms', { n: r.durationMs })}</span>}
                      </TableCell>
                      <TableCell className="text-xs">{t(DISPATCH_TRIGGER_LABEL[r.trigger])}</TableCell>
                      <TableCell className="text-xs">
                        {r.bookingId ? (
                          <button type="button" className="text-primary hover:underline" onClick={() => setBookingId(r.bookingId)}>
                            {nameOf(r.bookingId)}
                          </button>
                        ) : (
                          '—'
                        )}
                        {r.bookingStatus && <span className="block text-muted-foreground">{t(r.bookingStatus)}</span>}
                      </TableCell>
                      <TableCell>
                        <Badge variant={meta.tone}>{t(meta.label)}</Badge>
                        {r.attempts > 1 && <span className="block text-xs text-muted-foreground">{t('{{n}} attempts', { n: r.attempts })}</span>}
                      </TableCell>
                      <TableCell className="text-xs">
                        {alt ? `${t(DISPATCH_TARGET_LABEL[alt.target])} · ${addedText(alt.addedS)}` : '—'}
                        {r.tripId && (
                          <Link to={transportTripPath(r.tripId)} className="block text-primary hover:underline">
                            {t('Open trip')}
                          </Link>
                        )}
                      </TableCell>
                      <TableCell className="text-xs tabular-nums">{r.alternatives.length}</TableCell>
                      <TableCell className="max-w-64 text-xs text-muted-foreground">{r.reasons.length ? r.reasons.map((c) => t(reasonText(c))).join(' · ') : '—'}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </Card>
    </div>
  );
}

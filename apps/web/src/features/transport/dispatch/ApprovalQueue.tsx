import type { TransportBookingDto } from '@veetracer/shared';
import { CheckCheckIcon, CheckIcon, ChevronLeftIcon, ChevronRightIcon, InboxIcon, SmartphoneIcon, HeadsetIcon, XIcon } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { FormError } from '@/components/form-error';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { useAuth } from '@/features/auth/auth-context';
import { formatClock } from '@/features/planned-trips/trip-format';
import { cn } from '@/lib/utils';
import { routeText } from './adhoc-booking';
import { AfterCutoffBadge, GroupBadge, JourneyBadge } from './adhoc-ui';
import { DIRECTION_LABEL } from './e3-format';
import { DirectionBadge, e3ErrorMessage } from './e3-ui';
import { approvalQuery, bulkApproveIds, canApprove, canReject, groupIdOf, groupSizes, isPassengerRequest, purposeOf, requestNote, requestRows } from './group-booking';
import { ReasonDialog } from './ReasonDialog';
import { useApprovalQueue, useBookingCommand, useBulkApprove } from './use-e3';

const PAGE_SIZE = 50;

/** The number of requests waiting, for the tab label (REQUESTED from today on). */
export function useApprovalCount(today: string, enabled: boolean): number | null {
  const q = useApprovalQueue(approvalQuery(today, { page: 1, pageSize: 1 }), enabled);
  return q.data ? q.data.total : null;
}

function OriginBadge({ b }: { b: TransportBookingDto }) {
  const { t } = useTranslation();
  return isPassengerRequest(b) ? (
    <Badge variant="info">
      <SmartphoneIcon aria-hidden /> {t('Requested by passenger')}
    </Badge>
  ) : (
    <Badge variant="outline">
      <HeadsetIcon aria-hidden /> {t('Booked by the desk')}
    </Badge>
  );
}

/**
 * Transport → Bookings → "Requests to approve" (WP 3.9 wave 2, D-A5 / D-A6): every REQUESTED booking from today on,
 * soonest first, with purpose, pickup → destination, window, passenger and who asked. Approve / reject (reason required)
 * / approve all use the existing booking routes; each row offers only what its allowedActions allow.
 */
export function ApprovalQueue({ today, search }: { today: string; search: string }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [rejecting, setRejecting] = useState<TransportBookingDto | null>(null);
  const list = useApprovalQueue(approvalQuery(today, { q: search.trim() || undefined, page, pageSize: PAGE_SIZE }));
  const rows = useMemo(() => requestRows(list.data?.items ?? []), [list.data]);
  const sizes = useMemo(() => groupSizes(rows), [rows]);
  const total = list.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const cmd = useBookingCommand();
  const bulk = useBulkApprove();
  // The approve / reject routes need etms_bookings edit (what the contract calls "approve"); rows still follow allowedActions.
  const canAct = can('etms_bookings', 'edit');

  useEffect(() => {
    setPage(1);
    setSelected(new Set());
  }, [search, today]);

  const approvable = bulkApproveIds(rows, selected);
  const toggle = (id: string, on: boolean) =>
    setSelected((s) => {
      const n = new Set(s);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });

  const approve = (b: TransportBookingDto) =>
    cmd.mutate({ kind: 'approve', id: b.id, version: b.version }, { onSuccess: () => toast.success(t('Booking approved')), onError: (e) => toast.error(e3ErrorMessage(e, t)) });
  const reject = (b: TransportBookingDto, reason: string) =>
    cmd.mutate(
      { kind: 'reject', id: b.id, version: b.version, reason },
      {
        onSuccess: () => {
          toast.success(t('Booking rejected'));
          setRejecting(null);
        },
        onError: (e) => toast.error(e3ErrorMessage(e, t)),
      },
    );
  const approveAll = () =>
    bulk.mutate(approvable, {
      onSuccess: (r) => {
        if (r.approved.length) toast.success(t('{{n}} booking(s) approved', { n: r.approved.length }));
        if (r.skipped.length) toast.warning(t('{{n}} booking(s) skipped (changed meanwhile or not approvable)', { n: r.skipped.length }));
        setSelected(new Set());
      },
      onError: (e) => toast.error(e3ErrorMessage(e, t)),
    });

  if (list.isError) return <FormError message={e3ErrorMessage(list.error, t)} />;
  if (list.isPending) return <Skeleton className="h-60 w-full rounded-xl" />;
  if (!rows.length)
    return (
      <Card className="py-0">
        <EmptyState icon={InboxIcon} title={t('No requests waiting')} description={t('Passenger requests and bookings put on hold appear here until someone approves or rejects them.')} />
      </Card>
    );

  return (
    <div className={cn('grid gap-3', list.isPlaceholderData && 'opacity-60 transition-opacity')}>
      {canAct && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-card p-2 text-sm" role="region" aria-label={t('Approve requests')}>
          <Checkbox
            aria-label={t('Select all on this page')}
            checked={rows.length > 0 && rows.every((r) => selected.has(r.id))}
            onCheckedChange={(v) => setSelected(v ? new Set(rows.map((r) => r.id)) : new Set())}
          />
          <span className="px-1">{selected.size ? t('{{n}} selected', { n: selected.size }) : t('{{n}} waiting', { n: total })}</span>
          <Button size="sm" onClick={approveAll} disabled={!approvable.length || bulk.isPending}>
            {bulk.isPending ? <Spinner /> : <CheckCheckIcon />} {selected.size ? t('Approve {{n}}', { n: approvable.length }) : t('Approve all {{n}} on this page', { n: approvable.length })}
          </Button>
          {selected.size > 0 && (
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
              {t('Clear selection')}
            </Button>
          )}
        </div>
      )}
      <ul className="grid gap-3 lg:grid-cols-2" aria-label={t('Requests to approve')}>
        {rows.map((b) => {
          const purpose = purposeOf(b);
          const note = requestNote(b);
          const g = groupIdOf(b);
          const clock = (iso: string) => formatClock(iso, b.timeZone, b.serviceDate);
          return (
            <li key={b.id}>
              <Card className={cn('gap-2 p-3', selected.has(b.id) && 'border-primary')}>
                <div className="flex items-start gap-2">
                  {canAct && <Checkbox className="mt-1" aria-label={t('Select {{name}}', { name: b.passenger.displayName })} checked={selected.has(b.id)} onCheckedChange={(v) => toggle(b.id, !!v)} />}
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{b.passenger.displayName}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {b.passenger.employeeCode}
                      {b.shiftName && ` · ${b.shiftName}`}
                    </p>
                  </div>
                  <OriginBadge b={b} />
                </div>
                {purpose && (
                  <p className="text-sm">
                    <span className="text-muted-foreground">{t('Purpose')}: </span>
                    <span className="font-medium">{purpose}</span>
                  </p>
                )}
                <p className="truncate text-sm" title={routeText(b, t)}>
                  {routeText(b, t)}
                </p>
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="tabular-nums">
                    {b.serviceDate} · {clock(b.windowStart)} – {clock(b.windowEnd)}
                  </span>
                  {b.journey === 'POINT_TO_POINT' ? <JourneyBadge journey={b.journey} /> : <DirectionBadge direction={b.direction} />}
                  {b.afterCutoff && <AfterCutoffBadge reason={b.lateReason} />}
                  {g && <GroupBadge size={sizes.get(g) ?? 1} purpose={purpose} />}
                  {b.needsLocation && <Badge variant="warning">{t('Needs location')}</Badge>}
                </div>
                {note && <p className="line-clamp-2 text-xs text-muted-foreground">{t('Note: {{note}}', { note })}</p>}
                {canAct && (canApprove(b) || canReject(b)) && (
                  <div className="flex flex-wrap gap-2 pt-1">
                    {canApprove(b) && (
                      <Button size="sm" onClick={() => approve(b)} disabled={cmd.isPending}>
                        <CheckIcon /> {t('Approve')}
                      </Button>
                    )}
                    {canReject(b) && (
                      <Button size="sm" variant="outline" onClick={() => setRejecting(b)} disabled={cmd.isPending}>
                        <XIcon /> {t('Reject')}
                      </Button>
                    )}
                  </div>
                )}
              </Card>
            </li>
          );
        })}
      </ul>
      {total > PAGE_SIZE && (
        <div className="flex items-center justify-between gap-2 text-sm">
          <span className="text-muted-foreground">{t('Page {{page}} of {{pages}} · {{total}} bookings', { page, pages, total })}</span>
          <div className="flex gap-1">
            <Button variant="outline" size="icon-sm" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1} aria-label={t('Previous page')}>
              <ChevronLeftIcon />
            </Button>
            <Button variant="outline" size="icon-sm" onClick={() => setPage((p) => Math.min(pages, p + 1))} disabled={page >= pages} aria-label={t('Next page')}>
              <ChevronRightIcon />
            </Button>
          </div>
        </div>
      )}
      <ReasonDialog
        open={!!rejecting}
        onOpenChange={(o) => !o && setRejecting(null)}
        title={t('Reject booking?')}
        description={rejecting ? `${rejecting.passenger.displayName} · ${rejecting.serviceDate} · ${t(DIRECTION_LABEL[rejecting.direction])}` : undefined}
        label={t('Reason')}
        confirmLabel={t('Reject')}
        destructive
        pending={cmd.isPending}
        onConfirm={(reason) => rejecting && reject(rejecting, reason)}
      />
    </div>
  );
}

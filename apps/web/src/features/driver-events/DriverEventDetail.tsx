import type { DriverEventDto, DriverEventStatus } from '@veetracer/shared';
import { BanIcon, CheckIcon, ChevronLeftIcon, ChevronRightIcon, GraduationCapIcon, RotateCcwIcon, VideoIcon } from 'lucide-react';
import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { FormError } from '@/components/form-error';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/input';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { useAuth } from '@/features/auth/auth-context';
import { AlertTypeIcon } from '@/features/alerts/alert-icons';
import { videoPagePath } from '@/features/video/video-utils';
import { errorMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { STATUS_LABEL, STATUS_VARIANT } from './driver-event-utils';
import { EventGallery } from './EventMedia';
import { eventLabel, eventSeverity, useDriverEvent, useReviewEvent } from './use-driver-events';

const MiniMap = lazy(() => import('@/features/alerts/MiniMap').then((m) => ({ default: m.MiniMap })));

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[7.5rem_1fr] gap-3 py-1.5 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

export function EventStatusBadge({ status }: { status: DriverEventStatus }) {
  const { t } = useTranslation();
  return <Badge variant={STATUS_VARIANT[status]}>{t(STATUS_LABEL[status])}</Badge>;
}

/** Driver event detail: photos (lightbox), map, facts, recordings link, review with note, previous / next. */
export function DriverEventDetail({
  eventId,
  initial,
  onClose,
  onNavigate,
  prevId,
  nextId,
}: {
  eventId: string | null;
  initial: DriverEventDto | null;
  onClose: () => void;
  onNavigate: (id: string) => void;
  prevId: string | null;
  nextId: string | null;
}) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const query = useDriverEvent(eventId, initial);
  const review = useReviewEvent();
  const e = query.data;
  const [note, setNote] = useState('');
  useEffect(() => setNote(e?.note ?? ''), [e?.id, e?.note]);
  const canReview = can('driver_events', 'edit');

  const act = (status: DriverEventStatus) =>
    e &&
    review.mutate(
      { id: e.id, status, note: note.trim() || null },
      { onSuccess: () => toast.success(t('Event marked {{status}}', { status: t(STATUS_LABEL[status]).toLowerCase() })), onError: (err) => toast.error(errorMessage(err)) },
    );

  return (
    <Sheet open={!!eventId} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="sm:max-w-xl">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            {e && <AlertTypeIcon type={e.type} severity={eventSeverity(e.type)} />}
            {e ? t(eventLabel(e.type)) : t('Driver event')}
          </SheetTitle>
          <SheetDescription className="truncate">
            {e ? `${e.objectName}${e.plateNumber && e.plateNumber !== e.objectName ? ` · ${e.plateNumber}` : ''} · ${formatDateTime(e.occurredAt)}` : ' '}
          </SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
          {query.isError && <FormError message={errorMessage(query.error)} />}
          {!e && query.isPending && <Skeleton className="h-56 w-full" />}
          {e && (
            <>
              <EventGallery media={e.media} />
              <div className="flex flex-wrap gap-2">
                {can('video') && (
                  <Button size="sm" variant="outline" asChild>
                    <Link to={videoPagePath(e.objectId, { at: e.occurredAt })}>
                      <VideoIcon /> {t('Watch video')}
                    </Link>
                  </Button>
                )}
                <span className="flex-1" />
                <Button size="sm" variant="ghost" disabled={!prevId} onClick={() => prevId && onNavigate(prevId)} aria-label={t('Previous event')}>
                  <ChevronLeftIcon /> {t('Previous')}
                </Button>
                <Button size="sm" variant="ghost" disabled={!nextId} onClick={() => nextId && onNavigate(nextId)} aria-label={t('Next event')}>
                  {t('Next')} <ChevronRightIcon />
                </Button>
              </div>
              <dl className="divide-y">
                <Row label={t('Status')}>
                  <span className="flex flex-wrap items-center gap-2">
                    <EventStatusBadge status={e.status} />
                    {e.reviewedAt && <span className="text-xs text-muted-foreground">{`${e.reviewedByName ? `${t('by {{name}}', { name: e.reviewedByName })} · ` : ''}${formatDateTime(e.reviewedAt)}`}</span>}
                  </span>
                </Row>
                <Row label={t('Driver')}>{e.driverName ?? <span className="text-muted-foreground">{t('Not assigned')}</span>}</Row>
                <Row label={t('Time')}>{formatDateTime(e.occurredAt)}</Row>
                {e.level !== null && <Row label={t('Level')}>{e.level}</Row>}
                {e.speedKph !== null && <Row label={t('Speed')}>{`${Math.round(e.speedKph)} km/h`}</Row>}
                <Row label={t('Location')}>
                  {e.address ?? <span className="text-muted-foreground">{t('Address pending')}</span>}
                  {e.lat !== null && <span className="block font-mono text-xs text-muted-foreground">{`${e.lat.toFixed(6)}, ${e.lng?.toFixed(6)}`}</span>}
                </Row>
              </dl>
              {e.lat !== null && e.lng !== null && (
                <Suspense fallback={<div className="h-40 rounded-lg border bg-muted" />}>
                  <MiniMap lat={e.lat} lng={e.lng} severity={eventSeverity(e.type)} className="h-40" />
                </Suspense>
              )}
              {canReview ? (
                <section className="space-y-2">
                  <h3 className="text-sm font-semibold">{t('Review')}</h3>
                  <Textarea value={note} onChange={(ev) => setNote(ev.target.value)} maxLength={1000} placeholder={t('Note — e.g. spoke to the driver, false alarm')} aria-label={t('Note')} />
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" onClick={() => act('REVIEWED')} disabled={review.isPending}>
                      {review.isPending ? <Spinner /> : <CheckIcon />} {t('Mark reviewed')}
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => act('COACHED')} disabled={review.isPending}>
                      <GraduationCapIcon /> {t('Driver coached')}
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => act('DISMISSED')} disabled={review.isPending}>
                      <BanIcon /> {t('Dismiss (false alarm)')}
                    </Button>
                    {e.status !== 'NEW' && (
                      <Button size="sm" variant="ghost" onClick={() => act('NEW')} disabled={review.isPending}>
                        <RotateCcwIcon /> {t('Reopen')}
                      </Button>
                    )}
                  </div>
                </section>
              ) : (
                e.note && <Row label={t('Note')}>{e.note}</Row>
              )}
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

import { useQuery } from '@tanstack/react-query';
import { isDriverEventType, type DriverEventDto, type Paginated } from '@veetracer/shared';
import { ScanFaceIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/features/auth/auth-context';
import { AlertTypeIcon } from '@/features/alerts/alert-icons';
import { api } from '@/lib/api';
import { relativeTime } from '@/lib/format';
import { driverEventsPath } from './driver-event-utils';
import { EventGallery, EventThumbnail } from './EventMedia';
import { eventLabel, eventSeverity, useEventByAlert } from './use-driver-events';

/** Cabin / road snapshot of a driver behaviour alert, in the alert detail sheet. */
export function AlertSnapshot({ alertId, type }: { alertId: string; type: string }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const event = useEventByAlert(alertId, isDriverEventType(type));
  if (!isDriverEventType(type)) return null;
  if (event.isPending) return <Skeleton className="aspect-video w-full" />;
  const e = event.data;
  if (!e) return null;
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">{t('Dashcam snapshot')}</h3>
        {can('driver_events') && (
          <Link to={driverEventsPath({ event: e.id })} className="text-xs text-primary hover:underline">
            {t('Open driver event')}
          </Link>
        )}
      </div>
      {e.media.length ? (
        <EventGallery media={e.media} />
      ) : (
        <p className="rounded-lg border border-dashed p-3 text-center text-xs text-muted-foreground">
          {Date.now() - Date.parse(e.occurredAt) < 3 * 60_000 ? t('Waiting for the snapshot from the dashcam…') : t('No snapshot was received from the dashcam for this event.')}
        </p>
      )}
    </section>
  );
}

/** Latest driver events of a vehicle with thumbnails (live vehicle drawer); hidden when there are none. */
export function RecentDriverEvents({ objectId }: { objectId: string }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const list = useQuery({
    queryKey: ['driver-events', 'recent', objectId],
    queryFn: ({ signal }) => api.get<Paginated<DriverEventDto>>('/driver-events', { objectId, pageSize: 6 }, signal),
    enabled: can('driver_events'),
    refetchInterval: 60_000,
  });
  const rows = list.data?.items ?? [];
  if (!can('driver_events') || !rows.length) return null;
  return (
    <section className="space-y-2 pt-3">
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold">
          <ScanFaceIcon className="size-4 text-muted-foreground" aria-hidden /> {t('Recent driver events')}
        </h3>
        <Link to={driverEventsPath({ objectId })} className="text-xs text-primary hover:underline">
          {t('View all')}
        </Link>
      </div>
      <div className="grid grid-cols-3 gap-2">
        {rows.map((e) => (
          <Link key={e.id} to={driverEventsPath({ objectId, event: e.id })} className="group overflow-hidden rounded-lg border" title={`${t(eventLabel(e.type))} · ${relativeTime(e.occurredAt)}`}>
            <EventThumbnail event={e} className="aspect-video w-full" />
            <div className="flex items-center gap-1 p-1">
              <AlertTypeIcon type={e.type} severity={eventSeverity(e.type)} size="sm" className="size-4 [&_svg]:size-3" />
              <span className="truncate text-[11px] text-muted-foreground">{relativeTime(e.occurredAt)}</span>
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}

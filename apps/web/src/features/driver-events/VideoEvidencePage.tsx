import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ALERT_TYPE_MAP, DRIVER_EVENT_TYPES, type AlertTypeCode, type DriverEventDto, type Paginated, type TrackedObjectDto } from '@veetracer/shared';
import { ChevronLeftIcon, ChevronRightIcon, DownloadIcon, FilmIcon, InfoIcon, MapPinIcon } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import { FormError } from '@/components/form-error';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { MultiSelect, type Option } from '@/components/ui/multi-select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { useAuth } from '@/features/auth/auth-context';
import { AlertTypeIcon, DashcamBadge, dashcamKind } from '@/features/alerts/alert-icons';
import { DateRangePicker, rangeFromPreset, type DateRangeValue } from '@/features/alerts/DateRangePicker';
import { useEntityOptions } from '@/features/masters/use-options';
import { api, errorMessage, type QueryParams } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { neighbours } from './driver-event-utils';
import { DriverEventDetail } from './DriverEventDetail';
import { EventThumbnail } from './EventMedia';
import { eventLabel } from './use-driver-events';

const PAGE_SIZE = 24;
const objectOption = (o: TrackedObjectDto): Option => ({ value: o.id, label: o.name, description: o.plateNumber ?? undefined });

/** One piece of evidence: the clip (plays inline) or photo, event, time, vehicle, place; info + download. */
function EvidenceCard({ event, onInfo }: { event: DriverEventDto; onInfo: () => void }) {
  const { t } = useTranslation();
  const clip = event.media.find((m) => m.kind === 'VIDEO' && m.playable) ?? null;
  const download = clip ?? event.media.find((m) => m.kind === 'VIDEO') ?? event.media.find((m) => m.kind === 'PHOTO') ?? null;
  return (
    <Card className="gap-0 overflow-hidden p-0">
      {clip ? (
        <video src={clip.url} poster={event.thumbnailUrl ?? undefined} controls preload="none" className="aspect-video w-full bg-black object-contain" aria-label={t(eventLabel(event.type))} />
      ) : (
        <button type="button" onClick={onInfo} className="block w-full" aria-label={t('Open event')}>
          <EventThumbnail event={event} className="aspect-video w-full" />
        </button>
      )}
      <div className="flex items-start gap-2 p-3">
        <AlertTypeIcon type={event.type} severity={ALERT_TYPE_MAP[event.type as AlertTypeCode]?.defaultSeverity ?? 'WARNING'} size="sm" />
        <div className="min-w-0 flex-1 space-y-0.5 text-sm">
          <div className="flex flex-wrap items-center gap-1.5 font-medium">
            {t(eventLabel(event.type))}
            <DashcamBadge type={event.type} />
            {event.media.some((m) => m.kind === 'VIDEO') && <FilmIcon className="size-3.5 text-muted-foreground" aria-label={t('Clip')} />}
          </div>
          <div className="text-muted-foreground">
            {formatDateTime(event.occurredAt)} · {event.objectName}
            {event.plateNumber && event.plateNumber !== event.objectName ? ` (${event.plateNumber})` : ''}
            {event.speedKph !== null ? ` · ${Math.round(event.speedKph)} km/h` : ''}
          </div>
          {event.address && (
            <div className="flex items-start gap-1 text-xs text-muted-foreground">
              <MapPinIcon className="mt-0.5 size-3 shrink-0" aria-hidden />
              <span className="line-clamp-2">{event.address}</span>
            </div>
          )}
        </div>
        <div className="flex shrink-0 gap-0.5">
          <Button size="icon-sm" variant="ghost" onClick={onInfo} aria-label={t('Details')} title={t('Details')}>
            <InfoIcon />
          </Button>
          {download && (
            <Button size="icon-sm" variant="ghost" asChild title={t('Download')}>
              <a href={download.url} download aria-label={t('Download')}>
                <DownloadIcon />
              </a>
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}

/**
 * Video evidence: a gallery of every dashcam alert that has a clip or photo (ADAS, DMS, seat belt, harsh driving,
 * overspeed, SOS, crash), filtered by event types, vehicles and dates. Details open the driver event (map, review).
 */
export function VideoEvidencePage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const [range, setRange] = useState<DateRangeValue>(() => rangeFromPreset('today'));
  const [types, setTypes] = useState<string[]>([]);
  const [objectIds, setObjectIds] = useState<string[]>([]);
  const [clipsOnly, setClipsOnly] = useState(false);
  const [objectQ, setObjectQ] = useState('');
  const [page, setPage] = useState(1);
  const objects = useEntityOptions<TrackedObjectDto>('/objects', objectOption, { q: objectQ, enabled: can('objects') });
  const detailId = params.get('event');

  useEffect(() => setPage(1), [range, types, objectIds, clipsOnly]);

  const filters: QueryParams = {
    from: range.from.toISOString(),
    to: range.preset === 'custom' || range.preset === 'yesterday' ? range.to.toISOString() : undefined,
    type: types.length ? types.join(',') : undefined,
    objectIds: objectIds.length ? objectIds.join(',') : undefined,
    hasMedia: clipsOnly ? 'video' : 'any',
  };
  const list = useQuery({
    queryKey: ['driver-events', 'evidence', filters, page],
    queryFn: ({ signal }) => api.get<Paginated<DriverEventDto>>('/driver-events/evidence', { ...filters, page, pageSize: PAGE_SIZE }, signal),
    placeholderData: keepPreviousData,
    // Signed media links expire after ~30 min: refresh well before.
    refetchInterval: 10 * 60_000,
  });
  const rows = list.data?.items ?? [];
  const total = list.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const ids = useMemo(() => rows.map((r) => r.id), [rows]);
  const { prev, next } = neighbours(ids, detailId);
  const openDetail = (id: string | null) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        if (id) n.set('event', id);
        else n.delete('event');
        return n;
      },
      { replace: true },
    );
  const typeOptions: Option[] = DRIVER_EVENT_TYPES.map((v) => ({ value: v, label: t(eventLabel(v)), description: dashcamKind(v) ?? undefined }));

  return (
    <div className="space-y-4">
      <PageHeader title={t('Video evidence')} description={t('Clips and photos of every dashcam alert: ADAS, DMS, seat belt, harsh driving, overspeed, SOS and crashes.')} />

      <div className="flex flex-wrap items-center gap-2">
        <DateRangePicker value={range} onChange={setRange} />
        <div className="w-72">
          <MultiSelect value={types} onChange={setTypes} options={typeOptions} placeholder={t('All events')} searchPlaceholder={t('Search events…')} />
        </div>
        {can('objects') && (
          <div className="w-64">
            <MultiSelect value={objectIds} onChange={setObjectIds} options={objects.options} loading={objects.loading} onSearch={setObjectQ} placeholder={t('All vehicles')} searchPlaceholder={t('Search vehicles…')} />
          </div>
        )}
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={clipsOnly} onCheckedChange={setClipsOnly} />
          {t('Clips only')}
        </label>
        <span className="ml-auto text-sm text-muted-foreground">{list.data ? t('{{n}} events', { n: total }) : ''}</span>
      </div>

      {list.isError && <FormError message={errorMessage(list.error)} />}
      {list.isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="aspect-video w-full rounded-xl" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <EmptyState icon={FilmIcon} title={t('No evidence in this period')} description={t('Clips and photos appear here when a dashcam uploads them for an alert.')} />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {rows.map((e) => (
            <EvidenceCard key={e.id} event={e} onInfo={() => openDetail(e.id)} />
          ))}
        </div>
      )}

      {pageCount > 1 && (
        <div className="flex items-center justify-center gap-2 text-sm">
          <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} aria-label={t('Previous page')}>
            <ChevronLeftIcon />
          </Button>
          {t('Page {{page}} of {{count}}', { page, count: pageCount })}
          <Button size="sm" variant="outline" disabled={page >= pageCount} onClick={() => setPage((p) => p + 1)} aria-label={t('Next page')}>
            <ChevronRightIcon />
          </Button>
        </div>
      )}

      <DriverEventDetail eventId={detailId} initial={rows.find((r) => r.id === detailId) ?? null} onClose={() => openDetail(null)} onNavigate={openDetail} prevId={prev} nextId={next} />
    </div>
  );
}

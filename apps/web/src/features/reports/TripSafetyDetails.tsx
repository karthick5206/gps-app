import { ALERT_TYPE_MAP, type AlertTypeCode, type TripSafetyOccurrence } from '@veetracer/shared';
import { FilmIcon, ListIcon, MapIcon, MapPinIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { AlertTypeIcon } from '@/features/alerts/alert-icons';
import { useAuth } from '@/features/auth/auth-context';
import { historyLink } from '@/features/history/time-range';
import type { Row } from './report-columns';
import { formatReportTime } from './report-time';

const MIN = 60_000;

/** Place of an occurrence: address, else coordinates. */
const where = (o: TripSafetyOccurrence) => o.address || (o.lat !== null && o.lng !== null ? `${o.lat.toFixed(5)}, ${o.lng.toFixed(5)}` : null);

/**
 * TRIP_SAFETY "Details" cell: opens a panel with every violation of the trip, each with time, place, speed, a link to
 * the History map at that moment and to its clip (Video evidence) when the dashcam sent one.
 */
export function TripSafetyDetails({ row }: { row: Row }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const [open, setOpen] = useState(false);
  const occurrences = (row.occurrences as TripSafetyOccurrence[] | undefined) ?? [];
  if (!occurrences.length) return <span className="text-muted-foreground">—</span>;
  const objectId = row.objectId as string;
  const tripLink = can('history') ? historyLink(objectId, row.startTime as string, row.endTime as string) : null;
  const evidenceMenu = can('video_evidence') ? '/video-evidence' : can('driver_events') ? '/driver-events' : null;

  return (
    <>
      <Button size="sm" variant="outline" className="h-7 gap-1 px-2" onClick={() => setOpen(true)}>
        <ListIcon className="size-3.5" /> {t('{{n}} violations', { n: occurrences.length })}
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent className="flex flex-col gap-0 p-0 sm:max-w-lg">
          <SheetHeader className="border-b px-4 py-3">
            <SheetTitle>
              {String(row.objectName ?? '')} · {t('{{n}} violations', { n: occurrences.length })}
            </SheetTitle>
            <SheetDescription>
              {formatReportTime(row.startTime as string)} – {formatReportTime(row.endTime as string)}
              {row.driverName ? ` · ${String(row.driverName)}` : ''}
              {typeof row.score === 'number' ? ` · ${t('Score {{n}}', { n: row.score })}` : ''}
            </SheetDescription>
            {tripLink && (
              <Link to={tripLink} target="_blank" rel="noreferrer" className="inline-flex w-fit items-center gap-1 text-sm text-primary underline-offset-2 hover:underline">
                <MapIcon className="size-3.5" /> {t('Play the whole trip on the map')}
              </Link>
            )}
          </SheetHeader>
          <ol className="min-h-0 flex-1 divide-y overflow-y-auto">
            {occurrences.map((o) => {
              const at = Date.parse(o.occurredAt);
              const mapLink = can('history') ? historyLink(objectId, new Date(at - 2 * MIN).toISOString(), new Date(at + 2 * MIN).toISOString()) : null;
              const place = where(o);
              return (
                <li key={o.alertId} className="flex gap-3 px-4 py-3 text-sm">
                  <AlertTypeIcon type={o.type} severity={ALERT_TYPE_MAP[o.type as AlertTypeCode]?.defaultSeverity ?? 'WARNING'} size="sm" />
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-2">
                      <span className="font-medium">{t(ALERT_TYPE_MAP[o.type as AlertTypeCode]?.label ?? o.type)}</span>
                      <span className="text-xs text-muted-foreground tabular-nums">
                        {formatReportTime(o.occurredAt)}
                        {o.speedKph !== null ? ` · ${o.speedKph} km/h` : ''}
                      </span>
                    </div>
                    {place && (
                      <div className="flex items-start gap-1 text-xs text-muted-foreground">
                        <MapPinIcon className="mt-0.5 size-3 shrink-0" aria-hidden />
                        <span>{place}</span>
                      </div>
                    )}
                    <div className="flex flex-wrap gap-3 text-xs">
                      {mapLink && (
                        <Link to={mapLink} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline">
                          <MapIcon className="size-3" /> {t('Show on map')}
                        </Link>
                      )}
                      {o.driverEventId && evidenceMenu && (
                        <Link to={`${evidenceMenu}?event=${o.driverEventId}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline">
                          <FilmIcon className="size-3" /> {o.hasClip ? t('Watch clip') : t('View evidence')}
                        </Link>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
        </SheetContent>
      </Sheet>
    </>
  );
}

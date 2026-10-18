import { useQuery } from '@tanstack/react-query';
import type { GeofenceVisitDto } from '@veetracer/shared';
import { FootprintsIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormError } from '@/components/form-error';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { DateRangePicker, rangeFromPreset, type DateRangeValue } from '@/features/alerts/DateRangePicker';
import { api, errorMessage } from '@/lib/api';
import { formatDateTime, formatDuration } from '@/lib/format';

/** Visits (enter/exit log) of one geofence for a date range. */
export function GeofenceVisits({ geofenceId }: { geofenceId: string }) {
  const { t } = useTranslation();
  const [range, setRange] = useState<DateRangeValue>(() => rangeFromPreset('7d'));
  const visits = useQuery({
    queryKey: ['geofence-visits', geofenceId, range.from.toISOString(), range.to.toISOString()],
    queryFn: ({ signal }) => api.get<GeofenceVisitDto[]>(`/geofences/${geofenceId}/visits`, { from: range.from.toISOString(), to: range.to.toISOString() }, signal),
  });
  const rows = visits.data ?? [];
  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <DateRangePicker value={range} onChange={setRange} />
        {visits.data && <span className="text-sm text-muted-foreground">{t('{{count}} visit(s), {{inside}} inside now', { count: rows.length, inside: rows.filter((r) => !r.exitTime).length })}</span>}
      </div>
      {visits.isError && <FormError message={errorMessage(visits.error)} />}
      <div className="overflow-hidden rounded-xl border">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>{t('Vehicle')}</TableHead>
              <TableHead>{t('Entered')}</TableHead>
              <TableHead>{t('Exited')}</TableHead>
              <TableHead className="text-right">{t('Duration')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visits.isPending &&
              Array.from({ length: 4 }, (_, i) => (
                <TableRow key={i}>
                  {Array.from({ length: 4 }, (_, j) => (
                    <TableCell key={j}>
                      <Skeleton className="h-4 w-28" />
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            {rows.map((v, i) => (
              <TableRow key={`${v.objectId}-${v.enterTime}-${i}`}>
                <TableCell className="font-medium">{v.objectName}</TableCell>
                <TableCell>{formatDateTime(v.enterTime)}</TableCell>
                <TableCell>{v.exitTime ? formatDateTime(v.exitTime) : <Badge variant="success">{t('Inside')}</Badge>}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {v.durationSec !== null ? formatDuration(v.durationSec) : formatDuration((Date.now() - Date.parse(v.enterTime)) / 1000)}
                </TableCell>
              </TableRow>
            ))}
            {visits.isSuccess && rows.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={4}>
                  <EmptyState icon={FootprintsIcon} title={t('No visits in this period')} description={t('Entries and exits are recorded even when the alerts are switched off.')} />
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

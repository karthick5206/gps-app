import type { ChangeSetChangeView, TransportDirection } from '@veetracer/shared';
import { AlertTriangleIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { FormError } from '@/components/form-error';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { formatClock } from '@/features/planned-trips/trip-format';
import { changeLine } from './change-set-format';
import { DIRECTION_LABEL } from './e3-format';
import { e3ErrorMessage } from './e3-ui';
import { useChangeSet } from './use-e3';

/** What a saved (server) draft would do when published: its changes with names, and what would be refused now. */
export function ChangeSetDetailDialog({ id, tz, onOpenChange }: { id: string | null; tz: string | undefined; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation();
  const q = useChangeSet(id);
  const d = q.data;
  const clock = (iso: string) => formatClock(iso, tz, d?.serviceDate);
  return (
    <Dialog open={!!id} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('Saved draft')}</DialogTitle>
          <DialogDescription>{d ? `${d.serviceDate} · ${t(DIRECTION_LABEL[d.direction as TransportDirection])}${d.reason ? ` · ${d.reason}` : ''}` : t('Changes of the saved draft')}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-3">
          {q.isPending ? (
            <Skeleton className="h-32 w-full" />
          ) : q.isError ? (
            <FormError message={e3ErrorMessage(q.error, t)} />
          ) : d ? (
            <>
              {d.issues.length > 0 && (
                <div className="rounded-lg border border-warning/50 bg-warning/10 p-3 text-sm" role="status">
                  <p className="flex items-center gap-2 font-medium">
                    <AlertTriangleIcon className="size-4" aria-hidden /> {t('Publishing would be refused as things stand')}
                  </p>
                  <ul className="mt-1 list-disc pl-5">
                    {d.issues.map((i) => (
                      <li key={i}>{i}</li>
                    ))}
                  </ul>
                </div>
              )}
              {d.changes.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('This change set keeps no changes (published or discarded).')}</p>
              ) : (
                <ol className="space-y-2 text-sm">
                  {d.changes.map((c, i) => (
                    <ChangeItem key={i} c={c} n={i + 1} clock={clock} />
                  ))}
                </ol>
              )}
            </>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('Close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ChangeItem({ c, n, clock }: { c: ChangeSetChangeView; n: number; clock: (iso: string) => string }) {
  const { t } = useTranslation();
  const line = changeLine(c, t);
  return (
    <li className="rounded-lg border p-2.5">
      <p>
        <span className="text-muted-foreground tabular-nums">{n}.</span> {line}
        {c.op === 'ADD_PASSENGER' && c.bookingStatus && c.bookingStatus !== 'PENDING_ASSIGNMENT' && (
          <Badge variant="warning" className="ml-2">
            {t('Booking changed')}
          </Badge>
        )}
      </p>
      {c.op === 'CREATE_TRIP' && c.stops.length > 0 && (
        <ol className="mt-1 space-y-0.5 pl-5 text-xs text-muted-foreground">
          {c.stops.map((s) => (
            <li key={s.seq}>
              <span className="tabular-nums">{clock(s.plannedArrival)}</span> · {s.seq + 1}. {s.label ?? t('Stop')}
              {!s.point && ` (${t('location hidden: no routing consent')})`}
            </li>
          ))}
        </ol>
      )}
    </li>
  );
}

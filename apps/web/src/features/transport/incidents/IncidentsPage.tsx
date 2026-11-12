import type { IncidentListItem } from '@veetracer/shared';
import { CheckCircle2Icon, ClockIcon, MapPinIcon, RepeatIcon, SirenIcon, TruckIcon, WifiOffIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { Spinner } from '@/components/ui/spinner';
import { useAuth } from '@/features/auth/auth-context';
import { useRealtimeStatus } from '@/features/live/use-live';
import { errorMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { AckIncidentDialog, ResolveIncidentDialog } from './IncidentActions';
import { elapsed, EVENT_LABEL, NOTIFY_LABEL, RAISER_LABEL, RESOLUTION_LABEL, sortLane, STATUS_LABEL } from './sos-lane';
import { useIncident, useSosLane } from './use-incidents';

/** Re-render every second for the ticking "raised … ago" timers (not announced to screen readers). */
function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

function SosCard({ i, now, onAck, onResolve, onOpen, canEdit }: { i: IncidentListItem; now: number; onAck: () => void; onResolve: () => void; onOpen: () => void; canEdit: boolean }) {
  const { t } = useTranslation();
  const open = i.status === 'OPEN';
  return (
    <li className={cn('rounded-xl border p-3 sm:p-4', open ? 'border-destructive/50 bg-destructive/5' : 'bg-card')}>
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <span className={cn('flex size-9 shrink-0 items-center justify-center rounded-full', open ? 'bg-destructive/15 text-destructive motion-safe:animate-pulse' : 'bg-muted text-muted-foreground')}>
          <SirenIcon className="size-5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2 font-semibold">
            <span className="truncate">{i.raiserLabel}</span>
            <Badge variant="muted">{t(RAISER_LABEL[i.raiserType])}</Badge>
            <Badge variant={open ? 'destructive' : i.status === 'ACKNOWLEDGED' ? 'warning' : 'success'}>{t(STATUS_LABEL[i.status])}</Badge>
          </p>
          <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
            <span className="inline-flex items-center gap-1" title={formatDateTime(i.raisedAt)}>
              <ClockIcon className="size-3.5" aria-hidden />
              {t('Raised {{time}} ago', { time: elapsed(i.raisedAt, now) })}
            </span>
            {i.vehiclePlate && (
              <span className="inline-flex items-center gap-1">
                <TruckIcon className="size-3.5" aria-hidden />
                {i.vehiclePlate}
              </span>
            )}
            {i.lastFix && (
              <span className="inline-flex items-center gap-1">
                <MapPinIcon className="size-3.5" aria-hidden />
                {i.lastFix.lat.toFixed(5)}, {i.lastFix.lng.toFixed(5)}
                {i.lastFix.accuracyM !== undefined ? ` (±${Math.round(i.lastFix.accuracyM)} m)` : ''}
                {i.lastFix.stale ? ` · ${t('old location')}` : ''}
              </span>
            )}
            {i.repeatCount > 0 && (
              <span className="inline-flex items-center gap-1">
                <RepeatIcon className="size-3.5" aria-hidden />
                {t('Pressed {{count}} more times', { count: i.repeatCount })}
              </span>
            )}
            <span>{t(NOTIFY_LABEL[i.notify])}</span>
          </p>
          {i.acknowledgedAt && (
            <p className="mt-1 text-sm">
              {t('Acknowledged by {{name}} at {{time}}', { name: i.acknowledgedBy ?? t('Dispatcher'), time: formatDateTime(i.acknowledgedAt) })}
            </p>
          )}
        </div>
        <div className="flex w-full gap-2 sm:w-auto">
          <Button variant="outline" size="sm" className="flex-1 sm:flex-none" onClick={onOpen}>
            {t('Details')}
          </Button>
          {canEdit && open && (
            <Button variant="destructive" size="sm" className="flex-1 sm:flex-none" onClick={onAck}>
              {t('Acknowledge')}
            </Button>
          )}
          {canEdit && i.status === 'ACKNOWLEDGED' && (
            <Button size="sm" className="flex-1 sm:flex-none" onClick={onResolve}>
              {t('Resolve')}
            </Button>
          )}
        </div>
      </div>
    </li>
  );
}

function IncidentTimeline({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { t } = useTranslation();
  const q = useIncident(id);
  const d = q.data;
  return (
    <Sheet open={!!id} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="w-full max-w-md overflow-y-auto p-4" aria-describedby={undefined}>
        <SheetTitle>{t('Incident history')}</SheetTitle>
        {q.isLoading && <Spinner />}
        {q.error && <p className="text-sm text-destructive">{errorMessage(q.error)}</p>}
        {d && (
          <div className="mt-3 space-y-3 text-sm">
            <p className="font-semibold">{d.raiserLabel}</p>
            {d.note && <p className="rounded-md bg-muted p-2">{d.note}</p>}
            {d.resolution && <p>{t('Outcome')}: {t(RESOLUTION_LABEL[d.resolution])}</p>}
            <ol className="space-y-2 border-s ps-3">
              {d.events.map((e) => (
                <li key={e.id}>
                  <p className="font-medium">{t(EVENT_LABEL[e.kind] ?? e.kind)}</p>
                  <p className="text-xs text-muted-foreground">
                    {formatDateTime(e.at)}
                    {e.actorLabel ? ` · ${e.actorLabel}` : ''}
                  </p>
                  {e.note && <p className="mt-0.5">{e.note}</p>}
                </li>
              ))}
            </ol>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

/**
 * Transport → Incidents & SOS (menu etms_incidents; WP 5.4, doc 07 §6.5): the open SOS lane. OPEN SOS on top (longest
 * waiting first) with Acknowledge (note required); acknowledged ones below with Resolve (outcome + note). Reads
 * PostgreSQL; refreshes on the `transport.sos` socket event and polls (15 s while the socket is down).
 */
export function IncidentsPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const canEdit = can('etms_incidents', 'edit');
  const lane = useSosLane();
  const status = useRealtimeStatus();
  const now = useNow();
  const [ackId, setAckId] = useState<string | null>(null);
  const [resolveId, setResolveId] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const items = sortLane(lane.data?.items ?? []);
  const openItems = items.filter((i) => i.status === 'OPEN');
  const acked = items.filter((i) => i.status !== 'OPEN');

  return (
    <div className="space-y-4">
      <PageHeader title={t('Incidents & SOS')} description={t('SOS raised by passengers and drivers. Acknowledge every SOS: the person sees that the desk has it.')} />
      {status !== 'connected' && (
        <p className="flex items-center gap-2 rounded-md border border-warning/40 bg-warning-soft px-3 py-2 text-sm text-warning-fg" role="status">
          <WifiOffIcon className="size-4" aria-hidden />
          {t('Live updates are disconnected. This list refreshes every 15 seconds.')}
        </p>
      )}
      {lane.error && <p className="text-sm text-destructive">{errorMessage(lane.error)}</p>}
      <section aria-labelledby="sos-open-h" className="space-y-2">
        <h2 id="sos-open-h" className="flex items-center gap-2 text-base font-semibold">
          {t('Open SOS')}
          {openItems.length > 0 && <Badge variant="destructive">{openItems.length}</Badge>}
        </h2>
        {lane.isLoading ? (
          <Spinner />
        ) : openItems.length === 0 ? (
          <EmptyState icon={CheckCircle2Icon} title={t('No open SOS')} description={t('New SOS appear here at once, with a siren.')} />
        ) : (
          <ul className="space-y-2" role="alert" aria-live="assertive">
            {openItems.map((i) => (
              <SosCard key={i.id} i={i} now={now} canEdit={canEdit} onAck={() => setAckId(i.id)} onResolve={() => setResolveId(i.id)} onOpen={() => setDetailId(i.id)} />
            ))}
          </ul>
        )}
      </section>
      {acked.length > 0 && (
        <section aria-labelledby="sos-acked-h" className="space-y-2">
          <h2 id="sos-acked-h" className="text-base font-semibold">
            {t('Acknowledged, not yet resolved')}
          </h2>
          <ul className="space-y-2">
            {acked.map((i) => (
              <SosCard key={i.id} i={i} now={now} canEdit={canEdit} onAck={() => setAckId(i.id)} onResolve={() => setResolveId(i.id)} onOpen={() => setDetailId(i.id)} />
            ))}
          </ul>
        </section>
      )}
      <AckIncidentDialog incidentId={ackId} open={!!ackId} onOpenChange={(o) => !o && setAckId(null)} />
      <ResolveIncidentDialog incidentId={resolveId} open={!!resolveId} onOpenChange={(o) => !o && setResolveId(null)} />
      <IncidentTimeline id={detailId} onClose={() => setDetailId(null)} />
    </div>
  );
}

import { SirenIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';
import { useAuth } from '@/features/auth/auth-context';
import { playSiren } from '@/features/alerts/sound';
import { AckIncidentDialog } from './IncidentActions';
import { actionableOpenCount, bannerIncident, elapsed, INCIDENTS_PATH, newOpenIds, sirenIds } from './sos-lane';
import { useSosLane, useSosSocket } from './use-incidents';

const SIREN_REPEAT_MS = 3000;

/**
 * Bell mirror (doc 07 §6.5 "SOS also enters the bell"): a siren button in the top bar with the number of OPEN SOS in
 * scope, next to the alert bell. Hosts the socket subscription and rings the siren (repeating until acknowledged) and a
 * toast once per new SOS, on any page. Shown only with etms_incidents:view.
 */
export function SosBellMirror() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const navigate = useNavigate();
  useSosSocket();
  const lane = useSosLane();
  const seen = useRef<Set<string> | null>(null);
  const openCount = lane.data?.openCount ?? 0;
  // QA B8: the siren only for SOS the caller can acknowledge (view-only staff: banner + toast, no siren loop).
  const actionable = actionableOpenCount(lane.data?.items);

  // Siren + toast once per new OPEN SOS (not for the ones already open when the page loaded: the banner shows them).
  useEffect(() => {
    const items = lane.data?.items;
    if (!items) return;
    if (seen.current === null) {
      seen.current = new Set(items.map((i) => i.id));
      return;
    }
    const fresh = newOpenIds(seen.current, items);
    for (const id of fresh) {
      seen.current.add(id);
      const i = items.find((x) => x.id === id)!;
      toast.error(t('SOS raised'), { id: `sos-${id}`, description: i.raiserLabel, duration: 15_000, action: { label: t('Open'), onClick: () => navigate(INCIDENTS_PATH) } });
    }
    if (sirenIds(fresh, items).length) playSiren(true);
  }, [lane.data, navigate, t]);

  // Repeat the siren while any SOS the caller can acknowledge is OPEN (stops on acknowledgement).
  useEffect(() => {
    if (!actionable) return;
    const timer = setInterval(() => playSiren(true), SIREN_REPEAT_MS);
    return () => clearInterval(timer);
  }, [actionable]);

  if (!can('etms_incidents')) return null;
  const label = openCount ? t('{{count}} open SOS', { count: openCount }) : t('Incidents & SOS');
  return (
    <Tooltip content={label}>
      <Button variant="ghost" size="icon" aria-label={label} className="relative" onClick={() => navigate(INCIDENTS_PATH)}>
        <SirenIcon className={openCount ? 'text-destructive motion-safe:animate-pulse' : undefined} />
        {openCount > 0 && (
          <span className="absolute top-1 right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] leading-none font-semibold text-destructive-foreground tabular-nums ring-2 ring-card">
            {openCount > 99 ? '99+' : openCount}
          </span>
        )}
      </Button>
    </Tooltip>
  );
}

/**
 * Full-width red SOS banner below the top bar (doc 07 §4.2): the oldest OPEN SOS, on every page, until it is
 * acknowledged — it has no close button. "Acknowledge" opens the note dialog; "Open lane" goes to the SOS lane.
 */
export function SosBanner() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const { pathname } = useLocation();
  const lane = useSosLane();
  const [now, setNow] = useState(() => Date.now());
  const [ackId, setAckId] = useState<string | null>(null);
  const top = bannerIncident(lane.data?.items);
  useEffect(() => {
    if (!top) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [top]);
  if (!can('etms_incidents') || !top) return null;
  const more = (lane.data?.openCount ?? 1) - 1;
  return (
    <div className="sticky top-0 z-30 flex flex-wrap items-center gap-2 bg-destructive px-3 py-2 text-sm text-destructive-foreground sm:px-4" role="region" aria-label={t('SOS')}>
      {/* QA B5: announced once per banner SOS (keyed), never the ticking timer below. */}
      <span key={top.id} className="sr-only" role="alert">
        {t('SOS raised')}: {top.raiserLabel}
      </span>
      <SirenIcon className="size-4 shrink-0 motion-safe:animate-pulse" aria-hidden />
      <p className="min-w-0 flex-1 font-semibold">
        <span className="me-1">{t('SOS')}</span>
        <span className="break-words">{top.raiserLabel}</span>
        {top.vehiclePlate ? ` · ${top.vehiclePlate}` : ''}
        <span className="ms-1 font-normal tabular-nums" aria-hidden>
          {t('raised {{time}} ago', { time: elapsed(top.raisedAt, now) })}
        </span>
        {more > 0 && <span className="ms-1 font-normal">{t('(+{{count}} more)', { count: more })}</span>}
      </p>
      <div className="flex gap-2">
        {can('etms_incidents', 'edit') && top.canAct && (
          <Button size="sm" variant="secondary" onClick={() => setAckId(top.id)}>
            {t('Acknowledge')}
          </Button>
        )}
        {pathname !== INCIDENTS_PATH && (
          <Button size="sm" variant="outline" className="border-destructive-foreground/40 bg-transparent text-destructive-foreground hover:bg-destructive-foreground/10" asChild>
            <Link to={INCIDENTS_PATH}>{t('Open lane')}</Link>
          </Button>
        )}
      </div>
      <AckIncidentDialog incidentId={ackId} open={!!ackId} onOpenChange={(o) => !o && setAckId(null)} />
    </div>
  );
}

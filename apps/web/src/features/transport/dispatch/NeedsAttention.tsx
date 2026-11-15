import type { DispatchBoardDto, SafetyWatchDto } from '@veetracer/shared';
import { AlertTriangleIcon, ChevronDownIcon, HomeIcon, SirenIcon } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useAuth } from '@/features/auth/auth-context';
import { cn } from '@/lib/utils';
import { useSosLane } from '../incidents/use-incidents';
import { deskExceptions, LATE_AFTER_MIN, NOT_STARTED_AFTER_MIN, WAITING_SOON_MIN, type ExceptionKind } from './exceptions';
import { transportTripPath } from './use-e3';

const TEXT: Record<ExceptionKind, string> = {
  SOS: 'Open SOS',
  NOT_STARTED: `Not started (${NOT_STARTED_AFTER_MIN}+ min late)`,
  LATE: `Running late (${LATE_AFTER_MIN}+ min)`,
  NO_DRIVER: 'No driver',
  NOT_COMPLIANT: 'Vehicle documents',
  OUTCOME_MISSING: 'Boarding not recorded',
  WAITING_SOON: `Still waiting (within ${WAITING_SOON_MIN} min)`,
  TO_APPROVE: 'To approve',
  NO_LOCATION: 'No pickup point',
};

/** SOS lane count only for roles that may see incidents (the hook is a no-op otherwise). */
function useOpenSos(): number {
  const { can } = useAuth();
  const lane = useSosLane();
  return can('etms_incidents') ? (lane.data?.openCount ?? 0) : 0;
}

/**
 * "Needs attention" strip on Daily transport (today only): one chip per exception with its count. Trip chips list the
 * trips (open each); rider chips tick those riders in the waiting table. Re-evaluated every 30 s and on every board
 * update (live).
 */
export function NeedsAttention({ board, onSelect, watch }: { board: DispatchBoardDto; onSelect: (bookingIds: string[]) => void; watch?: SafetyWatchDto }) {
  const { t } = useTranslation();
  const openSos = useOpenSos();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const h = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(h);
  }, []);
  const items = useMemo(() => deskExceptions(board, now, openSos), [board, now, openSos]);
  const home = watch?.reachedHomePending ?? [];
  if (!items.length && !home.length) {
    return <p className="rounded-lg border border-success/40 bg-success/5 px-3 py-2 text-sm text-success-fg">{t('Nothing needs attention right now.')}</p>;
  }
  return (
    <section aria-label={t('Needs attention')} className="flex flex-wrap items-center gap-2 rounded-lg border border-warning/50 bg-warning/5 px-3 py-2">
      <span className="flex items-center gap-1.5 text-sm font-semibold">
        <AlertTriangleIcon className="size-4 text-warning-fg" aria-hidden /> {t('Needs attention')}
      </span>
      {home.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" className="inline-flex h-8 items-center gap-1.5 rounded-full border border-destructive/50 bg-destructive/10 px-3 text-sm font-medium text-destructive-fg outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <HomeIcon className="size-4" aria-hidden /> {t('Reached home not confirmed')} <span className="tabular-nums">{home.length}</span> <ChevronDownIcon className="size-3.5" aria-hidden />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuLabel>{t('Dropped at night, no confirmation yet: call them')}</DropdownMenuLabel>
            {home.map((h) => (
              <DropdownMenuItem key={h.passengerTripId} asChild>
                <Link to={transportTripPath(h.tripId)}>
                  {h.passenger} · {h.vehicleName ?? h.tripName} · {t('{{n}} min ago', { n: h.minutesAgo })}
                </Link>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {items.map((e) => {
        const chip = cn(
          'inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring',
          e.severity === 'red' ? 'border-destructive/50 bg-destructive/10 text-destructive-fg' : 'border-warning/60 bg-card text-warning-fg',
        );
        const body = (
          <>
            {e.kind === 'SOS' && <SirenIcon className="size-4" aria-hidden />}
            {t(TEXT[e.kind])} <span className="tabular-nums">{e.count}</span>
          </>
        );
        if (e.kind === 'SOS')
          return (
            <Link key={e.kind} to="/transport/incidents" className={chip}>
              {body}
            </Link>
          );
        if (e.bookingIds.length)
          return (
            <button key={e.kind} type="button" className={chip} onClick={() => onSelect(e.bookingIds)} title={e.names.join(', ')}>
              {body}
            </button>
          );
        return (
          <DropdownMenu key={e.kind}>
            <DropdownMenuTrigger asChild>
              <button type="button" className={chip}>
                {body} <ChevronDownIcon className="size-3.5" aria-hidden />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuLabel>{t(TEXT[e.kind])}</DropdownMenuLabel>
              {e.tripIds.map((id, i) => (
                <DropdownMenuItem key={id} asChild>
                  <Link to={transportTripPath(id)}>{e.names[i] ?? id}</Link>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        );
      })}
    </section>
  );
}

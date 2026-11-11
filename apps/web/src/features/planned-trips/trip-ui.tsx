import type { PlannedTripStatus, PlannedTripSummaryDto } from '@veetracer/shared';
import { CheckCircle2Icon, MoreHorizontalIcon, PencilIcon, PlayIcon, XCircleIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useAuth } from '@/features/auth/auth-context';
import { cn } from '@/lib/utils';
import { classifyDelay, DELAY_TEXT_CLASS, formatDelay, STATUS_LABEL, STATUS_TONE, tripActions, type TripAction } from './trip-format';

export function TripStatusBadge({ status, className }: { status: PlannedTripStatus; className?: string }) {
  const { t } = useTranslation();
  return (
    <Badge variant={STATUS_TONE[status]} className={className}>
      {(status === 'STARTED' || status === 'IN_PROGRESS') && <span className="size-1.5 animate-pulse rounded-full bg-current motion-reduce:animate-none" aria-hidden />}
      {t(STATUS_LABEL[status])}
    </Badge>
  );
}

/** "+12 min" in the late colour, "−3 min" early, on time green; "—" when unknown. */
export function DelayText({ delaySec, className }: { delaySec: number | null | undefined; className?: string }) {
  const { t } = useTranslation();
  const cls = classifyDelay(delaySec);
  if (!cls) return <span className={cn('text-muted-foreground', className)}>—</span>;
  const label = cls === 'late' ? t('Late') : cls === 'early' ? t('Early') : t('On time');
  return (
    <span className={cn('font-medium tabular-nums', DELAY_TEXT_CLASS[cls], className)} title={label}>
      {formatDelay(delaySec)}
      <span className="sr-only"> ({label})</span>
    </span>
  );
}

const ACTION_META: Record<TripAction, { label: string; icon: typeof PlayIcon; destructive?: boolean }> = {
  edit: { label: 'Edit', icon: PencilIcon },
  start: { label: 'Start now', icon: PlayIcon },
  complete: { label: 'Complete now', icon: CheckCircle2Icon },
  cancel: { label: 'Cancel trip', icon: XCircleIcon, destructive: true },
};

/** Actions this user may run on a trip in its status (all need Planned trips → edit). */
export function useAllowedActions(trip: Pick<PlannedTripSummaryDto, 'status' | 'origin'>): TripAction[] {
  const { can } = useAuth();
  return can('plannedTrips', 'edit') ? tripActions(trip.status, trip.origin) : [];
}

export function TripActionsMenu({ trip, onAction, className }: { trip: PlannedTripSummaryDto; onAction: (a: TripAction, trip: PlannedTripSummaryDto) => void; className?: string }) {
  const { t } = useTranslation();
  const actions = useAllowedActions(trip);
  if (!actions.length) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="icon-sm" variant="ghost" className={className} aria-label={t('Actions for {{name}}', { name: trip.routeName })} onClick={(e) => e.stopPropagation()}>
          <MoreHorizontalIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
        {actions.map((a) => {
          const m = ACTION_META[a];
          return (
            <DropdownMenuItem key={a} variant={m.destructive ? 'destructive' : 'default'} onSelect={() => onAction(a, trip)}>
              <m.icon /> {t(m.label)}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The same actions as buttons (trip detail header). */
export function TripActionButtons({ trip, onAction }: { trip: PlannedTripSummaryDto; onAction: (a: TripAction, trip: PlannedTripSummaryDto) => void }) {
  const { t } = useTranslation();
  const actions = useAllowedActions(trip);
  return (
    <>
      {actions.map((a) => {
        const m = ACTION_META[a];
        return (
          <Button key={a} size="sm" variant={m.destructive ? 'outline' : a === 'edit' ? 'outline' : 'default'} className={cn(m.destructive && 'text-destructive hover:text-destructive')} onClick={() => onAction(a, trip)}>
            <m.icon /> {t(m.label)}
          </Button>
        );
      })}
    </>
  );
}

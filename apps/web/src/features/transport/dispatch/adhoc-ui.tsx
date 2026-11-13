import type { TransportBookingJourney } from '@veetracer/shared';
import { ClockAlertIcon, UsersIcon, WaypointsIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { JOURNEY_LABEL } from './adhoc-booking';

/** WP 3.9: "Point-to-point" (a ride with no office end). */
export function JourneyBadge({ journey }: { journey: TransportBookingJourney }) {
  const { t } = useTranslation();
  return (
    <Badge variant="info" title={journey === 'POINT_TO_POINT' ? t('Any pickup to any destination, no office end. Dispatched by hand.') : undefined}>
      <WaypointsIcon aria-hidden />
      {t(JOURNEY_LABEL[journey])}
    </Badge>
  );
}

/** WP 3.9 (D-A1): booked or edited after the cut-off by a dispatcher with a reason; the reason is the badge's title. */
export function AfterCutoffBadge({ reason }: { reason: string | null }) {
  const { t } = useTranslation();
  return (
    <Badge variant="warning" title={reason ? t('Late reason: {{reason}}', { reason }) : t('Booked after the cut-off')}>
      <ClockAlertIcon aria-hidden />
      {t('After cut-off')}
      {reason && <span className="sr-only">: {reason}</span>}
    </Badge>
  );
}

/**
 * WP 3.9 wave 2 (D-A8): "Group of N" on a booking of a group ride, with its purpose as the title. With `onClick` it is a
 * button: on the bookings list it filters to that group; with `selectLabel` (dispatch board) it selects the whole group.
 */
export function GroupBadge({ size, purpose, onClick, active, selectLabel }: { size: number; purpose: string | null; onClick?: () => void; active?: boolean; selectLabel?: boolean }) {
  const { t } = useTranslation();
  const label = t('Group of {{n}}', { n: size });
  const title = purpose ? t('Group ride: {{purpose}}', { purpose }) : t('Group ride');
  const badge = (
    <Badge variant={active ? 'info' : 'outline'} title={selectLabel ? t('Select the whole group to put it on one trip') : title}>
      <UsersIcon aria-hidden />
      {label}
    </Badge>
  );
  if (!onClick) return badge;
  return (
    <button type="button" onClick={onClick} aria-pressed={active} aria-label={selectLabel ? (active ? t('Unselect this group: {{title}}', { title }) : t('Select the whole group: {{title}}', { title })) : active ? t('Show all bookings again') : t('Show only this group: {{title}}', { title })} className="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring">
      {badge}
    </button>
  );
}

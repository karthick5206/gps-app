import type { TransportBookingJourney } from '@veetracer/shared';
import { ClockAlertIcon, WaypointsIcon } from 'lucide-react';
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

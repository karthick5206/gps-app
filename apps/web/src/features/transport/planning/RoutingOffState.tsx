import type { RoutingOffReason } from '@veetracer/shared';
import { WaypointsIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { offReasonText } from '@/features/platform/routing-switch/routing-switch-format';

/**
 * v1.16: the planner while automatic routing is off for this company (env emergency switch, VeeTrax's platform switch or
 * the company's own switch; GET /routing/capabilities says which). Manual dispatch is always available.
 */
export function RoutingOffState({ reason }: { reason: RoutingOffReason | null | undefined }) {
  const { t } = useTranslation();
  return (
    <EmptyState
      icon={WaypointsIcon}
      title={t('Automatic routing is switched off')}
      description={t(offReasonText(reason))}
      action={
        <Button asChild variant="outline">
          <Link to="/transport/dispatch">{t('Open the dispatch board')}</Link>
        </Button>
      }
    />
  );
}

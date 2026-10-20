import type { AlertDto, AlertSeverity, AlertStatus } from '@veetracer/shared';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { SEVERITY_BADGE, SEVERITY_LABEL, STATUS_BADGE, STATUS_LABEL } from './severity';

export function SeverityBadge({ severity }: { severity: AlertSeverity }) {
  const { t } = useTranslation();
  return (
    <Badge variant={SEVERITY_BADGE[severity]} className={cn(severity === 'CRITICAL' && 'bg-destructive text-destructive-foreground')}>
      {t(SEVERITY_LABEL[severity])}
    </Badge>
  );
}

export function AlertStatusBadge({ status }: { status: AlertStatus }) {
  const { t } = useTranslation();
  return <Badge variant={STATUS_BADGE[status]}>{t(STATUS_LABEL[status])}</Badge>;
}

/**
 * Alert state for the signed-in user: ack-required alerts show "Needs acknowledgement" until acknowledged; other alerts
 * never need it, so they show only read / unread (older ones may still carry an acknowledged status).
 */
export function AlertStateBadge({ a }: { a: Pick<AlertDto, 'status' | 'read' | 'ackRequired'> }) {
  const { t } = useTranslation();
  if (a.status !== 'NEW') return <AlertStatusBadge status={a.status} />;
  if (a.ackRequired) return <Badge variant="destructive">{t('Needs acknowledgement')}</Badge>;
  return <Badge variant={a.read ? 'muted' : 'default'}>{a.read ? t('Read') : t('Unread')}</Badge>;
}

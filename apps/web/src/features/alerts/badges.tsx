import type { AlertSeverity, AlertStatus } from '@veetracer/shared';
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

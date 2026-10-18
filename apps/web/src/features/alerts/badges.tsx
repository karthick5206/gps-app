import type { AlertSeverity, AlertStatus } from '@veetracer/shared';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { SEVERITY_BADGE, SEVERITY_LABEL, STATUS_BADGE, STATUS_LABEL } from './severity';

export function SeverityBadge({ severity }: { severity: AlertSeverity }) {
  return (
    <Badge variant={SEVERITY_BADGE[severity]} className={cn(severity === 'CRITICAL' && 'bg-destructive text-destructive-foreground')}>
      {SEVERITY_LABEL[severity]}
    </Badge>
  );
}

export function AlertStatusBadge({ status }: { status: AlertStatus }) {
  return <Badge variant={STATUS_BADGE[status]}>{STATUS_LABEL[status]}</Badge>;
}

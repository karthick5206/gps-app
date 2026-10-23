import { STATUS_META, type MovementStatus } from '@veetracer/shared';
import { useTranslation } from 'react-i18next';
import { statusColor } from '@/lib/status-tokens';
import { cn } from '@/lib/utils';

export function StatusDot({ status, className, pulse }: { status: MovementStatus; className?: string; pulse?: boolean }) {
  return (
    <span className={cn('relative inline-flex size-2.5 shrink-0', className)} aria-hidden>
      {pulse && <span className="absolute inset-0 animate-ping rounded-full opacity-50 motion-reduce:hidden" style={{ backgroundColor: statusColor(status) }} />}
      <span className="relative inline-flex size-full rounded-full" style={{ backgroundColor: statusColor(status) }} />
    </span>
  );
}

/** `label` overrides the status name (e.g. a person's activity), `status` still picks the colour. */
export function StatusBadge({ status, label, className }: { status: MovementStatus; label?: string; className?: string }) {
  const { t } = useTranslation();
  return (
    <span
      className={cn('inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium', className)}
      style={{ backgroundColor: `color-mix(in oklab, ${statusColor(status)} 14%, transparent)`, color: statusColor(status) }}
    >
      <StatusDot status={status} className="size-2" />
      {t(label ?? STATUS_META[status].label)}
    </span>
  );
}

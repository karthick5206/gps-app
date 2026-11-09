import { useQueryClient } from '@tanstack/react-query';
import { SIM_STATUS_LABELS, type SimPlanDto, type SimProviderDto, type SimRenewalState, type SimStatus } from '@veetracer/shared';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import type { Option } from '@/components/ui/multi-select';
import type { BadgeVariant } from '@/features/inventory/shared';

export const SIM_STATUS_VARIANT: Record<SimStatus, BadgeVariant> = {
  AVAILABLE: 'info',
  RESERVED: 'default',
  ACTIVE: 'success',
  SUSPENDED: 'warning',
  EXPIRED: 'destructive',
  DEACTIVATED: 'muted',
  DAMAGED: 'destructive',
};

export function SimStatusBadge({ status }: { status: SimStatus }) {
  const { t } = useTranslation();
  return <Badge variant={SIM_STATUS_VARIANT[status]}>{t(SIM_STATUS_LABELS[status])}</Badge>;
}

export function RenewalBadge({ state, date }: { state: SimRenewalState; date: string | null }) {
  const { t } = useTranslation();
  if (!date) return <span className="text-muted-foreground">—</span>;
  const variant = state === 'OVERDUE' ? 'destructive' : state === 'DUE_SOON' ? 'warning' : 'outline';
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="tabular-nums">{date}</span>
      {state === 'OVERDUE' && <Badge variant={variant}>{t('Overdue')}</Badge>}
      {state === 'DUE_SOON' && <Badge variant={variant}>{t('Due soon')}</Badge>}
    </span>
  );
}

export const providerOption = (p: SimProviderDto): Option => ({ value: p.id, label: p.name });
export const planOption = (p: SimPlanDto): Option => ({ value: p.id, label: `${p.providerName} · ${p.name}` });

export const SIM_ENDPOINTS = ['/sims', '/sims/providers', '/sims/plans', '/sims/events'];

export function useInvalidateSims() {
  const qc = useQueryClient();
  return () => {
    for (const e of SIM_ENDPOINTS) {
      void qc.invalidateQueries({ queryKey: ['master', e] });
      void qc.invalidateQueries({ queryKey: ['options', e] });
    }
    void qc.invalidateQueries({ queryKey: ['sims'] });
  };
}

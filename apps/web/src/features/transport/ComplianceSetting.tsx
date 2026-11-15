import { TRANSPORT_COMPLIANCE_MODES, TRANSPORT_DRIVER_DOCS, TRANSPORT_VEHICLE_DOCS, documentTypeLabel, type TransportComplianceMode } from '@veetracer/shared';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useAuth } from '@/features/auth/auth-context';
import { Panel } from '@/features/dashboard/refresh/kit';
import { errorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useTransportSettings, useUpdateTransportSettings } from './use-agreements';

const LABEL: Record<TransportComplianceMode, string> = { OFF: 'Off', WARN: 'Warn', BLOCK: 'Block' };
const HINT: Record<TransportComplianceMode, string> = {
  OFF: 'Documents are not checked for transport.',
  WARN: 'Vehicles with a missing or expired document are flagged on Daily transport; Allocate vehicles prefers compliant ones.',
  BLOCK: 'Vehicles and drivers with a missing or expired document cannot be put on a trip.',
};

/**
 * v1.16.7: vehicle / driver document compliance for transport (Company.settings.etms.compliance, default WARN). The
 * documents themselves are VeeTrax Documents (Masters → Vehicles / Drivers → Documents).
 */
export function ComplianceSetting() {
  const { t } = useTranslation();
  const { can, me } = useAuth();
  const settings = useTransportSettings(true);
  const update = useUpdateTransportSettings();
  const editable = can('etms_settings', 'edit') && me?.dataScope === 'COMPANY';
  const mode: TransportComplianceMode = settings.data?.compliance ?? 'WARN';
  return (
    <Panel title={t('Vehicle and driver documents')} subtitle={t('Check documents before a vehicle or driver carries employees')} id="etms-compliance">
      <div className="space-y-2 text-sm">
        <div className="inline-flex rounded-lg border bg-muted p-[3px]" role="radiogroup" aria-label={t('Document check')}>
          {TRANSPORT_COMPLIANCE_MODES.map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              disabled={!editable || update.isPending}
              onClick={() => update.mutate({ compliance: m }, { onSuccess: () => toast.success(t('Document check: {{mode}}', { mode: t(LABEL[m]) })), onError: (e) => toast.error(errorMessage(e)) })}
              className={cn('h-8 rounded-md px-4 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60', mode === m ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground')}
            >
              {t(LABEL[m])}
            </button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">{t(HINT[mode])}</p>
        <p className="text-xs text-muted-foreground">
          {t('Vehicle')}: {TRANSPORT_VEHICLE_DOCS.map((d) => t(documentTypeLabel(d))).join(', ')} · {t('Driver')}: {TRANSPORT_DRIVER_DOCS.map((d) => t(documentTypeLabel(d))).join(', ')}
        </p>
        {!editable && <p className="text-xs text-muted-foreground">{t('Only a Transport admin with whole-company access can change this.')}</p>}
      </div>
    </Panel>
  );
}

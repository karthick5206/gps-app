import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Switch } from '@/components/ui/switch';
import { useAuth } from '@/features/auth/auth-context';
import { Panel } from '@/features/dashboard/refresh/kit';
import { companySwitchNote } from '@/features/platform/routing-switch/routing-switch-format';
import { errorMessage } from '@/lib/api';
import { PLANNING_MENU, plannerKeys, useCapabilities } from './planning/planner-client';
import { useTransportSettings, useUpdateTransportSettings } from './use-agreements';

/**
 * v1.16 (owner decision 2026-11-13): this company's own automatic route planning switch (Company.settings.etms.autoRouting,
 * default off). Routing works only while VeeTrax's platform switch is on too (and the server's emergency switch is not
 * pulled); the note says which one is missing when the caller can read the planner capabilities. Changed only by
 * whole-company users with etms_settings:edit (the API enforces it and audits the change).
 */
export function AutoRoutingSetting() {
  const { t } = useTranslation();
  const { can, me } = useAuth();
  const qc = useQueryClient();
  const settings = useTransportSettings(true);
  const update = useUpdateTransportSettings();
  const caps = useCapabilities(can(PLANNING_MENU, 'view'));
  const editable = can('etms_settings', 'edit') && me?.dataScope === 'COMPANY';
  const on = settings.data?.autoRouting === true;
  const reason = caps.data ? (caps.data.offReason ?? (caps.data.enabled ? null : undefined)) : undefined;
  return (
    <Panel title={t('Automatic route planning')} subtitle={t(on ? 'Automatic route planning is on for your company' : 'Automatic route planning is off for your company')} id="etms-auto-routing">
      <div className="flex items-start gap-3 text-sm">
        <Switch
          id="etms-auto-routing-on"
          checked={on}
          disabled={!editable || settings.isLoading || update.isPending}
          onCheckedChange={(v) =>
            update.mutate(
              { autoRouting: v },
              {
                onSuccess: (row) => {
                  void qc.invalidateQueries({ queryKey: plannerKeys.capabilities });
                  toast.success(t(row.autoRouting ? 'Automatic route planning is on for your company' : 'Automatic route planning is off for your company'));
                },
                onError: (e) => toast.error(errorMessage(e)),
              },
            )
          }
          aria-describedby="etms-auto-routing-help"
        />
        <div className="min-w-0 space-y-1">
          <label htmlFor="etms-auto-routing-on" className="font-medium">
            {t('Use automatic route planning')}
          </label>
          <p id="etms-auto-routing-help" className="text-xs text-muted-foreground">
            {t('Off by default. When on, your planners can optimise the day’s bookings into routes on the Route planning page.')}
          </p>
          {reason !== undefined && <p className="text-xs text-muted-foreground">{t(companySwitchNote(on, reason))}</p>}
          {!editable && <p className="text-xs text-muted-foreground">{t('Only a Transport admin with whole-company access can change this.')}</p>}
        </div>
      </div>
    </Panel>
  );
}

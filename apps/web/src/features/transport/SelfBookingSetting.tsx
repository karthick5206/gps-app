import type { UpdateTransportSettingsInput } from '@veetracer/shared';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Switch } from '@/components/ui/switch';
import { useAuth } from '@/features/auth/auth-context';
import { Panel } from '@/features/dashboard/refresh/kit';
import { errorMessage } from '@/lib/api';
import { selfBookingApprovalOf } from './dispatch/group-booking';
import { useTransportSettings, useUpdateTransportSettings } from './use-agreements';

/**
 * E5 WP 5.3: passenger self-service in the VeeTrax app (book within the cut-off, commute, saved places, confirm a ride,
 * report a problem). Off by default; Transport admins with whole-company access switch it (etms_settings:edit).
 */
export function SelfBookingSetting() {
  const { t } = useTranslation();
  const { can, me } = useAuth();
  const settings = useTransportSettings(true);
  const update = useUpdateTransportSettings();
  const editable = can('etms_settings', 'edit') && me?.dataScope === 'COMPANY';
  const on = settings.data?.selfBooking === true;
  const approval = selfBookingApprovalOf(settings.data);
  return (
    <Panel title={t('Passenger self-service')} subtitle={t('What passengers may do themselves in the VeeTrax app')} id="etms-self-booking">
      <div className="flex items-start gap-3 text-sm">
        <Switch
          id="etms-self-booking-on"
          checked={on}
          disabled={!editable || settings.isLoading || update.isPending}
          onCheckedChange={(v) =>
            update.mutate(
              { selfBooking: v },
              {
                onSuccess: (row) => toast.success(row.selfBooking ? t('Passengers can now book and manage trips in the app') : t('Passenger self-service is off')),
                onError: (e) => toast.error(errorMessage(e)),
              },
            )
          }
          aria-describedby="etms-self-booking-help"
        />
        <div className="min-w-0 space-y-1">
          <label htmlFor="etms-self-booking-on" className="font-medium">
            {t('Let passengers book trips in the app')}
          </label>
          <p id="etms-self-booking-help" className="text-xs text-muted-foreground">
            {t('Off by default. When on, passengers can book a trip for one of your shifts before the booking cut-off, see their regular commute, keep saved places, confirm a pickup or drop and report a problem. The driver’s record stays authoritative.')}
          </p>
          {!editable && <p className="text-xs text-muted-foreground">{t('Only a Transport admin with whole-company access can change this.')}</p>}
        </div>
      </div>
      {/* WP 3.9 wave 2 (D-A5): passenger requests wait for approval; absent = ON. */}
      <div className="mt-4 flex items-start gap-3 border-t pt-4 text-sm">
        <Switch
          id="etms-self-booking-approval"
          checked={approval}
          disabled={!editable || settings.isLoading || update.isPending}
          onCheckedChange={(v) => {
            const input: UpdateTransportSettingsInput & { selfBookingApproval?: boolean } = { selfBookingApproval: v };
            update.mutate(input, {
              onSuccess: (row) => toast.success(selfBookingApprovalOf(row) ? t('Passenger requests now wait for approval') : t('Passenger requests are now accepted without approval')),
              onError: (e) => toast.error(errorMessage(e)),
            });
          }}
          aria-describedby="etms-self-booking-approval-help"
        />
        <div className="min-w-0 space-y-1">
          <label htmlFor="etms-self-booking-approval" className="font-medium">
            {t('Passenger requests need approval')}
          </label>
          <p id="etms-self-booking-approval-help" className="text-xs text-muted-foreground">
            {t('On by default. When on, a ride a passenger requests in the app waits in "Requests to approve" until the transport team approves or rejects it; the passenger is told either way. When off, requests go straight to dispatch.')}
          </p>
          {!on && <p className="text-xs text-muted-foreground">{t('Applies once passengers can book trips in the app.')}</p>}
        </div>
      </div>
    </Panel>
  );
}


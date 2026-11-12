import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Switch } from '@/components/ui/switch';
import { useAuth } from '@/features/auth/auth-context';
import { Panel } from '@/features/dashboard/refresh/kit';
import { errorMessage } from '@/lib/api';
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
    </Panel>
  );
}


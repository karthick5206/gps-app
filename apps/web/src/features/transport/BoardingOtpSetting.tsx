import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Switch } from '@/components/ui/switch';
import { useAuth } from '@/features/auth/auth-context';
import { Panel } from '@/features/dashboard/refresh/kit';
import { errorMessage } from '@/lib/api';
import { useTransportSettings, useUpdateTransportSettings } from './use-agreements';

/**
 * v1.16.7 boarding OTP (Company.settings.etms.boardingOtp, default off): each passenger sees a 4-digit code for their
 * seat in the VeeTrax app (My commute); the driver must type it to record Boarded. The desk can still record boarding.
 */
export function BoardingOtpSetting() {
  const { t } = useTranslation();
  const { can, me } = useAuth();
  const settings = useTransportSettings(true);
  const update = useUpdateTransportSettings();
  const editable = can('etms_settings', 'edit') && me?.dataScope === 'COMPANY';
  const on = settings.data?.boardingOtp === true;
  return (
    <Panel title={t('Boarding code (OTP)')} subtitle={t('Proof that the employee actually boarded')} id="etms-boarding-otp">
      <label className="flex items-start gap-3 text-sm">
        <Switch
          checked={on}
          disabled={!editable || update.isPending}
          onCheckedChange={(v) => update.mutate({ boardingOtp: v }, { onSuccess: () => toast.success(v ? t('Boarding code is now required') : t('Boarding code is off')), onError: (e) => toast.error(errorMessage(e)) })}
        />
        <span className="min-w-0">
          <span className="font-medium">{t('Driver must enter the passenger’s boarding code')}</span>
          <span className="block text-xs text-muted-foreground">
            {t('Each employee sees a 4-digit code on their trip in the app. The driver types it to mark them Boarded; a wrong code is refused. Needs VeeTrax app 0.7.2 or newer for drivers and employees.')}
          </span>
          {!editable && <span className="block text-xs text-muted-foreground">{t('Only a Transport admin with whole-company access can change this.')}</span>}
        </span>
      </label>
    </Panel>
  );
}

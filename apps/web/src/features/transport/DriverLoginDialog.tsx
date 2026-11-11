import type { DriverDto } from '@veetracer/shared';
import { useTranslation } from 'react-i18next';
import { FormError } from '@/components/form-error';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/features/auth/auth-context';
import { errorMessage } from '@/lib/api';
import { AppLoginPanel } from './AppLoginPanel';
import { useDriverLogin, useDriverLoginMutation } from './use-people';

/**
 * "App login" of a driver (doc 05 §2.3, D5): create, link or disable the driver's VeeTrax login (Transport driver role)
 * through /api/drivers/:id/login. Only offered while the company has employee transport on.
 */
export function DriverLoginDialog({ driver, onClose }: { driver: Pick<DriverDto, 'id' | 'name' | 'mobile' | 'isActive'> | null; onClose: () => void }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const login = useDriverLogin(driver?.id ?? null);
  const mutation = useDriverLoginMutation(driver?.id ?? '');
  const current = login.data?.userId ? { active: login.data.active, email: login.data.email, mobile: login.data.mobile } : null;
  return (
    <Dialog
      open={!!driver}
      onOpenChange={(o) => {
        if (!o && !mutation.isPending) {
          mutation.reset();
          onClose();
        }
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {t('App login')} · {driver?.name}
          </DialogTitle>
          <DialogDescription>{t('The driver signs in to the VeeTrax app with this login to see their transport duty.')}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          {login.isPending ? (
            <Skeleton className="h-32" />
          ) : login.isError ? (
            <FormError message={errorMessage(login.error)} />
          ) : (
            <AppLoginPanel
              who="driver"
              current={current}
              defaults={{ email: null, mobile: driver?.mobile ?? null }}
              canEdit={can('drivers', 'edit')}
              disabledReason={driver?.isActive ? null : 'Reactivate the driver first.'}
              pending={mutation.isPending}
              error={mutation.error}
              outcome={mutation.data?.outcome ?? null}
              onGrant={(input) => mutation.mutate({ kind: 'grant', input })}
              onRevoke={(mode) => mutation.mutate({ kind: 'revoke', mode })}
            />
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { MobileTrackerStatusDto } from '@veetracer/shared';
import { KeyRoundIcon, MailIcon, SmartphoneIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/features/auth/auth-context';
import { api, errorMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/format';

/**
 * Devices → edit, for a phone running the VeeTrax Tracker app: which phone tracks now, the pending activation code
 * (read it out when SMS isn't set up) and stopping the phone.
 */
export function MobileTrackerSection({ deviceId }: { deviceId: string }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const key = ['mobile-tracker', deviceId];
  const q = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => api.get<MobileTrackerStatusDto>(`/devices/${deviceId}/mobile-tracker`, undefined, signal),
    // A user may be activating right now: show the code as soon as they ask for it.
    refetchInterval: 10_000,
  });
  const revoke = useMutation({
    mutationFn: () => api.post<MobileTrackerStatusDto>(`/devices/${deviceId}/mobile-tracker/revoke`, {}),
    onSuccess: (d) => {
      queryClient.setQueryData(key, d);
      toast.success(t('Phone stopped. It must be activated again to track.'));
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const d = q.data;
  const [email, setEmail] = useState('');
  useEffect(() => setEmail(d?.activationEmail ?? ''), [d?.activationEmail]);
  const saveEmail = useMutation({
    mutationFn: () => api.patch<MobileTrackerStatusDto>(`/devices/${deviceId}/mobile-tracker`, { activationEmail: email.trim() || null }),
    onSuccess: (r) => {
      queryClient.setQueryData(key, r);
      toast.success(r.activationEmail ? t('Activation codes will also be e-mailed to {{email}}.', { email: r.activationEmail }) : t('Extra activation e-mail removed.'));
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const emailDirty = email.trim() !== (d?.activationEmail ?? '');
  const active = d?.sessions.find((s) => s.active) ?? null;

  return (
    <section className="space-y-3 rounded-lg border p-3">
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        <SmartphoneIcon className="size-4" /> {t('Tracker app on the phone')}
      </h3>
      {q.isError && <p className="text-sm text-destructive">{errorMessage(q.error)}</p>}
      {d && (
        <>
          <p className="text-sm text-muted-foreground">
            {t('Install VeeTrax Tracker on the phone and activate it with {{mobile}}. Activating on a new phone stops the old one automatically.', { mobile: d.mobile })}
          </p>
          {d.pendingCode && (
            <div className="flex flex-wrap items-center gap-3 rounded-md bg-muted px-3 py-2">
              <KeyRoundIcon className="size-4 text-muted-foreground" />
              <span className="text-sm">{t('Activation code')}</span>
              <span className="font-mono text-lg font-semibold tracking-widest">{d.pendingCode.code}</span>
              <span className="text-xs text-muted-foreground">
                {d.pendingCode.smsSent
                  ? t('Sent by SMS')
                  : d.pendingCode.emailCount > 0
                    ? t('E-mailed to {{n}} address(es)', { n: d.pendingCode.emailCount })
                    : t('Not sent: read this code to the user')}{' '}
                · {t('valid until {{time}}', { time: formatDateTime(d.pendingCode.expiresAt) })}
              </span>
            </div>
          )}
          {can('devices', 'edit') && (
            <div className="space-y-1.5">
              <label htmlFor="activation-email" className="flex items-center gap-1.5 text-sm font-medium">
                <MailIcon className="size-3.5" /> {t('Send activation code to (e-mail)')}
              </label>
              <div className="flex gap-2">
                <Input id="activation-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="employee@example.com" className="flex-1" />
                <Button type="button" variant="outline" size="sm" className="h-9" disabled={!emailDirty || saveEmail.isPending} onClick={() => saveEmail.mutate()}>
                  {t('Save')}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">{t('Optional, e.g. the employee who uses this phone. Administrators who can edit this device always get the code too.')}</p>
            </div>
          )}
          {active ? (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-sm">
                <Badge variant="success">{t('Tracking')}</Badge> <span className="font-medium">{active.deviceName ?? t('Phone')}</span>
                <span className="text-muted-foreground">
                  {' '}
                  · {t('activated {{time}}', { time: formatDateTime(active.createdAt) })}
                  {active.lastUsedAt ? ` · ${t('last upload {{time}}', { time: formatDateTime(active.lastUsedAt) })}` : ''}
                  {active.appVersion ? ` · v${active.appVersion}` : ''}
                </span>
              </div>
              {can('devices', 'edit') && (
                <Button type="button" variant="outline" size="sm" disabled={revoke.isPending} onClick={() => window.confirm(t('Stop tracking on this phone? It must be activated again.')) && revoke.mutate()}>
                  {t('Stop this phone')}
                </Button>
              )}
            </div>
          ) : (
            <p className="text-sm">
              <Badge variant="muted">{t('Not activated')}</Badge> {t('No phone is tracking for this number yet.')}
            </p>
          )}
        </>
      )}
    </section>
  );
}

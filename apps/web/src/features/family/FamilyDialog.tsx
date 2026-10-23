import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { FamilyMembersDto } from '@veetracer/shared';
import { CheckCircle2Icon, SmartphoneIcon, UserPlusIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { api, errorMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/format';

const KEY = ['family-members'];
const dateOnly = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

/**
 * Personal / family accounts: the account's phones, and adding a family member's phone. The member gets an OTP by SMS
 * (their consent) and reads it out; then they install VeeTrax Tracker and activate with their number.
 */
export function FamilyDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [step, setStep] = useState<'list' | 'details' | 'code'>('list');
  const [name, setName] = useState('');
  const [mobile, setMobile] = useState('');
  const [code, setCode] = useState('');
  const members = useQuery({ queryKey: KEY, queryFn: ({ signal }) => api.get<FamilyMembersDto>('/family/members', undefined, signal), enabled: open });
  const reset = () => {
    setStep('list');
    setName('');
    setMobile('');
    setCode('');
  };
  const request = useMutation({
    mutationFn: () => api.post<{ ok: true; mobile: string; smsSent: boolean }>('/family/members/request', { name: name.trim(), mobile }),
    onSuccess: (r) => {
      setStep('code');
      if (!r.smsSent) toast.warning(t('The SMS could not be sent right now. Try again in a minute.'));
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const verify = useMutation({
    mutationFn: () => api.post<FamilyMembersDto>('/family/members/verify', { mobile, code }),
    onSuccess: (d) => {
      queryClient.setQueryData(KEY, d);
      void queryClient.invalidateQueries({ queryKey: ['/devices'] });
      toast.success(t('{{name}} added. Ask them to install VeeTrax Tracker and activate with their number.', { name: name.trim() }));
      reset();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const d = members.data;

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(o) : (reset(), onOpenChange(false)))}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('Family members')}</DialogTitle>
          <DialogDescription>
            {d ? t('Free tracking for {{used}} of {{max}} phones used.', { used: d.trialPhones.used, max: d.trialPhones.max }) : t('Phones tracked in your account.')}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          {members.isPending && <Spinner />}
          {members.isError && <p className="text-sm text-destructive">{errorMessage(members.error)}</p>}
          {step === 'list' && d && (
            <>
              <ul className="divide-y rounded-md border">
                {d.members.map((m) => (
                  <li key={m.deviceId} className="flex items-center gap-3 px-3 py-2 text-sm">
                    <SmartphoneIcon className="size-4 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{m.name}</span>
                      <span className="block text-xs text-muted-foreground">
                        {m.mobile}
                        {m.trialEndsAt ? ` · ${t('free until {{date}}', { date: dateOnly(m.trialEndsAt) })}` : m.licenceEndsAt ? ` · ${t('licence until {{date}}', { date: dateOnly(m.licenceEndsAt) })}` : ` · ${t('needs a licence')}`}
                        {m.lastSeenAt ? ` · ${t('seen {{time}}', { time: formatDateTime(m.lastSeenAt) })}` : ''}
                      </span>
                    </span>
                    {m.activated ? <Badge variant="success">{t('Tracking')}</Badge> : <Badge variant="muted">{t('Not activated')}</Badge>}
                  </li>
                ))}
                {d.members.length === 0 && <li className="px-3 py-4 text-center text-sm text-muted-foreground">{t('No phones yet.')}</li>}
              </ul>
              <Button onClick={() => setStep('details')}>
                <UserPlusIcon /> {t('Add family member')}
              </Button>
            </>
          )}
          {step === 'details' && (
            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                request.mutate();
              }}
            >
              <p className="text-sm text-muted-foreground">{t('We send a 6-digit code by SMS to their phone. Ask them for it: that is their consent to be tracked.')}</p>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('Name, e.g. Amma')} aria-label={t('Name')} required maxLength={80} />
              <Input value={mobile} onChange={(e) => setMobile(e.target.value)} placeholder={t('Their mobile number')} aria-label={t('Mobile number')} type="tel" required maxLength={16} />
              <div className="flex gap-2">
                <Button type="button" variant="outline" onClick={reset}>
                  {t('Cancel')}
                </Button>
                <Button type="submit" disabled={request.isPending || !name.trim() || !mobile.trim()}>
                  {request.isPending && <Spinner />} {t('Send code to their phone')}
                </Button>
              </div>
            </form>
          )}
          {step === 'code' && (
            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                verify.mutate();
              }}
            >
              <p className="text-sm">{t('Enter the 6-digit code {{name}} received on {{mobile}}.', { name: name.trim(), mobile })}</p>
              <Input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="••••••" aria-label={t('Code')} inputMode="numeric" className="text-center text-lg tracking-[0.5em]" />
              <div className="flex gap-2">
                <Button type="button" variant="outline" disabled={request.isPending} onClick={() => request.mutate()}>
                  {t('Send again')}
                </Button>
                <Button type="submit" disabled={verify.isPending || code.length !== 6}>
                  {verify.isPending ? <Spinner /> : <CheckCircle2Icon />} {t('Add')}
                </Button>
              </div>
            </form>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

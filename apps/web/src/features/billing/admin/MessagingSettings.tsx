import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { MessagingSettingsDto, MessagingSettingsInput } from '@veetracer/shared';
import { CheckCircle2Icon, CopyIcon, LinkIcon, SendIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { api, errorMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/format';

/**
 * Platform Settings → Messaging (Super Admin): which channels VeeTrax offers (customers only see switched-on channels
 * in their alert settings; WhatsApp is not shown to customers yet), and the Arattai Business set-up for verification
 * codes and alerts: ids, templates, API client, Connect (one-time approval) and test messages.
 */
export function MessagingSettings() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const q = useQuery({ queryKey: ['platform-messaging'], queryFn: ({ signal }) => api.get<MessagingSettingsDto>('/platform/messaging', undefined, signal) });
  const [f, setF] = useState<MessagingSettingsInput | null>(null);
  const [secret, setSecret] = useState('');
  const [mobile, setMobile] = useState('');
  useEffect(() => {
    if (q.data && !f) setF(q.data);
  }, [q.data, f]);
  // Back from "Connect Arattai".
  useEffect(() => {
    const r = params.get('arattai');
    if (!r) return;
    if (r === 'connected') toast.success(t('Arattai connected'));
    else toast.error(t('Arattai not connected: {{why}}', { why: r.replace(/^error:/, '') }));
    params.delete('arattai');
    setParams(params, { replace: true });
    void qc.invalidateQueries({ queryKey: ['platform-messaging'] });
  }, [params, setParams, qc, t]);

  const save = useMutation({
    mutationFn: () => api.put<MessagingSettingsDto>('/platform/messaging', { ...f, arattaiClientSecret: secret || undefined }),
    onSuccess: (d) => {
      qc.setQueryData(['platform-messaging'], d);
      void qc.invalidateQueries({ queryKey: ['messaging-channels'] });
      setF(d);
      setSecret('');
      toast.success(t('Saved'));
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const connect = useMutation({
    mutationFn: () => api.post<{ url: string }>('/platform/messaging/arattai/connect'),
    onSuccess: (r) => {
      window.location.href = r.url;
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const test = useMutation({
    mutationFn: (kind: 'otp' | 'alert') => api.post<{ sent: boolean; error: string | null }>('/platform/messaging/arattai/test', { mobile, kind }),
    onSuccess: (r) => (r.sent ? toast.success(t('Sent. Check Arattai on that phone.')) : toast.error(r.error ?? t('Not sent'))),
    onError: (e) => toast.error(errorMessage(e)),
  });

  const d = q.data;
  if (!d || !f) return <Skeleton className="h-96" />;
  const set = (p: Partial<MessagingSettingsInput>) => setF((x) => (x ? { ...x, ...p } : x));
  const dirty = JSON.stringify({ ...d, ...f }) !== JSON.stringify(d) || !!secret;
  const text = (k: keyof MessagingSettingsInput, label: string, hint?: string) => (
    <Field label={t(label)} htmlFor={`ms-${k}`} hint={hint && t(hint)}>
      <Input id={`ms-${k}`} value={String(f[k] ?? '')} onChange={(e) => set({ [k]: e.target.value } as Partial<MessagingSettingsInput>)} />
    </Field>
  );
  const channel = (k: 'smsEnabled' | 'emailEnabled' | 'arattaiEnabled' | 'whatsappEnabled', label: string, hint: string) => (
    <div className="flex items-start justify-between gap-4 rounded-lg border p-3">
      <div>
        <p className="text-sm font-semibold">{t(label)}</p>
        <p className="text-xs text-muted-foreground">{t(hint)}</p>
      </div>
      <Switch checked={f[k]} onCheckedChange={(v) => set({ [k]: v } as Partial<MessagingSettingsInput>)} aria-label={t(label)} />
    </div>
  );

  return (
    <div className="space-y-4">
      <Card className="gap-3 p-4">
        <div>
          <h3 className="text-[15px] font-bold">{t('Channels for alerts')}</h3>
          <p className="text-sm text-muted-foreground">{t('Customers can choose only the channels switched on here. Push and in-app are always available, and push is on by default.')}</p>
        </div>
        <div className="grid gap-2 md:grid-cols-2">
          {channel('emailEnabled', 'Email', 'Alert e-mails to users and contacts.')}
          {channel('smsEnabled', 'SMS', 'Alert SMS (needs the SMS provider and approved DLT templates).')}
          {channel('arattaiEnabled', 'Arattai', 'Alerts and verification codes by Arattai (set up below).')}
          {channel('whatsappEnabled', 'WhatsApp', 'Kept for later: not shown to customers yet.')}
        </div>
        <p className="text-xs text-muted-foreground">{t('Verification codes (sign-in, Tracker activation, family consent) always go by SMS and e-mail where available, and also by Arattai when it is switched on.')}</p>
      </Card>

      <Card className="gap-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-[15px] font-bold">{t('Arattai Business')}</h3>
          {d.arattaiConnected ? (
            <Badge variant="success">
              <CheckCircle2Icon /> {t('Connected {{when}}', { when: d.arattaiConnectedAt ? formatDateTime(d.arattaiConnectedAt) : '' })}
            </Badge>
          ) : (
            <Badge variant="warning">{t('Not connected')}</Badge>
          )}
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          {text('arattaiCompanyId', 'Company ID', 'Filled in by Connect Arattai (or type it).')}
          {text('arattaiBusinessNumberId', 'Business number ID', 'Filled in by Connect Arattai when there is one business number (not the phone number itself).')}
          {text('arattaiOtpTemplateId', 'Verification code template ID', 'Authentication template with {{otp}} and {{validity_minutes}} (Tools → Templates).')}
          {text('arattaiAlertTemplateId', 'Alert template ID', 'Transactional template with {{alert}}, {{vehicle}}, {{time}} and {{details}}.')}
          {text('arattaiLanguage', 'Template language', 'Usually en.')}
          {text('arattaiClientId', 'API client ID', 'From api-console.arattai.in.')}
          <Field label={t('API client secret')} htmlFor="ms-secret" hint={d.arattaiClientSecretSet ? t('Saved. Type a new one only to change it.') : t('From api-console.arattai.in.')}>
            <Input id="ms-secret" type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={d.arattaiClientSecretSet ? '••••••••' : ''} />
          </Field>
          <Field label={t('Redirect URI for the API client')} htmlFor="ms-redirect" hint={t('Add this exact address to the client in api-console.arattai.in.')}>
            <div className="flex gap-1.5">
              <Input id="ms-redirect" readOnly value={d.arattaiRedirectUri} className="font-mono text-xs" />
              <Button variant="outline" size="icon" aria-label={t('Copy')} onClick={() => void navigator.clipboard.writeText(d.arattaiRedirectUri).then(() => toast.success(t('Copied')))}>
                <CopyIcon />
              </Button>
            </div>
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" disabled={dirty || connect.isPending || !d.arattaiClientId || !d.arattaiClientSecretSet} onClick={() => connect.mutate()} title={dirty ? t('Save first') : undefined}>
            <LinkIcon /> {d.arattaiConnected ? t('Connect again') : t('Connect Arattai')}
          </Button>
          <span className="text-xs text-muted-foreground">{t('Opens Arattai to approve once; VeeTrax then keeps itself signed in.')}</span>
        </div>
        <div className="flex flex-wrap items-end gap-2 border-t pt-3">
          <Field label={t('Send a test to')} htmlFor="ms-test">
            <Input id="ms-test" className="w-48" inputMode="tel" value={mobile} onChange={(e) => setMobile(e.target.value)} placeholder="98765 43210" />
          </Field>
          <Button variant="outline" disabled={!mobile || test.isPending} onClick={() => test.mutate('otp')}>
            <SendIcon /> {t('Test code')}
          </Button>
          <Button variant="outline" disabled={!mobile || test.isPending} onClick={() => test.mutate('alert')}>
            <SendIcon /> {t('Test alert')}
          </Button>
          {test.isPending && <Spinner />}
        </div>
        <p className="text-xs text-muted-foreground">
          {d.arattaiLastSentAt && t('Last sent {{when}}.', { when: formatDateTime(d.arattaiLastSentAt) })} {d.arattaiLastError && <span className="text-destructive">{t('Last problem: {{err}}', { err: d.arattaiLastError })}</span>}
        </p>
      </Card>

      <div className="flex justify-end gap-2">
        <Button variant="outline" disabled={!dirty || save.isPending} onClick={() => (setF(d), setSecret(''))}>
          {t('Undo changes')}
        </Button>
        <Button disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
          {save.isPending && <Spinner />} {t('Save')}
        </Button>
      </div>
    </div>
  );
}

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { WEBHOOK_EVENT_DEFS, type WebhookEndpointDto, type WebhookEvent } from '@veetracer/shared';
import { TriangleAlertIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { FormError } from '@/components/form-error';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { api, errorMessage } from '@/lib/api';
import { SecretBox, WEBHOOKS_QUERY } from './shared';

/** Add (record = null) or edit a webhook endpoint. A new endpoint's signing secret is shown once afterwards. */
export function WebhookDialog({ open, onOpenChange, record }: { open: boolean; onOpenChange: (open: boolean) => void; record: WebhookEndpointDto | null }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<WebhookEvent[]>(['alert.created']);
  const [secret, setSecret] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(record?.name ?? '');
    setUrl(record?.url ?? 'https://');
    setEvents(record?.events ?? ['alert.created']);
    setSecret(null);
  }, [open, record]);

  const save = useMutation({
    mutationFn: () => {
      const body = { name: name.trim(), url: url.trim(), events };
      return record
        ? api.patch<WebhookEndpointDto>(`/developer/webhooks/${record.id}`, body).then(() => null)
        : api.post<{ endpoint: WebhookEndpointDto; secret: string }>('/developer/webhooks', body).then((r) => r.secret);
    },
    onSuccess: (newSecret) => {
      void queryClient.invalidateQueries({ queryKey: WEBHOOKS_QUERY });
      if (newSecret) setSecret(newSecret);
      else {
        toast.success(t('Webhook saved'));
        onOpenChange(false);
      }
    },
  });

  const toggle = (e: WebhookEvent, on: boolean) => setEvents((s) => (on ? [...s, e] : s.filter((x) => x !== e)));
  const close = (o: boolean) => {
    if (save.isPending) return;
    onOpenChange(o);
    if (!o) save.reset();
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-xl">
        {secret ? (
          <>
            <DialogHeader>
              <DialogTitle>{t('Webhook added')}</DialogTitle>
              <DialogDescription>{t('Use this signing secret to verify the X-VeeTrax-Signature header. You can view or rotate it later.')}</DialogDescription>
            </DialogHeader>
            <DialogBody>
              <SecretBox value={secret} />
            </DialogBody>
            <DialogFooter>
              <Button onClick={() => close(false)}>{t('Done')}</Button>
            </DialogFooter>
          </>
        ) : (
          <form
            className="contents"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate();
            }}
          >
            <DialogHeader>
              <DialogTitle>{record ? t('Edit webhook') : t('Add webhook')}</DialogTitle>
              <DialogDescription>{t('VeeTrax POSTs a signed JSON event to this URL when something happens.')}</DialogDescription>
            </DialogHeader>
            <DialogBody className="grid gap-4">
              <Field label={t('Name')} htmlFor="wh-name" required>
                <Input id="wh-name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder={t('e.g. Dispatch system')} />
              </Field>
              <Field label={t('URL')} htmlFor="wh-url" required hint={t('Must be https:// and reachable from the internet. Redirects are not followed.')}>
                <Input id="wh-url" type="url" value={url} maxLength={2000} onChange={(e) => setUrl(e.target.value)} placeholder="https://erp.example.com/veetrax/webhook" />
              </Field>
              <Field label={t('Events')} required>
                <div className="grid gap-2">
                  {WEBHOOK_EVENT_DEFS.map((d) => (
                    <label key={d.event} className="flex cursor-pointer items-start gap-2.5 rounded-md p-1 hover:bg-accent/50">
                      <Checkbox className="mt-0.5" checked={events.includes(d.event)} onCheckedChange={(v) => toggle(d.event, v === true)} />
                      <span className="grid gap-0.5">
                        <span className="text-sm font-medium">
                          {t(d.label)} <code className="ml-1 text-xs text-muted-foreground">{d.event}</code>
                        </span>
                        <span className="text-xs text-muted-foreground">{t(d.description)}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </Field>
              {record && !record.isActive && record.disabledReason && (
                <p className="flex items-start gap-2 text-sm text-warning">
                  <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" />
                  {record.disabledReason}
                </p>
              )}
              <FormError message={save.error ? errorMessage(save.error) : null} />
            </DialogBody>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => close(false)}>
                {t('Cancel')}
              </Button>
              <Button type="submit" disabled={!name.trim() || url.trim().length < 9 || !events.length || save.isPending}>
                {save.isPending && <Spinner />}
                {record ? t('Save changes') : t('Add webhook')}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { WebhookEndpointDto } from '@veetracer/shared';
import { EyeIcon, ListIcon, PencilIcon, PlusIcon, RefreshCcwIcon, SendIcon, Trash2Icon, TriangleAlertIcon, WebhookIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { FormError } from '@/components/form-error';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { useAuth } from '@/features/auth/auth-context';
import { DateCell } from '@/features/masters/cells';
import { api, errorMessage } from '@/lib/api';
import { DeliveryLog } from './DeliveryLog';
import { deliveriesQuery, SecretBox, WEBHOOKS_QUERY } from './shared';
import { WebhookDialog } from './WebhookDialog';

export function WebhooksTab() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const editable = can('api', 'edit');
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<WebhookEndpointDto | null | 'new'>(null);
  const [logFor, setLogFor] = useState<WebhookEndpointDto | null>(null);
  const [deleting, setDeleting] = useState<WebhookEndpointDto | null>(null);
  const [rotating, setRotating] = useState<WebhookEndpointDto | null>(null);
  const [secret, setSecret] = useState<{ name: string; value: string } | null>(null);
  const hooks = useQuery({ queryKey: WEBHOOKS_QUERY, queryFn: ({ signal }) => api.get<WebhookEndpointDto[]>('/developer/webhooks', undefined, signal) });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: WEBHOOKS_QUERY });
  const onError = (err: unknown) => toast.error(errorMessage(err));

  const toggle = useMutation({
    mutationFn: (e: WebhookEndpointDto) => api.patch(`/developer/webhooks/${e.id}`, { isActive: !e.isActive }),
    onSuccess: refresh,
    onError,
  });
  const test = useMutation({
    mutationFn: (e: WebhookEndpointDto) => api.post(`/developer/webhooks/${e.id}/test`, {}),
    onSuccess: (_r, e) => {
      toast.success(t('Test event queued; check the delivery log in a few seconds'));
      void queryClient.invalidateQueries({ queryKey: deliveriesQuery(e.id) });
    },
    onError,
  });
  const reveal = useMutation({
    mutationFn: (e: WebhookEndpointDto) => api.get<{ secret: string }>(`/developer/webhooks/${e.id}/secret`).then((r) => ({ name: e.name, value: r.secret })),
    onSuccess: setSecret,
    onError,
  });
  const rotate = useMutation({
    mutationFn: (e: WebhookEndpointDto) => api.post<{ secret: string }>(`/developer/webhooks/${e.id}/rotate-secret`).then((r) => ({ name: e.name, value: r.secret })),
    onSuccess: (s) => {
      setRotating(null);
      setSecret(s);
      refresh();
    },
    onError,
  });
  const remove = useMutation({
    mutationFn: (e: WebhookEndpointDto) => api.delete(`/developer/webhooks/${e.id}`),
    onSuccess: () => {
      setDeleting(null);
      toast.success(t('Webhook deleted'));
      refresh();
    },
    onError,
  });

  const rows = hooks.data ?? [];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="max-w-2xl text-sm text-muted-foreground">
          {t('Webhooks push events to your system as they happen, signed with HMAC-SHA256. Endpoints that fail 50 times in a row are switched off automatically.')}
        </p>
        {can('api', 'create') && (
          <Button onClick={() => setEditing('new')}>
            <PlusIcon />
            {t('Add webhook')}
          </Button>
        )}
      </div>
      {hooks.isError && <FormError message={errorMessage(hooks.error)} />}
      {hooks.isPending ? (
        <Skeleton className="h-28 w-full" />
      ) : !rows.length ? (
        <Card>
          <EmptyState icon={WebhookIcon} title={t('No webhooks yet')} description={t('Add an endpoint to receive alerts, trips and status changes in real time.')} />
        </Card>
      ) : (
        <div className="grid gap-3">
          {rows.map((e) => (
            <Card key={e.id} className="space-y-3 p-4">
              <div className="flex flex-wrap items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{e.name}</span>
                    <Badge variant={e.isActive ? 'success' : e.disabledAt ? 'destructive' : 'muted'}>
                      {e.isActive ? t('Active') : e.disabledAt ? t('Disabled after failures') : t('Off')}
                    </Badge>
                    {e.consecutiveFailures > 0 && e.isActive && <Badge variant="warning">{t('{{count}} failures in a row', { count: e.consecutiveFailures })}</Badge>}
                  </div>
                  <code className="mt-1 block truncate font-mono text-xs text-muted-foreground">{e.url}</code>
                </div>
                {editable && <Switch checked={e.isActive} disabled={toggle.isPending} onCheckedChange={() => toggle.mutate(e)} aria-label={t('Enabled')} />}
              </div>
              {!e.isActive && e.disabledReason && (
                <p className="flex items-start gap-2 text-xs text-destructive">
                  <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
                  {e.disabledReason}
                </p>
              )}
              <div className="flex flex-wrap gap-1">
                {e.events.map((ev) => (
                  <Badge key={ev} variant="secondary" className="font-mono">
                    {ev}
                  </Badge>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span>
                  {t('Last delivery')}: <DateCell value={e.lastDeliveryAt} relative />
                  {e.lastStatusCode !== null && ` · HTTP ${e.lastStatusCode}`}
                </span>
                <span>· {t('Secret')}: <code className="font-mono">{e.secretPrefix}…</code></span>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" onClick={() => setLogFor(e)}>
                  <ListIcon />
                  {t('Delivery log')}
                </Button>
                {editable && (
                  <>
                    <Button variant="outline" size="sm" disabled={test.isPending} onClick={() => test.mutate(e)}>
                      <SendIcon />
                      {t('Send test event')}
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => setEditing(e)}>
                      <PencilIcon />
                      {t('Edit')}
                    </Button>
                    <Button variant="ghost" size="sm" disabled={reveal.isPending} onClick={() => reveal.mutate(e)}>
                      <EyeIcon />
                      {t('Show secret')}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setRotating(e)}>
                      <RefreshCcwIcon />
                      {t('Rotate secret')}
                    </Button>
                  </>
                )}
                {can('api', 'delete') && (
                  <Button variant="ghost" size="sm" className="text-destructive" onClick={() => setDeleting(e)}>
                    <Trash2Icon />
                    {t('Delete')}
                  </Button>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}
      <WebhookDialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)} record={editing === 'new' ? null : editing} />
      <DeliveryLog endpoint={logFor} onOpenChange={(o) => !o && setLogFor(null)} />
      <Dialog open={!!secret} onOpenChange={(o) => !o && setSecret(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('Signing secret')}</DialogTitle>
            <DialogDescription>{secret?.name}</DialogDescription>
          </DialogHeader>
          <DialogBody>{secret && <SecretBox value={secret.value} />}</DialogBody>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={!!rotating}
        onOpenChange={(o) => !o && setRotating(null)}
        title={t('Rotate signing secret?')}
        description={t('The old secret stops working at once; update your receiver with the new one.')}
        confirmLabel={t('Rotate secret')}
        pending={rotate.isPending}
        onConfirm={() => rotating && rotate.mutate(rotating)}
      />
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={t('Delete webhook?')}
        description={t('“{{name}}” and its delivery log will be deleted.', { name: deleting?.name ?? '' })}
        confirmLabel={t('Delete')}
        destructive
        pending={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting)}
      />
    </div>
  );
}

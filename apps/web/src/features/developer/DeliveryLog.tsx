import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { WebhookDeliveryDto, WebhookDeliveryStatus, WebhookEndpointDto } from '@veetracer/shared';
import { InboxIcon, RefreshCwIcon, RotateCcwIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { FormError } from '@/components/form-error';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/features/auth/auth-context';
import { DateCell } from '@/features/masters/cells';
import { api, errorMessage } from '@/lib/api';
import { deliveriesQuery } from './shared';

const STATUS_VARIANT: Record<WebhookDeliveryStatus, 'success' | 'warning' | 'destructive' | 'muted'> = {
  SUCCEEDED: 'success',
  RETRYING: 'warning',
  FAILED: 'destructive',
  PENDING: 'muted',
};
const STATUS_LABELS: Record<WebhookDeliveryStatus, string> = { SUCCEEDED: 'Delivered', RETRYING: 'Retrying', FAILED: 'Failed', PENDING: 'Pending' };

function DeliveryRow({ d, canRedeliver, onRedeliver, pending }: { d: WebhookDeliveryDto; canRedeliver: boolean; onRedeliver: () => void; pending: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <li className="rounded-lg border p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={STATUS_VARIANT[d.status]}>{t(STATUS_LABELS[d.status])}</Badge>
        <code className="font-mono text-xs">{d.event}</code>
        {d.isTest && <Badge variant="outline">{t('Test')}</Badge>}
        {d.isRedelivery && <Badge variant="outline">{t('Redelivery')}</Badge>}
        <span className="ml-auto text-xs text-muted-foreground">
          <DateCell value={d.createdAt} relative />
        </span>
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>
          {t('Attempt')} {d.attempt}
        </span>
        {d.responseStatus !== null && <span>HTTP {d.responseStatus}</span>}
        {d.durationMs !== null && <span>{d.durationMs} ms</span>}
        {d.status === 'RETRYING' && d.nextAttemptAt && (
          <span>
            {t('Next try')} <DateCell value={d.nextAttemptAt} relative />
          </span>
        )}
      </div>
      {d.error && <p className="mt-1.5 text-xs break-words text-destructive">{d.error}</p>}
      <div className="mt-2 flex flex-wrap gap-2">
        {d.responseBody && (
          <Button variant="ghost" size="sm" onClick={() => setOpen((o) => !o)}>
            {open ? t('Hide response') : t('Show response')}
          </Button>
        )}
        {canRedeliver && d.status !== 'PENDING' && (
          <Button variant="outline" size="sm" disabled={pending} onClick={onRedeliver}>
            <RotateCcwIcon />
            {t('Redeliver')}
          </Button>
        )}
      </div>
      {open && d.responseBody && <pre className="mt-2 max-h-40 overflow-auto rounded bg-muted/50 p-2 font-mono text-xs whitespace-pre-wrap">{d.responseBody}</pre>}
      <p className="mt-1 font-mono text-[11px] text-muted-foreground">{d.eventId}</p>
    </li>
  );
}

/** Last deliveries of one endpoint (kept 30 days), newest first. */
export function DeliveryLog({ endpoint, onOpenChange }: { endpoint: WebhookEndpointDto | null; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const id = endpoint?.id ?? '';
  const log = useQuery({
    queryKey: deliveriesQuery(id),
    queryFn: ({ signal }) => api.get<{ items: WebhookDeliveryDto[]; nextBefore: string | null }>(`/developer/webhooks/${id}/deliveries`, undefined, signal),
    enabled: !!endpoint,
    refetchInterval: 10_000,
  });
  const redeliver = useMutation({
    mutationFn: (deliveryId: string) => api.post<WebhookDeliveryDto>(`/developer/webhook-deliveries/${deliveryId}/redeliver`),
    onSuccess: () => {
      toast.success(t('Redelivery queued'));
      void queryClient.invalidateQueries({ queryKey: deliveriesQuery(id) });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const items = log.data?.items ?? [];

  return (
    <Sheet open={!!endpoint} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>{t('Delivery log')}</SheetTitle>
          <SheetDescription>
            {endpoint?.name} · {t('Kept for 30 days. Failed deliveries are retried after 1 min, 5 min, 30 min, 2 h and 6 h.')}
          </SheetDescription>
        </SheetHeader>
        <div className="flex justify-end px-4">
          <Button variant="ghost" size="sm" onClick={() => void log.refetch()} disabled={log.isFetching}>
            <RefreshCwIcon className={log.isFetching ? 'animate-spin' : undefined} />
            {t('Refresh')}
          </Button>
        </div>
        <div className="px-4 pb-6">
          {log.isError && <FormError message={errorMessage(log.error)} />}
          {log.isPending ? (
            <div className="space-y-2">
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-20 w-full" />
            </div>
          ) : !items.length ? (
            <EmptyState icon={InboxIcon} title={t('No deliveries yet')} description={t('Use “Send test event” to try the endpoint.')} />
          ) : (
            <ul className="space-y-2">
              {items.map((d) => (
                <DeliveryRow key={d.id} d={d} canRedeliver={can('api', 'edit')} pending={redeliver.isPending} onRedeliver={() => redeliver.mutate(d.id)} />
              ))}
            </ul>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

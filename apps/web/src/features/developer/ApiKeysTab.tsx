import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ApiKeyDto } from '@veetracer/shared';
import { BanIcon, KeyRoundIcon, PlusIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { FormError } from '@/components/form-error';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useAuth } from '@/features/auth/auth-context';
import { DateCell } from '@/features/masters/cells';
import { api, errorMessage } from '@/lib/api';
import { formatNumber } from '@/lib/format';
import { CreateKeyDialog } from './CreateKeyDialog';
import { KEYS_QUERY } from './shared';

function keyState(k: ApiKeyDto): 'revoked' | 'expired' | 'active' {
  if (k.revokedAt) return 'revoked';
  if (k.expiresAt && Date.parse(k.expiresAt) <= Date.now()) return 'expired';
  return 'active';
}

export function ApiKeysTab() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<ApiKeyDto | null>(null);
  const keys = useQuery({ queryKey: KEYS_QUERY, queryFn: ({ signal }) => api.get<ApiKeyDto[]>('/developer/api-keys', undefined, signal) });

  const revoke = useMutation({
    mutationFn: (id: string) => api.delete<ApiKeyDto>(`/developer/api-keys/${id}`),
    onSuccess: () => {
      toast.success(t('API key revoked'));
      setRevoking(null);
      void queryClient.invalidateQueries({ queryKey: KEYS_QUERY });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const rows = keys.data ?? [];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="max-w-2xl text-sm text-muted-foreground">
          {t('Each key reads the data of the whole company (or one branch), limited to its scopes. Requests are limited per minute and per day.')}
        </p>
        {can('api', 'create') && (
          <Button onClick={() => setCreating(true)}>
            <PlusIcon />
            {t('Create API key')}
          </Button>
        )}
      </div>
      {keys.isError && <FormError message={errorMessage(keys.error)} />}
      <Card className="overflow-hidden p-0">
        {keys.isPending ? (
          <div className="space-y-2 p-4">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : !rows.length ? (
          <EmptyState icon={KeyRoundIcon} title={t('No API keys yet')} description={t('Create a key to connect your own software to VeeTrax.')} />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('Name')}</TableHead>
                <TableHead>{t('Key')}</TableHead>
                <TableHead>{t('Scopes')}</TableHead>
                <TableHead>{t('Last used')}</TableHead>
                <TableHead className="text-right">{t('Requests')}</TableHead>
                <TableHead>{t('Status')}</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((k) => {
                const state = keyState(k);
                return (
                  <TableRow key={k.id} className={state === 'active' ? undefined : 'opacity-60'}>
                    <TableCell>
                      <div className="font-medium">{k.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {k.branchName ?? t('Whole company')}
                        {k.ipAllowList.length > 0 && ` · ${t('{{count}} IP rules', { count: k.ipAllowList.length })}`}
                        {k.expiresAt && ` · ${t('expires')} ${new Date(k.expiresAt).toLocaleDateString()}`}
                      </div>
                    </TableCell>
                    <TableCell>
                      <code className="font-mono text-xs">{k.prefix}…</code>
                    </TableCell>
                    <TableCell>
                      <div className="flex max-w-xs flex-wrap gap-1">
                        {k.scopes.map((s) => (
                          <Badge key={s} variant="secondary" className="font-mono">
                            {s}
                          </Badge>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell>
                      <DateCell value={k.lastUsedAt} relative />
                      {k.lastUsedIp && <div className="text-xs text-muted-foreground">{k.lastUsedIp}</div>}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{formatNumber(k.requestCount)}</TableCell>
                    <TableCell>
                      <Badge variant={state === 'active' ? 'success' : state === 'expired' ? 'warning' : 'muted'}>
                        {state === 'active' ? t('Active') : state === 'expired' ? t('Expired') : t('Revoked')}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      {state !== 'revoked' && can('api', 'delete') && (
                        <Button variant="ghost" size="sm" className="text-destructive" onClick={() => setRevoking(k)}>
                          <BanIcon />
                          {t('Revoke')}
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Card>
      <CreateKeyDialog open={creating} onOpenChange={setCreating} />
      <ConfirmDialog
        open={!!revoking}
        onOpenChange={(o) => !o && setRevoking(null)}
        title={t('Revoke API key?')}
        description={t('Systems using “{{name}}” will stop working immediately. This cannot be undone.', { name: revoking?.name ?? '' })}
        confirmLabel={t('Revoke')}
        destructive
        pending={revoke.isPending}
        onConfirm={() => revoking && revoke.mutate(revoking.id)}
      />
    </div>
  );
}

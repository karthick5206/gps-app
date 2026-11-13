import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { RoutingPlatformSwitchDto, RoutingReadinessDto } from '@veetracer/shared';
import { CheckCircle2Icon, RefreshCwIcon, XCircleIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { useAuth } from '@/features/auth/auth-context';
import { Panel } from '@/features/dashboard/refresh/kit';
import { api, ApiError, errorMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { missingItems, readinessLabel, refusedReadiness } from './routing-switch-format';

export const routingSwitchKey = ['admin-routing-switch'] as const;

export function useRoutingSwitch(enabled = true) {
  return useQuery({
    queryKey: routingSwitchKey,
    enabled,
    queryFn: ({ signal }) => api.get<RoutingPlatformSwitchDto>('/admin/routing', undefined, signal),
    refetchInterval: 30_000,
  });
}

/** The readiness checklist (Platform Settings and System Health). */
export function ReadinessChecklist({ readiness }: { readiness: RoutingReadinessDto }) {
  const { t } = useTranslation();
  return (
    <ul className="space-y-2 text-sm" aria-label={t('Readiness')}>
      {readiness.checks.map((c) => (
        <li key={c.key} className="flex items-start gap-2">
          {c.ok ? <CheckCircle2Icon className="mt-0.5 size-4 shrink-0 text-success-fg" aria-hidden /> : <XCircleIcon className="mt-0.5 size-4 shrink-0 text-destructive-fg" aria-hidden />}
          <div className="min-w-0">
            <p className="font-medium">
              <span className="sr-only">{c.ok ? t('Ready') : t('Not ready')}: </span>
              {t(readinessLabel(c.key))}
            </p>
            {c.detail && <p className="break-words text-xs text-muted-foreground">{c.detail}</p>}
          </div>
        </li>
      ))}
    </ul>
  );
}

/**
 * Platform Settings → Route planning (Super Admin): the platform switch "Automatic route planning" with its readiness
 * checklist. Switching ON is refused by the API unless every check passes (409 ROUTING_NOT_READY with the checklist,
 * shown here); OFF always works. Every change is audited by the API.
 */
export function RoutingSwitchPanel() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const qc = useQueryClient();
  const q = useRoutingSwitch();
  const [refused, setRefused] = useState<RoutingReadinessDto | null>(null);
  const editable = can('sa_platform_settings', 'edit');
  const refresh = useMutation({
    mutationFn: () => api.get<RoutingPlatformSwitchDto>('/admin/routing', { refresh: '1' }),
    onSuccess: (row) => {
      setRefused(null);
      qc.setQueryData(routingSwitchKey, row);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const set = useMutation({
    mutationFn: (enabled: boolean) => api.put<RoutingPlatformSwitchDto>('/admin/routing', { enabled }),
    onSuccess: (row) => {
      setRefused(null);
      qc.setQueryData(routingSwitchKey, row);
      void qc.invalidateQueries({ queryKey: ['routing-capabilities'] });
      toast.success(row.enabled ? t('Automatic route planning switched on') : t('Automatic route planning switched off. Optimisations already running finish; queued ones are cancelled and their plans stay editable.'));
    },
    onError: (e) => {
      const r = e instanceof ApiError ? refusedReadiness(e.body) : null;
      if (r) {
        setRefused(r);
        toast.error(t('Cannot switch on yet: {{items}}', { items: missingItems(r).map((k) => t(readinessLabel(k))).join(', ') }));
      } else toast.error(errorMessage(e));
    },
  });
  const data = q.data;
  const readiness = refused ?? data?.readiness ?? null;
  return (
    <Panel
      title={t('Automatic route planning')}
      subtitle={t('Off by default. When on, companies that switched it on in their Transport settings can optimise routes automatically. It can only be switched on when every check below passes.')}
      id="routing-platform-switch"
      action={
        data && (
          <Badge variant={data.active ? 'default' : 'outline'}>{data.envMode === 'off' ? t('Emergency switch on the server: off') : data.enabled ? t('Switched on') : t('Installed, switched off')}</Badge>
        )
      }
    >
      {q.isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : q.isError ? (
        <p role="alert" className="text-sm text-destructive-fg">
          {errorMessage(q.error)}
        </p>
      ) : data ? (
        <div className="space-y-4">
          <div className="flex items-start gap-3 text-sm">
            <Switch
              id="routing-platform-on"
              checked={data.enabled}
              disabled={!editable || set.isPending}
              onCheckedChange={(v) => set.mutate(v)}
              aria-describedby="routing-platform-help"
            />
            <div className="min-w-0 space-y-1">
              <label htmlFor="routing-platform-on" className="font-medium">
                {t('Switch automatic route planning on for the platform')}
              </label>
              <p id="routing-platform-help" className="text-xs text-muted-foreground">
                {t('Switching off never interrupts a running optimisation: it finishes (at most a few minutes). Optimisations still waiting are ended and their plans go back to drafts. Manual dispatch is not affected.')}
              </p>
            </div>
          </div>
          <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-xs text-muted-foreground">{t('Companies using it')}</dt>
              <dd className="tabular-nums">{data.companiesOn}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{t('Optimisations queued or running')}</dt>
              <dd className="tabular-nums">{data.openJobs}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{t('Last changed')}</dt>
              <dd>{data.updatedAt ? `${formatDateTime(data.updatedAt)}${data.updatedBy ? ` · ${data.updatedBy}` : ''}` : '—'}</dd>
            </div>
          </dl>
          {readiness && (
            <div className="space-y-2 border-t pt-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-medium">
                  {t('Readiness')}: <span className={readiness.ready ? 'text-success-fg' : 'text-destructive-fg'}>{readiness.ready ? t('Ready') : t('Not ready')}</span>
                </p>
                <Button size="sm" variant="outline" onClick={() => refresh.mutate()} disabled={refresh.isPending}>
                  <RefreshCwIcon /> {t('Check again')}
                </Button>
              </div>
              <ReadinessChecklist readiness={readiness} />
            </div>
          )}
        </div>
      ) : null}
    </Panel>
  );
}

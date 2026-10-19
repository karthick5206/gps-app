import { useQuery } from '@tanstack/react-query';
import { API_PLAN_LABELS, API_PLANS, type ApiAccessStatusDto, type ApiPlan } from '@veetracer/shared';
import { ShoppingCartIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { FormError } from '@/components/form-error';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/features/auth/auth-context';
import { api, errorMessage } from '@/lib/api';
import { formatDay } from '@/features/billing/shared';

export const API_LICENCE_QUERY = ['developer', 'licence'];

const nextPlan = (p: ApiPlan): ApiPlan | null => API_PLANS[API_PLANS.indexOf(p) + 1] ?? null;

/** Developer API licence: plan, limits, today's usage, expiry, and buy / renew / upgrade (Billing & Licences). */
export function ApiPlanCard() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const q = useQuery({ queryKey: API_LICENCE_QUERY, queryFn: ({ signal }) => api.get<ApiAccessStatusDto | null>('/developer/licence', undefined, signal) });
  if (q.isPending) return <Skeleton className="h-24 w-full" />;
  if (q.isError) return <FormError message={errorMessage(q.error)} />;
  const s = q.data;
  if (!s || s.exempt) return null;
  const canBuy = can('billing', 'create');
  const seat = s.seat;
  const l = s.limits;
  const buy = (plan: ApiPlan, label: string) =>
    canBuy && (
      <Button asChild size="sm" variant={seat && !s.allowed ? 'default' : 'outline'}>
        <Link to={`/admin/billing?apiPlan=${plan}`}>
          <ShoppingCartIcon />
          {label}
        </Link>
      </Button>
    );
  const up = seat ? nextPlan(seat.plan) : null;
  const stat = (label: string, used: number | null, limit: number | null) => (
    <div className="min-w-28">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="font-medium tabular-nums">
        {used !== null ? `${used.toLocaleString('en-IN')} / ` : ''}
        {limit === null ? t('Unlimited') : limit.toLocaleString('en-IN')}
      </div>
    </div>
  );
  return (
    <Card className="space-y-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-medium">{t('Developer API plan')}</h3>
        {seat ? (
          <>
            <Badge variant="muted">{t(API_PLAN_LABELS[seat.plan])}</Badge>
            {seat.status === 'ACTIVE' && <Badge variant="success">{t('Active')}</Badge>}
            {seat.status === 'EXPIRING' && <Badge variant="warning">{t('Expiring')}</Badge>}
            {seat.status === 'GRACE' && <Badge variant="destructive">{t('In grace period')}</Badge>}
            {seat.locked && <Badge variant="destructive">{t('Developer API licence expired')}</Badge>}
            <span className="text-sm text-muted-foreground">
              {t('Expires on')} {formatDay(seat.expiresAt)}
            </span>
          </>
        ) : (
          <Badge variant="destructive">{t('No Developer API plan')}</Badge>
        )}
        <div className="ml-auto flex flex-wrap gap-2">
          {seat ? (
            <>
              {buy(seat.plan, t('Renew'))}
              {up && buy(up, t('Upgrade to {{plan}}', { plan: t(API_PLAN_LABELS[up]) }))}
            </>
          ) : (
            buy('BASIC', t('Buy a Developer API plan'))
          )}
        </div>
      </div>
      {!seat && <p className="text-sm text-muted-foreground">{t('API keys and webhooks work only with a Developer API plan (Basic, Standard or Enterprise).')}</p>}
      {seat && !s.allowed && <p className="text-sm text-destructive">{t('API requests are refused (402 LICENCE_EXPIRED) until the licence is renewed.')}</p>}
      {l && (
        <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
          {stat(t('Requests today'), s.usage.requestsToday, l.ratePerDay)}
          {stat(t('Requests / min per key'), null, l.ratePerMinute)}
          {stat(t('Vehicles'), s.usage.vehicles, l.maxVehicles)}
          {stat(t('Webhooks'), s.usage.webhooks, l.maxWebhooks)}
        </div>
      )}
      {l?.maxVehicles !== null && l && s.usage.vehicles > l.maxVehicles && (
        <p className="text-xs text-muted-foreground">{t('Only the first {{n}} vehicles (by name) are available through the API; requests for other vehicles get 402 API_VEHICLE_LIMIT.', { n: l.maxVehicles })}</p>
      )}
    </Card>
  );
}

import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { TransportCustomerContextDto } from '@veetracer/shared';
import { BuildingIcon } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { useAuth } from '@/features/auth/auth-context';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api, ApiError } from '@/lib/api';
import { ALL_CUSTOMERS, customerFromSearch, customerPickerOptions, withCustomerParam } from '@/lib/transport-context';

export const TRANSPORT_CONTEXT_KEY = 'transport-context';

/** GET /transport/context (sent with the selected customer, so an ended / foreign selection answers 404). */
export function useTransportContext(enabled = true) {
  const { companyId } = useAuth();
  const { search } = useLocation();
  const customer = customerFromSearch(search);
  return useQuery({
    queryKey: [TRANSPORT_CONTEXT_KEY, companyId, customer],
    queryFn: ({ signal }) => api.get<TransportCustomerContextDto>('/transport/context', undefined, signal),
    enabled,
    staleTime: 60_000,
    retry: false,
  });
}

/**
 * Customer picker of a provider's transport pages (docs/employee-transport/07 §2.5): "All customers" (aggregate) or
 * one customer. The choice lives in `?customer=<id>`; lib/api.ts sends it as X-Transport-Customer on every /transport
 * call and the API narrows the request to it. Hidden for corporate-managed accounts (context.showPicker false).
 */
export function CustomerPicker() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { pathname, search } = useLocation();
  const customer = customerFromSearch(search);
  const { can } = useAuth();
  const ctx = useTransportContext(can('etms_dashboard') || can('etms_passengers') || can('etms_bookings') || can('etms_dispatch') || can('etms_schedules') || can('etms_planning') || can('etms_partners'));

  // Another customer: cached transport lists belong to the previous one (the header is not part of their keys).
  const previous = useRef(customer);
  useEffect(() => {
    if (previous.current === customer) return;
    previous.current = customer;
    void qc.resetQueries({ predicate: (q) => q.queryKey[0] !== 'me' && q.queryKey[0] !== TRANSPORT_CONTEXT_KEY });
  }, [customer, qc]);

  // The selected customer is no longer available (agreement ended / suspended): back to all customers.
  const failed = ctx.isError && ctx.error instanceof ApiError && ctx.error.status === 404 && !!customer;
  useEffect(() => {
    if (!failed) return;
    toast.error(t('That customer is no longer available to you. Showing all customers.'));
    navigate({ pathname, search: withCustomerParam(search, null) }, { replace: true });
  }, [failed, navigate, pathname, search, t]);

  const data = ctx.data;
  if (!data?.showPicker) return null;
  const options = customerPickerOptions(data.customers, { all: t('All customers'), own: (name) => t('{{name}} (our company)', { name }) });
  const value = customer && options.some((o) => o.value === customer) ? customer : ALL_CUSTOMERS;
  return (
    <div className="flex min-w-0 items-center gap-2">
      <BuildingIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <Select value={value} onValueChange={(v) => navigate({ pathname, search: withCustomerParam(search, v === ALL_CUSTOMERS ? null : v) })}>
        <SelectTrigger aria-label={t('Customer')} className="h-9 w-56 max-w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

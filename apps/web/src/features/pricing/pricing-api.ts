import { useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import type {
  BillingSupplierProfileDto,
  PricingCalendarDto,
  PricingContractDto,
  PricingContractSummaryDto,
  PricingPage,
  PricingTaxProfileDto,
} from '@veetracer/shared';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { api, request, type QueryParams } from '@/lib/api';
import { pricingErrorMessage } from './errors';

/** Every /api/pricing route (doc 19 §4). */
export const P = '/pricing';

/** All pricing caches share the 'pricing' prefix, so one invalidation refreshes lists, details and the dashboard. */
export const pk = (...parts: unknown[]): QueryKey => ['pricing', ...parts];

/** Idempotency-Key for generate / close (8–100 of [A-Za-z0-9_.:-]); one key per user action, reused on a retry. */
export function newIdempotencyKey(): string {
  const c = globalThis.crypto;
  return c?.randomUUID ? c.randomUUID() : `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** POST with an Idempotency-Key header. */
export const postIdempotent = <T>(path: string, body: unknown, key: string) => request<T>(path, { method: 'POST', body, headers: { 'Idempotency-Key': key } });

/** Mutation with the pricing error mapping, a success toast and invalidation of every pricing cache. */
export function usePricingMutation<TVars, TResult = unknown>(fn: (vars: TVars) => Promise<TResult>, opts: { success?: string | ((r: TResult) => string); onSuccess?: (r: TResult, v: TVars) => void; toastError?: boolean } = {}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (r, v) => {
      if (opts.success) toast.success(typeof opts.success === 'function' ? opts.success(r) : t(opts.success));
      void qc.invalidateQueries({ queryKey: ['pricing'] });
      opts.onSuccess?.(r, v);
    },
    onError: (e) => {
      if (opts.toastError !== false) toast.error(pricingErrorMessage(e, t));
    },
  });
}

export function usePricingQuery<T>(key: unknown[], path: string, query?: QueryParams, enabled = true) {
  return useQuery({
    queryKey: pk(path, ...key, query),
    queryFn: ({ signal }) => api.get<T>(path, query, signal),
    enabled,
  });
}

/** Contracts for pickers (first 200, every status). */
export function useContractOptions(enabled = true) {
  const q = useQuery({
    queryKey: pk('contract-options'),
    queryFn: ({ signal }) => api.get<PricingPage<PricingContractSummaryDto>>(`${P}/contracts`, { pageSize: 200 }, signal),
    enabled,
    staleTime: 60_000,
  });
  return { contracts: q.data?.items ?? [], loading: q.isPending && enabled, error: q.error };
}

export function useContract(id: string | undefined) {
  return useQuery({
    queryKey: pk('contract', id),
    queryFn: ({ signal }) => api.get<PricingContractDto>(`${P}/contracts/${id}`, undefined, signal),
    enabled: !!id,
  });
}

export function useTaxProfiles(enabled = true) {
  return useQuery({ queryKey: pk('tax-profiles'), queryFn: ({ signal }) => api.get<PricingTaxProfileDto[]>(`${P}/settings/tax-profiles`, undefined, signal), enabled, staleTime: 60_000 });
}

export function useSupplier(enabled = true) {
  return useQuery({ queryKey: pk('supplier'), queryFn: ({ signal }) => api.get<BillingSupplierProfileDto | null>(`${P}/settings/supplier`, undefined, signal), enabled });
}

export function useCalendars(enabled = true) {
  return useQuery({ queryKey: pk('calendars'), queryFn: ({ signal }) => api.get<PricingCalendarDto[]>(`${P}/settings/calendars`, undefined, signal), enabled, staleTime: 60_000 });
}

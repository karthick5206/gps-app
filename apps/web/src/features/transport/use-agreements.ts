import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreateTransportAgreementInput,
  TransportAgreementAction,
  TransportAgreementDto,
  TransportAgreementHistoryEntryDto,
  TransportAgreementSitesDto,
  TransportAgreementSummaryDto,
  TransportCompanyLookupDto,
  TransportSiteOptionDto,
  UpdateTransportAgreementInput,
} from '@veetracer/shared';
import { useDeferredValue } from 'react';
import { api } from '@/lib/api';
import { lookupQuery } from './agreement-views-format';

export const AGREEMENTS_ENDPOINT = '/transport/agreements';
export const agreementPath = (id: string) => `/transport/partners/${id}`;

/** Every cache that shows agreements: the MasterPage list, the detail (with its sites and history), and the dashboard summary. */
export function useInvalidateAgreements() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ['master', AGREEMENTS_ENDPOINT] });
    qc.invalidateQueries({ queryKey: ['transport-agreement'] });
    qc.invalidateQueries({ queryKey: ['transport-agreement-summary'] });
  };
}

export function useAgreement(id: string | undefined) {
  return useQuery({
    queryKey: ['transport-agreement', id],
    queryFn: ({ signal }) => api.get<TransportAgreementDto>(`${AGREEMENTS_ENDPOINT}/${id}`, undefined, signal),
    enabled: !!id,
  });
}

export type AgreementCommand =
  | { kind: 'create'; input: CreateTransportAgreementInput }
  | { kind: 'update'; id: string; input: UpdateTransportAgreementInput }
  | { kind: Exclude<TransportAgreementAction, 'edit'>; id: string; version: number; reason?: string };

/** Create / patch / commands. Commands always send `expectedVersion` so concurrent changes fail with VERSION_CONFLICT. */
export function useAgreementMutation() {
  const invalidate = useInvalidateAgreements();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (cmd: AgreementCommand): Promise<TransportAgreementDto> => {
      if (cmd.kind === 'create') return api.post<TransportAgreementDto>(AGREEMENTS_ENDPOINT, cmd.input);
      if (cmd.kind === 'update') return api.patch<TransportAgreementDto>(`${AGREEMENTS_ENDPOINT}/${cmd.id}`, cmd.input);
      const body = cmd.kind === 'suspend' || cmd.kind === 'end' ? { reason: cmd.reason ?? '', expectedVersion: cmd.version } : { expectedVersion: cmd.version };
      return api.post<TransportAgreementDto>(`${AGREEMENTS_ENDPOINT}/${cmd.id}/${cmd.kind}`, body);
    },
    onSuccess: (row) => {
      qc.setQueryData(['transport-agreement', row.id], row);
      invalidate();
    },
  });
}

/** Counts per status + proposals awaiting the caller's side, in one request (GET /transport/agreements/summary). */
export function useAgreementSummary(enabled: boolean) {
  return useQuery({
    queryKey: ['transport-agreement-summary'],
    enabled,
    queryFn: ({ signal }) => api.get<TransportAgreementSummaryDto>(`${AGREEMENTS_ENDPOINT}/summary`, undefined, signal),
  });
}

/** Names of the customer sites the agreement is limited to (both parties; id + name only). */
export function useAgreementSites(id: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ['transport-agreement', id, 'sites'],
    enabled: !!id && enabled,
    queryFn: ({ signal }) => api.get<TransportAgreementSitesDto>(`${AGREEMENTS_ENDPOINT}/${id}/sites`, undefined, signal),
    staleTime: 60_000,
  });
}

/** Full agreement history from the audit log, oldest first. */
export function useAgreementHistory(id: string | undefined, version: number | undefined) {
  return useQuery({
    queryKey: ['transport-agreement', id, 'history', version],
    enabled: !!id,
    queryFn: ({ signal }) => api.get<TransportAgreementHistoryEntryDto[]>(`${AGREEMENTS_ENDPOINT}/${id}/history`, undefined, signal),
  });
}

/** The acting company's own places for the site picker (no Places permission needed). */
export function useSiteOptions(enabled: boolean, q: string, customerCompanyId?: string) {
  const search = useDeferredValue(q.trim());
  return useQuery({
    queryKey: ['transport-site-options', search, customerCompanyId ?? null],
    enabled,
    queryFn: ({ signal }) => api.get<TransportSiteOptionDto[]>(`${AGREEMENTS_ENDPOINT}/site-options`, { q: search || undefined, customerCompanyId }, signal),
    staleTime: 60_000,
  });
}

/** Partner directory search (ETMS companies only; at least 3 characters, rate-limited on the server). */
export function useCompanyLookup(enabled: boolean, raw: string) {
  const q = lookupQuery(useDeferredValue(raw));
  return useQuery({
    queryKey: ['transport-company-lookup', q],
    enabled: enabled && q !== null,
    queryFn: ({ signal }) => api.get<TransportCompanyLookupDto[]>('/transport/companies/lookup', { q: q! }, signal),
    staleTime: 60_000,
    retry: false,
  });
}

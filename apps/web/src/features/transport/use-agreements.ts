import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreateTransportAgreementInput,
  Paginated,
  TransportAgreementAction,
  TransportAgreementDto,
  TransportAgreementStatus,
  UpdateTransportAgreementInput,
} from '@veetracer/shared';
import { api } from '@/lib/api';

export const AGREEMENTS_ENDPOINT = '/transport/agreements';
export const agreementPath = (id: string) => `/transport/partners/${id}`;

/** Every cache that shows agreements: the MasterPage list, the detail, and the dashboard counts. */
export function useInvalidateAgreements() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ['master', AGREEMENTS_ENDPOINT] });
    qc.invalidateQueries({ queryKey: ['transport-agreement'] });
    qc.invalidateQueries({ queryKey: ['transport-agreement-counts'] });
    qc.invalidateQueries({ queryKey: ['transport-agreement-approvals'] });
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

/** Totals per lifecycle status (one small request each: the list `total` with pageSize 1). Real data only. */
export function useAgreementCounts(enabled: boolean) {
  return useQuery({
    queryKey: ['transport-agreement-counts'],
    enabled,
    queryFn: async ({ signal }) => {
      const statuses: TransportAgreementStatus[] = ['DRAFT', 'PROPOSED', 'ACTIVE', 'SUSPENDED', 'ENDED'];
      const totals = await Promise.all(statuses.map((s) => api.get<Paginated<TransportAgreementDto>>(AGREEMENTS_ENDPOINT, { agreementStatus: s, pageSize: 1 }, signal).then((r) => r.total)));
      return Object.fromEntries(statuses.map((s, i) => [s, totals[i]])) as Record<TransportAgreementStatus, number>;
    },
  });
}

/** Proposed agreements the caller's side still has to approve (server `allowedActions` contains approve). */
export function useAgreementsAwaitingMe(enabled: boolean) {
  return useQuery({
    queryKey: ['transport-agreement-approvals'],
    enabled,
    queryFn: async ({ signal }) => {
      const res = await api.get<Paginated<TransportAgreementDto>>(AGREEMENTS_ENDPOINT, { agreementStatus: 'PROPOSED', pageSize: 100, sort: 'updatedAt', order: 'desc' }, signal);
      return res.items.filter((a) => a.allowedActions.includes('approve'));
    },
  });
}

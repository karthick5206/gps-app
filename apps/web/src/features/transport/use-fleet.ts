import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateTransportFleetAllocationInput, TransportFleetAllocationDto } from '@veetracer/shared';
import { useDeferredValue } from 'react';
import { api } from '@/lib/api';
import { AGREEMENTS_ENDPOINT } from './use-agreements';

/** GET /transport/agreements/:id/fleet-options: the provider's own vehicles and drivers it may allocate. */
export interface FleetOptionsDto {
  vehicles: { id: string; name: string; plateNumber: string | null }[];
  drivers: { id: string; name: string }[];
}

const fleetKey = (agreementId: string) => ['transport-agreement', agreementId, 'fleet'] as const;

export function useFleetAllocations(agreementId: string) {
  return useQuery({
    queryKey: fleetKey(agreementId),
    queryFn: ({ signal }) => api.get<TransportFleetAllocationDto[]>(`${AGREEMENTS_ENDPOINT}/${agreementId}/fleet`, undefined, signal),
  });
}

export function useFleetOptions(agreementId: string, q: string, enabled: boolean) {
  const query = useDeferredValue(q.trim());
  return useQuery({
    queryKey: [...fleetKey(agreementId), 'options', query],
    queryFn: ({ signal }) => api.get<FleetOptionsDto>(`${AGREEMENTS_ENDPOINT}/${agreementId}/fleet-options`, { q: query || undefined }, signal),
    enabled,
    staleTime: 30_000,
  });
}

export type FleetCommand = { kind: 'create'; input: CreateTransportFleetAllocationInput } | { kind: 'end'; allocationId: string };

export function useFleetMutation(agreementId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (cmd: FleetCommand) =>
      cmd.kind === 'create'
        ? api.post<TransportFleetAllocationDto>(`${AGREEMENTS_ENDPOINT}/${agreementId}/fleet`, cmd.input)
        : api.post<TransportFleetAllocationDto>(`${AGREEMENTS_ENDPOINT}/${agreementId}/fleet/${cmd.allocationId}/end`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: fleetKey(agreementId) }),
  });
}

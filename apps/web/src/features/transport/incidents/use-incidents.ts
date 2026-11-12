import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { SOS_SOCKET_EVENT, type AckIncidentRequest, type IncidentDetail, type IncidentListResponse, type ResolveIncidentRequest } from '@veetracer/shared';
import { useEffect, useRef } from 'react';
import { useAuth } from '@/features/auth/auth-context';
import { realtime } from '@/features/live/realtime';
import { useRealtimeStatus } from '@/features/live/use-live';
import { api } from '@/lib/api';
import { INCIDENTS_ENDPOINT, isSosPayload, lanePollMs } from './sos-lane';

export const incidentKeys = {
  lane: ['transport-incidents', 'open'] as const,
  all: ['transport-incidents'] as const,
  detail: (id: string) => ['transport-incidents', 'detail', id] as const,
};

/**
 * The open SOS lane (OPEN + ACKNOWLEDGED), shared by the lane page, the top banner and the bell mirror (one query).
 * Refetches on every `transport.sos` socket event and after a reconnect; polls 15 s while the socket is down and
 * 60 s while it is up (sos-lane.ts lanePollMs). Enabled only for etms_incidents:view.
 */
export function useSosLane() {
  const { can } = useAuth();
  const enabled = can('etms_incidents');
  const status = useRealtimeStatus();
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: incidentKeys.lane,
    queryFn: ({ signal }) => api.get<IncidentListResponse>(INCIDENTS_ENDPOINT, { open: 1, limit: 100 }, signal),
    enabled,
    refetchInterval: lanePollMs(status === 'connected'),
    refetchIntervalInBackground: true,
    staleTime: 5_000,
  });
  const wasConnected = useRef(status === 'connected');
  useEffect(() => {
    if (!enabled) return;
    // Pushes during a disconnect are lost by design: refetch after every reconnect.
    if (status === 'connected' && !wasConnected.current) void qc.invalidateQueries({ queryKey: incidentKeys.all });
    wasConnected.current = status === 'connected';
  }, [enabled, status, qc]);
  return query;
}

/** Mount once (the shell): the socket event refreshes the lane and the open detail immediately. */
export function useSosSocket() {
  const { can } = useAuth();
  const enabled = can('etms_incidents');
  const qc = useQueryClient();
  useEffect(() => {
    if (!enabled) return;
    return realtime.on(SOS_SOCKET_EVENT, (payload: unknown) => {
      if (!isSosPayload(payload)) return;
      void qc.invalidateQueries({ queryKey: incidentKeys.all });
    });
  }, [enabled, qc]);
}

export function useIncident(id: string | null) {
  return useQuery({
    queryKey: incidentKeys.detail(id ?? ''),
    queryFn: ({ signal }) => api.get<IncidentDetail>(`${INCIDENTS_ENDPOINT}/${id}`, undefined, signal),
    enabled: !!id,
  });
}

export function useAckIncident() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: AckIncidentRequest & { id: string }) => api.post<IncidentDetail>(`${INCIDENTS_ENDPOINT}/${id}/ack`, body),
    onSuccess: (d) => {
      qc.setQueryData(incidentKeys.detail(d.id), d);
      void qc.invalidateQueries({ queryKey: incidentKeys.lane });
    },
  });
}

export function useResolveIncident() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: ResolveIncidentRequest & { id: string }) => api.post<IncidentDetail>(`${INCIDENTS_ENDPOINT}/${id}/resolve`, body),
    onSuccess: (d) => {
      qc.setQueryData(incidentKeys.detail(d.id), d);
      void qc.invalidateQueries({ queryKey: incidentKeys.lane });
    },
  });
}

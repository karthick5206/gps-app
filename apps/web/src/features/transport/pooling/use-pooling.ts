import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  DispatchRequestDto,
  DispatchRequestListQuery,
  DriverHoursPolicy,
  LiveDispatchDecideInput,
  LiveDispatchDecisionDto,
  PoolingSettingsDto,
  PutVehicleAvailabilityInput,
  TransportBookingDto,
  TransportBookingHoldInput,
  TransportSharingPolicyDto,
  UpdatePoolingSettingsInput,
  UpdateTransportSharingPolicyInput,
  VehicleAvailabilityDto,
} from '@veetracer/shared';
import { api, ApiError, request, type QueryParams } from '@/lib/api';
import { invalidateDispatch } from '../dispatch/use-e3';

export const poolingKeys = {
  policy: ['transport-sharing-policy'] as const,
  settings: ['transport-pooling-settings'] as const,
  availability: (id: string) => ['transport-vehicle-availability', id] as const,
  live: ['transport-live-requests'] as const,
};

/** An older server (no pooling routes) answers 404: the screens then hide the pooling parts. */
const orNull = async <T>(p: Promise<T>): Promise<T | null> => {
  try {
    return await p;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
};

/** GET /transport/sharing-policy (etms_bookings view): the current version, text, limits; version 0 = built-in default. */
export function useSharingPolicy(enabled = true) {
  return useQuery({
    queryKey: poolingKeys.policy,
    queryFn: ({ signal }) => orNull(api.get<TransportSharingPolicyDto>('/transport/sharing-policy', undefined, signal)),
    enabled,
    staleTime: 60_000,
  });
}

/** PUT /transport/sharing-policy: a NEW version (accepted bookings keep theirs). */
export function useSaveSharingPolicy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateTransportSharingPolicyInput) => api.put<TransportSharingPolicyDto>('/transport/sharing-policy', input),
    onSuccess: (row) => qc.setQueryData(poolingKeys.policy, row),
  });
}

export function usePoolingSettings(enabled = true) {
  return useQuery({
    queryKey: poolingKeys.settings,
    queryFn: ({ signal }) => orNull(api.get<PoolingSettingsDto>('/transport/pooling/settings', undefined, signal)),
    enabled,
    staleTime: 30_000,
  });
}

export function useSavePoolingSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdatePoolingSettingsInput) => api.put<PoolingSettingsDto>('/transport/pooling/settings', input),
    onSuccess: (row) => qc.setQueryData(poolingKeys.settings, row),
  });
}

/** PUT /transport/driver-policy `{ policy }` (null = no policy, P7). */
export function useSaveDriverPolicy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (policy: DriverHoursPolicy | null) => api.put<PoolingSettingsDto>('/transport/driver-policy', { policy }),
    onSuccess: (row) => qc.setQueryData(poolingKeys.settings, row),
  });
}

/** PATCH /transport/bookings/:id/hold (etms_dispatch edit): exclude from runs without cancelling, or release. */
export function useHoldBooking() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: TransportBookingHoldInput }) => api.patch<TransportBookingDto>(`/transport/bookings/${id}/hold`, input),
    onSettled: () => invalidateDispatch(qc),
  });
}

export function useVehicleAvailability(objectId: string | null) {
  return useQuery({
    queryKey: poolingKeys.availability(objectId ?? ''),
    queryFn: ({ signal }) => api.get<VehicleAvailabilityDto>(`/transport/vehicles/${objectId}/availability`, undefined, signal),
    enabled: !!objectId,
  });
}

export function useSaveVehicleAvailability(objectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: PutVehicleAvailabilityInput) => api.put<VehicleAvailabilityDto>(`/transport/vehicles/${objectId}/availability`, input),
    onSuccess: (row) => qc.setQueryData(poolingKeys.availability(objectId), row),
  });
}

/** GET /transport/dispatch/live/requests: the live decision log, newest first (polled while the board is open). */
export function useLiveRequests(q: DispatchRequestListQuery, enabled = true) {
  return useQuery({
    queryKey: [...poolingKeys.live, q],
    queryFn: ({ signal }) => orNull(api.get<DispatchRequestDto[]>('/transport/dispatch/live/requests', q as QueryParams, signal)),
    enabled,
    refetchInterval: 15_000,
  });
}

/** POST /transport/dispatch/live/decide: a dry run (no key) or an apply (Idempotency-Key required). */
export function useLiveDecide() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ input, key }: { input: LiveDispatchDecideInput; key?: string }) =>
      request<LiveDispatchDecisionDto>('/transport/dispatch/live/decide', { method: 'POST', body: input, ...(key ? { headers: { 'Idempotency-Key': key } } : {}) }),
    onSettled: (_d, _e, v) => {
      void qc.invalidateQueries({ queryKey: poolingKeys.live });
      if (v.input.apply) invalidateDispatch(qc);
    },
  });
}

/** The machine code of an error for the live flow ('NETWORK' / 'SERVER' keep the Idempotency-Key for a retry). */
export function liveErrorCode(err: unknown): string | null {
  if (err instanceof ApiError) return err.status >= 500 || err.status === 0 ? 'SERVER' : (err.code ?? `HTTP_${err.status}`);
  return 'NETWORK';
}

/**
 * Ride preferences of a day's bookings (booking id → preference) for badging private rides in an AREA plan: the plan
 * stop view does not carry the preference (API gap), so the bookings list (first 200 of the day) is read instead.
 */
export function useDayRidePreferences(serviceDate: string | null) {
  return useQuery({
    queryKey: ['transport-bookings', 'ride-preferences', serviceDate],
    queryFn: async ({ signal }) => {
      const page = await api.get<{ items: TransportBookingDto[] }>('/transport/bookings', { serviceDate: serviceDate ?? '', pageSize: 200, page: 1 } as QueryParams, signal);
      return new Map(page.items.map((b) => [b.id, b.ridePreference] as const));
    },
    enabled: !!serviceDate,
    staleTime: 60_000,
  });
}

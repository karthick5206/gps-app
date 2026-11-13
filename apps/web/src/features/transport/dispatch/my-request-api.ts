import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { MeAdhocRequestInput, MeBookingDto, MeGeocodeHitDto, MePlaceDto, MeRequestPlaceDto } from '@veetracer/shared';
import { api, ApiError } from '@/lib/api';
import { e3Keys, ME_ENDPOINT, postIdempotent } from './use-e3';

/** v1.15.1 passenger web: the data hooks of "Request a ride" and the own-booking cancel (all /me/transport/*). */

const noRetryOn4xx = (count: number, err: unknown) => !(err instanceof ApiError && err.status < 500) && count < 2;

/** My saved places (GET /me/transport/places); coordinates only with the routing consent. */
export function useMySavedPlaces(enabled: boolean) {
  return useQuery({
    queryKey: [...e3Keys.me, 'places'],
    queryFn: ({ signal }) => api.get<MePlaceDto[]>(`${ME_ENDPOINT}/places`, undefined, signal),
    enabled,
    staleTime: 60_000,
    retry: noRetryOn4xx,
  });
}

/** Company places I may pick (GET /me/transport/request-places?q=, at most 50). */
export function useRequestPlaces(q: string, enabled: boolean) {
  return useQuery({
    queryKey: [...e3Keys.me, 'request-places', q],
    queryFn: ({ signal }) => api.get<MeRequestPlaceDto[]>(`${ME_ENDPOINT}/request-places`, q ? { q } : undefined, signal),
    enabled,
    staleTime: 5 * 60_000,
    placeholderData: keepPreviousData,
    retry: noRetryOn4xx,
  });
}

/** Address search through the VeeTrax server only (self-hosted Photon behind GET /me/transport/geocode?q=). */
export function searchMyAddress(q: string, signal?: AbortSignal): Promise<MeGeocodeHitDto[]> {
  return api.get<MeGeocodeHitDto[]>(`${ME_ENDPOINT}/geocode`, { q }, signal);
}

export type MyRequestResult = MeBookingDto & { needsApproval?: boolean };

/** POST /me/transport/requests (Idempotency-Key; the caller keeps the key for retries of the same form). */
export function useRequestRide() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ body, key }: { body: MeAdhocRequestInput; key: string }) => postIdempotent<MyRequestResult>(`${ME_ENDPOINT}/requests`, body, key),
    retry: false,
    onSuccess: () => void qc.invalidateQueries({ queryKey: e3Keys.me }),
  });
}

/** POST /me/transport/bookings/:id/cancel (E5): my own booking, before its cut-off. */
export function useCancelMyBooking() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason?: string }) => api.post<MeBookingDto>(`${ME_ENDPOINT}/bookings/${id}/cancel`, reason ? { reason } : {}),
    retry: false,
    onSettled: () => void qc.invalidateQueries({ queryKey: e3Keys.me }),
  });
}

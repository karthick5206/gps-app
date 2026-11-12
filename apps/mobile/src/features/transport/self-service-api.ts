import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  MeBookingDto,
  MeCommuteDto,
  MeCreateBookingInput,
  MePlaceDto,
  MePlaceInput,
  MePlaceUpdateInput,
  MeTransportPolicyDto,
  MeTripConfirmInput,
  MeTripConfirmResult,
  MeTripReportInput,
  MeTripReportResult,
} from '@veetracer/shared';
import { useState } from 'react';
import { ApiError, api, errorMessage } from '@/lib/api';
import { i18n } from '@/lib/i18n';
import { uuidv7 } from './event-queue';
import { selfErrorText } from './self-service';

/**
 * Passenger self-service API (E5 WP 5.3, `/api/me/transport/{policy, bookings, schedule, places, trips/:id/confirm,
 * trips/:id/reports}`). Everything except the policy needs the company setting `selfBooking` (404
 * SELF_BOOKING_DISABLED otherwise). Booking, places, confirm and report are online only (doc 08 §6.1: cut-off rules
 * make late replays wrong); each create carries a key made once per attempt so a double tap or a retry is one write.
 */

const KEY = ['me-transport'] as const;
const noRetryOn4xx = (count: number, err: unknown) => count < 2 && !(err instanceof ApiError && err.status >= 400 && err.status < 500);
const OFF: MeTransportPolicyDto = { selfBooking: false, cutoffMin: 60, maxDaysAhead: 14, shifts: [], stops: [], routingConsent: false, sos: false, deskPhone: null };

/**
 * What the passenger may do. A server without WP 5.3 answers 404 for /policy: treated as "nothing switched on" (no
 * booking screens, no SOS button), never as an error screen.
 */
export function useMyPolicy(enabled = true) {
  return useQuery({
    queryKey: [...KEY, 'policy'],
    queryFn: async ({ signal }) => {
      try {
        return await api.get<MeTransportPolicyDto>('/me/transport/policy', undefined, signal);
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) return OFF;
        throw err;
      }
    },
    enabled,
    retry: noRetryOn4xx,
    staleTime: 5 * 60_000,
  });
}

/** One stable key per attempt (renewed after a success), so a retry of the same attempt replays instead of duplicating. */
export function useAttemptKey(): [string, () => void] {
  const [key, setKey] = useState(() => uuidv7(Date.now()));
  return [key, () => setKey(uuidv7(Date.now()))];
}

export function useBookTrip() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ body, key }: { body: MeCreateBookingInput; key: string }) => api.post<MeBookingDto>('/me/transport/bookings', body, { headers: { 'Idempotency-Key': key } }),
    retry: false,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: [...KEY, 'bookings'] });
      void qc.invalidateQueries({ queryKey: [...KEY, 'commute'] });
    },
  });
}

export function useMyCommute() {
  return useQuery({
    queryKey: [...KEY, 'commute'],
    queryFn: ({ signal }) => api.get<MeCommuteDto>('/me/transport/schedule', undefined, signal),
    retry: noRetryOn4xx,
  });
}

export function useMyPlaces(enabled = true) {
  return useQuery({
    queryKey: [...KEY, 'places'],
    queryFn: ({ signal }) => api.get<MePlaceDto[]>('/me/transport/places', undefined, signal),
    enabled,
    retry: noRetryOn4xx,
  });
}

export function useSavePlace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (p: { id?: string; body: MePlaceInput | MePlaceUpdateInput }) => (p.id ? api.patch<MePlaceDto>(`/me/transport/places/${p.id}`, p.body) : api.post<MePlaceDto>('/me/transport/places', p.body)),
    retry: false,
    onSuccess: () => void qc.invalidateQueries({ queryKey: [...KEY, 'places'] }),
  });
}

export function useDeletePlace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<{ deleted: true }>(`/me/transport/places/${id}`),
    retry: false,
    onSuccess: () => void qc.invalidateQueries({ queryKey: [...KEY, 'places'] }),
  });
}

/** P5: the passenger's confirmation is a dispute signal; the trip screen keeps showing the driver's record. */
export function useConfirmRide(tripId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: MeTripConfirmInput) => api.post<MeTripConfirmResult>(`/me/transport/trips/${tripId}/confirm`, body),
    retry: false,
    onSuccess: () => void qc.invalidateQueries({ queryKey: [...KEY, 'trip', tripId] }),
  });
}

export function useReportProblem(tripId: string) {
  return useMutation({
    mutationFn: (body: MeTripReportInput) => api.post<MeTripReportResult>(`/me/transport/trips/${tripId}/reports`, body),
    retry: false,
  });
}

export function isSelfBookingOff(err: unknown): boolean {
  return err instanceof ApiError && err.code === 'SELF_BOOKING_DISABLED';
}

/** Translated text for a self-service error (known codes), else the server message. */
export function selfServiceErrorText(err: unknown, action: 'book' | 'place' | 'confirm' | 'report'): string {
  const known = err instanceof ApiError ? selfErrorText(err.code, action) : null;
  return known ? i18n.t(known) : errorMessage(err);
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ConsentNoticeDto, ConsentPurpose, MeBookingDto, MeTripDto, MeVehicleDto, PassengerConsentsDto, PassengerConsentStateDto, PassengerNoticeDto } from '@veetracer/shared';
import { useEffect, useState } from 'react';
import { ApiError, api, errorMessage } from '@/lib/api';
import { i18n } from '@/lib/i18n';
import { ERROR_TEXT } from './labels';
import { ME_POLL_MS } from './trip-window';

/**
 * Passenger API (`/api/me/transport/*`, doc 05 §2.8): the signed-in passenger's own data only. The server answers
 * 403 NOT_A_PASSENGER when the login is not linked to an active passenger profile, and 404 for anyone else's ids.
 * Nothing here is cached on the device beyond react-query's in-memory cache (cleared on sign-out).
 */

const KEY = ['me-transport'] as const;
const noRetryOn4xx = (count: number, err: unknown) => count < 2 && !(err instanceof ApiError && err.status >= 400 && err.status < 500);

export function useMyTrips() {
  return useQuery({
    queryKey: [...KEY, 'trips'],
    queryFn: ({ signal }) => api.get<MeTripDto[]>('/me/transport/trips', undefined, signal),
    retry: noRetryOn4xx,
    refetchInterval: 60_000,
  });
}

export function useMyTrip(id: string) {
  return useQuery({
    queryKey: [...KEY, 'trip', id],
    queryFn: ({ signal }) => api.get<MeTripDto>(`/me/transport/trips/${id}`, undefined, signal),
    retry: noRetryOn4xx,
    // The trip screen refreshes status every 15 s while it is open (doc 05 §5.5); react-query stops when unmounted.
    refetchInterval: ME_POLL_MS,
  });
}

/** The vehicle, polled every 15 s only while `enabled` (inside the trip window and the screen is open). */
export function useMyVehicle(tripId: string, enabled: boolean) {
  return useQuery({
    queryKey: [...KEY, 'vehicle', tripId],
    queryFn: ({ signal }) => api.get<MeVehicleDto>(`/me/transport/trips/${tripId}/vehicle`, undefined, signal),
    enabled,
    retry: noRetryOn4xx,
    refetchInterval: enabled ? ME_POLL_MS : false,
    refetchIntervalInBackground: false,
    staleTime: 0,
    gcTime: 0,
  });
}

export function useMyBookings() {
  return useQuery({
    queryKey: [...KEY, 'bookings'],
    queryFn: ({ signal }) => api.get<MeBookingDto[]>('/me/transport/bookings', undefined, signal),
    retry: noRetryOn4xx,
  });
}

export function useMyConsent() {
  return useQuery({
    queryKey: [...KEY, 'consent'],
    queryFn: ({ signal }) => api.get<PassengerConsentStateDto[]>('/me/transport/consent', undefined, signal),
    retry: noRetryOn4xx,
  });
}

export function useConsentNotices() {
  return useQuery({
    queryKey: [...KEY, 'consent-notices'],
    queryFn: ({ signal }) => api.get<{ purpose: ConsentPurpose; notice: ConsentNoticeDto | null }[]>('/me/transport/consent/notices', undefined, signal),
    retry: noRetryOn4xx,
  });
}

export function useMyNotices() {
  return useQuery({
    queryKey: [...KEY, 'notices'],
    queryFn: ({ signal }) => api.get<PassengerNoticeDto[]>('/me/transport/notices', undefined, signal),
    retry: noRetryOn4xx,
    refetchInterval: 5 * 60_000,
  });
}

/**
 * Grant or withdraw one purpose from the passenger's own session. A grant names the notice version the person was
 * shown; the server refuses a stale one (409 CONSENT_NOTICE_OUTDATED) and the notices are reloaded.
 */
export function useRecordConsent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { purpose: ConsentPurpose; granted: boolean; noticeVersion?: string; locale?: string }) => api.post<PassengerConsentsDto>('/me/transport/consent', body),
    onSuccess: (res) => {
      qc.setQueryData([...KEY, 'consent'], res.current);
      void qc.invalidateQueries({ queryKey: [...KEY, 'trips'] });
      void qc.invalidateQueries({ queryKey: [...KEY, 'trip'] });
    },
    onError: (err) => {
      if (err instanceof ApiError && (err.code === 'CONSENT_NOTICE_OUTDATED' || err.code === 'CONSENT_NOTICE_MISSING')) void qc.invalidateQueries({ queryKey: [...KEY, 'consent-notices'] });
    },
  });
}

export function isNotPassenger(err: unknown): boolean {
  return err instanceof ApiError && err.code === 'NOT_A_PASSENGER';
}

/** Passenger-facing error text (known codes translated), else the server message. */
export function transportErrorText(err: unknown): string {
  if (err instanceof ApiError && err.code && ERROR_TEXT[err.code]) return i18n.t(ERROR_TEXT[err.code]);
  return errorMessage(err);
}

/** Ticking clock for window decisions (re-renders every `ms`). */
export function useNow(ms = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

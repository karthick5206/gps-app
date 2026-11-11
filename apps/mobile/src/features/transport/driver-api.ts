import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  DriverDutyDto,
  DriverDutyTodayDto,
  DriverMeDto,
  DriverStartTripResult,
  DriverTripDetailDto,
  DriverTripEventBatchResult,
  DriverTripEventInput,
} from '@veetracer/shared';
import { ApiError, api, errorMessage } from '@/lib/api';
import { i18n } from '@/lib/i18n';
import { DRIVER_CODE_TEXT } from './labels';
import { QueueSendError, uuidv7, type EventOutcome, type QueuedEvent, type QueueTransport } from './event-queue';

/**
 * Driver API (`/api/driver/v1/*`, contract packages/shared/src/transport-driver.ts). Every route needs `etms_driver`
 * AND the caller's own active Driver row (403 NOT_A_DRIVER / DRIVER_INACTIVE); trips not assigned → 404.
 * Start trip and duty start / end are ONLINE ONLY: they are sent now or not at all (never queued).
 */

export const DRIVER_KEY = ['driver'] as const;
const BASE = '/driver/v1';
const noRetryOn4xx = (count: number, err: unknown) => count < 2 && !(err instanceof ApiError && err.status >= 400 && err.status < 500);

export function useDriverMe() {
  return useQuery({
    queryKey: [...DRIVER_KEY, 'me'],
    queryFn: ({ signal }) => api.get<DriverMeDto>(`${BASE}/me`, undefined, signal),
    retry: noRetryOn4xx,
    refetchInterval: 60_000,
  });
}

export function useDriverDuty() {
  return useQuery({
    queryKey: [...DRIVER_KEY, 'duty'],
    queryFn: ({ signal }) => api.get<DriverDutyTodayDto>(`${BASE}/duty`, undefined, signal),
    retry: noRetryOn4xx,
    refetchInterval: 60_000,
  });
}

export function useDriverTrip(id: string) {
  return useQuery({
    queryKey: [...DRIVER_KEY, 'trip', id],
    queryFn: ({ signal }) => api.get<DriverTripDetailDto>(`${BASE}/trips/${id}`, undefined, signal),
    retry: noRetryOn4xx,
    refetchInterval: 30_000,
  });
}

function newCommand() {
  const now = Date.now();
  return { clientEventId: uuidv7(now), occurredAt: new Date(now).toISOString() };
}

/** POST /trips/:id/start — online only; a fresh clientEventId per tap (the server dedupes a retried send). */
export function useStartTrip(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<DriverStartTripResult>(`${BASE}/trips/${id}/start`, newCommand()),
    retry: false,
    onSuccess: (res) => {
      qc.setQueryData([...DRIVER_KEY, 'trip', id], res.trip);
      void qc.invalidateQueries({ queryKey: [...DRIVER_KEY, 'duty'] });
    },
  });
}

/** POST /duty/start | /duty/end — online only. */
export function useDutyCommand() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { kind: 'start' | 'end'; objectId?: string | null }) =>
      api.post<DriverDutyDto>(`${BASE}/duty/${v.kind}`, v.kind === 'start' ? { ...newCommand(), objectId: v.objectId ?? null } : newCommand()),
    retry: false,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: [...DRIVER_KEY, 'me'] });
      void qc.invalidateQueries({ queryKey: [...DRIVER_KEY, 'duty'] });
    },
  });
}

export function isNotDriver(err: unknown): boolean {
  return err instanceof ApiError && (err.code === 'NOT_A_DRIVER' || err.code === 'DRIVER_INACTIVE');
}

/** Body of one queued event as the contract wants it (no local bookkeeping fields). */
export function toEventInput(e: QueuedEvent, clockOffsetMs: number): DriverTripEventInput {
  return {
    clientEventId: e.clientEventId,
    seq: e.seq,
    type: e.type as DriverTripEventInput['type'],
    occurredAt: e.occurredAt,
    clockOffsetMs: Math.round(clockOffsetMs) || undefined,
    stopSeq: e.stopSeq,
    passengerTripId: e.passengerTripId,
    reasonCode: e.reasonCode,
    etaMin: e.etaMin,
    note: e.note,
  };
}

/** Maps an API failure of a whole batch to the queue's retry / pause / terminal kinds (doc 09 §6.3). */
export function classifyBatchError(err: unknown): QueueSendError {
  if (!(err instanceof ApiError)) return new QueueSendError('network');
  const { status, code } = err;
  if (status === 0 || status === 408 || status === 429 || status >= 500) return new QueueSendError('network', code);
  if (status === 401) return new QueueSendError('auth', code);
  if (status === 403) return new QueueSendError('inactive', code ?? 'DRIVER_INACTIVE');
  if (status === 404) return new QueueSendError('rejected', code === 'NOT_FOUND' || !code ? 'NOT_ASSIGNED' : code);
  return new QueueSendError('rejected', code ?? `HTTP_${status}`);
}

/** Queue transport: POST /trips/:id/events; the returned trip refreshes the cached detail. */
export function driverEventTransport(onTrip: (tripId: string, trip: DriverTripDetailDto | null) => void): QueueTransport {
  return {
    async send(tripId, events, clockOffsetMs): Promise<EventOutcome[]> {
      let res: DriverTripEventBatchResult;
      try {
        res = await api.post<DriverTripEventBatchResult>(`${BASE}/trips/${tripId}/events`, { events: events.map((e) => toEventInput(e, clockOffsetMs)) });
      } catch (err) {
        throw classifyBatchError(err);
      }
      onTrip(tripId, res.trip);
      return res.results.map((r) => ({ clientEventId: r.clientEventId, outcome: r.outcome, code: r.code, serverTime: res.serverTime }));
    },
  };
}

/** Driver-facing text for a rejection / error code (translated), else the code itself. */
export function driverCodeText(code: string | null | undefined): string {
  if (!code) return '';
  return DRIVER_CODE_TEXT[code] ? i18n.t(DRIVER_CODE_TEXT[code]) : code;
}

/** Driver-facing error text: known codes translated, else the server message. */
export function driverErrorText(err: unknown): string {
  if (err instanceof ApiError && err.status === 0) return i18n.t('No connection. This needs a connection: try again when you are online.');
  if (err instanceof ApiError && err.code && DRIVER_CODE_TEXT[err.code]) return i18n.t(DRIVER_CODE_TEXT[err.code]);
  return errorMessage(err);
}

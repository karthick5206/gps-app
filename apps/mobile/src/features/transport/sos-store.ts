import { IDEMPOTENCY_KEY_HEADER, SOS_ROUTES, type CreateSosRequest, type SosReceipt } from '@veetracer/shared';
import * as SecureStore from 'expo-secure-store';
import { useEffect, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import { ApiError, api } from '@/lib/api';
import type { KeyValueStore } from './event-queue';
import { SosQueue, SosSendError, type SosItem, type SosTransport } from './sos-queue';

/**
 * The app's passenger SOS queue: sos-queue.ts on SecureStore (device keystore; ids, tap time, trip id and the optional
 * note only), sent to `POST /api/me/transport/sos` (contract: packages/shared/src/transport-sos.ts, WP 5.4) with the
 * `Idempotency-Key` = clientIncidentId. Drain triggers: right after raising, when the app comes to the foreground, and
 * every second while an SOS is pending (the per-item back-off decides when to actually send). No location fix is sent:
 * the passenger app has no location permission (doc 08 §5; adding expo-location needs a native build, not approved).
 */

const secureStore: KeyValueStore = {
  get: (k) => SecureStore.getItemAsync(k),
  set: (k, v) => SecureStore.setItemAsync(k, v),
  delete: (k) => SecureStore.deleteItemAsync(k),
};

export const sosQueue = new SosQueue({ store: secureStore });

/** `/api` prefix is part of the base URL in this app's client. */
const PASSENGER_SOS_PATH = SOS_ROUTES.passenger.replace(/^\/api/, '');

export const sosTransport: SosTransport = {
  async send(item: SosItem): Promise<SosReceipt> {
    const body: CreateSosRequest = { raisedAt: item.raisedAt, ...(item.tripId ? { tripId: item.tripId } : {}), ...(item.note ? { note: item.note } : {}) };
    try {
      return await api.post<SosReceipt>(PASSENGER_SOS_PATH, body, { headers: { [IDEMPOTENCY_KEY_HEADER]: item.clientIncidentId } });
    } catch (err) {
      if (err instanceof ApiError) throw new SosSendError(err.status === 0 ? undefined : err.status, err.code);
      throw new SosSendError(undefined);
    }
  },
};

let active = false;

function drain(force = false) {
  if (active) void sosQueue.drain(sosTransport, force).catch(() => undefined);
}

/** Raises an SOS: stored on the phone first, then sent at once. Throws only when it could not be stored. */
export async function raiseSos(input: { tripId?: string | null; note?: string | null }) {
  const item = await sosQueue.raise(input);
  drain(true);
  return item;
}

export function retrySos(clientIncidentId: string) {
  void sosQueue.retry(clientIncidentId).then((ok) => ok && drain(true));
}

export function useSosQueue() {
  return useSyncExternalStore(
    (l) => sosQueue.subscribe(l),
    () => sosQueue.snapshot(),
  );
}

/**
 * Loads the signed-in passenger's SOS queue (null = not a passenger / signed out: unload; rows stay on the phone for
 * that user's next sign-in), retries pending SOS, and refreshes the latest receipt (acknowledgement) every 15 s.
 */
export function useSosQueueLifecycle(userId: string | null) {
  useEffect(() => {
    if (!userId) {
      active = false;
      sosQueue.unload();
      return;
    }
    let stopped = false;
    void sosQueue.load(userId).then(() => {
      if (stopped) return;
      active = true;
      drain(true);
    });
    const tick = setInterval(() => {
      if (sosQueue.due()) drain();
    }, 1_000);
    const poll = setInterval(() => {
      const latest = sosQueue.snapshot().latest;
      const incidentId = latest?.receipt?.incidentId;
      if (!latest || latest.state !== 'RECEIVED' || !incidentId || latest.receipt?.resolvedAt) return;
      void api
        .get<SosReceipt>(`${PASSENGER_SOS_PATH}/${incidentId}`)
        .then((r) => sosQueue.updateReceipt(latest.clientIncidentId, r))
        .catch(() => undefined);
    }, 15_000);
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') drain(true);
    });
    return () => {
      stopped = true;
      active = false;
      clearInterval(tick);
      clearInterval(poll);
      sub.remove();
    };
  }, [userId]);
}

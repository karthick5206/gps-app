import { useQueryClient } from '@tanstack/react-query';
import type { DriverTripDetailDto } from '@veetracer/shared';
import * as SecureStore from 'expo-secure-store';
import { useEffect, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import { DRIVER_KEY, driverEventTransport } from './driver-api';
import { EventQueue, type KeyValueStore, type QueuedEventInput, type QueueTransport } from './event-queue';

/**
 * The app's driver event queue: event-queue.ts on SecureStore (device keystore; one small row per event, ids and codes
 * only, no names or phone numbers). Drain triggers (doc 09 §6.3): right after an enqueue, when the app comes to the
 * foreground, and every 30 s while the app is open. No background task: the vehicle GPS keeps tracking the trip on the
 * server meanwhile.
 */

const secureStore: KeyValueStore = {
  get: (k) => SecureStore.getItemAsync(k),
  set: (k, v) => SecureStore.setItemAsync(k, v),
  delete: (k) => SecureStore.deleteItemAsync(k),
};

export const driverQueue = new EventQueue({ store: secureStore });

let transport: QueueTransport | null = null;

function drain(force = false) {
  if (transport) void driverQueue.drain(transport, force).catch(() => undefined);
}

/** Stores the event (durably) and tries to send it at once. Throws when it could not be stored. */
export async function queueDriverEvent(input: QueuedEventInput) {
  const ev = await driverQueue.enqueue(input);
  drain();
  return ev;
}

/** "Sync now": ignores the backoff (not an auth pause: that needs the same user to sign in again). */
export function syncNow() {
  drain(true);
}

export function useDriverQueue() {
  return useSyncExternalStore(
    (l) => driverQueue.subscribe(l),
    () => driverQueue.snapshot(),
  );
}

/**
 * Loads the queue of the signed-in driver (null = not a driver / signed out: unload; the rows stay on the phone for
 * that user's next sign-in) and runs the drain triggers.
 */
export function useTransportQueueLifecycle(userId: string | null) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!userId) {
      transport = null;
      driverQueue.unload();
      return;
    }
    transport = driverEventTransport((tripId, trip: DriverTripDetailDto | null) => {
      if (trip) qc.setQueryData([...DRIVER_KEY, 'trip', tripId], trip);
      else void qc.invalidateQueries({ queryKey: [...DRIVER_KEY, 'trip', tripId] });
      void qc.invalidateQueries({ queryKey: [...DRIVER_KEY, 'duty'] });
    });
    let cancelled = false;
    driverQueue
      .load(userId)
      .then(() => !cancelled && drain())
      .catch(() => undefined);
    const tick = setInterval(() => {
      if (AppState.currentState === 'active' && driverQueue.due()) drain();
    }, 30_000);
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') drain();
    });
    return () => {
      cancelled = true;
      clearInterval(tick);
      sub.remove();
    };
  }, [userId, qc]);
}

import { useQueryClient } from '@tanstack/react-query';
import type { DriverTripDetailDto } from '@veetracer/shared';
import * as SecureStore from 'expo-secure-store';
import { useEffect, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import { ApiError } from '@/lib/api';
import { DRIVER_KEY, driverEventTransport, fetchDriverSync } from './driver-api';
import { EventQueue, type KeyValueStore, type QueuedEventInput, type QueueTransport } from './event-queue';
import { loadSyncCursor, saveSyncCursor } from './sync-cursor';

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
    // A trip that is no longer mine (revoked, reassigned, cancelled): drop every cached copy of its manifest.
    const wipeTrip = (tripId: string) => {
      qc.removeQueries({ queryKey: [...DRIVER_KEY, 'trip', tripId] });
      qc.removeQueries({ queryKey: [...DRIVER_KEY, 'motion', tripId] });
    };
    transport = driverEventTransport((tripId, trip: DriverTripDetailDto | null) => {
      if (trip) qc.setQueryData([...DRIVER_KEY, 'trip', tripId], trip);
      else wipeTrip(tripId);
      void qc.invalidateQueries({ queryKey: [...DRIVER_KEY, 'duty'] });
    });

    // GET /sync?since=: revoked trips are wiped, changed ones refetched, and outcomes of events whose send answer was
    // lost settle the queue (doc 09 §6.4.5). The cursor is kept per user in SecureStore (sync-cursor.ts), so a restart
    // continues from it; a missing / implausible one means a full-window sync.
    let cursor: string | null = null;
    let syncing = false;
    let stopped = false;
    const runSync = async () => {
      if (syncing || stopped || AppState.currentState !== 'active') return;
      syncing = true;
      try {
        const res = await fetchDriverSync(cursor);
        for (const t of res.trips) {
          if (t.change === 'REVOKED') wipeTrip(t.id);
          // Changed (e.g. a passenger withdrew consent and a stop lost its point): refetch every cached copy, also one
          // no screen shows right now, so no stale stop point stays in the offline cache.
          else void qc.invalidateQueries({ queryKey: [...DRIVER_KEY, 'trip', t.id], refetchType: 'all' });
        }
        if (res.trips.length) void qc.invalidateQueries({ queryKey: [...DRIVER_KEY, 'duty'] });
        for (const e of res.events) await driverQueue.applyServerOutcome(e.clientEventId, e.outcome, e.code);
        cursor = res.cursor;
        await saveSyncCursor(secureStore, userId, res.cursor);
      } catch (err) {
        // Not a driver (an admin holding the menu): stop asking. Network errors: try again on the next tick.
        if (err instanceof ApiError && err.status === 403) stopped = true;
      } finally {
        syncing = false;
      }
    };

    let cancelled = false;
    driverQueue
      .load(userId)
      .then(async () => {
        cursor = await loadSyncCursor(secureStore, userId);
        if (cancelled) return;
        drain();
        void runSync();
      })
      .catch(() => undefined);
    const tick = setInterval(() => {
      if (AppState.currentState === 'active' && driverQueue.due()) drain();
    }, 30_000);
    const syncTick = setInterval(() => void runSync(), 60_000);
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') {
        drain();
        void runSync();
      }
    });
    return () => {
      cancelled = true;
      stopped = true;
      clearInterval(tick);
      clearInterval(syncTick);
      sub.remove();
    };
  }, [userId, qc]);
}

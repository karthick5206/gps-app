import { IDEMPOTENCY_KEY_HEADER, SOS_ROUTES, type CreateSosRequest, type SosReceipt } from '@veetracer/shared';
import * as SecureStore from 'expo-secure-store';
import { useEffect, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import { ApiError, api } from '@/lib/api';
import type { KeyValueStore } from './event-queue';
import { EMPTY_SOS_CONTEXT, mergeSosContext, offlineIdentityFor, parseOfflineIdentity, parseSosContext, sosTripIdAt, type OfflineIdentity, type SosContext } from './sos-context';
import { SosQueue, SosSendError, type SosItem, type SosTransport } from './sos-queue';

/**
 * The app's SOS queues: sos-queue.ts on SecureStore (device keystore; ids, tap time, trip id and the optional note
 * only), one per audience:
 * - passenger → `POST /api/me/transport/sos` (WP 5.3 / 5.4), namespace `sos`;
 * - driver → `POST /api/driver/v1/sos` (doc 09 §7.3, r114), namespace `dsos`.
 * Contract: packages/shared/src/transport-sos.ts. `Idempotency-Key` = clientIncidentId. Drain triggers: right after
 * raising, when the app comes to the foreground, and every second while an SOS is pending (the per-item back-off decides
 * when to actually send). Each channel also keeps a small SOS context (current trip + desk phone, sos-context.ts) in
 * the keystore so the button works, and attaches the trip, after an offline cold start.
 *
 * No location fix is sent: there is no location module in this app (adding expo-location needs a native build, not
 * approved). Recorded as a deviation from doc 08 §6.1 / doc 09 §7.3 in the r114 mobile report.
 */

const secureStore: KeyValueStore = {
  get: (k) => SecureStore.getItemAsync(k),
  set: (k, v) => SecureStore.setItemAsync(k, v),
  delete: (k) => SecureStore.deleteItemAsync(k),
};

export type SosAudience = 'passenger' | 'driver';

export interface SosChannel {
  audience: SosAudience;
  queue: SosQueue;
  /** Stores the SOS on the phone first, then sends it at once. Throws only when it could not be stored. */
  raise(input?: { tripId?: string | null; note?: string | null }): Promise<SosItem>;
  retry(clientIncidentId: string): void;
  /** Updates the remembered trip / desk phone (no-op when unchanged). */
  setContext(patch: Partial<SosContext>): void;
  context(): SosContext;
  subscribeContext(l: () => void): () => void;
}

/** `/api` prefix is part of the base URL in this app's client. */
const strip = (p: string) => p.replace(/^\/api/, '');

function createChannel(audience: SosAudience, namespace: string, route: string) {
  const queue = new SosQueue({ store: secureStore, namespace });
  const path = strip(route);
  const transport: SosTransport = {
    async send(item: SosItem): Promise<SosReceipt> {
      const body: CreateSosRequest = { raisedAt: item.raisedAt, ...(item.tripId ? { tripId: item.tripId } : {}), ...(item.note ? { note: item.note } : {}) };
      try {
        return await api.post<SosReceipt>(path, body, { headers: { [IDEMPOTENCY_KEY_HEADER]: item.clientIncidentId } });
      } catch (err) {
        if (err instanceof ApiError) throw new SosSendError(err.status === 0 ? undefined : err.status, err.code);
        throw new SosSendError(undefined);
      }
    },
  };
  let active = false;
  let userId: string | null = null;
  let ctx: SosContext = EMPTY_SOS_CONTEXT;
  const ctxListeners = new Set<() => void>();
  const ctxKey = (u: string) => `vt.${namespace}ctx.${u}`;
  const drain = (force = false) => {
    if (active) void queue.drain(transport, force).catch(() => undefined);
  };
  const emitCtx = () => ctxListeners.forEach((l) => l());

  const channel: SosChannel = {
    audience,
    queue,
    async raise(input = {}) {
      // The explicit trip (trip screen) wins; else the remembered current trip while it is still current.
      const tripId = input.tripId ?? sosTripIdAt(ctx, Date.now());
      const item = await queue.raise({ tripId, note: input.note });
      drain(true);
      return item;
    },
    retry(clientIncidentId) {
      void queue.retry(clientIncidentId).then((ok) => ok && drain(true));
    },
    setContext(patch) {
      const next = mergeSosContext(ctx, patch);
      if (!next) return;
      ctx = next;
      emitCtx();
      if (userId) void secureStore.set(ctxKey(userId), JSON.stringify(next)).catch(() => undefined);
    },
    context: () => ctx,
    subscribeContext(l) {
      ctxListeners.add(l);
      return () => {
        ctxListeners.delete(l);
      };
    },
  };

  /**
   * Loads the signed-in user's queue for this audience (null = not this audience / signed out: unload; rows stay on
   * the phone for that user's next sign-in), retries pending SOS, and refreshes the latest receipt every 15 s.
   */
  function useLifecycle(uid: string | null) {
    useEffect(() => {
      if (!uid) {
        active = false;
        userId = null;
        ctx = EMPTY_SOS_CONTEXT;
        emitCtx();
        queue.unload();
        return;
      }
      let stopped = false;
      userId = uid;
      void secureStore
        .get(ctxKey(uid))
        .then((raw) => {
          // A context set by a screen before the keystore answered is newer: keep it.
          if (!stopped && ctx === EMPTY_SOS_CONTEXT) {
            ctx = parseSosContext(raw);
            emitCtx();
          }
        })
        .catch(() => undefined);
      void queue.load(uid).then(() => {
        if (stopped) return;
        active = true;
        drain(true);
      });
      const tick = setInterval(() => {
        if (queue.due()) drain();
      }, 1_000);
      const poll = setInterval(() => {
        const latest = queue.snapshot().latest;
        const incidentId = latest?.receipt?.incidentId;
        if (!latest || latest.state !== 'RECEIVED' || !incidentId || latest.receipt?.resolvedAt) return;
        void api
          .get<SosReceipt>(`${path}/${incidentId}`)
          .then((r) => queue.updateReceipt(latest.clientIncidentId, r))
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
    }, [uid]);
  }

  return { channel, useLifecycle };
}

const passenger = createChannel('passenger', 'sos', SOS_ROUTES.passenger);
const driver = createChannel('driver', 'dsos', SOS_ROUTES.driver);

export const passengerSos: SosChannel = passenger.channel;
export const driverSos: SosChannel = driver.channel;

export function sosChannelFor(audience: SosAudience): SosChannel {
  return audience === 'driver' ? driverSos : passengerSos;
}

/** Back-compat names (WP 5.3): the passenger queue. */
export const sosQueue = passengerSos.queue;
export const raiseSos = (input: { tripId?: string | null; note?: string | null }) => passengerSos.raise(input);
export const retrySos = (clientIncidentId: string) => passengerSos.retry(clientIncidentId);

export function useSosQueue(channel: SosChannel = passengerSos) {
  return useSyncExternalStore(
    (l) => channel.queue.subscribe(l),
    () => channel.queue.snapshot(),
  );
}

export function useSosContext(channel: SosChannel): SosContext {
  return useSyncExternalStore(channel.subscribeContext, channel.context);
}

/** Passenger SOS queue of the signed-in user (null = none). */
export function useSosQueueLifecycle(userId: string | null) {
  passenger.useLifecycle(userId);
}

/** Driver SOS queue of the signed-in user (null = none). */
export function useDriverSosLifecycle(userId: string | null) {
  driver.useLifecycle(userId);
}

// ───────────────────────────── Offline identity (offline cold start) ─────────────────────────────

const OFFLINE_KEY = 'vt.etmsOffline';

export async function loadOfflineIdentity(): Promise<OfflineIdentity | null> {
  try {
    return parseOfflineIdentity(await SecureStore.getItemAsync(OFFLINE_KEY));
  } catch {
    return null;
  }
}

let lastSaved: string | null = null;
/** Remembers (or forgets) which SOS sections the signed-in user has, for an offline cold start. */
export function rememberOfflineIdentity(userId: string | null | undefined, roles: { passenger: boolean; driver: boolean } | null | undefined): void {
  const id = offlineIdentityFor(userId, roles);
  const raw = id ? JSON.stringify(id) : '';
  if (raw === lastSaved) return;
  lastSaved = raw;
  (id ? SecureStore.setItemAsync(OFFLINE_KEY, raw) : SecureStore.deleteItemAsync(OFFLINE_KEY)).catch(() => undefined);
}

export function forgetOfflineIdentity(): void {
  lastSaved = '';
  SecureStore.deleteItemAsync(OFFLINE_KEY).catch(() => undefined);
}

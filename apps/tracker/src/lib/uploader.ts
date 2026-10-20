import { api, ApiError, type Point } from './api';
import { clearQueue, enqueue, peek, remove } from './db';
import { getToken, setToken, store } from './state';
import { S } from './strings';
import { applyConfig, stopTracking, stopUpdates } from './tracking';

const MAX_BATCH = 500;
const BACKOFF_BASE_MS = 5_000;
const BACKOFF_MAX_MS = 10 * 60_000;
const INACTIVE_RECHECK_MS = 60 * 60_000;

let running: Promise<void> | null = null;

/** Clears the token and local data and stops tracking. `notice` is shown on the activation screen. */
export async function signOut(notice: string | null): Promise<void> {
  await stopTracking();
  await setToken(null);
  clearQueue();
  store.setBlocked(null);
  store.setLastT(0);
  store.patchStatus({ lastError: null, failures: 0, backoffUntil: 0 });
  store.setNotice(notice);
  store.setSession(null);
}

/** Handles auth / inactive errors from any tracker call. Returns true when the error was one of those. */
export async function handleAuthError(e: unknown): Promise<boolean> {
  if (!(e instanceof ApiError)) return false;
  if (e.status === 401) {
    await signOut(e.code === 'REVOKED' ? S.reasonRevoked : S.reasonInvalid);
    return true;
  }
  if (e.status === 403 && e.code === 'INACTIVE') {
    // Keep the token; stop the location service and look again in an hour.
    store.setWanted(false);
    await stopUpdates();
    const now = Date.now();
    store.setBlocked({ code: 'INACTIVE', at: now, nextCheckAt: now + INACTIVE_RECHECK_MS });
    return true;
  }
  return false;
}

/** Uploads queued points oldest first, in batches. Only one upload runs at a time. `force` ignores the backoff. */
export function flush(force = false): Promise<void> {
  if (!running) running = doFlush(force).finally(() => (running = null));
  return running;
}

async function doFlush(force: boolean): Promise<void> {
  const token = await getToken();
  if (!token || store.blocked()) return;
  const st = store.status();
  if (!force && st.backoffUntil && Date.now() < st.backoffUntil) return;

  for (let round = 0; round < 50; round++) {
    const batch = peek(Math.min(MAX_BATCH, Math.max(1, store.config().batchMax || 100)));
    if (!batch.length) return;
    try {
      const res = await api.positions(token, batch);
      remove(batch.map((p) => p.t));
      store.patchStatus({ lastUploadAt: Date.now(), lastError: null, failures: 0, backoffUntil: 0 });
      await applyConfig(res?.config);
    } catch (e) {
      if (await handleAuthError(e)) return;
      if (e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429) {
        // The server rejected this batch's content: drop it rather than retrying it for ever.
        remove(batch.map((p) => p.t));
        store.patchStatus({ lastError: e.message });
        continue;
      }
      const failures = (store.status().failures ?? 0) + 1;
      const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.min(failures - 1, 10));
      store.patchStatus({ failures, backoffUntil: Date.now() + delay, lastError: e instanceof Error ? e.message : String(e) });
      return;
    }
  }
}

/** Sends one SOS point straight away; if that fails it is queued. Returns true when the server accepted it. */
export async function sendSos(point: Point): Promise<boolean> {
  const token = await getToken();
  if (!token) return false;
  try {
    await api.positions(token, [{ ...point, sos: true }]);
    return true;
  } catch (e) {
    if (await handleAuthError(e)) return false;
    enqueue([{ ...point, sos: true }]);
    return false;
  }
}

/** Hourly check while blocked by INACTIVE: if /me works again, clear the block (the user starts tracking again). */
export async function recheckBlocked(): Promise<void> {
  const b = store.blocked();
  const token = await getToken();
  if (!b || !token || Date.now() < b.nextCheckAt) return;
  try {
    const me = await api.me(token);
    store.setBlocked(null);
    store.setSession({ uniqueId: me.uniqueId, objectName: me.objectName, companyName: me.companyName });
    await applyConfig(me.config);
  } catch (e) {
    if (!(await handleAuthError(e))) store.setBlocked({ ...b, nextCheckAt: Date.now() + INACTIVE_RECHECK_MS });
  }
}

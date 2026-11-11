import type { KeyValueStore } from './event-queue';

/**
 * The driver's `GET /api/driver/v1/sync` cursor, kept across app restarts (pure, `node --test`). Stored per user in the
 * same SecureStore as the event queue (key `vt.dsync.<userId>`; only an ISO time, nothing personal). A stored cursor is
 * used only while it is plausible: a valid time, not in the device's future beyond the allowed clock skew, and not
 * older than the server's own look-back (DRIVER_LIMITS.maxPastHours = 48 h; kept literal so this module has no runtime
 * import). Anything else is dropped and the app asks without a cursor (the server then sends its full window, which is
 * always safe: the client is idempotent).
 */
export const SYNC_CURSOR_MAX_AGE_MS = 48 * 3600_000;
const FUTURE_SKEW_MS = 2 * 60_000;

export function syncCursorKey(userId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(userId)) throw new Error('Invalid user id for the sync cursor');
  return `vt.dsync.${userId}`;
}

/** The cursor if it is still usable at `nowMs`, else null. */
export function usableCursor(raw: string | null | undefined, nowMs: number): string | null {
  if (!raw) return null;
  const t = Date.parse(raw);
  if (!Number.isFinite(t)) return null;
  if (t > nowMs + FUTURE_SKEW_MS) return null;
  if (nowMs - t > SYNC_CURSOR_MAX_AGE_MS) return null;
  return new Date(t).toISOString();
}

/** Reads the stored cursor of `userId` (null when none, unusable, or the store fails). */
export async function loadSyncCursor(store: KeyValueStore, userId: string, nowMs: number = Date.now()): Promise<string | null> {
  try {
    const raw = await store.get(syncCursorKey(userId));
    const ok = usableCursor(raw, nowMs);
    if (raw && !ok) await store.delete(syncCursorKey(userId)).catch(() => undefined);
    return ok;
  } catch {
    return null;
  }
}

/** Stores the cursor the server returned (best effort: a failed write only means a larger next sync). */
export async function saveSyncCursor(store: KeyValueStore, userId: string, cursor: string): Promise<void> {
  if (!usableCursor(cursor, Date.now())) return;
  try {
    await store.set(syncCursorKey(userId), cursor);
  } catch {
    /* best effort */
  }
}

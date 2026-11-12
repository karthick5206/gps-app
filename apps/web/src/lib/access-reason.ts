import { accessReasonKey, decodeStoredReason, encodeStoredReason } from './transport-context';

/**
 * The Super Admin's reason for reading a customer's passenger data (ETMS 10 §2.2 item 8), remembered per data-owner
 * company for 30 minutes (security review L8; ACCESS_REASON_TTL_MS), in sessionStorage (private mode / blocked storage
 * just means asking again). `scope` = the data-owner company (see reasonScopeOf / reasonScopeFromError).
 */
type Listener = () => void;
const listeners = new Set<Listener>();
const memory = new Map<string, string>();

function read(key: string): string | null {
  try {
    return sessionStorage.getItem(key) ?? memory.get(key) ?? null;
  } catch {
    return memory.get(key) ?? null;
  }
}

export function rememberedAccessReason(actingCompanyId: string | null, scope: string | null, now: number = Date.now()): string | null {
  const key = accessReasonKey(actingCompanyId, scope);
  const reason = decodeStoredReason(read(key), now);
  if (!reason && read(key)) forget(key); // expired: drop it
  return reason;
}

export function rememberAccessReason(actingCompanyId: string | null, scope: string | null, reason: string, now: number = Date.now()): void {
  const key = accessReasonKey(actingCompanyId, scope);
  const value = encodeStoredReason(reason, now);
  memory.set(key, value);
  try {
    sessionStorage.setItem(key, value);
  } catch {
    /* private mode */
  }
  listeners.forEach((l) => l());
}

function forget(key: string): void {
  memory.delete(key);
  try {
    sessionStorage.removeItem(key);
  } catch {
    /* private mode */
  }
}

export function forgetAccessReason(actingCompanyId: string | null, scope: string | null): void {
  forget(accessReasonKey(actingCompanyId, scope));
  listeners.forEach((l) => l());
}

export function subscribeAccessReason(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

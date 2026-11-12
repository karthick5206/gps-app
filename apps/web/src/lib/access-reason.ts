import { accessReasonKey } from './transport-context';

/**
 * The Super Admin's reason for reading a customer's passenger data (ETMS 10 §2.2 item 8), remembered per acting
 * company for this browser session only (sessionStorage; private mode / blocked storage just means asking again).
 */
type Listener = () => void;
const listeners = new Set<Listener>();
const memory = new Map<string, string>();

export function rememberedAccessReason(companyId: string | null): string | null {
  const key = accessReasonKey(companyId);
  try {
    return sessionStorage.getItem(key) ?? memory.get(key) ?? null;
  } catch {
    return memory.get(key) ?? null;
  }
}

export function rememberAccessReason(companyId: string | null, reason: string): void {
  const key = accessReasonKey(companyId);
  memory.set(key, reason);
  try {
    sessionStorage.setItem(key, reason);
  } catch {
    /* private mode */
  }
  listeners.forEach((l) => l());
}

export function forgetAccessReason(companyId: string | null): void {
  const key = accessReasonKey(companyId);
  memory.delete(key);
  try {
    sessionStorage.removeItem(key);
  } catch {
    /* private mode */
  }
  listeners.forEach((l) => l());
}

export function subscribeAccessReason(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

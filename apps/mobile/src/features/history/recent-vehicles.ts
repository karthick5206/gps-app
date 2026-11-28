import * as SecureStore from 'expo-secure-store';

/** Vehicles whose history was opened most recently (newest first), so the History tab lists them on top. */
const KEY = 'history.recentVehicles';
const MAX = 8;

export async function loadRecentVehicles(): Promise<string[]> {
  try {
    const v = await SecureStore.getItemAsync(KEY);
    const ids = v ? (JSON.parse(v) as unknown) : [];
    return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function pushRecent(list: readonly string[], id: string, max = MAX): string[] {
  return [id, ...list.filter((x) => x !== id)].slice(0, max);
}

export async function rememberVehicle(id: string): Promise<void> {
  const next = pushRecent(await loadRecentVehicles(), id);
  await SecureStore.setItemAsync(KEY, JSON.stringify(next)).catch(() => undefined);
}

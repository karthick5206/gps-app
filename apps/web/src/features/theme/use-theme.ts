import { useSyncExternalStore } from 'react';
import { themeStore } from './theme-store';

export function useTheme() {
  const preference = useSyncExternalStore(themeStore.subscribe, themeStore.getPreference);
  const resolved = useSyncExternalStore(themeStore.subscribe, themeStore.getResolved);
  return { preference, resolved };
}

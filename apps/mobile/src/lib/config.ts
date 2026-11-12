import * as SecureStore from 'expo-secure-store';
import { useSyncExternalStore } from 'react';

/**
 * Servers the app can talk to. Live (production) is the default; "Demo account" on the sign-in screen switches the
 * phone to the demo server. Override per build with EXPO_PUBLIC_SERVER_URL / EXPO_PUBLIC_DEMO_SERVER_URL.
 */
const trim = (url: string) => url.replace(/\/+$/, '');
export const LIVE_SERVER_URL = trim(process.env.EXPO_PUBLIC_SERVER_URL || 'https://app.veetrax.com');
export const DEMO_SERVER_URL = trim(process.env.EXPO_PUBLIC_DEMO_SERVER_URL || 'https://gps.mintplus.co.in');

/**
 * Which server this phone uses: saved on the phone, restored at start (before the first API call, with session.load).
 * Only changed from the sign-in screen while signed out: tokens from one server are not valid on the other.
 */
const DEMO_KEY = 'vt.demoServer';
const listeners = new Set<() => void>();
let demo = false;

export const serverChoice = {
  isDemo: () => demo,
  set(next: boolean) {
    if (next === demo) return;
    demo = next;
    SecureStore.setItemAsync(DEMO_KEY, next ? '1' : '0').catch(() => undefined);
    listeners.forEach((l) => l());
  },
  async restore() {
    try {
      demo = (await SecureStore.getItemAsync(DEMO_KEY)) === '1';
      listeners.forEach((l) => l());
    } catch {
      /* keystore unavailable: live server */
    }
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

/** Server in use, read at call time (API client, live socket, links opened from handlers). */
export const serverUrl = (): string => (demo ? DEMO_SERVER_URL : LIVE_SERVER_URL);
export const apiUrl = (): string => `${serverUrl()}/api`;

/** For render: re-renders when the choice changes (React Compiler would otherwise keep a stale module value). */
export function useDemoServer(): boolean {
  return useSyncExternalStore(serverChoice.subscribe, serverChoice.isDemo);
}
export function useServerUrl(): string {
  return useDemoServer() ? DEMO_SERVER_URL : LIVE_SERVER_URL;
}

/** Basemaps: the same OpenFreeMap styles as the web map. */
export const MAP_STYLE = {
  standard: process.env.EXPO_PUBLIC_MAP_STYLE_STANDARD || 'https://tiles.openfreemap.org/styles/liberty',
  light: process.env.EXPO_PUBLIC_MAP_STYLE_LIGHT || 'https://tiles.openfreemap.org/styles/positron',
  dark: process.env.EXPO_PUBLIC_MAP_STYLE_DARK || 'https://tiles.openfreemap.org/styles/dark',
} as const;

/**
 * Self-hosted basemap styles ONLY ("nothing leaves the server", gate G8): the build's EXPO_PUBLIC_MAP_STYLE_* values
 * with no third-party fallback. Employee-transport screens (passenger and driver) use these; when a build does not set
 * them, those screens show text instead of a map rather than loading OpenFreeMap tiles. Each variable is read by its
 * full name so Expo inlines it at build time.
 */
export const SELF_HOSTED_MAP_STYLE = {
  standard: process.env.EXPO_PUBLIC_MAP_STYLE_STANDARD || null,
  light: process.env.EXPO_PUBLIC_MAP_STYLE_LIGHT || null,
  dark: process.env.EXPO_PUBLIC_MAP_STYLE_DARK || null,
} as const;

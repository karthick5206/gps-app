import * as SecureStore from 'expo-secure-store';

/**
 * Server the app talks to, chosen on the sign-in screen: the live VeeTrax server, or the demo server ("Demo account").
 * A session belongs to the server that issued it, so the choice only changes while signed out.
 * EXPO_PUBLIC_SERVER_URL (e.g. in .env.local) pins one server for development and hides the choice.
 */

export const LIVE_SERVER_URL = 'https://app.veetrax.com';
export const DEMO_SERVER_URL = 'https://gps.mintplus.co.in';

export type ServerChoice = 'live' | 'demo';

const PINNED = (process.env.EXPO_PUBLIC_SERVER_URL || '').replace(/\/+$/, '') || null;
const KEY = 'vt.server';

let choice: ServerChoice = 'live';

/** True when the build pins a server (no Live / Demo choice on the sign-in screen). */
export const serverPinned = PINNED !== null;

export const serverChoice = (): ServerChoice => choice;
export const isDemo = () => choice === 'demo';

export function serverUrl(): string {
  return PINNED ?? (choice === 'demo' ? DEMO_SERVER_URL : LIVE_SERVER_URL);
}

export const apiUrl = () => `${serverUrl()}/api`;

/** Host name for display, e.g. "app.veetrax.com". */
export const serverHost = () => serverUrl().replace(/^https?:\/\//, '');

/** Sign-in screen only (signed out). */
export function setServerChoice(next: ServerChoice): void {
  choice = next;
  SecureStore.setItemAsync(KEY, next).catch(() => undefined);
}

/**
 * Run at start-up, before the first API call. Installs from before this choice existed all signed in on the demo
 * server's address (then the only one): with a saved session they stay there instead of being signed out.
 * A fresh install starts on the live server.
 */
export async function loadServerChoice(hasSession: boolean): Promise<void> {
  let saved: string | null = null;
  try {
    saved = await SecureStore.getItemAsync(KEY);
  } catch {
    saved = null;
  }
  if (saved === 'live' || saved === 'demo') choice = saved;
  else setServerChoice(hasSession ? 'demo' : 'live');
}

/** Basemaps: the same OpenFreeMap styles as the web map. */
export const MAP_STYLE = {
  standard: process.env.EXPO_PUBLIC_MAP_STYLE_STANDARD || 'https://tiles.openfreemap.org/styles/liberty',
  light: process.env.EXPO_PUBLIC_MAP_STYLE_LIGHT || 'https://tiles.openfreemap.org/styles/positron',
  dark: process.env.EXPO_PUBLIC_MAP_STYLE_DARK || 'https://tiles.openfreemap.org/styles/dark',
} as const;

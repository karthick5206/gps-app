import * as Tracker from '../../modules/veetrax-tracker';
import { kvGet, kvSet } from './db';

/**
 * Which server this phone reports to, chosen on the activation screen: the live VeeTrax server, or the demo server
 * ("Demo account"). A token belongs to the server that issued it, so the choice is fixed while signed in and can
 * only change on the activation screen.
 */

export const LIVE_SERVER_URL = 'https://app.veetrax.com';
export const DEMO_SERVER_URL = 'https://gps.mintplus.co.in';

export type ServerChoice = 'live' | 'demo';

const KEY = 'server';

const urlOf = (choice: ServerChoice) => (choice === 'demo' ? DEMO_SERVER_URL : LIVE_SERVER_URL);
const sameUrl = (a: string, b: string) => a.replace(/\/+$/, '').toLowerCase() === b.toLowerCase();

let cached: ServerChoice | null = null;

export function serverChoice(): ServerChoice {
  if (!cached) cached = kvGet<ServerChoice | null>(KEY, null) ?? 'live';
  return cached;
}

export function serverUrl(): string {
  return urlOf(serverChoice());
}

export const isDemo = () => serverChoice() === 'demo';

/** Activation screen only (signed out). */
export function setServerChoice(choice: ServerChoice): void {
  cached = choice;
  kvSet(KEY, choice);
}

/**
 * Run once at start-up, before any API call. Installs from before this choice existed were all activated on the
 * demo server's address (then the only one): they stay there instead of being signed out. Decided by the server the
 * native engine holds a token for, else by an existing session; a fresh install starts on the live server.
 */
export async function initServerChoice(): Promise<void> {
  if (kvGet<ServerChoice | null>(KEY, null)) return;
  const st = await Tracker.getStatus().catch(() => null);
  let choice: ServerChoice = 'live';
  if (st?.hasToken) choice = sameUrl(st.serverUrl, LIVE_SERVER_URL) ? 'live' : 'demo';
  else if (kvGet<unknown>('session', null)) choice = 'demo';
  setServerChoice(choice);
}

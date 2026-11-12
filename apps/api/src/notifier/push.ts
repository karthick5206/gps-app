/**
 * Mobile push via the Expo push service (https://docs.expo.dev/push-notifications/sending-notifications/).
 * Expo relays to FCM (Android) and APNs (iOS) with the credentials configured for the app in EAS, so the server
 * needs no Firebase/Apple keys. Optional EXPO_ACCESS_TOKEN enables "enhanced push security" on the Expo project.
 * PUSH_PROVIDER=none disables sending (pushes are logged as SKIPPED). PUSH_PROVIDER=fake (tests only, refused in
 * production) records the messages in a local file instead of sending them.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { isEmergencyAlert } from '@veetracer/shared';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const TIMEOUT_MS = 10_000;
/** Expo accepts at most 100 messages per request. */
const BATCH = 100;

export interface PushMessage {
  title: string;
  body: string;
  data?: Record<string, unknown>;
  /** Android notification channel created by the app ('alerts' plays the alert sound). */
  channelId?: string;
  /** 'default', or a sound file bundled in the app (iOS plays it by name; Android uses the channel's sound). */
  sound?: string;
}

/**
 * SOS / crash pushes, and every alert of a vehicle in parking mode, use the app's 'sos' channel (bundled siren, may
 * break through Do Not Disturb); everything else the normal alert channel.
 */
export function pushStyle(alertType: unknown, parkingAlarm = false): Pick<PushMessage, 'channelId' | 'sound'> {
  return parkingAlarm || (typeof alertType === 'string' && isEmergencyAlert(alertType)) ? { channelId: 'sos', sound: 'sos_siren.wav' } : { channelId: 'alerts', sound: 'default' };
}

/**
 * ETMS push payload (D7 / L4, doc 02 §8.3): exactly `{ kind, tripId, notificationId }` — whatever else the caller
 * passed is dropped, so no name, phone, address, plate or coordinate can reach Expo / FCM / APNs through `data`.
 */
export function transportPushData(data: Record<string, unknown>): Record<string, unknown> {
  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  return { kind: str(data.kind), tripId: str(data.tripId), notificationId: str(data.notificationId) };
}

export interface PushResult {
  /** Tokens accepted by the push service. */
  sent: number;
  /** Tokens the service says are no longer valid (app uninstalled / signed out): delete them. */
  invalidTokens: string[];
  /** First error message for tokens that failed for another reason. */
  error: string | null;
  /** D6 G3: Expo ticket ids of the accepted messages (stored as the provider message id). */
  ticketIds?: string[];
}

interface ExpoTicket {
  status: 'ok' | 'error';
  id?: string;
  message?: string;
  details?: { error?: string };
}

export interface PushProvider {
  readonly name: string;
  readonly enabled: boolean;
  send(tokens: string[], message: PushMessage): Promise<PushResult>;
}

export class ExpoPushProvider implements PushProvider {
  readonly name = 'expo';
  readonly enabled = true;

  constructor(private readonly accessToken: string | undefined = process.env.EXPO_ACCESS_TOKEN || undefined) {}

  async send(tokens: string[], m: PushMessage): Promise<PushResult> {
    const result: PushResult = { sent: 0, invalidTokens: [], error: null, ticketIds: [] };
    for (let i = 0; i < tokens.length; i += BATCH) {
      const chunk = tokens.slice(i, i + BATCH);
      const res = await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          ...(this.accessToken ? { Authorization: `Bearer ${this.accessToken}` } : {}),
        },
        body: JSON.stringify(
          chunk.map((to) => ({ to, title: m.title, body: m.body, data: m.data ?? {}, sound: m.sound ?? 'default', priority: 'high', channelId: m.channelId ?? 'alerts' })),
        ),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`Expo push HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const { data } = (await res.json()) as { data?: ExpoTicket[] };
      (data ?? []).forEach((ticket, j) => {
        if (ticket.status === 'ok') {
          result.sent++;
          if (ticket.id) result.ticketIds!.push(ticket.id);
        }
        else if (ticket.details?.error === 'DeviceNotRegistered') result.invalidTokens.push(chunk[j]);
        else result.error ??= ticket.message ?? ticket.details?.error ?? 'Push failed';
      });
    }
    return result;
  }
}

export class DisabledPushProvider implements PushProvider {
  readonly name = 'none';
  readonly enabled = false;
  send(): Promise<PushResult> {
    return Promise.reject(new Error('Push not configured'));
  }
}

/**
 * Test provider (PUSH_PROVIDER=fake; E5 WP 5.5 harness): nothing leaves the machine. Each message is appended as one
 * JSON line ({ at, tokens, title, body, data, channelId, ticketIds }) to PUSH_FAKE_LOG (default var/push/push.log) and
 * reported as accepted with a synthetic `fake-…` ticket id, so the notifier's SENT path and the push payload can be
 * asserted. A token containing `Unregistered` is answered DeviceNotRegistered (the token clean-up path).
 */
export class FakePushProvider implements PushProvider {
  readonly name = 'fake';
  readonly enabled = true;
  constructor(private readonly file: string = resolve(process.env.PUSH_FAKE_LOG || 'var/push/push.log')) {}

  send(tokens: string[], m: PushMessage): Promise<PushResult> {
    const invalidTokens = tokens.filter((t) => t.includes('Unregistered'));
    const ok = tokens.filter((t) => !invalidTokens.includes(t));
    const ticketIds = ok.map(() => `fake-${randomUUID()}`);
    mkdirSync(dirname(this.file), { recursive: true });
    appendFileSync(this.file, `${JSON.stringify({ at: new Date().toISOString(), tokens: ok, title: m.title, body: m.body, data: m.data ?? {}, channelId: m.channelId ?? 'alerts', ticketIds })}\n`);
    return Promise.resolve({ sent: ok.length, invalidTokens, error: null, ticketIds });
  }
}

/** PUSH_PROVIDER: expo (default) | none | fake. `fake` is refused in production: pushes are then SKIPPED, never faked. */
export function createPushProvider(env: NodeJS.ProcessEnv = process.env): PushProvider {
  const name = (env.PUSH_PROVIDER ?? 'expo').toLowerCase();
  if (name === 'none') return new DisabledPushProvider();
  if (name === 'fake') return env.NODE_ENV === 'production' ? new DisabledPushProvider() : new FakePushProvider();
  return new ExpoPushProvider();
}

/**
 * Mobile push via the Expo push service (https://docs.expo.dev/push-notifications/sending-notifications/).
 * Expo relays to FCM (Android) and APNs (iOS) with the credentials configured for the app in EAS, so the server
 * needs no Firebase/Apple keys. Optional EXPO_ACCESS_TOKEN enables "enhanced push security" on the Expo project.
 * PUSH_PROVIDER=none disables sending (pushes are logged as SKIPPED).
 */

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

/** SOS / crash pushes use the app's 'sos' channel and bundled siren; everything else the normal alert channel. */
export function pushStyle(alertType: unknown): Pick<PushMessage, 'channelId' | 'sound'> {
  return typeof alertType === 'string' && isEmergencyAlert(alertType) ? { channelId: 'sos', sound: 'sos_siren.wav' } : { channelId: 'alerts', sound: 'default' };
}

export interface PushResult {
  /** Tokens accepted by the push service. */
  sent: number;
  /** Tokens the service says are no longer valid (app uninstalled / signed out): delete them. */
  invalidTokens: string[];
  /** First error message for tokens that failed for another reason. */
  error: string | null;
}

interface ExpoTicket {
  status: 'ok' | 'error';
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
    const result: PushResult = { sent: 0, invalidTokens: [], error: null };
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
        if (ticket.status === 'ok') result.sent++;
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

export function createPushProvider(): PushProvider {
  return (process.env.PUSH_PROVIDER ?? 'expo').toLowerCase() === 'none' ? new DisabledPushProvider() : new ExpoPushProvider();
}

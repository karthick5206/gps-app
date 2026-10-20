import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { router } from 'expo-router';
import { Platform } from 'react-native';
import { isEmergencyAlert } from '@veetracer/shared';
import { api } from '@/lib/api';
import { i18n } from '@/lib/i18n';

/**
 * Push alerts: the app registers its Expo push token with the API after sign-in; the notifier sends alerts for
 * the PUSH channel to every signed-in install of the user. Tapping a notification opens the alert.
 *
 * Needs an EAS project id (app.json → extra.eas.projectId) and, on Android, Firebase (google-services.json);
 * without them registration is skipped and the rest of the app works normally.
 */

let registeredToken: string | null = null;
/** Last registration outcome for the settings screen: null = registered, else the reason it is off (English; translated where shown). */
export let pushStatus: string | null = 'Not registered yet';

export const SOS_CHANNEL = 'sos';
export const SOS_SOUND = 'sos_siren.wav';

// In the foreground an emergency opens the SOS screen, which loops the siren itself: no second sound.
Notifications.setNotificationHandler({
  handleNotification: async (n) => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: !isEmergencyAlert(n.request.content.data?.type as string | undefined) && !n.request.content.data?.sosTest,
    shouldSetBadge: false,
  }),
});

function projectId(): string | undefined {
  return (Constants.expoConfig?.extra?.eas as { projectId?: string } | undefined)?.projectId ?? Constants.easConfig?.projectId;
}

/**
 * Android notification channels. 'sos' (SOS / crash) plays the bundled siren at MAX importance and may bypass
 * Do Not Disturb once the user allows it. A channel's sound and importance are fixed once created on the phone.
 */
export async function ensureChannels(): Promise<void> {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync('alerts', {
    name: i18n.t('Alerts'),
    importance: Notifications.AndroidImportance.HIGH,
    vibrationPattern: [0, 250, 250, 250],
    lightColor: '#0e5e57',
  });
  await Notifications.setNotificationChannelAsync(SOS_CHANNEL, {
    name: i18n.t('SOS / Emergency'),
    importance: Notifications.AndroidImportance.MAX,
    sound: SOS_SOUND,
    vibrationPattern: [0, 800, 400, 800, 400, 800],
    bypassDnd: true,
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
    enableLights: true,
    lightColor: '#ff0000',
    enableVibrate: true,
  });
}

/** Asks for permission (once) and registers this install. Returns why it didn't, or null on success. */
export async function registerForPush(): Promise<string | null> {
  try {
    pushStatus = await register();
  } catch (err) {
    pushStatus = (err as Error).message;
  }
  return pushStatus;
}

async function register(): Promise<string | null> {
  if (!Device.isDevice) return 'Push needs a real phone';
  const id = projectId();
  if (!id) return 'Push not set up for this build';
  await ensureChannels();
  let { status } = await Notifications.getPermissionsAsync();
  if (status !== 'granted') status = (await Notifications.requestPermissionsAsync()).status;
  if (status !== 'granted') return 'Notifications are turned off for VeeTrax';
  const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId: id });
  await api.post('/auth/push-token', { token, platform: Platform.OS === 'ios' ? 'ios' : 'android', deviceName: Device.deviceName ?? Device.modelName ?? undefined });
  registeredToken = token;
  pushStatus = null;
  return null;
}

/** Asks the server to send a test notification to this phone. Returns null when sent, else the reason. */
export async function sendTestPush(): Promise<string | null> {
  if (!registeredToken) return pushStatus ?? 'Not registered yet';
  const res = await api.post<{ sent: boolean; error: string | null }>('/auth/push-token/test', { token: registeredToken });
  return res.sent ? null : (res.error ?? 'Push failed');
}

/** Stops pushes to this install (before signing out). */
export async function unregisterPush(): Promise<void> {
  const token = registeredToken;
  registeredToken = null;
  if (token) await api.post('/auth/push-token/remove', { token }, { anonymous: true }).catch(() => undefined);
}

/** Alert ids whose SOS screen was already opened in this app session (a push and its tap must not open it twice). */
const openedSos = new Set<string>();

/** Opens the full-screen SOS alarm once per alert; `test` opens it without an alert (no API calls). */
export function openSos(alertId: string, test = false): void {
  if (!test && openedSos.has(alertId)) return;
  if (!test) openedSos.add(alertId);
  router.push({ pathname: '/sos/[id]', params: test ? { id: 'test', test: '1' } : { id: alertId } });
}

function openFromNotification(n: Notifications.Notification, tapped: boolean): void {
  const data = n.request.content.data ?? {};
  if (data.sosTest) return openSos('test', true);
  const alertId = data.alertId;
  if (typeof alertId !== 'string') return;
  if (isEmergencyAlert(data.type as string | undefined) && !openedSos.has(alertId)) openSos(alertId);
  else if (tapped) router.push(`/alert/${alertId}`);
}

/**
 * Tapped notifications open the alert (emergencies: the SOS screen), also when the tap launched the app.
 * Emergency pushes received while the app is open go straight to the SOS screen.
 */
export function handleNotificationTaps(): () => void {
  // iOS keeps returning the last tapped notification on every launch until it is cleared; without clearing, an old
  // SOS tap re-opened the alarm each time the app started.
  const last = Notifications.getLastNotificationResponse();
  if (last) {
    Notifications.clearLastNotificationResponse();
    openFromNotification(last.notification, true);
  }
  const tap = Notifications.addNotificationResponseReceivedListener((r) => {
    Notifications.clearLastNotificationResponse();
    openFromNotification(r.notification, true);
  });
  const received = Notifications.addNotificationReceivedListener((n) => {
    const data = n.request.content.data ?? {};
    if (isEmergencyAlert(data.type as string | undefined)) openFromNotification(n, false);
  });
  return () => {
    tap.remove();
    received.remove();
  };
}

/** Local test of the emergency channel: siren notification now, and the SOS screen in test mode. */
export async function testEmergencyAlert(): Promise<string | null> {
  await ensureChannels();
  let { status } = await Notifications.getPermissionsAsync();
  if (status !== 'granted') status = (await Notifications.requestPermissionsAsync()).status;
  if (status !== 'granted') return 'Notifications are turned off for VeeTrax';
  await Notifications.scheduleNotificationAsync({
    content: { title: i18n.t('Test: SOS alarm'), body: i18n.t('This is a test. No action is needed.'), sound: SOS_SOUND, data: { sosTest: true }, priority: 'max' },
    trigger: Platform.OS === 'android' ? { channelId: SOS_CHANNEL } : null,
  });
  return null;
}

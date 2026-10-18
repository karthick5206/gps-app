import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { router } from 'expo-router';
import { Platform } from 'react-native';
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

Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
});

function projectId(): string | undefined {
  return (Constants.expoConfig?.extra?.eas as { projectId?: string } | undefined)?.projectId ?? Constants.easConfig?.projectId;
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
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('alerts', {
      name: i18n.t('Alerts'),
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: '#0e5e57',
    });
  }
  let { status } = await Notifications.getPermissionsAsync();
  if (status !== 'granted') status = (await Notifications.requestPermissionsAsync()).status;
  if (status !== 'granted') return 'Notifications are turned off for Veetrax';
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

/** Opens the alert behind a tapped notification (also when the tap launched the app). */
export function handleNotificationTaps(): () => void {
  const open = (r: Notifications.NotificationResponse | null) => {
    const alertId = r?.notification.request.content.data?.alertId;
    if (typeof alertId === 'string') router.push(`/alert/${alertId}`);
  };
  open(Notifications.getLastNotificationResponse());
  const sub = Notifications.addNotificationResponseReceivedListener(open);
  return () => sub.remove();
}

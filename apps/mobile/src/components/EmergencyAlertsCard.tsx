import Constants from 'expo-constants';
import { BellRingIcon, MaximizeIcon, MoonIcon } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, AppState, Linking, Platform, View } from 'react-native';
import { Button, Card, Text } from '@/components/ui';
import { SOS_CHANNEL, testEmergencyAlert } from '@/features/notifications/push';
import { canUseFullScreen, openFullScreenSettings, startAlarm } from '../../modules/veetrax-alarm';
import { errorMessage } from '@/lib/api';
import { SPACE, useColors } from '@/lib/theme';

/** Android 14+: whether full-screen SOS alerts are allowed; re-checked when the user comes back from Settings. */
export function useFullScreenAllowed(): boolean {
  const [allowed, setAllowed] = useState(() => canUseFullScreen());
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') setAllowed(canUseFullScreen());
    });
    return () => sub.remove();
  }, []);
  return allowed;
}

/** Opens Android's settings for the SOS channel (where "Override Do Not Disturb" lives); falls back to the app's settings. */
export async function openSosChannelSettings(): Promise<void> {
  const pkg = Constants.expoConfig?.android?.package ?? 'com.sasvata.veetrax';
  try {
    await Linking.sendIntent('android.settings.CHANNEL_NOTIFICATION_SETTINGS', [
      { key: 'android.provider.extra.APP_PACKAGE', value: pkg },
      { key: 'android.provider.extra.CHANNEL_ID', value: SOS_CHANNEL },
    ]);
  } catch {
    await Linking.openSettings().catch(() => undefined);
  }
}

/**
 * Rings the same loud alarm a real SOS rings when the app is closed. Its notification opens the SOS screen in test mode
 * (no alert is acknowledged). Press Home to hear it as with the app closed.
 */
export async function runEmergencyTest(t: (s: string) => string): Promise<void> {
  try {
    const reason = await testEmergencyAlert();
    if (reason) return Alert.alert(t('Notifications not working'), t(reason));
    startAlarm(t('Test: SOS alarm'), t('This is a test. No action is needed.'), 'test');
  } catch (err) {
    Alert.alert(t('Notifications not working'), errorMessage(err));
  }
}

export function EmergencyAlertsCard() {
  const { t } = useTranslation();
  const c = useColors();
  const fullScreen = useFullScreenAllowed();
  return (
    <Card style={{ gap: SPACE.md }}>
      <Text size="sm">{t('SOS, crash, power cut and tamper alerts play a loud siren and open a full-screen alarm until someone acknowledges them.')}</Text>
      {Platform.OS === 'android' && !fullScreen && (
        // Without it the alarm still rings, the screen wakes and the alert banner keeps coming back; this makes it full screen.
        <View style={{ gap: SPACE.xs, padding: SPACE.md, borderRadius: 12, backgroundColor: c.warningSoft }}>
          <Text size="sm" weight="700">
            {t('Full-screen SOS alerts are off')}
          </Text>
          <Text size="xs" tone="muted">
            {t('The siren still rings and the alert stays at the top of the screen. Allow full screen so the SOS opens over the lock screen.')}
          </Text>
          <Button title={t('Allow full-screen SOS alerts')} icon={MaximizeIcon} onPress={openFullScreenSettings} />
        </View>
      )}
      <Button title={t('Test emergency alert')} icon={BellRingIcon} variant="outline" onPress={() => void runEmergencyTest(t)} />
      {Platform.OS === 'android' && (
        <View style={{ gap: SPACE.xs }}>
          <Button title={t('Allow through Do Not Disturb')} icon={MoonIcon} variant="outline" onPress={() => void openSosChannelSettings()} />
          <Text size="xs" tone="muted">
            {t('Turn on "Override Do Not Disturb" for SOS / Emergency so the siren rings even when the phone is on Do Not Disturb.')}
          </Text>
        </View>
      )}
    </Card>
  );
}

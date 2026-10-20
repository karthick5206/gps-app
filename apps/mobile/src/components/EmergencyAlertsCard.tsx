import Constants from 'expo-constants';
import { BellRingIcon, MoonIcon } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { Alert, Linking, Platform, View } from 'react-native';
import { Button, Card, Text } from '@/components/ui';
import { openSos, SOS_CHANNEL, testEmergencyAlert } from '@/features/notifications/push';
import { errorMessage } from '@/lib/api';
import { SPACE } from '@/lib/theme';

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

/** Plays the siren notification and opens the SOS screen in test mode (no alert is acknowledged). */
export async function runEmergencyTest(t: (s: string) => string): Promise<void> {
  try {
    const reason = await testEmergencyAlert();
    if (reason) return Alert.alert(t('Notifications not working'), t(reason));
    openSos('test', true);
  } catch (err) {
    Alert.alert(t('Notifications not working'), errorMessage(err));
  }
}

export function EmergencyAlertsCard() {
  const { t } = useTranslation();
  return (
    <Card style={{ gap: SPACE.md }}>
      <Text size="sm">{t('SOS, crash, power cut and tamper alerts play a loud siren and open a full-screen alarm until someone acknowledges them.')}</Text>
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

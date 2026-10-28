import { DownloadIcon, SmartphoneIcon } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { Linking, View } from 'react-native';
import { Button, Card, Text } from '@/components/ui';
import { PLAY_STORE } from '@veetracer/shared';
import { SPACE, useColors } from '@/lib/theme';

const POINTS = [
  'Install it on the phone to be tracked (Android 7 or newer).',
  'Open it and enter that phone’s mobile number: a 6-digit code comes by SMS.',
  'Allow location “All the time”: tracking keeps running in the background until Stop is tapped.',
  'Free for 100 days, then a yearly licence. Uses mobile data lightly and saves battery when the phone is still.',
] as const;

/** What the VeeTrax Tracker app is and where to get it (same text as the web TrackerAppInfo). */
export function TrackerAppInfo() {
  const c = useColors();
  const { t } = useTranslation();
  return (
    <Card style={{ gap: SPACE.sm }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE.sm }}>
        <SmartphoneIcon size={18} color={c.primary} />
        <Text weight="600">{t('VeeTrax Tracker app')}</Text>
      </View>
      {POINTS.map((p) => (
        <Text key={p} size="sm" tone="muted">
          • {t(p)}
        </Text>
      ))}
      <Button title={t('Download VeeTrax Tracker')} icon={DownloadIcon} variant="outline" onPress={() => Linking.openURL(PLAY_STORE.tracker).catch(() => undefined)} />
    </Card>
  );
}

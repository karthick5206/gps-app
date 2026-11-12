import { LogOutIcon, RefreshCwIcon, WifiOffIcon } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { Alert, ScrollView, View } from 'react-native';
import { Button, Card, SectionTitle, Text } from '@/components/ui';
import { useAuth } from '@/features/auth/auth';
import { SosContent } from '@/features/transport/SosScreen';
import { useSosQueue, driverSos, passengerSos } from '@/features/transport/sos-store';
import { SPACE, useColors } from '@/lib/theme';

/**
 * Offline cold start (r114, QA B4): the app could not reach the server, and the last signed-in user is an ETMS
 * passenger and / or driver. The session is kept; the SOS works from the phone's queue (sent once the server answers)
 * with the remembered trip and desk phone, and the call buttons need no data connection. The app retries every 15 s
 * and opens the normal screens as soon as the server answers.
 */
export default function OfflineSosScreen() {
  const { t } = useTranslation();
  const c = useColors();
  const { offlineIdentity, retryOnline, signOut } = useAuth();
  const p = useSosQueue(passengerSos);
  const d = useSosQueue(driverSos);
  const pending = p.pending + d.pending;
  const confirmSignOut = () =>
    Alert.alert(
      t('Sign out?'),
      pending ? t('An SOS on this phone has not been sent yet. It is sent after you sign in again.') : t('You can sign in again when you are online.'),
      [
        { text: t('Cancel'), style: 'cancel' },
        { text: t('Sign out'), style: 'destructive', onPress: signOut },
      ],
    );
  const both = !!offlineIdentity?.driver && !!offlineIdentity?.passenger;
  return (
    <ScrollView contentContainerStyle={{ padding: SPACE.lg, paddingTop: SPACE.xl * 2, gap: SPACE.md, paddingBottom: SPACE.xl }}>
      <Card style={{ gap: SPACE.sm }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE.sm }}>
          <WifiOffIcon size={22} color={c.warning} />
          <Text size="lg" weight="700" accessibilityRole="header" style={{ flex: 1 }}>
            {t('No connection')}
          </Text>
        </View>
        <Text size="sm" tone="muted">
          {t('VeeTrax cannot reach the server right now. You can still raise an SOS: it is saved on this phone and sent as soon as the connection returns.')}
        </Text>
        <Button title={t('Try again')} icon={RefreshCwIcon} variant="outline" onPress={retryOnline} />
      </Card>
      {offlineIdentity?.driver ? (
        <>
          {both ? <SectionTitle>{t('Driver SOS')}</SectionTitle> : null}
          <SosContent audience="driver" online={false} />
        </>
      ) : null}
      {offlineIdentity?.passenger ? (
        <>
          {both ? <SectionTitle>{t('Passenger SOS')}</SectionTitle> : null}
          <SosContent audience="passenger" online={false} />
        </>
      ) : null}
      <Button title={t('Sign out')} icon={LogOutIcon} variant="ghost" onPress={confirmSignOut} />
    </ScrollView>
  );
}

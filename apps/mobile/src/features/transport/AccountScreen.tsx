import Constants from 'expo-constants';
import { router } from 'expo-router';
import { LogOutIcon, UserIcon } from 'lucide-react-native';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, ScrollView, View } from 'react-native';
import { DisplaySizeCard } from '@/components/DisplaySizeCard';
import { LanguageChips } from '@/components/LanguageChips';
import { ThemePicker } from '@/components/ThemePicker';
import { Button, Card, InfoRow, SectionTitle, Text } from '@/components/ui';
import { useAuth } from '@/features/auth/auth';
import { pushStatus } from '@/features/notifications/push';
import { useDemoServer, useServerUrl } from '@/lib/config';
import { SPACE, useColors } from '@/lib/theme';

/**
 * Account tab of the Passenger and Driver shells: profile, language (English / हिन्दी / தமிழ்), theme, text size,
 * notifications status, sign out. `pendingEvents` (driver) makes sign-out say that unsynced events stay on the phone.
 */
export function AccountScreen({ children, pendingEvents = 0 }: { children?: ReactNode; pendingEvents?: number }) {
  const { t } = useTranslation();
  const c = useColors();
  const server = useServerUrl();
  const demoServer = useDemoServer();
  const { me, signOut } = useAuth();
  const confirmSignOut = () =>
    Alert.alert(
      t('Sign out?'),
      pendingEvents > 0
        ? t('{{n}} actions are not synced yet. They stay on this phone and are sent when you sign in again with the same account.', { n: pendingEvents })
        : t('You will need to sign in again.'),
      [
        { text: t('Cancel'), style: 'cancel' },
        { text: t('Sign out'), style: 'destructive', onPress: signOut },
      ],
    );
  return (
    <ScrollView contentContainerStyle={{ padding: SPACE.lg, gap: SPACE.md, paddingBottom: SPACE.xl }}>
      <Card onPress={() => router.push('/profile')}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE.md, minHeight: 48 }} accessible accessibilityRole="button" accessibilityLabel={`${t('Profile')}: ${me?.user.name ?? ''}`}>
          <View style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: c.accent, alignItems: 'center', justifyContent: 'center' }}>
            <UserIcon size={24} color={c.primary} />
          </View>
          <View style={{ flex: 1 }}>
            <Text size="lg" weight="700">
              {me?.user.name ?? '—'}
            </Text>
            <Text size="sm" tone="muted">
              {me?.company.name ?? ''}
            </Text>
          </View>
        </View>
      </Card>

      {children}

      <SectionTitle>{t('Language')}</SectionTitle>
      <Card>
        <LanguageChips />
      </Card>

      <SectionTitle>{t('Display size')}</SectionTitle>
      <DisplaySizeCard />

      <SectionTitle>{t('Appearance')}</SectionTitle>
      <Card style={{ paddingVertical: SPACE.xs }}>
        <ThemePicker />
      </Card>

      <SectionTitle>{t('App')}</SectionTitle>
      <Card style={{ paddingVertical: 0 }}>
        <InfoRow label={t('Notifications')} value={pushStatus ? t(pushStatus) : t('On')} />
        <InfoRow label={t('Server')} value={demoServer ? t('Demo server') : server.replace(/^https?:\/\//, '')} />
        <InfoRow label={t('Version')} value={Constants.expoConfig?.version ?? '—'} />
      </Card>

      <Button title={t('Sign out')} icon={LogOutIcon} variant="outline" onPress={confirmSignOut} style={{ marginTop: SPACE.md, minHeight: 48 }} />
    </ScrollView>
  );
}

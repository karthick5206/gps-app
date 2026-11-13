import { router } from 'expo-router';
import { ShieldCheckIcon, UserIcon } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { Button, SectionTitle } from '@/components/ui';
import { AccountScreen } from '@/features/transport/AccountScreen';
import { PushPreferences } from '@/features/transport/passenger/PushPreferences';

export default function PassengerAccountTab() {
  const { t } = useTranslation();
  return (
    <AccountScreen>
      <Button title={t('My transport profile')} icon={UserIcon} variant="outline" onPress={() => router.push('/commute/profile')} style={{ minHeight: 48 }} />
      <Button title={t('Privacy & consent')} icon={ShieldCheckIcon} variant="outline" onPress={() => router.push('/commute/consent')} style={{ minHeight: 48 }} />
      <SectionTitle>{t('Notifications')}</SectionTitle>
      <PushPreferences />
    </AccountScreen>
  );
}

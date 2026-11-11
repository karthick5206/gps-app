import { router } from 'expo-router';
import { ShieldCheckIcon } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui';
import { AccountScreen } from '@/features/transport/AccountScreen';

export default function PassengerAccountTab() {
  const { t } = useTranslation();
  return (
    <AccountScreen>
      <Button title={t('Privacy & consent')} icon={ShieldCheckIcon} variant="outline" onPress={() => router.push('/commute/consent')} style={{ minHeight: 48 }} />
    </AccountScreen>
  );
}

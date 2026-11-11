import { BellIcon } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { ScrollView } from 'react-native';
import { TransportInbox, useTransportNotifications } from '@/features/transport/TransportInbox';
import { TransportEmpty } from '@/features/transport/ui';
import { SPACE } from '@/lib/theme';

export default function DriverInboxTab() {
  const { t } = useTranslation();
  const q = useTransportNotifications('driver');
  return (
    <ScrollView contentContainerStyle={{ padding: SPACE.lg, gap: SPACE.sm, paddingBottom: SPACE.xl }}>
      <TransportInbox audience="driver" />
      {!q.data?.length && <TransportEmpty icon={BellIcon} title={t('No notifications')} description={t('New, changed and cancelled trips are listed here.')} />}
    </ScrollView>
  );
}

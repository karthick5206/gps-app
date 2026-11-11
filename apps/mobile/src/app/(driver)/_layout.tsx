import { Tabs } from 'expo-router';
import { BellIcon, CalendarCheckIcon, RefreshCwIcon, UserIcon } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { useDriverQueue } from '@/features/transport/queue-store';
import { ShellTabs, shellTabIcon } from '@/features/transport/shell';
import { useColors } from '@/lib/theme';

/**
 * Driver shell (doc 09 §2.2, §5; D4 / D5): for a login whose only permission is `etms_driver` (company with `etms`).
 * No background location: the vehicle's GPS device is the tracker. Actions queue offline (Sync tab).
 */
export default function DriverLayout() {
  const { t } = useTranslation();
  const c = useColors();
  const q = useDriverQueue();
  const badge = q.pending + q.rejected;
  return (
    <ShellTabs>
      <Tabs.Screen name="my-duty" options={{ title: t('Today'), tabBarIcon: shellTabIcon(CalendarCheckIcon, c) }} />
      <Tabs.Screen name="driver-inbox" options={{ title: t('Inbox'), tabBarIcon: shellTabIcon(BellIcon, c) }} />
      <Tabs.Screen name="driver-sync" options={{ title: t('Sync'), tabBarBadge: badge ? (badge > 99 ? '99+' : badge) : undefined, tabBarIcon: shellTabIcon(RefreshCwIcon, c) }} />
      <Tabs.Screen name="driver-account" options={{ title: t('Account'), tabBarIcon: shellTabIcon(UserIcon, c) }} />
    </ShellTabs>
  );
}

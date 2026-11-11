import { Tabs } from 'expo-router';
import { BellIcon, BusIcon, TicketIcon, UserIcon } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { ShellTabs, shellTabIcon } from '@/features/transport/shell';
import { useColors } from '@/lib/theme';

/**
 * Passenger shell (doc 08 §4.1; D4): for a login whose only permission is `etms_self` in a company with the `etms`
 * add-on. No fleet tabs, no live socket, no location permission: the passenger's phone is never tracked.
 */
export default function PassengerLayout() {
  const { t } = useTranslation();
  const c = useColors();
  return (
    <ShellTabs>
      <Tabs.Screen name="my-commute" options={{ title: t('My commute'), tabBarIcon: shellTabIcon(BusIcon, c) }} />
      <Tabs.Screen name="my-bookings" options={{ title: t('My bookings'), tabBarIcon: shellTabIcon(TicketIcon, c) }} />
      <Tabs.Screen name="my-notices" options={{ title: t('Notices'), tabBarIcon: shellTabIcon(BellIcon, c) }} />
      <Tabs.Screen name="my-account" options={{ title: t('Account'), tabBarIcon: shellTabIcon(UserIcon, c) }} />
    </ShellTabs>
  );
}

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { isAlarmAlert, type AlertDto, type AlertUnreadCount } from '@veetracer/shared';
import { Tabs } from 'expo-router';
import { BellIcon, LayoutDashboardIcon, ListIcon, MapIcon, MenuIcon, type LucideIcon } from 'lucide-react-native';
import { useEffect } from 'react';
import { View, type ColorValue } from 'react-native';
import { useTranslation } from 'react-i18next';
import { SosIntroNotice } from '@/components/SosIntroNotice';
import { refreshAlertLists } from '@/features/alerts/read';
import { useAuth } from '@/features/auth/auth';
import { realtime } from '@/features/live/realtime';
import { useLiveConnection } from '@/features/live/use-live-connection';
import { handleNotificationTaps, openSos, registerForPush } from '@/features/notifications/push';
import { api } from '@/lib/api';
import { announceAlert } from '@/features/notifications/voice';
import { useColors, type Colors } from '@/lib/theme';

/** Tab icon with the brand-accent (saffron) bar over the current tab, as on the web menu. */
function tabIcon(Icon: LucideIcon, c: Colors) {
  return function TabIcon({ color, size, focused }: { color: ColorValue; size: number; focused: boolean }) {
    return (
      <View style={{ alignItems: 'center' }}>
        {focused ? <View style={{ position: 'absolute', top: -7, width: 28, height: 3, borderRadius: 2, backgroundColor: c.brandAccent }} /> : null}
        <Icon color={color as string} size={size} strokeWidth={focused ? 2.4 : 2} />
      </View>
    );
  };
}

export default function TabsLayout() {
  const c = useColors();
  const { t } = useTranslation();
  const { can } = useAuth();
  const queryClient = useQueryClient();
  useLiveConnection();
  useEffect(() => {
    void registerForPush();
    return handleNotificationTaps();
  }, []);

  const unread = useQuery({
    queryKey: ['alerts', 'unread-count'],
    queryFn: ({ signal }) => api.get<AlertUnreadCount>('/alerts/unread-count', undefined, signal),
    enabled: can('alerts'),
    refetchInterval: 60_000,
  });
  // New alerts arrive over the live socket: refresh the badge and any open alert list.
  // An emergency (SOS, crash, power cut, tamper) seen live while the app is open rings the alarm at once, without waiting for
  // the push (which may be late, or not sent when push is off for this user). openSos ignores the later push.
  useEffect(
    () =>
      realtime.on('alert', (a?: AlertDto) => {
        void queryClient.invalidateQueries({ queryKey: ['alerts'] });
        if (a) announceAlert(a);
        if (a?.id && isAlarmAlert(a.type, a.data) && a.status === 'NEW') openSos(a.id);
      }),
    [queryClient],
  );
  // Read on the web or another phone (same user): badge and lists. Acknowledged by anyone: everything, open alerts too.
  useEffect(() => realtime.on('alerts:read', () => void refreshAlertLists(queryClient)), [queryClient]);
  useEffect(() => realtime.on('alerts:acked', () => queryClient.invalidateQueries({ queryKey: ['alerts'] })), [queryClient]);
  const count = unread.data?.count ?? 0;

  return (
    <>
      <Tabs
        screenOptions={{
          tabBarActiveTintColor: c.navActive,
          tabBarInactiveTintColor: c.mutedForeground,
          tabBarStyle: { backgroundColor: c.card, borderTopColor: c.border },
          tabBarLabelStyle: { fontWeight: '600' },
          headerStyle: { backgroundColor: c.brand },
          headerTintColor: c.brandForeground,
          headerTitleStyle: { fontWeight: '700' },
          headerShadowVisible: false,
        }}
      >
        <Tabs.Screen name="index" options={{ title: t('Live map'), headerShown: false, tabBarIcon: tabIcon(MapIcon, c) }} />
        <Tabs.Screen name="vehicles" options={{ title: t('Vehicles'), tabBarIcon: tabIcon(ListIcon, c) }} />
        <Tabs.Screen
          name="alerts"
          options={{
            title: t('Alerts'),
            href: can('alerts') ? undefined : null,
            tabBarBadge: count ? (count > 99 ? '99+' : count) : undefined,
            tabBarIcon: tabIcon(BellIcon, c),
          }}
        />
        <Tabs.Screen name="dashboard" options={{ title: t('Dashboard'), href: can('dashboard') ? undefined : null, tabBarIcon: tabIcon(LayoutDashboardIcon, c) }} />
        <Tabs.Screen name="more" options={{ title: t('More'), tabBarIcon: tabIcon(MenuIcon, c) }} />
      </Tabs>
      <SosIntroNotice />
    </>
  );
}

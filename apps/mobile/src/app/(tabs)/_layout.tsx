import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AlertUnreadCount } from '@veetracer/shared';
import { Tabs } from 'expo-router';
import { BellIcon, LayoutDashboardIcon, ListIcon, MapIcon, MenuIcon } from 'lucide-react-native';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { SosIntroNotice } from '@/components/SosIntroNotice';
import { refreshAlertLists } from '@/features/alerts/read';
import { useAuth } from '@/features/auth/auth';
import { realtime } from '@/features/live/realtime';
import { useLiveConnection } from '@/features/live/use-live-connection';
import { handleNotificationTaps, registerForPush } from '@/features/notifications/push';
import { api } from '@/lib/api';
import { useColors } from '@/lib/theme';

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
  useEffect(() => realtime.on('alert', () => queryClient.invalidateQueries({ queryKey: ['alerts'] })), [queryClient]);
  // Read on the web or another phone (same user): badge and lists. Acknowledged by anyone: everything, open alerts too.
  useEffect(() => realtime.on('alerts:read', () => void refreshAlertLists(queryClient)), [queryClient]);
  useEffect(() => realtime.on('alerts:acked', () => queryClient.invalidateQueries({ queryKey: ['alerts'] })), [queryClient]);
  const count = unread.data?.count ?? 0;

  return (
    <>
      <Tabs
        screenOptions={{
          tabBarActiveTintColor: c.primary,
          tabBarInactiveTintColor: c.mutedForeground,
          tabBarStyle: { backgroundColor: c.card, borderTopColor: c.border },
          headerStyle: { backgroundColor: c.card },
          headerTintColor: c.foreground,
          headerShadowVisible: false,
        }}
      >
        <Tabs.Screen name="index" options={{ title: t('Live map'), headerShown: false, tabBarIcon: ({ color, size }) => <MapIcon color={color} size={size} /> }} />
        <Tabs.Screen name="vehicles" options={{ title: t('Vehicles'), tabBarIcon: ({ color, size }) => <ListIcon color={color} size={size} /> }} />
        <Tabs.Screen
          name="alerts"
          options={{
            title: t('Alerts'),
            href: can('alerts') ? undefined : null,
            tabBarBadge: count ? (count > 99 ? '99+' : count) : undefined,
            tabBarIcon: ({ color, size }) => <BellIcon color={color} size={size} />,
          }}
        />
        <Tabs.Screen name="dashboard" options={{ title: t('Dashboard'), href: can('dashboard') ? undefined : null, tabBarIcon: ({ color, size }) => <LayoutDashboardIcon color={color} size={size} /> }} />
        <Tabs.Screen name="more" options={{ title: t('More'), tabBarIcon: ({ color, size }) => <MenuIcon color={color} size={size} /> }} />
      </Tabs>
      <SosIntroNotice />
    </>
  );
}

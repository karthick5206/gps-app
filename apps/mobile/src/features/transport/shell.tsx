import { Tabs } from 'expo-router';
import type { LucideIcon } from 'lucide-react-native';
import { useEffect, type ReactNode } from 'react';
import { View, type ColorValue } from 'react-native';
import { handleNotificationTaps, registerForPush } from '@/features/notifications/push';
import { useColors, type Colors } from '@/lib/theme';
import { sosHeaderRight } from './SosScreen';
import type { SosAudience } from './sos-store';

/** Tab icon with the brand-accent bar over the current tab (same look as the fleet tab bar). */
export function shellTabIcon(Icon: LucideIcon, c: Colors) {
  return function TabIcon({ color, size, focused }: { color: ColorValue; size: number; focused: boolean }) {
    return (
      <View style={{ alignItems: 'center' }}>
        {focused ? <View style={{ position: 'absolute', top: -7, width: 28, height: 3, borderRadius: 2, backgroundColor: c.brandAccent }} /> : null}
        <Icon color={color as string} size={size} strokeWidth={focused ? 2.4 : 2} />
      </View>
    );
  };
}

/**
 * Tabs of the Passenger / Driver shells. Registers this install for push (generic payloads, D7) and handles taps
 * (they open a screen that fetches the details); no live socket: these users have no fleet permissions. Every tab has the red SOS
 * header button (`sos`: which queue it opens).
 */
export function ShellTabs({ children, sos }: { children: ReactNode; sos: SosAudience }) {
  const c = useColors();
  useEffect(() => {
    void registerForPush();
    return handleNotificationTaps();
  }, []);
  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: c.navActive,
        tabBarInactiveTintColor: c.mutedForeground,
        tabBarStyle: { backgroundColor: c.card, borderTopColor: c.border, minHeight: 56 },
        tabBarLabelStyle: { fontWeight: '600' },
        headerStyle: { backgroundColor: c.brand },
        headerTintColor: c.brandForeground,
        headerTitleStyle: { fontWeight: '700' },
        headerShadowVisible: false,
        // One tap to the SOS screen from every tab (QA B4, doc 09 §7.3).
        headerRight: sosHeaderRight(sos),
      }}
    >
      {children}
    </Tabs>
  );
}

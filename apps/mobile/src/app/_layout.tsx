import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import '@/lib/i18n';
import { AuthProvider, useAuth } from '@/features/auth/auth';
import { setTransportPushRoles } from '@/features/notifications/push';
import { appHome, transportRoles, type TransportRoles } from '@/features/transport/roles';
import { useTransportQueueLifecycle } from '@/features/transport/queue-store';
import { sosHeaderRight } from '@/features/transport/SosScreen';
import { rememberOfflineIdentity, useDriverSosLifecycle, useSosQueueLifecycle } from '@/features/transport/sos-store';
import { useBrandBarStyle, useColors, useScheme } from '@/lib/theme';

SplashScreen.preventAutoHideAsync();

/** Red SOS header button on every passenger / driver stack screen (QA B4, doc 09 §7.3). */
const PASSENGER_SOS = { headerRight: sosHeaderRight('passenger') };
const DRIVER_SOS = { headerRight: sosHeaderRight('driver') };

function RootStack() {
  const { status, me, offlineIdentity } = useAuth();
  const { t } = useTranslation();
  const scheme = useScheme();
  const c = useColors();
  const barStyle = useBrandBarStyle();

  // Which shell (fleet / passenger / driver, ETMS E5): from the server's /auth/me. The last known roles are kept while
  // /auth/me refetches (company switch), so the navigator is not torn down; before the first answer the splash stays.
  const current = useMemo(() => (status === 'authenticated' && me ? transportRoles(me) : null), [status, me]);
  const [lastRoles, setLastRoles] = useState<TransportRoles | null>(null);
  useEffect(() => {
    if (current) setLastRoles(current);
    else if (status !== 'authenticated') setLastRoles(null);
  }, [current, status]);
  const roles = status === 'authenticated' ? (current ?? lastRoles) : null;
  // Set during render (idempotent module value): the shells' tap handler reads it in their own mount effects, which
  // run before this component's effects, so a cold-start tap on a trip push already knows the roles.
  setTransportPushRoles(roles ?? { passenger: false, driver: false, incidents: false, fleet: false });
  useTransportQueueLifecycle(status === 'authenticated' && roles?.driver ? (me?.user.id ?? null) : null);
  // The SOS queues (pending SOS are retried after a restart until the server confirms them): passenger (E5 WP 5.3) and
  // driver (r114). Offline cold start: the remembered identity loads them so the offline SOS screen works.
  const offline = status === 'offline' ? offlineIdentity : null;
  useSosQueueLifecycle(status === 'authenticated' && roles?.passenger ? (me?.user.id ?? null) : offline?.passenger ? offline.userId : null);
  useDriverSosLifecycle(status === 'authenticated' && roles?.driver ? (me?.user.id ?? null) : offline?.driver ? offline.userId : null);
  // Remember who may use the offline SOS screen (cleared on sign-out and for users without an SOS section).
  const meUserId = me?.user.id ?? null;
  useEffect(() => {
    if (current && meUserId) rememberOfflineIdentity(meUserId, current);
  }, [current, meUserId]);
  const ready = status === 'anonymous' || status === 'offline' || (status === 'authenticated' && !!roles);

  useEffect(() => {
    if (ready) SplashScreen.hideAsync();
  }, [ready]);
  if (!ready) return null;

  const base = scheme === 'dark' ? DarkTheme : DefaultTheme;
  const theme = { ...base, colors: { ...base.colors, primary: c.primary, background: c.background, card: c.card, text: c.foreground, border: c.border } };
  const signedIn = status === 'authenticated';
  const shell = roles?.shell ?? 'fleet';
  // Shell-aware home: every guard below redirects here. `/` is the fleet `(tabs)` index, so a passenger / driver
  // reaching `/` (sign-in, cold start, `veetrax:///`, `router.replace('/')`) lands on My commute / My duty instead of
  // expo-router's default fallback `/(passenger)` / `/(driver)`, which has no index ("Unmatched Route").
  const home = appHome(status, shell);
  return (
    <ThemeProvider value={theme}>
      {/* Every screen starts with the brand header band (the sign-in screen too), so the bar follows the band. */}
      <StatusBar style={barStyle} />
      <Stack
        screenOptions={{
          headerBackTitle: t('Back'),
          headerTintColor: c.brandForeground,
          headerStyle: { backgroundColor: c.brand },
          headerTitleStyle: { fontWeight: '700' },
          headerShadowVisible: false,
          contentStyle: { backgroundColor: c.background },
        }}
      >
        {/* Offline cold start of an ETMS passenger / driver (QA B4): only the offline SOS screen until the server answers. */}
        <Stack.Protected guard={status === 'offline'} redirectTo={home}>
          <Stack.Screen name="offline-sos" options={{ headerShown: false }} />
        </Stack.Protected>
        {/* One shell at a time; a signed-in user lands on `home` (fleet `/`, passenger `/my-commute`, driver `/my-duty`). */}
        <Stack.Protected guard={signedIn && shell === 'fleet'} redirectTo={home}>
          <Stack.Screen name="(tabs)" options={{ headerShown: false, title: t('Home') }} />
        </Stack.Protected>
        <Stack.Protected guard={signedIn && shell === 'passenger'} redirectTo={home}>
          <Stack.Screen name="(passenger)" options={{ headerShown: false, title: t('My commute') }} />
        </Stack.Protected>
        <Stack.Protected guard={signedIn && shell === 'driver'} redirectTo={home}>
          <Stack.Screen name="(driver)" options={{ headerShown: false, title: t('My transport duty') }} />
        </Stack.Protected>
        {/* Passenger screens: the Passenger shell, and "My commute" inside the fleet / driver shells (P3). */}
        <Stack.Protected guard={signedIn && !!roles?.passenger} redirectTo={home}>
          <Stack.Screen name="commute/index" options={{ title: t('My commute'), ...PASSENGER_SOS }} />
          <Stack.Screen name="commute/bookings" options={{ title: t('My bookings'), ...PASSENGER_SOS }} />
          <Stack.Screen name="commute/notices" options={{ title: t('Notices'), ...PASSENGER_SOS }} />
          <Stack.Screen name="commute/consent" options={{ title: t('Privacy & consent'), ...PASSENGER_SOS }} />
          <Stack.Screen name="commute/trip/[id]" options={{ title: t('My trip'), ...PASSENGER_SOS }} />
          <Stack.Screen name="commute/book" options={{ title: t('Book a trip'), ...PASSENGER_SOS }} />
          <Stack.Screen name="commute/request" options={{ title: t('Request a ride'), ...PASSENGER_SOS }} />
          <Stack.Screen name="commute/profile" options={{ title: t('My transport profile'), ...PASSENGER_SOS }} />
          <Stack.Screen name="commute/places" options={{ title: t('Saved places'), ...PASSENGER_SOS }} />
          <Stack.Screen name="commute/schedule" options={{ title: t('Regular commute'), ...PASSENGER_SOS }} />
          <Stack.Screen name="commute/report/[id]" options={{ title: t('Report a problem'), ...PASSENGER_SOS }} />
          <Stack.Screen name="commute/sos" options={{ title: t('SOS') }} />
        </Stack.Protected>
        {/* Driver screens: the Driver shell, and "My transport duty" inside the fleet shell. */}
        <Stack.Protected guard={signedIn && !!roles?.driver} redirectTo={home}>
          <Stack.Screen name="duty/index" options={{ title: t('My transport duty'), ...DRIVER_SOS }} />
          <Stack.Screen name="duty/trip/[id]" options={{ title: t('Trip'), ...DRIVER_SOS }} />
          <Stack.Screen name="duty/report/[id]" options={{ title: t('Report a problem'), ...DRIVER_SOS }} />
          <Stack.Screen name="duty/sync" options={{ title: t('Sync'), ...DRIVER_SOS }} />
          <Stack.Screen name="duty/sos" options={{ title: t('SOS') }} />
        </Stack.Protected>
        {/* Read-only SOS incident opened from a dispatcher SOS push (QA B2). */}
        <Stack.Protected guard={signedIn && !!roles?.incidents} redirectTo={home}>
          <Stack.Screen name="transport-incident/[id]" options={{ title: t('Transport SOS') }} />
        </Stack.Protected>
        <Stack.Protected guard={signedIn} redirectTo={home}>
          <Stack.Screen name="vehicle/[id]" options={{ title: t('Vehicle') }} />
          <Stack.Screen name="alert/[id]" options={{ title: t('Alert') }} />
          <Stack.Screen name="sos/[id]" options={{ headerShown: false, presentation: 'fullScreenModal', gestureEnabled: false, animation: 'fade', contentStyle: { backgroundColor: '#c62828' } }} />
          <Stack.Screen name="history/[id]" options={{ title: t('History') }} />
          <Stack.Screen name="commands/[id]" options={{ title: t('Commands') }} />
          <Stack.Screen name="manage/[kind]/index" options={{ title: t('Manage') }} />
          <Stack.Screen name="manage/[kind]/[id]" options={{ title: t('Edit') }} />
          <Stack.Screen name="profile" options={{ title: t('Profile') }} />
          <Stack.Screen name="company" options={{ title: t('Switch company') }} />
          <Stack.Screen name="family" options={{ title: t('Family members') }} />
          <Stack.Screen name="geofences/index" options={{ title: t('Geofences') }} />
          <Stack.Screen name="expenses" options={{ title: t('Fuel & expenses') }} />
          <Stack.Screen name="attendance" options={{ title: t('Staff attendance') }} />
          <Stack.Screen name="attendance-day" options={{ title: t('Staff attendance') }} />
          <Stack.Screen name="attendance-person" options={{ title: t('Staff attendance') }} />
          <Stack.Screen name="driver-scores" options={{ title: t('Driver scorecard') }} />
          <Stack.Screen name="ask" options={{ title: t('Ask VeeTrax') }} />
          <Stack.Screen name="share/[id]" options={{ title: t('Share live location') }} />
          <Stack.Screen name="parking/index" options={{ title: t('Parking mode') }} />
          <Stack.Screen name="parking/[id]" options={{ title: t('Parking mode') }} />
          <Stack.Screen name="geofences/[id]" options={{ title: t('Geofence') }} />
          <Stack.Screen name="pois/index" options={{ title: t('Points of interest') }} />
          <Stack.Screen name="pois/[id]" options={{ title: t('Point of interest') }} />
          <Stack.Screen name="alert-settings" options={{ title: t('Alert settings') }} />
          <Stack.Screen name="reports/index" options={{ title: t('Reports') }} />
          <Stack.Screen name="reports/[type]" options={{ title: t('Report') }} />
          <Stack.Screen name="documents/index" options={{ title: t('Documents & service') }} />
          <Stack.Screen name="documents/[id]" options={{ title: t('Document') }} />
          <Stack.Screen name="documents/service/[id]" options={{ title: t('Service reminder') }} />
          <Stack.Screen name="driver-events/index" options={{ title: t('Driver events') }} />
          <Stack.Screen name="driver-events/[id]" options={{ title: t('Driver event') }} />
        </Stack.Protected>
        <Stack.Protected guard={status === 'anonymous'} redirectTo={home}>
          <Stack.Screen name="login" options={{ headerShown: false }} />
        </Stack.Protected>
      </Stack>
    </ThemeProvider>
  );
}

export default function RootLayout() {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: (count, err) => count < 2 && (err as { status?: number }).status !== 403, staleTime: 15_000 },
        },
      }),
  );
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <RootStack />
        </AuthProvider>
      </QueryClientProvider>
    </GestureHandlerRootView>
  );
}

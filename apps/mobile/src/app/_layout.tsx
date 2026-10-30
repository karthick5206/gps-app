import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import '@/lib/i18n';
import { AuthProvider, useAuth } from '@/features/auth/auth';
import { useColors, useScheme } from '@/lib/theme';

SplashScreen.preventAutoHideAsync();

function RootStack() {
  const { status } = useAuth();
  const { t } = useTranslation();
  const scheme = useScheme();
  const c = useColors();

  useEffect(() => {
    if (status !== 'loading') SplashScreen.hideAsync();
  }, [status]);
  if (status === 'loading') return null;

  const base = scheme === 'dark' ? DarkTheme : DefaultTheme;
  const theme = { ...base, colors: { ...base.colors, primary: c.primary, background: c.background, card: c.card, text: c.foreground, border: c.border } };
  const signedIn = status === 'authenticated';
  return (
    <ThemeProvider value={theme}>
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
      <Stack screenOptions={{ headerBackTitle: t('Back'), headerTintColor: c.foreground, headerStyle: { backgroundColor: c.card }, headerShadowVisible: false, contentStyle: { backgroundColor: c.background } }}>
        <Stack.Protected guard={signedIn}>
          <Stack.Screen name="(tabs)" options={{ headerShown: false, title: t('Home') }} />
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
        <Stack.Protected guard={!signedIn}>
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

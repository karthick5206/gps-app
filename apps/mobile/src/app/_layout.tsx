import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { AuthProvider, useAuth } from '@/features/auth/auth';
import { COLORS, useScheme } from '@/lib/theme';

SplashScreen.preventAutoHideAsync();

function RootStack() {
  const { status } = useAuth();
  const scheme = useScheme();
  const c = COLORS[scheme];

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
      <Stack screenOptions={{ headerTintColor: c.foreground, headerStyle: { backgroundColor: c.card }, headerShadowVisible: false, contentStyle: { backgroundColor: c.background } }}>
        <Stack.Protected guard={signedIn}>
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen name="vehicle/[id]" options={{ title: 'Vehicle' }} />
          <Stack.Screen name="alert/[id]" options={{ title: 'Alert' }} />
          <Stack.Screen name="history/[id]" options={{ title: 'History' }} />
          <Stack.Screen name="commands/[id]" options={{ title: 'Commands' }} />
          <Stack.Screen name="alert-settings" options={{ title: 'Alert settings' }} />
          <Stack.Screen name="reports/index" options={{ title: 'Reports' }} />
          <Stack.Screen name="reports/[type]" options={{ title: 'Report' }} />
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

import { router, Stack, useSegments } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { useColorScheme } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { api, SERVER_URL } from '@/lib/api';
import { installJsCrashHandler, reportCrashes } from '@/lib/crash';
import { handleAuthError, syncStopReason } from '@/lib/control';
import { getToken, hasToken, sessionFrom, store, useStoreVersion } from '@/lib/state';
import { S } from '@/lib/strings';
import { useColors } from '@/lib/theme';
import { applyConfig, resumeIfWanted, Tracker } from '@/lib/tracking';

installJsCrashHandler();
SplashScreen.preventAutoHideAsync().catch(() => undefined);

/**
 * Runs once per app start: handles a stop the native engine decided while the app was closed (REVOKED /
 * INVALID → sign out), resumes tracking if it is wanted but not running, and refreshes names / config.
 */
async function startup(): Promise<void> {
  // Works signed in or not: a crash during activation is the one we most need to see.
  reportCrashes().catch(() => undefined);
  const token = await getToken();
  if (!token || !store.session()) return;
  const st = await Tracker.getStatus().catch(() => null);
  await syncStopReason(st);
  if (!(await getToken())) return;
  // Make sure the native engine has the token (e.g. an install that activated before the native engine existed).
  if (st && !st.hasToken && !st.stopReason) await Tracker.setCredentials(token, SERVER_URL).catch(() => undefined);
  await resumeIfWanted();
  try {
    const me = await api.me(token);
    store.setSession(sessionFrom(me));
    if (store.inactive() || st?.stopReason === 'INACTIVE') {
      // /me works again, so the administrator switched the device back on; the user taps Start.
      store.setInactive(false);
      await Tracker.resetStopReason().catch(() => undefined);
    }
    await applyConfig(me.config);
    Tracker.flush().catch(() => undefined);
  } catch (e) {
    await handleAuthError(e);
  }
}

export default function RootLayout() {
  const [ready, setReady] = useState(false);
  useStoreVersion();
  const c = useColors();
  const scheme = useColorScheme();
  const segments = useSegments();
  // The session row is written together with the token on activation and cleared on sign-out.
  const signedIn = ready && hasToken() && !!store.session();

  // Move between Activate and Home only after this layout has re-rendered with the new sign-in state. Navigating
  // from the Activate screen right after saving the token raced the guard (still signed out) and left the user on
  // Activate until the app was reopened.
  useEffect(() => {
    if (!ready) return;
    const onActivate = segments[0] === 'activate';
    if (signedIn && onActivate) router.replace('/');
    else if (!signedIn && !onActivate) router.replace('/activate');
  }, [ready, signedIn, segments]);

  useEffect(() => {
    getToken()
      .catch(() => undefined)
      .finally(() => {
        setReady(true);
        SplashScreen.hideAsync().catch(() => undefined);
        startup().catch(() => undefined);
      });
  }, []);

  if (!ready) return null;

  return (
    <SafeAreaProvider>
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
      <Stack
        screenOptions={{
          headerTintColor: c.text,
          headerStyle: { backgroundColor: c.card },
          headerShadowVisible: false,
          contentStyle: { backgroundColor: c.background },
        }}
      >
        <Stack.Protected guard={signedIn}>
          <Stack.Screen name="index" options={{ title: S.appName }} />
          <Stack.Screen name="disclosure" options={{ title: S.disclosureTitle, presentation: 'modal' }} />
        </Stack.Protected>
        <Stack.Protected guard={!signedIn}>
          <Stack.Screen name="activate" options={{ headerShown: false }} />
        </Stack.Protected>
      </Stack>
    </SafeAreaProvider>
  );
}

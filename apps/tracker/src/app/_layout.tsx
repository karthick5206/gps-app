import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { useColorScheme } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { api } from '@/lib/api';
import { getToken, hasToken, store, useStoreVersion } from '@/lib/state';
import { S } from '@/lib/strings';
import { useColors } from '@/lib/theme';
import { applyConfig, resumeIfWanted } from '@/lib/tracking';
import { flush, handleAuthError } from '@/lib/uploader';

SplashScreen.preventAutoHideAsync().catch(() => undefined);

/** Refreshes names/config from the server and resumes tracking if it was on. Runs once per app start. */
async function startup(): Promise<void> {
  const token = await getToken();
  if (!token || !store.session()) return;
  await resumeIfWanted();
  try {
    const me = await api.me(token);
    store.setSession({ uniqueId: me.uniqueId, objectName: me.objectName, companyName: me.companyName });
    await applyConfig(me.config);
    flush(true).catch(() => undefined);
  } catch (e) {
    await handleAuthError(e);
  }
}

export default function RootLayout() {
  const [ready, setReady] = useState(false);
  useStoreVersion();
  const c = useColors();
  const scheme = useColorScheme();

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
  // The session row is written together with the token on activation and cleared on sign-out.
  const signedIn = hasToken() && !!store.session();

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

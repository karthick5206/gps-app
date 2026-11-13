/**
 * Shell-aware home (the "Unmatched Route veetrax:///" bug): the real expo-router with the same guard structure as
 * `app/_layout.tsx`. `/` belongs to the fleet `(tabs)` group only; with `redirectTo={appHome(...)}` a passenger lands on
 * /my-commute and a driver on /my-duty, on start, on `router.replace('/')` and on `<Redirect href="/" />`.
 */
import { Redirect, Stack, Tabs, router } from 'expo-router';
import { act, renderRouter, screen } from 'expo-router/testing-library';
import { Text } from 'react-native';
import { appHome, type Shell } from '../roles';

function routes(shell: Shell, withRedirect = true) {
  const RootLayout = () => {
    const home = withRedirect ? appHome('authenticated', shell) : undefined;
    return (
      <Stack>
        <Stack.Protected guard={shell === 'fleet'} redirectTo={home}>
          <Stack.Screen name="(tabs)" />
        </Stack.Protected>
        <Stack.Protected guard={shell === 'passenger'} redirectTo={home}>
          <Stack.Screen name="(passenger)" />
        </Stack.Protected>
        <Stack.Protected guard={shell === 'driver'} redirectTo={home}>
          <Stack.Screen name="(driver)" />
        </Stack.Protected>
        <Stack.Protected guard={true} redirectTo={home}>
          <Stack.Screen name="incident" />
        </Stack.Protected>
        <Stack.Protected guard={false} redirectTo={home}>
          <Stack.Screen name="login" />
        </Stack.Protected>
      </Stack>
    );
  };
  const tabs = (...names: string[]) => () => <Tabs>{names.map((n) => <Tabs.Screen key={n} name={n} />)}</Tabs>;
  return {
    _layout: RootLayout,
    '(tabs)/_layout': tabs('index'),
    '(tabs)/index': () => <Text>fleet home</Text>,
    '(passenger)/_layout': tabs('my-commute', 'my-bookings'),
    '(passenger)/my-commute': () => <Text>my commute</Text>,
    '(passenger)/my-bookings': () => <Text>my bookings</Text>,
    '(driver)/_layout': tabs('my-duty', 'driver-sync'),
    '(driver)/my-duty': () => <Text>my duty</Text>,
    '(driver)/driver-sync': () => <Text>driver sync</Text>,
    // Like transport-incident/[id].tsx: falls back to "/".
    incident: () => <Redirect href="/" />,
    login: () => <Text>sign in</Text>,
  };
}

describe('shell home', () => {
  it.each([
    ['fleet', '/', 'fleet home'],
    ['passenger', '/my-commute', 'my commute'],
    ['driver', '/my-duty', 'my duty'],
  ] as const)('%s: cold start / veetrax:/// lands on %s', async (shell, path, text) => {
    const r = await renderRouter(routes(shell), { initialUrl: '/' });
    expect(await screen.findByText(text)).toBeTruthy();
    expect(r.getPathname()).toBe(path);
    expect(screen.queryByText(/Unmatched Route/)).toBeNull();
  });

  it.each([
    ['passenger', '/my-bookings', '/my-commute', 'my commute'],
    ['driver', '/driver-sync', '/my-duty', 'my duty'],
  ] as const)('%s: router.replace("/") goes home', async (shell, start, path, text) => {
    const r = await renderRouter(routes(shell), { initialUrl: start });
    await act(() => router.replace('/'));
    expect(await screen.findByText(text)).toBeTruthy();
    expect(r.getPathname()).toBe(path);
  });

  it('passenger: <Redirect href="/" /> fallback goes home', async () => {
    const r = await renderRouter(routes('passenger'), { initialUrl: '/incident' });
    expect(await screen.findByText('my commute')).toBeTruthy();
    expect(r.getPathname()).toBe('/my-commute');
  });

  it('passenger: the sign-in route (guarded once signed in) goes home', async () => {
    await renderRouter(routes('passenger'), { initialUrl: '/login' });
    expect(await screen.findByText('my commute')).toBeTruthy();
  });

  it('regression: without redirectTo the passenger shell hits Unmatched Route on /', async () => {
    await renderRouter(routes('passenger', false), { initialUrl: '/' });
    expect(screen.queryByText('my commute')).toBeNull();
  });
});

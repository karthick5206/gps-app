import Constants from 'expo-constants';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Me, ThemePreference } from '@veetracer/shared';
import { router, type Href } from 'expo-router';
import { BellRingIcon, ChevronRightIcon, CpuIcon, FileBarChartIcon, HexagonIcon, IdCardIcon, TruckIcon, LogOutIcon, ServerIcon, UserIcon, type LucideIcon } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Button, Card, Chips, InfoRow, SectionTitle, Text } from '@/components/ui';
import { meQueryKey, useAuth } from '@/features/auth/auth';
import { applyThemePreference } from '@/features/theme/theme';
import { api } from '@/lib/api';
import { useRealtimeStatus } from '@/features/live/use-live';
import { pushStatus } from '@/features/notifications/push';
import { LanguageChips } from '@/components/LanguageChips';
import { SERVER_URL } from '@/lib/config';
import { SPACE, useColors } from '@/lib/theme';

function MenuItem({ icon: Icon, label, href }: { icon: LucideIcon; label: string; href: Href }) {
  const c = useColors();
  return (
    <Pressable onPress={() => router.push(href)} style={({ pressed }) => [{ flexDirection: 'row', alignItems: 'center', gap: SPACE.md, paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border }, pressed && { opacity: 0.6 }]}>
      <Icon size={20} color={c.primary} />
      <Text style={{ flex: 1 }}>{label}</Text>
      <ChevronRightIcon size={18} color={c.mutedForeground} />
    </Pressable>
  );
}

const CONNECTION_LABEL = { idle: 'Not connected', connecting: 'Connecting…', connected: 'Live', disconnected: 'Reconnecting…' } as const;

export default function MoreScreen() {
  const c = useColors();
  const { t } = useTranslation();
  const { me, signOut, can, companyId } = useAuth();
  const queryClient = useQueryClient();
  const theme = me?.user.preferences.theme ?? 'system';
  const setTheme = useMutation({
    mutationFn: (t: ThemePreference) => api.patch<Me>('/auth/me/preferences', { theme: t }),
    onMutate: (t) => applyThemePreference(t),
    onSuccess: (updated) => queryClient.setQueryData(meQueryKey(companyId), updated),
    onError: () => applyThemePreference(theme),
  });
  const connection = useRealtimeStatus();
  const confirmSignOut = () =>
    Alert.alert(t('Sign out?'), t('You will need to sign in again to see your vehicles.'), [
      { text: t('Cancel'), style: 'cancel' },
      { text: t('Sign out'), style: 'destructive', onPress: signOut },
    ]);
  return (
    <ScrollView contentContainerStyle={{ padding: SPACE.lg, gap: SPACE.md }}>
      <Card onPress={() => router.push('/profile')}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE.md }}>
          <View style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: c.accent, alignItems: 'center', justifyContent: 'center' }}>
            <UserIcon size={24} color={c.primary} />
          </View>
          <View style={{ flex: 1 }}>
            <Text size="lg" weight="700">
              {me?.user.name ?? '—'}
            </Text>
            <Text size="sm" tone="muted">
              {me?.user.email ?? me?.user.mobile ?? ''}
            </Text>
          </View>
          <ChevronRightIcon size={18} color={c.mutedForeground} />
        </View>
      </Card>

      <Card style={{ paddingVertical: 0 }}>
        {can('reports') && <MenuItem icon={FileBarChartIcon} label={t('Reports')} href="/reports" />}
        {can('objects') && <MenuItem icon={TruckIcon} label={t('Vehicles')} href="/manage/vehicles" />}
        {can('devices') && <MenuItem icon={CpuIcon} label={t('Devices')} href="/manage/devices" />}
        {can('drivers') && <MenuItem icon={IdCardIcon} label={t('Drivers')} href="/manage/drivers" />}
        {can('geofences') && <MenuItem icon={HexagonIcon} label={t('Geofences')} href="/geofences" />}
        {can('alert_settings') && <MenuItem icon={BellRingIcon} label={t('Alert settings')} href="/alert-settings" />}
      </Card>

      <SectionTitle>{t('Account')}</SectionTitle>
      <Card style={{ paddingVertical: 0 }}>
        <InfoRow label={t('Company')} value={me?.company.name ?? '—'} />
        <InfoRow label={t('Time zone')} value={me?.company.timezone ?? '—'} />
        <InfoRow label={t('Data access')} value={me?.dataScope === 'ASSIGNED' ? t('Assigned branches / vehicles') : t('Whole company')} />
      </Card>

      <SectionTitle>{t('Language')}</SectionTitle>
      <Card>
        <LanguageChips />
      </Card>

      <SectionTitle>{t('Appearance')}</SectionTitle>
      <Card style={{ gap: SPACE.sm }}>
        <Chips
          value={setTheme.isPending && setTheme.variables ? setTheme.variables : theme}
          onChange={(t) => setTheme.mutate(t)}
          options={[
            { value: 'system', label: t('System') },
            { value: 'light', label: t('Light') },
            { value: 'dark', label: t('Dark') },
          ]}
        />
        <Text size="xs" tone="muted">
          {t('Saved to your profile, so the web app uses the same theme.')}
        </Text>
      </Card>

      <SectionTitle>{t('App')}</SectionTitle>
      <Card style={{ paddingVertical: 0 }}>
        <InfoRow label={t('Live connection')} value={t(CONNECTION_LABEL[connection])} />
        <InfoRow label={t('Push alerts')} value={pushStatus ? t(pushStatus) : t('On')} />
        <InfoRow
          label={t('Server')}
          value={
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <ServerIcon size={14} color={c.mutedForeground} />
              <Text size="sm">{SERVER_URL.replace(/^https?:\/\//, '')}</Text>
            </View>
          }
        />
        <InfoRow label={t('Version')} value={Constants.expoConfig?.version ?? '—'} />
      </Card>

      <Button title={t('Sign out')} icon={LogOutIcon} variant="outline" onPress={confirmSignOut} style={{ marginTop: SPACE.md }} />
    </ScrollView>
  );
}
